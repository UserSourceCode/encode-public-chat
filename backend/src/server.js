import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { nanoid } from "nanoid";
import { Server } from "socket.io";

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "3mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

/* =========================
   In-memory state (RAM)
========================= */
const rooms = new Map();     // roomId -> {id,type,name,passHash?,createdAt,adminKey?}
const messages = new Map();  // roomId -> [{nick,text,at}]
const users = new Map();     // socketId -> {nick,roomId,ip,connectedAt,role}
const bansByIp = new Map();  // ip -> {until,reason}

// flags globais (admin painel do servidor pode mexer nisso no seu projeto)
const flags = {
  groupCreationEnabled: true,
  generalFrozen: false
};

function sanitizeNick(n){
  const s = String(n || "").trim();
  if(s.length < 2) return "";
  return s.slice(0, 18);
}

function getIp(socket){
  const xf = socket.handshake.headers["x-forwarded-for"];
  const ip = (Array.isArray(xf) ? xf[0] : xf || socket.handshake.address || "").split(",")[0].trim();
  return ip || "unknown";
}

function isIpBanned(ip){
  const b = bansByIp.get(ip);
  if(!b) return false;
  if(b.until == null) return true; // permanente
  if(Date.now() < b.until) return true;
  bansByIp.delete(ip);
  return false;
}

function ensureRoom(roomId){
  if(!rooms.has(roomId)){
    rooms.set(roomId, { id: roomId, type: "public", name: "Geral", createdAt: Date.now() });
    messages.set(roomId, []);
  }
}

function getRoomUsers(roomId){
  const out = [];
  for(const [sid, u] of users.entries()){
    if(u.roomId === roomId){
      out.push({ socketId: sid, nick: u.nick, role: u.role || "member" });
    }
  }
  out.sort((a,b)=> a.nick.localeCompare(b.nick));
  return out;
}

function roomSnapshot(roomId){
  ensureRoom(roomId);
  return {
    roomId,
    room: rooms.get(roomId),
    users: getRoomUsers(roomId),
    messages: messages.get(roomId) || []
  };
}

function emitUsers(roomId){
  const r = rooms.get(roomId);
  const list = getRoomUsers(roomId);

  // ✅ role só faz sentido em grupo. Geral pode omitir, mas não tem problema enviar.
  io.to(roomId).emit("users_list", {
    roomId,
    users: list.map(x => ({
      socketId: x.socketId,
      nick: x.nick,
      ...(r?.type === "group" ? { role: x.role || "member" } : {})
    }))
  });
}

function isRoomFrozen(roomId){
  if(roomId === "geral") return !!flags.generalFrozen;
  const r = rooms.get(roomId);
  return !!r?.frozen;
}

function isGroupAdmin(socketId){
  const u = users.get(socketId);
  if(!u) return false;
  const r = rooms.get(u.roomId);
  if(!r || r.type !== "group") return false;
  return u.role === "admin";
}

function requireGroupAdmin(socket){
  if(!isGroupAdmin(socket.id)){
    socket.emit("error_toast", { message: "Ação permitida apenas para admin do grupo." });
    return false;
  }
  return true;
}

/* =========================
   Routes
========================= */

// ✅ cria grupo (criador recebe adminKey)
app.post("/api/groups", async (req, res) => {
  try{
    if(!flags.groupCreationEnabled){
      return res.status(403).json({ ok:false, error:"Criação de grupos está bloqueada." });
    }

    const name = String(req.body?.name || "").trim() || "Grupo";
    const pass = String(req.body?.password || "");
    const nick = sanitizeNick(req.body?.nick);

    if(!nick) return res.status(400).json({ ok:false, error:"Apelido inválido (mín. 2)." });
    if(pass.length < 3) return res.status(400).json({ ok:false, error:"Senha muito curta (mín. 3)." });

    const id = "g_" + nanoid(10);
    const passHash = await bcrypt.hash(pass, 10);

    const adminKey = crypto.randomBytes(24).toString("hex");

    rooms.set(id, {
      id,
      type: "group",
      name: name.slice(0, 32),
      passHash,
      createdAt: Date.now(),
      adminKey,
      frozen: false
    });
    messages.set(id, []);

    res.json({ ok:true, groupId:id, adminKey });
  }catch{
    res.status(500).json({ ok:false, error:"Erro ao criar grupo." });
  }
});

/* =========================
   Socket.IO
========================= */
io.on("connection", (socket) => {
  const ip = getIp(socket);

  if(isIpBanned(ip)){
    socket.emit("admin_ban", { message: "Seu IP está bloqueado." });
    try{ socket.disconnect(true); } catch {}
    return;
  }

  socket.on("join_public", ({ nick }) => {
    const n = sanitizeNick(nick);
    if(!n) return socket.emit("error_toast", { message: "Apelido inválido." });

    ensureRoom("geral");
    users.set(socket.id, { nick: n, roomId: "geral", ip, connectedAt: Date.now(), role: "member" });
    socket.join("geral");

    socket.emit("room_snapshot", roomSnapshot("geral"));
    socket.emit("you_role", { roomId: "geral", role: "member" });
    emitUsers("geral");
  });

  socket.on("join_group", async ({ roomId, nick, password, adminKey }) => {
    const n = sanitizeNick(nick);
    if(!n) return socket.emit("error_toast", { message: "Apelido inválido." });

    const rid = String(roomId || "");
    const r = rooms.get(rid);
    if(!r || r.type !== "group"){
      return socket.emit("error_toast", { message: "Grupo não existe (ou já expirou)." });
    }

    const ok = await bcrypt.compare(String(password || ""), r.passHash);
    if(!ok) return socket.emit("error_toast", { message: "Senha incorreta." });

    const isAdmin = Boolean(adminKey && r.adminKey && String(adminKey) === String(r.adminKey));
    const role = isAdmin ? "admin" : "member";

    users.set(socket.id, { nick: n, roomId: rid, ip, connectedAt: Date.now(), role });
    socket.join(rid);

    socket.emit("room_snapshot", roomSnapshot(rid));
    socket.emit("you_role", { roomId: rid, role });

    emitUsers(rid);
    io.to(rid).emit("admin_notice", { message: `${n} entrou no grupo.` });
  });

  // ✅ enviar msg Geral
  socket.on("send_public", ({ text }) => {
    const u = users.get(socket.id);
    if(!u || u.roomId !== "geral") return;
    if(isRoomFrozen("geral")) return socket.emit("error_toast", { message: "O Geral está congelado." });

    const t = String(text || "").trim().slice(0, 900);
    if(!t) return;

    const msg = { nick: u.nick, text: t, at: Date.now() };
    const arr = messages.get("geral") || [];
    arr.push(msg);
    if(arr.length > 300) arr.splice(0, arr.length - 300);
    messages.set("geral", arr);

    io.to("geral").emit("message", msg);
  });

  // ✅ enviar msg Grupo
  socket.on("send_group", ({ roomId, text }) => {
    const u = users.get(socket.id);
    if(!u) return;

    const rid = String(roomId || "");
    if(u.roomId !== rid) return;

    if(isRoomFrozen(rid)) return socket.emit("error_toast", { message: "Sala congelada pelo admin." });

    const t = String(text || "").trim().slice(0, 900);
    if(!t) return;

    const msg = { nick: u.nick, text: t, at: Date.now() };
    const arr = messages.get(rid) || [];
    arr.push(msg);
    if(arr.length > 300) arr.splice(0, arr.length - 300);
    messages.set(rid, arr);

    io.to(rid).emit("message", msg);
  });

  /* =========================
     ✅ Group admin actions
  ========================= */

  // aviso privado
  socket.on("group_warn", ({ targetSocketId, message }) => {
    if(!requireGroupAdmin(socket)) return;

    const me = users.get(socket.id);
    const targetId = String(targetSocketId || "");
    const target = users.get(targetId);
    if(!me || !target) return;

    if(me.roomId !== target.roomId){
      return socket.emit("error_toast", { message: "Usuário não está neste grupo." });
    }

    const msg = String(message || "Aviso do administrador.").trim().slice(0, 220);
    io.to(targetId).emit("private_warn", { message: msg });
    socket.emit("admin_notice", { message: "Aviso enviado (privado)." });
  });

  // kick (sem ban)
  socket.on("group_kick", ({ targetSocketId, message }) => {
    if(!requireGroupAdmin(socket)) return;

    const me = users.get(socket.id);
    const targetId = String(targetSocketId || "");
    const target = users.get(targetId);
    if(!me || !target) return;

    if(me.roomId !== target.roomId){
      return socket.emit("error_toast", { message: "Usuário não está neste grupo." });
    }

    if(targetId === socket.id){
      return socket.emit("error_toast", { message: "Você não pode expulsar você mesmo." });
    }

    const msg = String(message || "Você foi removido pelo administrador do grupo.").trim().slice(0, 220);
    io.to(targetId).emit("admin_kick", { message: msg });

    const s = io.sockets.sockets.get(targetId);
    setTimeout(()=>{ try{ s?.disconnect(true); } catch{} }, 120);

    io.to(me.roomId).emit("admin_notice", { message: `👢 ${target.nick} foi removido (kick).` });
    emitUsers(me.roomId);
  });

  // promover admin
  socket.on("group_promote_admin", ({ targetSocketId }) => {
    if(!requireGroupAdmin(socket)) return;

    const me = users.get(socket.id);
    const targetId = String(targetSocketId || "");
    const target = users.get(targetId);
    if(!me || !target) return;

    if(me.roomId !== target.roomId){
      return socket.emit("error_toast", { message: "Usuário não está neste grupo." });
    }

    target.role = "admin";
    users.set(targetId, target);

    io.to(targetId).emit("you_role", { roomId: me.roomId, role: "admin" });
    io.to(me.roomId).emit("admin_notice", { message: `✅ ${target.nick} agora é admin do grupo.` });
    emitUsers(me.roomId);
  });

  // demover admin
  socket.on("group_demote_admin", ({ targetSocketId }) => {
    if(!requireGroupAdmin(socket)) return;

    const me = users.get(socket.id);
    const targetId = String(targetSocketId || "");
    const target = users.get(targetId);
    if(!me || !target) return;

    if(me.roomId !== target.roomId){
      return socket.emit("error_toast", { message: "Usuário não está neste grupo." });
    }

    // não deixa o admin tirar o próprio admin (pra não travar o grupo)
    if(targetId === socket.id){
      return socket.emit("error_toast", { message: "Você não pode demover você mesmo." });
    }

    target.role = "member";
    users.set(targetId, target);

    io.to(targetId).emit("you_role", { roomId: me.roomId, role: "member" });
    io.to(me.roomId).emit("admin_notice", { message: `↘️ ${target.nick} foi demovido (não é mais admin).` });
    emitUsers(me.roomId);
  });

  // ban ip
  socket.on("group_ban_ip", ({ targetSocketId, minutes = 60, reason }) => {
    if(!requireGroupAdmin(socket)) return;

    const me = users.get(socket.id);
    const targetId = String(targetSocketId || "");
    const target = users.get(targetId);

    if(!me || !target) return;
    if(me.roomId !== target.roomId){
      return socket.emit("error_toast", { message: "Usuário não está neste grupo." });
    }
    if(targetId === socket.id){
      return socket.emit("error_toast", { message: "Você não pode banir você mesmo." });
    }

    const mins = Number(minutes || 0);
    const until = mins > 0 ? (Date.now() + mins * 60 * 1000) : null;
    const ip2 = target.ip || "unknown";
    const msg = String(reason || "Acesso bloqueado pelo admin do grupo.").trim().slice(0, 220);

    bansByIp.set(ip2, { until, reason: msg });

    io.to(targetId).emit("admin_ban", { message: msg });

    const s = io.sockets.sockets.get(targetId);
    setTimeout(()=>{ try{ s?.disconnect(true); } catch{} }, 120);

    io.to(me.roomId).emit("admin_notice", { message: `⛔ ${target.nick} foi banido do grupo.` });
    emitUsers(me.roomId);
  });

  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if(!u) return;
    users.delete(socket.id);
    emitUsers(u.roomId);
  });
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 4100;
server.listen(PORT, () => {
  console.log("Server on", PORT);
});

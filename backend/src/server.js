// backend/src/server.js
import express from "express";
import helmet from "helmet";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "12mb" }));

const server = http.createServer(app);

// CORS: se front e back no mesmo domínio (Render), pode deixar true
const ORIGIN = process.env.ORIGIN || true;

const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 6 * 1024 * 1024 // 6MB
});

// -------------------- CONFIG ADMIN --------------------
const ADMIN_PASS = String(process.env.ADMIN_PASS || "");
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || "");

if (!ADMIN_PASS) {
  console.warn("[WARN] ADMIN_PASS não definido. Painel admin ficará inacessível.");
}

const adminKey = crypto
  .createHash("sha256")
  .update(ADMIN_SECRET || ("fallback:" + ADMIN_PASS))
  .digest("hex");

function signAdminToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", adminKey).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", adminKey).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

function requireAdmin(req, res, next) {
  try {
    const h = String(req.headers.authorization || "");
    const m = h.match(/^Bearer\s+(.+)$/i);
    const token = m ? m[1] : "";
    const payload = verifyAdminToken(token);
    if (!payload) return res.status(401).json({ ok: false, error: "Não autorizado." });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Não autorizado." });
  }
}

// -------------------- MEMÓRIA (SEM PERSISTÊNCIA) --------------------
/**
 * rooms:
 *  - "geral" sempre existe
 *  - group: "g_xxxxx"
 *  - dm: "dm_<a>_<b>"
 *
 * users:
 *  - socketId -> { nick, roomId, ip, joinedAt }
 *
 * messages:
 *  - roomId -> Array<Message>
 *
 * bans:
 *  - ip -> { until, reason }
 */
const rooms = new Map();
const users = new Map();
const messages = new Map();
const bans = new Map(); // ip -> {until, reason}
let freezeGroups = false;

function now() { return Date.now(); }

function normalizeIP(ip) {
  ip = String(ip || "");
  // socket.io/express podem fornecer "::ffff:127.0.0.1"
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function isIpBanned(ip) {
  const b = bans.get(ip);
  if (!b) return false;
  if (b.until && now() > b.until) {
    bans.delete(ip);
    return false;
  }
  return true;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    if (roomId === "geral") {
      rooms.set(roomId, { id: "geral", type: "public", name: "Geral", createdAt: now() });
    } else {
      rooms.set(roomId, { id: roomId, type: "public", name: "Sala", createdAt: now() });
    }
  }
  if (!messages.has(roomId)) messages.set(roomId, []);
}
ensureRoom("geral");

function sanitizeNick(nick) {
  nick = String(nick || "").trim().replace(/\s+/g, " ");
  if (nick.length < 2) return null;
  if (nick.length > 18) nick = nick.slice(0, 18);
  return nick;
}

function roomSnapshot(roomId) {
  return { room: rooms.get(roomId), messages: messages.get(roomId) || [] };
}

function removeUserMessages(socketId, roomId) {
  const arr = messages.get(roomId) || [];
  if (!arr.length) return;

  const removedIds = arr.filter(m => m.userId === socketId).map(m => m.id);
  if (!removedIds.length) return;

  messages.set(roomId, arr.filter(m => m.userId !== socketId));
  io.to(roomId).emit("message_deleted", { ids: removedIds });
}

function cleanupRoomIfEmpty(roomId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  const count = socketsInRoom ? socketsInRoom.size : 0;
  if (count === 0) {
    messages.set(roomId, []);
    const r = rooms.get(roomId);
    if (r && (r.type === "group" || r.type === "dm")) {
      rooms.delete(roomId);
      messages.delete(roomId);
    }
  }
}

function getRoomUsers(roomId) {
  const arr = [];
  for (const [sid, u] of users.entries()) {
    if (u.roomId === roomId) arr.push({ socketId: sid, nick: u.nick, ip: u.ip, joinedAt: u.joinedAt });
  }
  arr.sort((a, b) => a.nick.localeCompare(b.nick, "pt-BR"));
  return arr;
}

function emitUsers(roomId) {
  io.to(roomId).emit("users_list", { roomId, users: getRoomUsers(roomId).map(u => ({ socketId: u.socketId, nick: u.nick })) });
}

function dmIdFor(a, b) {
  const [x, y] = [a, b].sort();
  return `dm_${x}_${y}`;
}

function ensureDm(dmId) {
  if (!rooms.has(dmId)) rooms.set(dmId, { id: dmId, type: "dm", name: "Privado", createdAt: now() });
  if (!messages.has(dmId)) messages.set(dmId, []);
}

function dmMetaList() {
  const out = [];
  for (const [rid, r] of rooms.entries()) {
    if (r?.type !== "dm") continue;
    const socketsInRoom = io.sockets.adapter.rooms.get(rid);
    const count = socketsInRoom ? socketsInRoom.size : 0;
    // participantes (nick) a partir do map users
    const participants = [];
    if (socketsInRoom) {
      for (const sid of socketsInRoom.values()) {
        const u = users.get(sid);
        if (u) participants.push({ socketId: sid, nick: u.nick });
      }
    }
    out.push({
      id: rid,
      participants,
      onlineCount: count,
      msgCount: (messages.get(rid) || []).length,
      createdAt: r.createdAt
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// -------------------- REST API BÁSICO --------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/groups", async (req, res) => {
  try {
    if (freezeGroups) return res.status(403).json({ ok: false, error: "Criação de grupos está bloqueada pelo administrador." });

    const name = String(req.body?.name || "").trim() || "Grupo";
    const pass = String(req.body?.password || "");
    const nick = sanitizeNick(req.body?.nick);

    if (!nick) return res.status(400).json({ ok: false, error: "Apelido inválido (mín. 2 caracteres)." });
    if (pass.length < 3) return res.status(400).json({ ok: false, error: "Senha muito curta (mín. 3)." });

    const id = "g_" + nanoid(10);
    const passHash = await bcrypt.hash(pass, 10);

    rooms.set(id, { id, type: "group", name: name.slice(0, 32), passHash, createdAt: now() });
    messages.set(id, []);

    res.json({ ok: true, groupId: id, linkPath: `/#/g/${id}` });
  } catch {
    res.status(500).json({ ok: false, error: "Erro ao criar grupo." });
  }
});

app.get("/api/rooms/:id/public", (req, res) => {
  const id = req.params.id;
  const r = rooms.get(id);
  if (!r) return res.status(404).json({ ok: false, error: "Sala não existe (ou já expirou)." });
  res.json({ ok: true, room: { id: r.id, type: r.type, name: r.name } });
});

// -------------------- ADMIN REST --------------------
app.post("/api/admin/login", async (req, res) => {
  const pass = String(req.body?.password || "");
  if (!ADMIN_PASS) return res.status(403).json({ ok: false, error: "Admin desativado." });
  if (pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: "Senha incorreta." });

  const token = signAdminToken({ role: "admin", exp: now() + 1000 * 60 * 60 * 6 }); // 6h
  res.json({ ok: true, token });
});

app.get("/api/admin/state", requireAdmin, (req, res) => {
  const roomList = [];
  for (const [rid, r] of rooms.entries()) {
    if (!r) continue;
    const socketsInRoom = io.sockets.adapter.rooms.get(rid);
    const online = socketsInRoom ? socketsInRoom.size : 0;

    roomList.push({
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt,
      onlineCount: online,
      msgCount: (messages.get(rid) || []).length
    });
  }

  // mensagens VISÍVEIS: apenas geral + grupos (não DM)
  const visibleMessages = {};
  for (const [rid, r] of rooms.entries()) {
    if (!r) continue;
    if (r.type === "public" || r.type === "group") {
      visibleMessages[rid] = (messages.get(rid) || []).slice(-250);
    }
  }

  const onlineUsers = [];
  for (const [sid, u] of users.entries()) {
    onlineUsers.push({ socketId: sid, nick: u.nick, roomId: u.roomId, ip: u.ip, joinedAt: u.joinedAt });
  }

  res.json({
    ok: true,
    freezeGroups,
    bans: Array.from(bans.entries()).map(([ip, b]) => ({ ip, until: b.until || null, reason: b.reason || "" })),
    rooms: roomList.sort((a, b) => (b.onlineCount - a.onlineCount) || (b.createdAt - a.createdAt)),
    users: onlineUsers.sort((a, b) => (a.roomId || "").localeCompare(b.roomId || "") || a.nick.localeCompare(b.nick, "pt-BR")),
    messages: visibleMessages,
    dms: dmMetaList()
  });
});

app.post("/api/admin/freeze-groups", requireAdmin, (req, res) => {
  freezeGroups = !!req.body?.enabled;
  res.json({ ok: true, freezeGroups });
});

app.post("/api/admin/warn", requireAdmin, (req, res) => {
  const socketId = String(req.body?.socketId || "");
  const message = String(req.body?.message || "Atenção: moderação.").slice(0, 220);
  const s = io.sockets.sockets.get(socketId);
  if (!s) return res.status(404).json({ ok: false, error: "Usuário não encontrado." });

  s.emit("admin_warn", { message });
  res.json({ ok: true });
});

app.post("/api/admin/kick", requireAdmin, (req, res) => {
  const socketId = String(req.body?.socketId || "");
  const s = io.sockets.sockets.get(socketId);
  if (!s) return res.status(404).json({ ok: false, error: "Usuário não encontrado." });

  s.emit("admin_warn", { message: "Você foi desconectado pela moderação." });
  s.disconnect(true);
  res.json({ ok: true });
});

app.post("/api/admin/ban-ip", requireAdmin, (req, res) => {
  const ip = normalizeIP(req.body?.ip);
  const minutes = Number(req.body?.minutes || 0);
  const reason = String(req.body?.reason || "Moderação").slice(0, 120);

  if (!ip) return res.status(400).json({ ok: false, error: "IP inválido." });

  const until = minutes > 0 ? (now() + minutes * 60 * 1000) : null; // null = até reiniciar
  bans.set(ip, { until, reason });

  // derruba todos que estiverem nesse IP
  for (const [sid, u] of users.entries()) {
    if (u.ip === ip) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit("admin_warn", { message: "Você foi banido pela moderação." });
        s.disconnect(true);
      }
    }
  }

  res.json({ ok: true });
});

app.post("/api/admin/unban-ip", requireAdmin, (req, res) => {
  const ip = normalizeIP(req.body?.ip);
  bans.delete(ip);
  res.json({ ok: true });
});

app.post("/api/admin/clear-room", requireAdmin, (req, res) => {
  const roomId = String(req.body?.roomId || "");
  const r = rooms.get(roomId);
  if (!r) return res.status(404).json({ ok: false, error: "Sala não existe." });
  if (!(r.type === "public" || r.type === "group")) return res.status(400).json({ ok: false, error: "Só é permitido limpar Geral/Grupo." });

  messages.set(roomId, []);
  io.to(roomId).emit("room_cleared", { roomId });
  res.json({ ok: true });
});

app.post("/api/admin/close-dm", requireAdmin, (req, res) => {
  const dmId = String(req.body?.dmId || "");
  const r = rooms.get(dmId);
  if (!r || r.type !== "dm") return res.status(404).json({ ok: false, error: "DM não encontrado." });

  messages.delete(dmId);
  rooms.delete(dmId);

  // avisa quem estava na sala e faz sair
  io.to(dmId).emit("dm_closed", { dmId });
  // remove todo mundo da sala dm
  const socketsInRoom = io.sockets.adapter.rooms.get(dmId);
  if (socketsInRoom) {
    for (const sid of socketsInRoom.values()) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.leave(dmId);
    }
  }
  res.json({ ok: true });
});

// -------------------- SERVIR FRONTEND BUILD --------------------
const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
const indexHtml = path.join(frontendDist, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(frontendDist));
  app.get("*", (req, res) => res.sendFile(indexHtml));
} else {
  app.get("*", (req, res) => {
    res.status(200).send(
      `<pre style="font-family: ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap">
Frontend build não encontrado.

Esperado:
  ${indexHtml}

Como resolver (na raiz do projeto):
  npm --prefix frontend install
  npm --prefix frontend run build

Depois rode:
  node backend/src/server.js
</pre>`
    );
  });
}

// -------------------- SOCKET.IO --------------------
io.on("connection", (socket) => {
  const ip = normalizeIP(socket.handshake.address);

  if (isIpBanned(ip)) {
    socket.emit("error_toast", { message: "Acesso bloqueado pela moderação." });
    socket.disconnect(true);
    return;
  }

  socket.on("join_public", ({ nick }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });
    if (isIpBanned(ip)) return socket.emit("error_toast", { message: "Acesso bloqueado pela moderação." });

    ensureRoom("geral");
    users.set(socket.id, { nick, roomId: "geral", ip, joinedAt: now() });

    socket.join("geral");
    socket.emit("room_snapshot", roomSnapshot("geral"));
    io.to("geral").emit("presence", { type: "join", nick });
    emitUsers("geral");
  });

  socket.on("join_group", async ({ roomId, nick, password }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });
    if (isIpBanned(ip)) return socket.emit("error_toast", { message: "Acesso bloqueado pela moderação." });

    const r = rooms.get(roomId);
    if (!r || r.type !== "group") return socket.emit("error_toast", { message: "Grupo não existe (ou já expirou)." });

    const ok = await bcrypt.compare(String(password || ""), r.passHash);
    if (!ok) return socket.emit("error_toast", { message: "Senha incorreta." });

    users.set(socket.id, { nick, roomId, ip, joinedAt: now() });
    socket.join(roomId);

    socket.emit("room_snapshot", roomSnapshot(roomId));
    io.to(roomId).emit("presence", { type: "join", nick });
    emitUsers(roomId);
  });

  socket.on("send_message", ({ type, content, roomId, replyTo }) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (isIpBanned(ip)) return;

    const rid = u.roomId;
    if (roomId && roomId !== rid) return;

    const t = String(type || "text");
    const allowed = new Set(["text", "image", "audio"]);
    if (!allowed.has(t)) return;

    const c = String(content || "");
    if (!c) return;

    if (t === "text" && c.length > 2000) return socket.emit("error_toast", { message: "Texto muito grande (máx 2000)." });
    if (t !== "text" && c.length > 5_500_000) return socket.emit("error_toast", { message: "Arquivo muito grande." });

    const msg = {
      id: "m_" + nanoid(10),
      roomId: rid,
      userId: socket.id,
      nick: u.nick,
      type: t,
      content: c,
      ts: now(),
      reactions: {},
      replyTo: replyTo && replyTo.id ? {
        id: String(replyTo.id),
        nick: String(replyTo.nick || "").slice(0, 18),
        preview: String(replyTo.preview || "").slice(0, 140),
        type: String(replyTo.type || "text")
      } : null
    };

    const arr = messages.get(rid) || [];
    arr.push(msg);
    while (arr.length > 250) arr.shift();
    messages.set(rid, arr);

    io.to(rid).emit("new_message", msg);
  });

  socket.on("react_message", ({ roomId, messageId, emoji }) => {
    const u = users.get(socket.id);
    if (!u) return;
    if (isIpBanned(ip)) return;

    const rid = u.roomId;
    if (roomId && roomId !== rid) return;

    emoji = String(emoji || "").trim().slice(0, 4);
    if (!emoji) return;

    const arr = messages.get(rid) || [];
    const m = arr.find(x => x.id === messageId);
    if (!m) return;

    m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;
    io.to(rid).emit("message_reacted", { messageId: m.id, reactions: m.reactions });
  });

  // -------- DM (conteúdo NÃO exposto ao admin; admin só vê meta + pode encerrar) --------
  socket.on("start_dm", ({ peerSocketId }) => {
    const me = users.get(socket.id);
    if (!me) return;
    if (isIpBanned(ip)) return;

    const peer = users.get(peerSocketId);
    if (!peer) return socket.emit("error_toast", { message: "Usuário não está mais online." });

    // DM apenas se estiverem na mesma sala pública/grupo
    if (peer.roomId !== me.roomId) return socket.emit("error_toast", { message: "Usuário não está nessa sala." });

    const dmId = dmIdFor(socket.id, peerSocketId);
    ensureDm(dmId);

    socket.join(dmId);
    io.to(peerSocketId).socketsJoin(dmId);

    socket.emit("dm_ready", { dmId, peer: { socketId: peerSocketId, nick: peer.nick } });
    io.to(peerSocketId).emit("dm_ready", { dmId, peer: { socketId: socket.id, nick: me.nick } });

    socket.emit("dm_snapshot", { dmId, messages: messages.get(dmId) || [] });
    io.to(peerSocketId).emit("dm_snapshot", { dmId, messages: messages.get(dmId) || [] });
  });

  socket.on("send_dm", ({ dmId, type, content, replyTo }) => {
    const me = users.get(socket.id);
    if (!me) return;
    if (isIpBanned(ip)) return;

    const r = rooms.get(dmId);
    if (!r || r.type !== "dm") return;

    const t = String(type || "text");
    const allowed = new Set(["text", "image", "audio"]);
    if (!allowed.has(t)) return;

    const c = String(content || "");
    if (!c) return;

    if (t === "text" && c.length > 2000) return socket.emit("error_toast", { message: "Texto muito grande (máx 2000)." });
    if (t !== "text" && c.length > 5_500_000) return socket.emit("error_toast", { message: "Arquivo muito grande." });

    const msg = {
      id: "m_" + nanoid(10),
      roomId: dmId,
      userId: socket.id,
      nick: me.nick,
      type: t,
      content: c,
      ts: now(),
      reactions: {},
      replyTo: replyTo && replyTo.id ? {
        id: String(replyTo.id),
        nick: String(replyTo.nick || "").slice(0, 18),
        preview: String(replyTo.preview || "").slice(0, 140),
        type: String(replyTo.type || "text")
      } : null
    };

    const arr = messages.get(dmId) || [];
    arr.push(msg);
    while (arr.length > 200) arr.shift();
    messages.set(dmId, arr);

    io.to(dmId).emit("dm_new_message", { dmId, message: msg });
  });

  socket.on("react_dm", ({ dmId, messageId, emoji }) => {
    const r = rooms.get(dmId);
    if (!r || r.type !== "dm") return;
    if (isIpBanned(ip)) return;

    emoji = String(emoji || "").trim().slice(0, 4);
    if (!emoji) return;

    const arr = messages.get(dmId) || [];
    const m = arr.find(x => x.id === messageId);
    if (!m) return;

    m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;
    io.to(dmId).emit("dm_reacted", { dmId, messageId: m.id, reactions: m.reactions });
  });

  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;

    const { nick, roomId } = u;
    users.delete(socket.id);

    removeUserMessages(socket.id, roomId);
    io.to(roomId).emit("presence", { type: "leave", nick });
    emitUsers(roomId);

    setTimeout(() => cleanupRoomIfEmpty(roomId), 50);

    // limpa DMs vazias
    setTimeout(() => {
      for (const [rid, info] of rooms.entries()) {
        if (info?.type !== "dm") continue;
        cleanupRoomIfEmpty(rid);
      }
    }, 120);
  });
});

// -------------------- START --------------------
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server on port", PORT);
  console.log("Frontend dist:", frontendDist);
});

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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

const ORIGIN = process.env.ORIGIN || true; // mesmo domínio no Render = ok
const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 6 * 1024 * 1024
});

// ===================================================================
// MEMÓRIA (NÃO PERSISTE)
// ===================================================================
const rooms = new Map();    // roomId -> { id,type,name,passHash?,createdAt }
const users = new Map();    // socketId -> { nick,roomId,ip,connectedAt }
const messages = new Map(); // roomId -> Array<Message>

// ===================================================================
// MÉTRICAS (OBSERVABILIDADE) — tudo em RAM
// ===================================================================
const metrics = {
  bootAt: Date.now(),

  // Online
  peakOnline: 0,
  peakOnlineAt: null,
  peakByRoom: new Map(), // roomId -> { peak, at }

  // Sessões
  sessionsClosedCount: 0,
  sessionsClosedTotalMs: 0,

  // Mensagens por minuto (janela deslizante 60s)
  msgWindow: new Array(60).fill(0),
  msgWindowSec: Math.floor(Date.now() / 1000),
  peakMsgsPerMin: 0,
  peakMsgsPerMinAt: null,
};

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    if (roomId === "geral") {
      rooms.set(roomId, { id: "geral", type: "public", name: "Geral", createdAt: Date.now() });
    } else {
      rooms.set(roomId, { id: roomId, type: "public", name: "Sala", createdAt: Date.now() });
    }
  }
  if (!messages.has(roomId)) messages.set(roomId, []);
}
ensureRoom("geral");

function updatePeaksOnline() {
  const onlineNow = users.size;
  if (onlineNow > metrics.peakOnline) {
    metrics.peakOnline = onlineNow;
    metrics.peakOnlineAt = Date.now();
  }
  const counts = new Map();
  for (const [, u] of users.entries()) {
    counts.set(u.roomId, (counts.get(u.roomId) || 0) + 1);
  }
  for (const [rid, cnt] of counts.entries()) {
    const prev = metrics.peakByRoom.get(rid);
    if (!prev || cnt > prev.peak) {
      metrics.peakByRoom.set(rid, { peak: cnt, at: Date.now() });
    }
  }
}

// ---- msgs/min rolling 60s ----
function rotateMsgWindowIfNeeded(nowSec) {
  let cur = metrics.msgWindowSec;
  if (nowSec <= cur) return;
  const diff = Math.min(60, nowSec - cur);
  for (let i = 0; i < diff; i++) {
    const idx = (cur + 1 + i) % 60;
    metrics.msgWindow[idx] = 0;
  }
  metrics.msgWindowSec = nowSec;
}
function getMsgsPerMinNow() {
  const nowSec = Math.floor(Date.now() / 1000);
  rotateMsgWindowIfNeeded(nowSec);
  return metrics.msgWindow.reduce((a, b) => a + b, 0);
}
function bumpMsgCounter() {
  const nowSec = Math.floor(Date.now() / 1000);
  rotateMsgWindowIfNeeded(nowSec);
  const idx = nowSec % 60;
  metrics.msgWindow[idx] += 1;

  const nowMpm = getMsgsPerMinNow();
  if (nowMpm > metrics.peakMsgsPerMin) {
    metrics.peakMsgsPerMin = nowMpm;
    metrics.peakMsgsPerMinAt = Date.now();
  }
}

// ---- sessões ----
function getAvgSessionNowMs() {
  if (users.size === 0) return 0;
  const now = Date.now();
  let total = 0, count = 0;
  for (const [, u] of users.entries()) {
    if (!u.connectedAt) continue;
    total += Math.max(0, now - u.connectedAt);
    count++;
  }
  return count ? Math.round(total / count) : 0;
}
function getAvgSessionAllMs() {
  const now = Date.now();
  let total = metrics.sessionsClosedTotalMs;
  let count = metrics.sessionsClosedCount;

  for (const [, u] of users.entries()) {
    if (!u.connectedAt) continue;
    total += Math.max(0, now - u.connectedAt);
    count++;
  }
  return count ? Math.round(total / count) : 0;
}

function sanitizeNick(nick) {
  nick = String(nick || "").trim().replace(/\s+/g, " ");
  if (nick.length < 2) return null;
  if (nick.length > 18) nick = nick.slice(0, 18);
  return nick;
}

function roomSnapshot(roomId) {
  return {
    room: rooms.get(roomId),
    messages: messages.get(roomId) || []
  };
}

// ===================================================================
// BAN / MODERAÇÃO (RAM)
// ===================================================================
const bansByIp = new Map(); // ip -> { until|null, reason }

function getIp(reqOrSocket) {
  const xff = reqOrSocket?.headers?.["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const ip =
    (raw ? String(raw).split(",")[0].trim() : "") ||
    reqOrSocket?.ip ||
    reqOrSocket?.handshake?.address ||
    "";
  return ip || "unknown";
}

function isBannedIp(ip) {
  const b = bansByIp.get(ip);
  if (!b) return null;
  if (b.until && Date.now() > b.until) {
    bansByIp.delete(ip);
    return null;
  }
  return b;
}

// ===================================================================
// ADMIN AUTH
// ===================================================================
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const adminTokens = new Map(); // token -> { createdAt, expiresAt }

function requireAdmin(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const t = adminTokens.get(token);
  if (!t) return res.status(401).json({ ok: false, error: "Não autorizado" });
  if (t.expiresAt && Date.now() > t.expiresAt) {
    adminTokens.delete(token);
    return res.status(401).json({ ok: false, error: "Sessão expirada" });
  }
  next();
}

// ===================================================================
// HELPERS
// ===================================================================
function getRoomUsers(roomId) {
  const arr = [];
  for (const [sid, u] of users.entries()) {
    if (u.roomId === roomId) arr.push({ socketId: sid, nick: u.nick });
  }
  arr.sort((a, b) => a.nick.localeCompare(b.nick, "pt-BR"));
  return arr;
}
function emitUsers(roomId) {
  io.to(roomId).emit("users_list", { roomId, users: getRoomUsers(roomId) });
}

function dmIdFor(a, b) {
  const [x, y] = [a, b].sort();
  return `dm_${x}_${y}`;
}
function ensureDm(dmId) {
  if (!rooms.has(dmId)) rooms.set(dmId, { id: dmId, type: "dm", name: "Privado", createdAt: Date.now() });
  if (!messages.has(dmId)) messages.set(dmId, []);
}

function cleanupRoomIfEmpty(roomId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  const count = socketsInRoom ? socketsInRoom.size : 0;

  if (count === 0) {
    if (messages.has(roomId)) messages.set(roomId, []);
    const r = rooms.get(roomId);
    if (r && (r.type === "group" || r.type === "dm")) {
      rooms.delete(roomId);
      messages.delete(roomId);
      metrics.peakByRoom.delete(roomId);
    }
  }
}

function removeUserMessages(socketId, roomId) {
  const arr = messages.get(roomId) || [];
  if (!arr.length) return;

  const removed = arr.filter(m => m.userId === socketId).map(m => m.id);
  if (!removed.length) return;

  messages.set(roomId, arr.filter(m => m.userId !== socketId));
  io.to(roomId).emit("message_deleted", { ids: removed });
}

// ===================================================================
// API (JSON)
// ===================================================================
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/groups", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim() || "Grupo";
    const pass = String(req.body?.password || "");
    const nick = sanitizeNick(req.body?.nick);

    if (!nick) return res.status(400).json({ ok: false, error: "Apelido inválido (mín. 2 caracteres)." });
    if (pass.length < 3) return res.status(400).json({ ok: false, error: "Senha muito curta (mín. 3)." });

    const id = "g_" + nanoid(10);
    const passHash = await bcrypt.hash(pass, 10);

    rooms.set(id, { id, type: "group", name: name.slice(0, 32), passHash, createdAt: Date.now() });
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

// ----------------- ADMIN -----------------
app.post("/api/admin/login", (req, res) => {
  const pass = String(req.body?.password || "");
  if (!ADMIN_PASS) return res.status(500).json({ ok: false, error: "ADMIN_PASS não configurado no servidor." });
  if (pass !== ADMIN_PASS) return res.status(401).json({ ok: false, error: "Senha inválida." });

  const token = crypto.randomBytes(24).toString("hex");
  const createdAt = Date.now();
  const expiresAt = createdAt + 12 * 60 * 60 * 1000; // 12h
  adminTokens.set(token, { createdAt, expiresAt });

  res.json({ ok: true, token, expiresAt });
});

app.get("/api/admin/metrics", requireAdmin, (req, res) => {
  // online por sala
  const roomCounts = new Map();
  for (const [, u] of users.entries()) {
    roomCounts.set(u.roomId, (roomCounts.get(u.roomId) || 0) + 1);
  }

  const byRoom = [];
  for (const [rid, r] of rooms.entries()) {
    const onlineNow = roomCounts.get(rid) || 0;
    const peakObj = metrics.peakByRoom.get(rid) || { peak: 0, at: null };
    byRoom.push({
      id: rid,
      name: r.name,
      type: r.type,
      onlineNow,
      peakOnline: peakObj.peak || 0,
      peakOnlineAt: peakObj.at || null,
      createdAt: r.createdAt || null
    });
  }
  byRoom.sort((a, b) => (b.onlineNow - a.onlineNow) || a.name.localeCompare(b.name, "pt-BR"));

  // RAM
  const mem = process.memoryUsage();
  const ram = {
    rss: mem.rss || 0,
    heapUsed: mem.heapUsed || 0,
    heapTotal: mem.heapTotal || 0,
    external: mem.external || 0,
  };

  res.json({
    ok: true,
    bootAt: metrics.bootAt,
    uptimeSec: Math.floor(process.uptime()),

    // online/picos
    onlineNow: users.size,
    peakOnline: metrics.peakOnline,
    peakOnlineAt: metrics.peakOnlineAt,
    roomsTotal: rooms.size,
    groupsTotal: Array.from(rooms.values()).filter(x => x.type === "group").length,
    dmActive: Array.from(rooms.values()).filter(x => x.type === "dm").length,

    // sessões
    avgSessionNowMs: getAvgSessionNowMs(),
    avgSessionAllMs: getAvgSessionAllMs(),
    sessionsClosedCount: metrics.sessionsClosedCount,

    // msgs/min
    msgsPerMinNow: getMsgsPerMinNow(),
    peakMsgsPerMin: metrics.peakMsgsPerMin,
    peakMsgsPerMinAt: metrics.peakMsgsPerMinAt,

    // RAM
    ram,

    byRoom
  });
});

app.post("/api/admin/warn", requireAdmin, (req, res) => {
  const socketId = String(req.body?.socketId || "");
  const message = String(req.body?.message || "").trim().slice(0, 220);
  if (!socketId || !message) return res.status(400).json({ ok: false, error: "socketId e message são obrigatórios." });
  io.to(socketId).emit("admin_notice", { message });
  res.json({ ok: true });
});

app.post("/api/admin/kick", requireAdmin, (req, res) => {
  const socketId = String(req.body?.socketId || "");
  const message = String(req.body?.message || "Você foi removido pelo administrador.").trim().slice(0, 220);

  const s = io.sockets.sockets.get(socketId);
  if (!s) return res.status(404).json({ ok: false, error: "Usuário não encontrado." });

  io.to(socketId).emit("admin_kick", { message });
  setTimeout(() => { try { s.disconnect(true); } catch {} }, 120);
  res.json({ ok: true });
});

app.post("/api/admin/ban-ip", requireAdmin, (req, res) => {
  const socketId = String(req.body?.socketId || "");
  const minutes = Number(req.body?.minutes || 0);
  const reason = String(req.body?.reason || "Acesso bloqueado pelo administrador.").trim().slice(0, 220);

  const s = io.sockets.sockets.get(socketId);
  if (!s) return res.status(404).json({ ok: false, error: "Usuário não encontrado." });

  const ip = users.get(socketId)?.ip || getIp(s.request);
  const until = minutes > 0 ? (Date.now() + minutes * 60 * 1000) : null;
  bansByIp.set(ip, { until, reason });

  io.to(socketId).emit("admin_ban", { message: reason });
  setTimeout(() => { try { s.disconnect(true); } catch {} }, 120);

  res.json({ ok: true, ip, until });
});

// ✅ Se bater em /api e não existir rota, NUNCA devolve HTML:
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Rota da API não encontrada." }));

// ===================================================================
// FRONTEND (servir dist) + fallback CORRETO (não pega /api)
// ===================================================================
const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
const indexHtml = path.join(frontendDist, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(frontendDist));

  // ✅ Fallback do React (HashRouter) — MAS NÃO CAPTURA /api
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(indexHtml));
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

// ===================================================================
// SOCKET.IO
// ===================================================================
io.on("connection", (socket) => {
  // bloqueio por IP
  const ip = getIp(socket.request);
  const banned = isBannedIp(ip);
  if (banned) {
    socket.emit("admin_ban", { message: banned.reason || "Acesso bloqueado." });
    return socket.disconnect(true);
  }

  socket.on("join_public", ({ nick }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });

    ensureRoom("geral");
    users.set(socket.id, { nick, roomId: "geral", ip, connectedAt: Date.now() });
    socket.join("geral");

    updatePeaksOnline();
    socket.emit("room_snapshot", roomSnapshot("geral"));
    io.to("geral").emit("presence", { type: "join", nick });
    emitUsers("geral");
  });

  socket.on("join_group", async ({ roomId, nick, password }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });

    const r = rooms.get(roomId);
    if (!r || r.type !== "group") return socket.emit("error_toast", { message: "Grupo não existe (ou já expirou)." });

    const ok = await bcrypt.compare(String(password || ""), r.passHash);
    if (!ok) return socket.emit("error_toast", { message: "Senha incorreta." });

    users.set(socket.id, { nick, roomId, ip, connectedAt: Date.now() });
    socket.join(roomId);

    updatePeaksOnline();
    socket.emit("room_snapshot", roomSnapshot(roomId));
    io.to(roomId).emit("presence", { type: "join", nick });
    emitUsers(roomId);
  });

  // Mensagem sala (geral/grupo)
  socket.on("send_message", ({ type, content, roomId, replyTo }) => {
    const u = users.get(socket.id);
    if (!u) return;

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
      ts: Date.now(),
      reactions: {},
      replyTo: replyTo && replyTo.id ? {
        id: String(replyTo.id),
        nick: String(replyTo.nick || "").slice(0, 18),
        preview: String(replyTo.preview || "").slice(0, 140),
        type: String(replyTo.type || "text")
      } : null,
    };

    const arr = messages.get(rid) || [];
    arr.push(msg);
    while (arr.length > 250) arr.shift();
    messages.set(rid, arr);

    bumpMsgCounter();
    io.to(rid).emit("new_message", msg);
  });

  socket.on("react_message", ({ roomId, messageId, emoji }) => {
    const u = users.get(socket.id);
    if (!u) return;

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

  // DM
  socket.on("start_dm", ({ peerSocketId }) => {
    const me = users.get(socket.id);
    if (!me) return;

    const peer = users.get(peerSocketId);
    if (!peer) return socket.emit("error_toast", { message: "Usuário não está mais online." });

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

    const r = rooms.get(dmId);
    if (!r || r.type !== "dm") return;

    const t = String(type || "text");
    const allowed = new Set(["text", "image", "audio"]);
    if (!allowed.has(t)) return;

    const c = String(content || "");
    if (!c) return;

    const msg = {
      id: "m_" + nanoid(10),
      roomId: dmId,
      userId: socket.id,
      nick: me.nick,
      type: t,
      content: c,
      ts: Date.now(),
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

    bumpMsgCounter();
    io.to(dmId).emit("dm_new_message", { dmId, message: msg });
  });

  socket.on("react_dm", ({ dmId, messageId, emoji }) => {
    const r = rooms.get(dmId);
    if (!r || r.type !== "dm") return;

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

    // sessões encerradas
    if (u.connectedAt) {
      const dur = Math.max(0, Date.now() - u.connectedAt);
      metrics.sessionsClosedCount += 1;
      metrics.sessionsClosedTotalMs += dur;
    }

    const { nick, roomId } = u;
    users.delete(socket.id);

    removeUserMessages(socket.id, roomId);
    io.to(roomId).emit("presence", { type: "leave", nick });
    emitUsers(roomId);

    setTimeout(() => cleanupRoomIfEmpty(roomId), 50);

    // limpa DMs órfãos
    for (const [rid, info] of rooms.entries()) {
      if (info?.type === "dm") setTimeout(() => cleanupRoomIfEmpty(rid), 80);
    }
  });
});

// ===================================================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server on port", PORT));

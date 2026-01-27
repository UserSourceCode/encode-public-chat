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

const ORIGIN = process.env.ORIGIN || true;
const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 6 * 1024 * 1024
});

// ======================================================
// MEMÓRIA (NÃO PERSISTE)
// ======================================================
const rooms = new Map();    // roomId -> { id,type,name,passHash?,createdAt }
const users = new Map();    // socketId -> { nick,roomId,ip,connectedAt }
const messages = new Map(); // roomId -> Array<Message>

// ======================================================
// FLAGS / CONTROLES (ADMIN) — em RAM
// ======================================================
const flags = {
  groupCreationEnabled: true,
  frozenRooms: new Set(), // roomIds congelados (inclui "geral" se quiser)
};

// ======================================================
// MÉTRICAS (OBSERVABILIDADE) — em RAM
// ======================================================
const metrics = {
  bootAt: Date.now(),

  // Online
  peakOnline: 0,
  peakOnlineAt: null,
  peakByRoom: new Map(), // roomId -> { peak, at }

  // Sessões
  sessionsClosedCount: 0,
  sessionsClosedTotalMs: 0,

  // Mensagens por minuto (rolling 60s)
  msgWindow: new Array(60).fill(0),
  msgWindowSec: Math.floor(Date.now() / 1000),
  peakMsgsPerMin: 0,
  peakMsgsPerMinAt: null,

  // Online (histórico 60s)
  onlineWindow: new Array(60).fill(0),
  onlineWindowSec: Math.floor(Date.now() / 1000),
  peakOnlineLast60: 0,
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

// ---------------- Online peaks ----------------
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

// ---------------- msgs/min rolling 60s ----------------
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

// ---------------- online rolling 60s ----------------
function rotateOnlineWindowIfNeeded(nowSec) {
  let cur = metrics.onlineWindowSec;
  if (nowSec <= cur) return;
  const diff = Math.min(60, nowSec - cur);
  for (let i = 0; i < diff; i++) {
    const idx = (cur + 1 + i) % 60;
    metrics.onlineWindow[idx] = 0;
  }
  metrics.onlineWindowSec = nowSec;
}
function sampleOnline() {
  const nowSec = Math.floor(Date.now() / 1000);
  rotateOnlineWindowIfNeeded(nowSec);
  const idx = nowSec % 60;
  metrics.onlineWindow[idx] = users.size;

  const peak = Math.max(...metrics.onlineWindow);
  metrics.peakOnlineLast60 = peak;
}

// amostragem contínua (não pesa)
setInterval(sampleOnline, 1000);

// ---------------- sessões ----------------
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
  return { room: rooms.get(roomId), messages: messages.get(roomId) || [] };
}

function isRoomFrozen(roomId) {
  return flags.frozenRooms.has(roomId);
}

// ======================================================
// BAN / MODERAÇÃO (RAM)
// ======================================================
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

// ======================================================
// ADMIN AUTH
// ======================================================
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

// ======================================================
// HELPERS
// ======================================================
function getRoomUsers(roomId) {
  const arr = [];
  for (const [sid, u] of users.entries()) {
    if (u.roomId === roomId) arr.push({
      socketId: sid,
      nick: u.nick,
      connectedAt: u.connectedAt,
      ip: u.ip,
    });
  }
  arr.sort((a, b) => a.nick.localeCompare(b.nick, "pt-BR"));
  return arr;
}

function emitUsers(roomId) {
  io.to(roomId).emit("users_list", {
    roomId,
    users: getRoomUsers(roomId).map(x => ({ socketId: x.socketId, nick: x.nick }))
  });
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
    // sempre limpa mensagens quando fica vazio
    if (messages.has(roomId)) messages.set(roomId, []);

    // remove grupos/dm totalmente
    const r = rooms.get(roomId);
    if (r && (r.type === "group" || r.type === "dm")) {
      rooms.delete(roomId);
      messages.delete(roomId);
      metrics.peakByRoom.delete(roomId);
      flags.frozenRooms.delete(roomId);
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

function buildSeriesFromCircular(windowArr, currentSec) {
  // retorna em ordem cronológica (60 pontos)
  const out = [];
  for (let i = 59; i >= 0; i--) {
    const sec = currentSec - i;
    out.push(windowArr[sec % 60] || 0);
  }
  return out;
}

// ======================================================
// API (JSON)
// ======================================================
app.get("/api/health", (req, res) => res.json({ ok: true }));

// criar grupo privado
app.post("/api/groups", async (req, res) => {
  try {
    if (!flags.groupCreationEnabled) {
      return res.status(403).json({ ok: false, error: "Criação de grupos está temporariamente bloqueada." });
    }

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

// ======================================================
// ADMIN API
// ======================================================
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

// métricas agregadas + séries para gráficos
app.get("/api/admin/metrics", requireAdmin, (req, res) => {
  const roomCounts = new Map();
  for (const [, u] of users.entries()) {
    roomCounts.set(u.roomId, (roomCounts.get(u.roomId) || 0) + 1);
  }

  const byRoom = [];
  for (const [rid, r] of rooms.entries()) {
    const onlineNow = roomCounts.get(rid) || 0;
    const peakObj = metrics.peakByRoom.get(rid) || { peak: 0, at: null };
    const lastMsg = (messages.get(rid) || []).at?.(-1) || null;
    byRoom.push({
      id: rid,
      name: r.name,
      type: r.type,
      onlineNow,
      peakOnline: peakObj.peak || 0,
      peakOnlineAt: peakObj.at || null,
      createdAt: r.createdAt || null,
      frozen: isRoomFrozen(rid),
      lastActivityAt: lastMsg?.ts || null,
      messagesCount: (messages.get(rid) || []).length
    });
  }
  byRoom.sort((a, b) => (b.onlineNow - a.onlineNow) || a.name.localeCompare(b.name, "pt-BR"));

  const mem = process.memoryUsage();
  const ram = {
    rss: mem.rss || 0,
    heapUsed: mem.heapUsed || 0,
    heapTotal: mem.heapTotal || 0,
    external: mem.external || 0,
  };

  const nowSec = Math.floor(Date.now() / 1000);
  rotateMsgWindowIfNeeded(nowSec);
  rotateOnlineWindowIfNeeded(nowSec);

  res.json({
    ok: true,
    bootAt: metrics.bootAt,
    uptimeSec: Math.floor(process.uptime()),

    // flags
    flags: {
      groupCreationEnabled: flags.groupCreationEnabled,
      generalFrozen: isRoomFrozen("geral"),
    },

    // online/picos
    onlineNow: users.size,
    peakOnline: metrics.peakOnline,
    peakOnlineAt: metrics.peakOnlineAt,
    peakOnlineLast60: metrics.peakOnlineLast60,
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

    // séries (60 pontos)
    series: {
      onlineLast60: buildSeriesFromCircular(metrics.onlineWindow, nowSec),
      msgsLast60: buildSeriesFromCircular(metrics.msgWindow, nowSec),
    },

    // RAM
    ram,

    byRoom
  });
});

// detalhes de uma sala (clicar na tabela)
app.get("/api/admin/room/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const r = rooms.get(id);
  if (!r) return res.status(404).json({ ok: false, error: "Sala não encontrada." });

  const listUsers = getRoomUsers(id);
  const arrMsgs = messages.get(id) || [];
  const lastMsg = arrMsgs.length ? arrMsgs[arrMsgs.length - 1] : null;

  res.json({
    ok: true,
    room: {
      id: r.id,
      type: r.type,
      name: r.name,
      createdAt: r.createdAt || null,
      frozen: isRoomFrozen(id),
      activeForMs: r.createdAt ? (Date.now() - r.createdAt) : null,
      onlineNow: listUsers.length,
      users: listUsers.map(u => ({ socketId: u.socketId, nick: u.nick, connectedAt: u.connectedAt })),
      messagesCount: arrMsgs.length,
      lastActivityAt: lastMsg?.ts || null,
      peak: metrics.peakByRoom.get(id) || { peak: 0, at: null }
    }
  });
});

// flags gerais
app.post("/api/admin/flags", requireAdmin, (req, res) => {
  const groupCreationEnabled = req.body?.groupCreationEnabled;
  const generalFrozen = req.body?.generalFrozen;

  if (typeof groupCreationEnabled === "boolean") flags.groupCreationEnabled = groupCreationEnabled;
  if (typeof generalFrozen === "boolean") {
    if (generalFrozen) flags.frozenRooms.add("geral");
    else flags.frozenRooms.delete("geral");
  }
  res.json({ ok: true, flags: { groupCreationEnabled: flags.groupCreationEnabled, generalFrozen: isRoomFrozen("geral") } });
});

// congelar/descongelar sala específica
app.post("/api/admin/room/:id/freeze", requireAdmin, (req, res) => {
  const id = req.params.id;
  const r = rooms.get(id);
  if (!r) return res.status(404).json({ ok: false, error: "Sala não encontrada." });

  const freeze = Boolean(req.body?.freeze);
  if (freeze) flags.frozenRooms.add(id);
  else flags.frozenRooms.delete(id);

  io.to(id).emit("room_frozen", { roomId: id, frozen: isRoomFrozen(id) });
  res.json({ ok: true, roomId: id, frozen: isRoomFrozen(id) });
});

// excluir grupo (desconecta usuários do grupo e remove tudo)
app.delete("/api/admin/room/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const r = rooms.get(id);
  if (!r) return res.status(404).json({ ok: false, error: "Sala não encontrada." });

  if (r.type !== "group") return res.status(400).json({ ok: false, error: "Só é permitido excluir grupos." });

  try {
    const sockets = await io.in(id).fetchSockets();
    for (const s of sockets) {
      s.emit("admin_kick", { message: "Grupo encerrado pelo administrador." });
      try { s.disconnect(true); } catch {}
    }
  } catch {}

  rooms.delete(id);
  messages.delete(id);
  metrics.peakByRoom.delete(id);
  flags.frozenRooms.delete(id);

  res.json({ ok: true });
});

// moderação: aviso/kick/ban
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

// Se bater em /api e não existir rota, NUNCA devolve HTML:
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "Rota da API não encontrada." }));

// ======================================================
// FRONTEND (dist) + fallback CORRETO (não pega /api)
// ======================================================
const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
const indexHtml = path.join(frontendDist, "index.html");

if (fs.existsSync(indexHtml)) {
  app.use(express.static(frontendDist));
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

// ======================================================
// SOCKET.IO
// ======================================================
io.on("connection", (socket) => {
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
    socket.emit("room_frozen", { roomId: "geral", frozen: isRoomFrozen("geral") });
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
    socket.emit("room_frozen", { roomId, frozen: isRoomFrozen(roomId) });
    io.to(roomId).emit("presence", { type: "join", nick });
    emitUsers(roomId);
  });

  socket.on("send_message", ({ type, content, roomId, replyTo }) => {
    const u = users.get(socket.id);
    if (!u) return;

    const rid = u.roomId;
    if (roomId && roomId !== rid) return;

    if (isRoomFrozen(rid)) {
      return socket.emit("error_toast", { message: "Esta sala está congelada pelo administrador." });
    }

    const t = String(type || "text");
    const allowed = new Set(["text", "image", "audio"]);
    if (!allowed.has(t)) return;

    const c = String(content || "");
    if (!c) return;

        if (t === "text" && c.length > 2000) {
      return socket.emit("error_toast", { message: "Texto muito grande (máx 2000 caracteres)." });
    }
    if (t !== "text" && c.length > 5_500_000) {
      return socket.emit("error_toast", { message: "Arquivo muito grande." });
    }

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

    emoji = String(emoji || "").trim().slice(0, 8);
    if (!emoji) return;

    const arr = messages.get(rid) || [];
    const m = arr.find(x => x.id === messageId);
    if (!m) return;

    // toggle simples: se o usuário reagir no mesmo emoji de novo, remove 1
    // (não guardamos quem reagiu para simplificar sem persistência; então é só contador)
    m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;

    io.to(rid).emit("message_reacted", { messageId: m.id, reactions: m.reactions });
  });

  // ======================================================
  // DM (mensagem privada) — ainda sem persistência
  // ======================================================
  socket.on("start_dm", ({ peerSocketId }) => {
    const me = users.get(socket.id);
    if (!me) return;

    const peer = users.get(peerSocketId);
    if (!peer) return socket.emit("error_toast", { message: "Usuário não está mais online." });

    // DM só entre pessoas na mesma sala atual
    if (peer.roomId !== me.roomId) {
      return socket.emit("error_toast", { message: "Usuário não está nessa mesma sala." });
    }

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

    // opcional: congelar DM? (não fazemos por padrão)
    // if (isRoomFrozen(dmId)) return socket.emit("error_toast", { message: "Este privado está congelado." });

    const t = String(type || "text");
    const allowed = new Set(["text", "image", "audio"]);
    if (!allowed.has(t)) return;

    const c = String(content || "");
    if (!c) return;

    if (t === "text" && c.length > 2000) {
      return socket.emit("error_toast", { message: "Texto muito grande (máx 2000)." });
    }
    if (t !== "text" && c.length > 5_500_000) {
      return socket.emit("error_toast", { message: "Arquivo muito grande." });
    }

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

    emoji = String(emoji || "").trim().slice(0, 8);
    if (!emoji) return;

    const arr = messages.get(dmId) || [];
    const m = arr.find(x => x.id === messageId);
    if (!m) return;

    m.reactions[emoji] = (m.reactions[emoji] || 0) + 1;
    io.to(dmId).emit("dm_reacted", { dmId, messageId: m.id, reactions: m.reactions });
  });

  // ======================================================
  // DISCONNECT
  // ======================================================
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

    // remove mensagens do usuário do chat público/grupo
    removeUserMessages(socket.id, roomId);

    io.to(roomId).emit("presence", { type: "leave", nick });
    emitUsers(roomId);

    updatePeaksOnline();

    // limpa salas vazias
    setTimeout(() => cleanupRoomIfEmpty(roomId), 60);

    // limpa DMs órfãs
    for (const [rid, info] of rooms.entries()) {
      if (info?.type === "dm") setTimeout(() => cleanupRoomIfEmpty(rid), 120);
    }
  });
});

// ======================================================
// START
// ======================================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server on port", PORT));


// backend/src/server.js
import express from "express";
import helmet from "helmet";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

// CORS (Render: deixe ORIGIN vazio; Local com Vite: ORIGIN=http://localhost:5173)
const ORIGIN = process.env.ORIGIN || true;

const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN },
  maxHttpBufferSize: 6 * 1024 * 1024 // 6MB para base64 no socket
});

/**
 * rooms:
 *  - "geral" sempre existe
 *  - grupos: "g_xxxxx"
 *  - dm: "dm_socketA_socketB"
 * users:
 *  - socketId -> { nick, roomId }
 * messages:
 *  - roomId -> Array<Message>
 */
const rooms = new Map();
const users = new Map();
const messages = new Map();

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
  if (arr.length === 0) return;

  const removedIds = arr.filter(m => m.userId === socketId).map(m => m.id);
  if (removedIds.length === 0) return;

  const kept = arr.filter(m => m.userId !== socketId);
  messages.set(roomId, kept);

  io.to(roomId).emit("message_deleted", { ids: removedIds });
}

function cleanupRoomIfEmpty(roomId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
  const count = socketsInRoom ? socketsInRoom.size : 0;

  if (count === 0) {
    // sempre limpa mensagens
    messages.set(roomId, []);

    // remove grupo privado por completo
    const r = rooms.get(roomId);
    if (r && r.type === "group") {
      rooms.delete(roomId);
      messages.delete(roomId);
    }
  }
}

// ---- ONLINE LIST ----
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

// ---- DM HELPERS ----
function dmIdFor(a, b) {
  const [x, y] = [a, b].sort();
  return `dm_${x}_${y}`;
}
function ensureDm(dmId) {
  if (!rooms.has(dmId)) {
    rooms.set(dmId, { id: dmId, type: "dm", name: "Privado", createdAt: Date.now() });
  }
  if (!messages.has(dmId)) messages.set(dmId, []);
}
function cleanupDmIfEmpty(dmId) {
  const socketsInRoom = io.sockets.adapter.rooms.get(dmId);
  const count = socketsInRoom ? socketsInRoom.size : 0;
  if (count === 0) {
    rooms.delete(dmId);
    messages.delete(dmId);
  }
}

// ---------------- API ----------------
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

// -------- SERVIR FRONTEND BUILD ----------
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

// ---------------- SOCKET.IO ----------------
io.on("connection", (socket) => {
  socket.on("join_public", ({ nick }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });

    ensureRoom("geral");
    users.set(socket.id, { nick, roomId: "geral" });

    socket.join("geral");
    socket.emit("room_snapshot", roomSnapshot("geral"));
    io.to("geral").emit("presence", { type: "join", nick });
    emitUsers("geral");
  });

  socket.on("join_group", async ({ roomId, nick, password }) => {
    nick = sanitizeNick(nick);
    if (!nick) return socket.emit("error_toast", { message: "Apelido inválido." });

    const r = rooms.get(roomId);
    if (!r || r.type !== "group") {
      return socket.emit("error_toast", { message: "Grupo não existe (ou já expirou)." });
    }

    const ok = await bcrypt.compare(String(password || ""), r.passHash);
    if (!ok) return socket.emit("error_toast", { message: "Senha incorreta." });

    users.set(socket.id, { nick, roomId });
    socket.join(roomId);

    socket.emit("room_snapshot", roomSnapshot(roomId));
    io.to(roomId).emit("presence", { type: "join", nick });
    emitUsers(roomId);
  });

  // --------- mensagens de sala (geral/grupo) ---------
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

    if (t === "text" && c.length > 2000) {
      return socket.emit("error_toast", { message: "Texto muito grande (máx 2000)." });
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

  // --------- DM (privado) ---------
  socket.on("start_dm", ({ peerSocketId }) => {
    const me = users.get(socket.id);
    if (!me) return;

    const peer = users.get(peerSocketId);
    if (!peer) return socket.emit("error_toast", { message: "Usuário não está mais online." });

    // só permite DM com alguém na mesma sala atual
    if (peer.roomId !== me.roomId) {
      return socket.emit("error_toast", { message: "Usuário não está nessa sala." });
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

    const { nick, roomId } = u;
    users.delete(socket.id);

    // remove mensagens do usuário na sala (geral/grupo)
    removeUserMessages(socket.id, roomId);

    io.to(roomId).emit("presence", { type: "leave", nick });
    emitUsers(roomId);

    setTimeout(() => cleanupRoomIfEmpty(roomId), 50);

    // limpa DMs que ficaram vazios
    setTimeout(() => {
      for (const [rid, info] of rooms.entries()) {
        if (info?.type === "dm") cleanupDmIfEmpty(rid);
      }
    }, 100);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server on port", PORT);
  console.log("Frontend dist:", frontendDist);
});

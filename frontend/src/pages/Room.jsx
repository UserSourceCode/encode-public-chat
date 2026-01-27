import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import Toast from "../ui/Toast.jsx";
import Modal from "../ui/Modal.jsx";

function useQuery(){
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function fmtHhmm(ts){
  try{
    return new Date(ts).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
  }catch{
    return "";
  }
}

function safeNick(n){
  const s = String(n || "").trim().replace(/\s+/g, " ");
  if(s.length < 2) return "";
  return s.slice(0, 18);
}

function shortText(s, max=90){
  const t = String(s || "");
  if(t.length <= max) return t;
  return t.slice(0, max-1) + "…";
}

const QUICK_REACTIONS = ["👍","❤️","😂","😮","😡","👏","🔥","✅"];

export default function Room(){
  const nav = useNavigate();
  const params = useParams();
  const q = useQuery();
  const location = useLocation();

  // rota: /geral  ou /g/:id
  const isGeneral = location.pathname.includes("/geral");
  const roomId = isGeneral ? "geral" : (params.id || "");

  // query
  const nickFromUrl = safeNick(q.get("nick"));
  const passFromUrl = q.get("pass") || "";

  const [toast, setToast] = useState("");
  const [banner, setBanner] = useState(""); // aviso persistente do admin
  const [room, setRoom] = useState(null);
  const [frozen, setFrozen] = useState(false);

  const [users, setUsers] = useState([]); // [{socketId,nick}]
  const [msgs, setMsgs] = useState([]);

  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState(null); // {id,userNick,preview}
  const [showReactionsFor, setShowReactionsFor] = useState(null); // msgId
  const [sending, setSending] = useState(false);

  const [openDm, setOpenDm] = useState(false);
  const [dmTarget, setDmTarget] = useState(null); // {socketId,nick}
  const [dmText, setDmText] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const recRef = useRef(null);
  const recChunksRef = useRef([]);
  const fileInputRef = useRef(null);

  const socketRef = useRef(null);
  const listRef = useRef(null);

  const myNick = nickFromUrl;

  const canEnter = useMemo(()=>{
    if(!myNick) return false;
    if(isGeneral) return true;
    return !!roomId && !!passFromUrl; // grupo precisa pass
  }, [myNick, isGeneral, roomId, passFromUrl]);

  // scroll to bottom
  function scrollBottom(){
    const el = listRef.current;
    if(!el) return;
    el.scrollTop = el.scrollHeight;
  }

  // fallback (se abrir rota sem parâmetros)
  useEffect(()=>{
    if(!myNick){
      setToast("Informe um apelido para entrar.");
      nav("/", { replace:true });
      return;
    }
    if(!isGeneral){
      if(!roomId){
        setToast("Grupo inválido.");
        nav("/", { replace:true });
        return;
      }
      if(!passFromUrl){
        setToast("Informe a senha do grupo.");
        nav("/", { replace:true });
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // conexão socket
  useEffect(()=>{
    if(!canEnter) return;

    const s = io("/", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 700,
      timeout: 15000,
    });

    socketRef.current = s;

    s.on("connect", () => {
      setToast("");
      if(isGeneral){
        s.emit("join_public", { nick: myNick });
      }else{
        s.emit("join_group", { roomId, nick: myNick, password: passFromUrl });
      }
    });

    s.on("disconnect", () => {
      // só sinaliza, não expulsa
    });

    // snapshot inicial
    s.on("room_snapshot", (payload) => {
      setRoom(payload?.room || null);
      setMsgs(Array.isArray(payload?.messages) ? payload.messages : []);
      setTimeout(scrollBottom, 60);
    });

    s.on("room_frozen", ({ frozen }) => {
      setFrozen(!!frozen);
      if(frozen){
        setToast("Sala congelada pelo administrador.");
      }
    });

    // lista de usuários
    s.on("users_list", (p) => {
      const arr = Array.isArray(p?.users) ? p.users : [];
      setUsers(arr);
    });

    // presença
    s.on("presence", (p) => {
      if(!p?.nick) return;
      if(p.type === "join") setToast(`${p.nick} entrou.`);
      if(p.type === "leave") setToast(`${p.nick} saiu.`);
    });

    // novas mensagens
    s.on("message_new", ({ message }) => {
      if(!message) return;
      setMsgs(prev => [...prev, message]);
      setTimeout(scrollBottom, 30);
    });

    // deletadas (ex: ao sair / moderação)
    s.on("message_deleted", ({ ids }) => {
      const setIds = new Set(ids || []);
      if(setIds.size === 0) return;
      setMsgs(prev => prev.filter(m => !setIds.has(m.id)));
    });

    // reação (se backend emitir)
    s.on("message_reaction", ({ id, reactions }) => {
      if(!id) return;
      setMsgs(prev => prev.map(m => (m.id === id ? { ...m, reactions } : m)));
    });

    // avisos do admin
    s.on("admin_notice", ({ message }) => {
      const msg = String(message || "").trim();
      if(!msg) return;
      setBanner(msg);
      setToast("Aviso do administrador recebido.");
    });

    s.on("admin_kick", ({ message }) => {
      setToast(message || "Você foi removido pelo administrador.");
      setTimeout(()=>nav("/", { replace:true }), 800);
    });

    s.on("admin_ban", ({ message }) => {
      setToast(message || "Acesso bloqueado pelo administrador.");
      setTimeout(()=>nav("/", { replace:true }), 900);
    });

    s.on("error_toast", ({ message }) => {
      if(message) setToast(message);
    });

    return () => {
      try{ s.disconnect(); }catch{}
      socketRef.current = null;
    };
  }, [canEnter, isGeneral, myNick, nav, passFromUrl, roomId]);

  // envia texto
  async function sendText(e){
    e?.preventDefault?.();
    if(sending) return;
    const s = socketRef.current;
    if(!s) return;

    const content = String(text || "").trim();
    if(!content) return;

    setSending(true);
    try{
      s.emit("send_message", {
        type: "text",
        content,
        roomId: room?.id || roomId,
        replyTo: replyTo ? { id: replyTo.id, userNick: replyTo.userNick, preview: replyTo.preview } : null
      });
      setText("");
      setReplyTo(null);
      setShowReactionsFor(null);
    } finally {
      setSending(false);
    }
  }

  // upload imagem
  async function onPickImage(ev){
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if(!file) return;

    if(file.size > 4.5 * 1024 * 1024){
      setToast("Imagem muito grande (máx ~4.5MB).");
      return;
    }

    const s = socketRef.current;
    if(!s) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result || "");
      s.emit("send_message", {
        type: "image",
        content: base64,
        roomId: room?.id || roomId,
        replyTo: replyTo ? { id: replyTo.id, userNick: replyTo.userNick, preview: replyTo.preview } : null
      });
      setReplyTo(null);
      setShowReactionsFor(null);
    };
    reader.readAsDataURL(file);
  }

  // grava áudio
  async function toggleRecord(){
    const s = socketRef.current;
    if(!s) return;

    if(isRecording){
      try{
        recRef.current?.stop?.();
      }catch{}
      return;
    }

    if(!navigator.mediaDevices?.getUserMedia){
      setToast("Seu navegador não suporta gravação de áudio.");
      return;
    }

    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      recRef.current = rec;
      recChunksRef.current = [];

      rec.ondataavailable = (e) => {
        if(e.data?.size) recChunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        setIsRecording(false);
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(recChunksRef.current, { type: "audio/webm" });
        recChunksRef.current = [];

        if(blob.size > 4.5 * 1024 * 1024){
          setToast("Áudio muito grande (máx ~4.5MB).");
          return;
        }

        // converte para base64
        const fr = new FileReader();
        fr.onload = () => {
          const base64 = String(fr.result || "");
          s.emit("send_message", {
            type: "audio",
            content: base64,
            roomId: room?.id || roomId,
            replyTo: replyTo ? { id: replyTo.id, userNick: replyTo.userNick, preview: replyTo.preview } : null
          });
          setReplyTo(null);
          setShowReactionsFor(null);
        };
        fr.readAsDataURL(blob);
      };

      rec.start();
      setIsRecording(true);
      setToast("Gravando… clique novamente para enviar.");
    }catch{
      setToast("Permissão de microfone negada.");
    }
  }

  // reply
  function setReply(m){
    setReplyTo({
      id: m.id,
      userNick: m.nick || "—",
      preview: m.type === "text" ? shortText(m.content, 120) : (m.type === "image" ? "📷 Imagem" : "🎤 Áudio")
    });
    setTimeout(()=>document.getElementById("msgInput")?.focus?.(), 30);
  }

  // reactions
  function openReactions(m){
    setShowReactionsFor(prev => (prev === m.id ? null : m.id));
  }
  function react(m, emoji){
    const s = socketRef.current;
    if(!s) return;
    setShowReactionsFor(null);

    // tenta emitir; se backend não tiver, não quebra
    try{
      s.emit("react_message", { roomId: room?.id || roomId, messageId: m.id, emoji });
    }catch{}
  }

  // dm modal
  function openDmTo(u){
    setDmTarget(u);
    setDmText("");
    setOpenDm(true);
  }
  function sendDm(e){
    e?.preventDefault?.();
    const s = socketRef.current;
    if(!s) return;

    const msg = String(dmText || "").trim();
    if(!msg) return;

    // tenta enviar dm; se backend não suportar, avisa
    try{
      s.emit("send_dm", { to: dmTarget?.socketId, content: msg });
      setToast(`Mensagem privada enviada para ${dmTarget?.nick}.`);
      setOpenDm(false);
    }catch{
      setToast("DM ainda não está habilitado no servidor.");
    }
  }

  // resolve nick do autor e reactions (se existir)
  const title = room?.name || (isGeneral ? "Geral" : "Grupo");
  const subtitle = isGeneral ? "Sala pública" : `Grupo: ${roomId}`;

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      {/* Topbar do chat */}
      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">{title}</div>
            <div className="brand-sub">{subtitle} • Online: {users.length}</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="btn" onClick={()=>nav("/")} title="Voltar">Voltar</button>
          <button className="btn" onClick={()=>nav("/area-reservada")} title="Admin">Área Reservada</button>
        </div>
      </header>

      <main style={{ width: "min(1100px, 100%)", margin: "0 auto", padding: "14px 14px 26px" }}>
        {/* aviso do admin */}
        {banner && (
          <div className="admin-card" style={{ marginBottom: 14 }}>
            <h2>Aviso do administrador</h2>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>{banner}</div>
            <div style={{ marginTop: 12, display:"flex", justifyContent:"flex-end" }}>
              <button className="btn" onClick={()=>setBanner("")}>Fechar aviso</button>
            </div>
          </div>
        )}

        {/* status sala */}
        {(frozen) && (
          <div className="admin-card" style={{ marginBottom: 14 }}>
            <h2>⚠️ Sala congelada</h2>
            <div className="muted">O administrador congelou esta sala. Envio de mensagens está bloqueado.</div>
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"1fr 320px", gap: 14 }}>
          {/* mensagens */}
          <div className="admin-card full" style={{ gridColumn:"auto", padding: 0 }}>
            <div style={{
              padding: "12px 14px",
              borderBottom: "1px solid rgba(255,255,255,.10)",
              background: "rgba(0,0,0,.18)",
              display:"flex",
              alignItems:"center",
              justifyContent:"space-between",
              gap: 10
            }}>
              <div style={{ fontWeight: 1000 }}>Mensagens</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Dica: duplo clique na mensagem para reagir • clique em “Responder”
              </div>
            </div>

            <div
              ref={listRef}
              style={{
                padding: 14,
                height: "min(62vh, 620px)",
                overflow: "auto"
              }}
            >
              {msgs.length === 0 && (
                <div className="muted">Ainda não há mensagens nesta sala.</div>
              )}

              {msgs.map((m) => (
                <div
                  key={m.id}
                  className="control"
                  style={{ marginBottom: 10, alignItems:"stretch", cursor:"default" }}
                  onDoubleClick={()=>openReactions(m)}
                  onMouseDown={()=>{ /* fecha barra ao clicar fora */
                    if(showReactionsFor && showReactionsFor !== m.id) setShowReactionsFor(null);
                  }}
                >
                  <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap: 8, flexWrap:"wrap" }}>
                        <span style={{ fontWeight: 1000 }}>{m.nick || "—"}</span>
                        <span className="badge mono" style={{ fontSize: 11, padding:"4px 8px" }}>{fmtHhmm(m.ts || Date.now())}</span>
                        {m.userId === socketRef.current?.id && (
                          <span className="badge" style={{ fontSize: 11, padding:"4px 8px" }}>Você</span>
                        )}
                      </div>

                      {/* reply preview */}
                      {m.replyTo?.id && (
                        <div style={{
                          marginTop: 8,
                          padding: "10px 10px",
                          borderRadius: 14,
                          border: "1px solid rgba(255,255,255,.08)",
                          background: "rgba(0,0,0,.18)"
                        }}>
                          <div className="muted" style={{ fontSize: 12 }}>
                            Respondendo a <b style={{ color:"var(--text)" }}>{m.replyTo.userNick || "—"}</b>
                          </div>
                          <div style={{ marginTop: 4, fontSize: 13 }}>
                            {shortText(m.replyTo.preview || "", 120)}
                          </div>
                        </div>
                      )}

                      {/* content */}
                      <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.45, wordBreak:"break-word" }}>
                        {m.type === "text" && <span>{m.content}</span>}
                        {m.type === "image" && (
                          <img
                            src={m.content}
                            alt="imagem"
                            style={{
                              maxWidth: "100%",
                              borderRadius: 14,
                              border: "1px solid rgba(255,255,255,.10)",
                              display:"block"
                            }}
                          />
                        )}
                        {m.type === "audio" && (
                          <audio controls src={m.content} style={{ width: "100%" }} />
                        )}
                      </div>

                      {/* reactions display */}
                      {m.reactions && typeof m.reactions === "object" && (
                        <div style={{ marginTop: 10, display:"flex", gap: 8, flexWrap:"wrap" }}>
                          {Object.entries(m.reactions).map(([emo, count]) => (
                            <span key={emo} className="badge" style={{ padding:"6px 10px" }}>
                              {emo} <b>{count}</b>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* quick reactions bar */}
                      {showReactionsFor === m.id && (
                        <div style={{ marginTop: 10, display:"flex", gap: 8, flexWrap:"wrap" }}>
                          {QUICK_REACTIONS.map((emo) => (
                            <button
                              key={emo}
                              type="button"
                              className="btn"
                              style={{ padding:"8px 10px", borderRadius: 999, fontWeight: 1000 }}
                              onClick={()=>react(m, emo)}
                              title={`Reagir com ${emo}`}
                            >
                              {emo}
                            </button>
                          ))}
                          <button
                            type="button"
                            className="btn"
                            style={{ padding:"8px 10px", borderRadius: 999 }}
                            onClick={()=>setShowReactionsFor(null)}
                          >
                            Fechar
                          </button>
                        </div>
                      )}
                    </div>

                    {/* actions */}
                    <div style={{ display:"flex", flexDirection:"column", gap: 8, alignItems:"flex-end" }}>
                      <button className="btn" type="button" onClick={()=>setReply(m)}>Responder</button>
                      {m.userId && m.userId !== socketRef.current?.id && (
                        <button
                          className="btn"
                          type="button"
                          onClick={()=>openDmTo({ socketId: m.userId, nick: m.nick || "Usuário" })}
                          title="Mensagem privada"
                        >
                          Privado
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* composer */}
            <div style={{
              padding: 14,
              borderTop: "1px solid rgba(255,255,255,.10)",
              background: "rgba(0,0,0,.16)"
            }}>
              {replyTo && (
                <div style={{
                  marginBottom: 10,
                  padding: "10px 10px",
                  borderRadius: 16,
                  border: "1px solid rgba(255,255,255,.10)",
                  background: "rgba(0,0,0,.18)",
                  display:"flex",
                  justifyContent:"space-between",
                  gap: 10,
                  alignItems:"center"
                }}>
                  <div style={{ minWidth:0 }}>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Respondendo a <b style={{ color:"var(--text)" }}>{replyTo.userNick}</b>
                    </div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>
                      {shortText(replyTo.preview, 140)}
                    </div>
                  </div>
                  <button className="btn" type="button" onClick={()=>setReplyTo(null)}>Cancelar</button>
                </div>
              )}

              <form onSubmit={sendText} style={{ display:"flex", gap: 10, alignItems:"center" }}>
                <input
                  id="msgInput"
                  className="home-input"
                  style={{ flex: 1 }}
                  value={text}
                  onChange={(e)=>setText(e.target.value)}
                  placeholder={frozen ? "Sala congelada pelo administrador." : "Digite sua mensagem…"}
                  disabled={frozen}
                  maxLength={1200}
                />
                <button className="btn" type="button" disabled={frozen} onClick={()=>fileInputRef.current?.click?.()}>
                  Foto
                </button>
                <button className={"btn " + (isRecording ? "danger" : "")} type="button" disabled={frozen} onClick={toggleRecord}>
                  {isRecording ? "Parar" : "Áudio"}
                </button>
                <button className="btn primary" type="submit" disabled={frozen || !text.trim() || sending}>
                  Enviar
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display:"none" }}
                  onChange={onPickImage}
                />
              </form>

              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Sem histórico: ao ficar vazio, o servidor limpa as mensagens.
              </div>
            </div>
          </div>

          {/* sidebar users */}
          <div className="admin-card" style={{ gridColumn:"auto" }}>
            <h2>Usuários online</h2>
            <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              Clique em um usuário para abrir “Privado”.
            </div>

            <div className="users-list">
              {users.length === 0 && <div className="muted">Ninguém online agora.</div>}
              {users.map((u) => (
                <div key={u.socketId} className="user-row">
                  <div className="user-nick">{u.nick}</div>
                  <div className="user-actions">
                    <button className="btn" type="button" onClick={()=>openDmTo(u)} disabled={u.socketId === socketRef.current?.id}>
                      Privado
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 14 }} className="muted">
              Sala: <span className="pill mono">{room?.id || roomId}</span>
            </div>
          </div>
        </div>
      </main>

      {/* DM modal */}
      <Modal open={openDm} title="Mensagem privada" onClose={()=>setOpenDm(false)}>
        <form onSubmit={sendDm} className="form">
          <div className="muted">
            Para: <b style={{ color:"var(--text)" }}>{dmTarget?.nick || "—"}</b>
          </div>
          <label>
            Mensagem
            <textarea
              value={dmText}
              onChange={(e)=>setDmText(e.target.value)}
              placeholder="Escreva sua mensagem privada…"
              maxLength={1200}
            />
          </label>
          <div className="row">
            <button type="button" className="btn" onClick={()=>setOpenDm(false)}>Cancelar</button>
            <button className="btn primary" type="submit" disabled={!dmText.trim()}>
              Enviar
            </button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Observação: se o servidor não tiver DM habilitado ainda, o envio será recusado.
          </div>
        </form>
      </Modal>
    </div>
  );
}

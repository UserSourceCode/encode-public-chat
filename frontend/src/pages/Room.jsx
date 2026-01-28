import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

function useQuery(){
  const { search } = useLocation();
  return useMemo(()=>new URLSearchParams(search), [search]);
}

function fmtTime(ts){
  try{
    return new Date(ts).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
  }catch{ return ""; }
}

function safeNick(n){
  return String(n || "").trim().slice(0, 18);
}

export default function Room(){
  const nav = useNavigate();
  const params = useParams();
  const q = useQuery();

  const pathname = useLocation().pathname;
  const isGroupRoute = pathname.startsWith("/g/");
  const roomId = isGroupRoute ? params.id : "geral";

  const nick = safeNick(q.get("nick"));
  const pass = q.get("pass") || "";
  const owner = q.get("owner") || "";

  const [toast, setToast] = useState("");
  const [connected, setConnected] = useState(false);

  const [room, setRoom] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [frozen, setFrozen] = useState(false);

  const [users, setUsers] = useState([]); // {socketId,nick}
  const [admins, setAdmins] = useState([]); // socketIds
  const [isGroupAdmin, setIsGroupAdmin] = useState(false);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // modal admin do grupo
  const [openAdmin, setOpenAdmin] = useState(false);
  const [openUserModal, setOpenUserModal] = useState(false);
  const [target, setTarget] = useState(null); // {socketId,nick}
  const [action, setAction] = useState("warn"); // warn|kick|ban|promote|demote
  const [actionMsg, setActionMsg] = useState("");
  const [banMinutes, setBanMinutes] = useState(60);

  // upload (imagem/audio)
  const fileInputRef = useRef(null);
  const audioInputRef = useRef(null);

  // recorder simples
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const [recOn, setRecOn] = useState(false);

  const listEndRef = useRef(null);

  // socket
  const sockRef = useRef(null);

  useEffect(()=>{
    // valida login mínimo
    if(!nick || nick.length < 2){
      nav("/");
      return;
    }
    if(isGroupRoute && (!roomId || !pass)){
      nav("/");
      return;
    }

    const socket = io("/", { transports: ["websocket", "polling"] });
    sockRef.current = socket;

    function toastErr(m){ setToast(m || "Erro"); }
    function toastOk(m){ setToast(m || "OK"); }

    socket.on("connect", ()=>{
      setConnected(true);

      if(isGroupRoute){
        socket.emit("join_group", { roomId, nick, password: pass, ownerToken: owner });
      }else{
        socket.emit("join_public", { nick });
      }
    });

    socket.on("disconnect", ()=>{
      setConnected(false);
    });

    socket.on("error_toast", (p)=>toastErr(p?.message));
    socket.on("ok_toast", (p)=>toastOk(p?.message));

    socket.on("room_snapshot", (snap)=>{
      setRoom(snap?.room || null);
      setMsgs(Array.isArray(snap?.messages) ? snap.messages : []);
      setTimeout(()=>listEndRef.current?.scrollIntoView({ behavior:"instant" }), 0);
    });

    socket.on("message_new", (m)=>{
      setMsgs(prev => {
        const next = [...prev, m];
        return next.slice(-320);
      });
      setTimeout(()=>listEndRef.current?.scrollIntoView({ behavior:"smooth" }), 0);
    });

    socket.on("message_deleted", ({ ids })=>{
      if(!Array.isArray(ids) || !ids.length) return;
      setMsgs(prev => prev.filter(x => !ids.includes(x.id)));
    });

    socket.on("room_frozen", ({ roomId: rid, frozen })=>{
      if(rid === roomId) setFrozen(Boolean(frozen));
    });

    socket.on("users_list", ({ users })=>{
      setUsers(Array.isArray(users) ? users : []);
    });

    socket.on("group_admins", ({ admins })=>{
      setAdmins(Array.isArray(admins) ? admins : []);
    });

    socket.on("group_you_are_admin", ({ ok })=>{
      setIsGroupAdmin(Boolean(ok));
    });

    socket.on("admin_notice", ({ message })=>{
      setToast(message || "Aviso do administrador");
    });

    socket.on("admin_kick", ({ message })=>{
      setToast(message || "Você foi removido.");
      setTimeout(()=>nav("/"), 400);
    });

    socket.on("admin_ban", ({ message })=>{
      setToast(message || "Você foi banido.");
      setTimeout(()=>nav("/"), 500);
    });

    return ()=>{
      try{ socket.disconnect(); }catch{}
      sockRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  function sendText(e){
    e?.preventDefault?.();
    if(frozen) return setToast("Sala congelada. Não é possível enviar.");
    const s = sockRef.current;
    if(!s) return;
    const t = String(text || "").trim();
    if(!t) return;
    setSending(true);
    s.emit("send_message", { type:"text", content: t, roomId });
    setText("");
    setTimeout(()=>setSending(false), 120);
  }

  async function fileToDataUrl(file){
    return new Promise((resolve, reject)=>{
      const r = new FileReader();
      r.onload = ()=>resolve(String(r.result || ""));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function pickImage(){
    if(frozen) return setToast("Sala congelada. Não é possível enviar.");
    fileInputRef.current?.click();
  }

  async function onPickImage(e){
    const file = e.target.files?.[0];
    e.target.value = "";
    if(!file) return;

    if(file.size > 2.2 * 1024 * 1024){
      setToast("Imagem muito grande (máx ~2MB).");
      return;
    }
    const s = sockRef.current;
    if(!s) return;

    setSending(true);
    try{
      const dataUrl = await fileToDataUrl(file);
      s.emit("send_message", { type:"image", content: dataUrl, roomId });
    }catch{
      setToast("Falha ao enviar imagem.");
    }finally{
      setTimeout(()=>setSending(false), 120);
    }
  }

  async function pickAudio(){
    if(frozen) return setToast("Sala congelada. Não é possível enviar.");
    // se o browser suportar gravação, preferir recorder
    if(navigator.mediaDevices?.getUserMedia){
      if(recOn){
        // parar gravação
        try{
          recRef.current?.stop();
        }catch{}
        return;
      }
      try{
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream, { mimeType: "audio/webm" });
        recRef.current = rec;
        chunksRef.current = [];
        rec.ondataavailable = (ev)=>{
          if(ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        rec.onstop = async ()=>{
          setRecOn(false);
          try{
            stream.getTracks().forEach(t=>t.stop());
          }catch{}
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          if(blob.size > 2.2 * 1024 * 1024){
            setToast("Áudio muito grande (tente menor).");
            return;
          }
          const s = sockRef.current;
          if(!s) return;
          const dataUrl = await fileToDataUrl(blob);
          setSending(true);
          s.emit("send_message", { type:"audio", content: dataUrl, roomId });
          setTimeout(()=>setSending(false), 120);
        };
        rec.start();
        setRecOn(true);
        setToast("Gravando áudio... clique novamente para parar.");
      }catch{
        // fallback para upload
        audioInputRef.current?.click();
      }
    }else{
      audioInputRef.current?.click();
    }
  }

  async function onPickAudio(e){
    const file = e.target.files?.[0];
    e.target.value = "";
    if(!file) return;

    if(file.size > 2.2 * 1024 * 1024){
      setToast("Áudio muito grande (máx ~2MB).");
      return;
    }
    const s = sockRef.current;
    if(!s) return;

    setSending(true);
    try{
      const dataUrl = await fileToDataUrl(file);
      s.emit("send_message", { type:"audio", content: dataUrl, roomId });
    }catch{
      setToast("Falha ao enviar áudio.");
    }finally{
      setTimeout(()=>setSending(false), 120);
    }
  }

  function openAdminPanel(){
    if(!isGroupRoute) return setToast("No Geral não existe admin.");
    if(!isGroupAdmin) return setToast("Você não é admin deste grupo.");
    setOpenAdmin(true);

    const s = sockRef.current;
    if(s) s.emit("group_admin_list");
  }

  function selectUser(u){
    setTarget(u);
    setAction("warn");
    setActionMsg("Por favor, mantenha o respeito e siga as regras.");
    setBanMinutes(60);
    setOpenUserModal(true);
  }

  function runUserAction(e){
    e?.preventDefault?.();
    if(!target?.socketId) return;

    const s = sockRef.current;
    if(!s) return;

    // promove/demote pode sem msg
    const payload = {
      action,
      targetSocketId: target.socketId,
      message: actionMsg,
      minutes: banMinutes,
    };

    // ajustes
    if(action === "kick"){
      payload.message = actionMsg || "Você foi removido pelo admin do grupo.";
    }
    if(action === "ban"){
      payload.message = actionMsg || "Você foi banido deste grupo.";
      payload.minutes = Number(banMinutes || 0);
    }
    if(action === "promote"){
      payload.message = "";
      payload.minutes = 0;
    }
    if(action === "demote"){
      payload.message = "";
      payload.minutes = 0;
    }

    s.emit("group_admin_action", payload);
    setOpenUserModal(false);

    // recarregar lista para refletir admin/promote
    setTimeout(()=>s.emit("group_admin_list"), 200);
  }

  const title = useMemo(()=>{
    if(!room) return "Carregando…";
    return room.type === "group" ? `Grupo • ${room.name}` : "Geral";
  }, [room]);

  const youAreAdminLabel = isGroupRoute && isGroupAdmin;

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">{title}</div>
            <div className="brand-sub">
              {connected ? "Conectado" : "Conectando…"}
              {frozen ? " • Sala congelada" : ""}
              {youAreAdminLabel ? " • Você é admin do grupo" : ""}
            </div>
          </div>
        </div>

        <div className="top-actions">
          {isGroupRoute && (
            <button className={"btn " + (youAreAdminLabel ? "primary" : "")} type="button" onClick={openAdminPanel}>
              Admin do grupo
            </button>
          )}
          <button className="btn danger" type="button" onClick={()=>nav("/")}>
            Sair
          </button>
        </div>
      </header>

      <main className="room-shell">
        <section className="chat-card">
          <div className="chat-head">
            <div className="chat-title">Mensagens</div>
            <div className="chat-meta">
              <span className={"badge " + (frozen ? "warn" : "good")}>
                {frozen ? "CONGELADA" : "ATIVA"}
              </span>
              <span className="badge mono">Sala: <b>{roomId}</b></span>
            </div>
          </div>

          <div className="chat-list">
            {msgs.map(m => (
              <div key={m.id} className={"msg " + (m.nick === nick ? "me" : "")}>
                <div className="msg-top">
                  <div className="msg-nick">{m.nick}</div>
                  <div className="msg-time">{fmtTime(m.ts)}</div>
                </div>

                {m.type === "text" && (
                  <div className="msg-bubble">{m.content}</div>
                )}

                {m.type === "image" && (
                  <div className="msg-bubble media">
                    <img src={m.content} alt="imagem" className="msg-img" />
                  </div>
                )}

                {m.type === "audio" && (
                  <div className="msg-bubble media">
                    <audio controls src={m.content} className="msg-audio" />
                  </div>
                )}
              </div>
            ))}
            <div ref={listEndRef} />
          </div>

          <form className="chat-compose" onSubmit={sendText}>
            <input
              className="home-input"
              value={text}
              onChange={(e)=>setText(e.target.value)}
              placeholder={frozen ? "Sala congelada…" : "Digite sua mensagem…"}
              disabled={frozen}
            />

            <div className="compose-actions">
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display:"none" }} onChange={onPickImage} />
              <input ref={audioInputRef} type="file" accept="audio/*" style={{ display:"none" }} onChange={onPickAudio} />

              <button className="btn" type="button" onClick={pickImage} disabled={frozen || sending}>
                Foto
              </button>
              <button className={"btn " + (recOn ? "warn" : "")} type="button" onClick={pickAudio} disabled={frozen || sending}>
                {recOn ? "Parar" : "Áudio"}
              </button>
              <button className="btn primary" type="submit" disabled={frozen || sending || !text.trim()}>
                Enviar
              </button>
            </div>
          </form>

          <div className="muted" style={{ marginTop: 8 }}>
            Limites: texto até ~1200 caracteres • imagem/áudio até ~2MB (RAM).
          </div>
        </section>

        <aside className="side-card">
          <div className="side-title">Online agora</div>
          <div className="side-sub muted">Usuários conectados nesta sala</div>

          <div className="users-mini">
            {users.map(u => (
              <div key={u.socketId} className="user-mini">
                <div className="user-mini-dot" />
                <div className="user-mini-name">
                  {u.nick}
                  {admins.includes(u.socketId) && <span className="pill mono" style={{ marginLeft: 8 }}>admin</span>}
                </div>
              </div>
            ))}
            {users.length === 0 && <div className="muted">Ninguém por aqui…</div>}
          </div>
        </aside>
      </main>

      {/* ADMIN LIST MODAL */}
      <Modal open={openAdmin} title="Admin do grupo" onClose={()=>setOpenAdmin(false)}>
        {!isGroupAdmin && (
          <div className="muted">
            Você não é admin deste grupo.
          </div>
        )}

        {isGroupAdmin && (
          <div className="admin-list">
            <div className="muted" style={{ marginBottom: 10 }}>
              Clique em um usuário para abrir ações: <b>Avisar</b>, <b>Kick</b>, <b>Ban</b>, <b>Promover</b>.
            </div>

            <div className="users-list">
              {users.map(u => (
                <button
                  key={u.socketId}
                  className="user-pick"
                  type="button"
                  onClick={()=>selectUser(u)}
                >
                  <div className="user-pick-left">
                    <div className="user-nick">{u.nick}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {admins.includes(u.socketId) ? "Admin do grupo" : "Membro"}
                    </div>
                  </div>
                  <div className="user-pick-right">
                    {admins.includes(u.socketId) ? <span className="badge good">Admin</span> : <span className="badge">Usuário</span>}
                  </div>
                </button>
              ))}
              {users.length === 0 && <div className="muted">Nenhum usuário no grupo.</div>}
            </div>
          </div>
        )}
      </Modal>

      {/* USER ACTION MODAL */}
      <Modal
        open={openUserModal}
        title={target ? `Ações • ${target.nick}` : "Ações"}
        onClose={()=>setOpenUserModal(false)}
      >
        {!target && <div className="muted">Selecione um usuário.</div>}

        {target && (
          <form className="form" onSubmit={runUserAction}>
            <div className="admin-actions-tabs">
              <button type="button" className={"tab " + (action==="warn" ? "active":"")} onClick={()=>{ setAction("warn"); setActionMsg("Por favor, mantenha o respeito e siga as regras."); }}>
                Avisar
              </button>
              <button type="button" className={"tab " + (action==="kick" ? "active":"")} onClick={()=>{ setAction("kick"); setActionMsg("Você foi removido pelo administrador."); }}>
                Kick
              </button>
              <button type="button" className={"tab " + (action==="ban" ? "active":"")} onClick={()=>{ setAction("ban"); setActionMsg("Acesso bloqueado pelo administrador."); }}>
                Ban
              </button>
              <button type="button" className={"tab " + (action==="promote" ? "active":"")} onClick={()=>{ setAction("promote"); setActionMsg(""); }}>
                Promover admin
              </button>
              <button type="button" className={"tab " + (action==="demote" ? "active":"")} onClick={()=>{ setAction("demote"); setActionMsg(""); }}>
                Remover admin
              </button>
            </div>

            {(action === "warn" || action === "kick" || action === "ban") && (
              <label>
                Mensagem
                <textarea
                  value={actionMsg}
                  onChange={(e)=>setActionMsg(e.target.value)}
                  placeholder="Digite a mensagem"
                  maxLength={220}
                  required={action === "warn" || action === "ban" || action === "kick"}
                />
              </label>
            )}

            {action === "ban" && (
              <label>
                Duração (minutos) — 0 = permanente
                <input
                  type="number"
                  min="0"
                  max="43200"
                  value={banMinutes}
                  onChange={(e)=>setBanMinutes(Number(e.target.value || 0))}
                />
              </label>
            )}

            <div className="row" style={{ justifyContent:"flex-end" }}>
              <button type="button" className="btn" onClick={()=>setOpenUserModal(false)}>Cancelar</button>
              <button className={"btn " + (action==="warn" || action==="promote" ? "primary" : "danger")} type="submit">
                Confirmar
              </button>
            </div>

            <div className="muted" style={{ marginTop: 8 }}>
              * Admin só existe em grupos. No Geral não há admin.
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

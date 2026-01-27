import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { socket } from "../lib/socket.js";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

function nowTime(ts){
  const d = new Date(ts);
  return d.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
}

const QUICK_REACTIONS = ["👍","😂","❤️","🔥","😮","👏","😡","🎉"];

export default function Room({ mode }){
  const nav = useNavigate();
  const params = useParams();
  const roomId = mode === "group" ? params.id : "geral";

  const [toast, setToast] = useState("");
  const [openAuth, setOpenAuth] = useState(true);

  // pega do sessionStorage (usado na Home "Entrar em grupo")
  const [nick, setNick] = useState(() => sessionStorage.getItem("join_nick") || "");
  const [password, setPassword] = useState(() => sessionStorage.getItem("join_pass") || "");

  const [room, setRoom] = useState(null);
  const [msgs, setMsgs] = useState([]);

  const [text, setText] = useState("");
  const listRef = useRef(null);

  // ONLINE + REPLY + PICKER
  const [usersOnline, setUsersOnline] = useState([]); // [{socketId,nick}]
  const [reply, setReply] = useState(null); // {id,nick,preview,type}
  const [picker, setPicker] = useState(null); // { messageId, x, y, dm: false }

  // DM
  const [dmOpen, setDmOpen] = useState(false);
  const [dmPeer, setDmPeer] = useState(null); // {socketId,nick}
  const [dmId, setDmId] = useState("");
  const [dmMsgs, setDmMsgs] = useState([]);
  const [dmText, setDmText] = useState("");
  const dmListRef = useRef(null);

  const inviteLink = useMemo(()=>{
    if(mode !== "group") return "";
    return `${location.origin}/#/g/${roomId}`;
  }, [mode, roomId]);

  function scrollToBottom(){
    const el = listRef.current;
    if(!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function scrollDmBottom(){
    const el = dmListRef.current;
    if(!el) return;
    el.scrollTop = el.scrollHeight;
  }

  function safeExit(reason){
    // Fecha tudo, mostra aviso e sai pro início
    try{
      socket.disconnect();
    }catch{}
    setDmOpen(false);
    setReply(null);
    setPicker(null);
    setOpenAuth(true);
    if(reason) setToast(reason);
    setTimeout(()=>nav("/"), 350);
  }

  useEffect(()=>{
    function onSnap(snap){
      setRoom(snap.room);
      setMsgs(snap.messages || []);

      // entrou ok: limpa credenciais temporárias
      sessionStorage.removeItem("join_nick");
      sessionStorage.removeItem("join_pass");

      setTimeout(()=>scrollToBottom(), 30);
    }

    function onNew(m){
      setMsgs(prev => [...prev, m]);
      setTimeout(()=>scrollToBottom(), 30);
    }

    function onPresence(p){
      if(p?.nick) setToast(p.type === "join" ? `${p.nick} entrou` : `${p.nick} saiu`);
    }

    function onDeleted({ ids }){
      if(!ids?.length) return;
      setMsgs(prev => prev.filter(m => !ids.includes(m.id)));
    }

    function onReact({ messageId, reactions }){
      setMsgs(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    }

    function onErr({ message }){
      setToast(message || "Erro");
    }

    function onUsersList(payload){
      if(payload?.roomId !== roomId) return;
      setUsersOnline(payload.users || []);
    }

    // ✅ Aviso do admin (toast na tela)
    function onAdminNotice(payload){
      const msg = String(payload?.message || "").trim();
      if(msg) setToast(`⚠️ Aviso: ${msg}`);
    }

    // ✅ Kick / Ban (sai do chat)
    function onAdminKick(payload){
      const msg = String(payload?.message || "Você foi removido pelo administrador.").trim();
      safeExit(msg);
    }
    function onAdminBan(payload){
      const msg = String(payload?.message || "Seu acesso foi bloqueado.").trim();
      safeExit(msg);
    }

    // DM handlers
    function onDmReady({ dmId, peer }){
      setDmId(dmId);
      setDmPeer(peer);
      setDmOpen(true);
      setTimeout(()=>scrollDmBottom(), 30);
    }

    function onDmSnap({ dmId: id, messages }){
      if(!id) return;
      setDmMsgs(messages || []);
      setTimeout(()=>scrollDmBottom(), 30);
    }

    function onDmNew({ dmId: id, message }){
      if(!id || !message) return;
      setDmMsgs(prev => [...prev, message]);
      setTimeout(()=>scrollDmBottom(), 30);
    }

    function onDmReacted({ dmId: id, messageId, reactions }){
      if(!id) return;
      setDmMsgs(prev => prev.map(m => m.id === messageId ? { ...m, reactions } : m));
    }

    socket.on("room_snapshot", onSnap);
    socket.on("new_message", onNew);
    socket.on("presence", onPresence);
    socket.on("message_deleted", onDeleted);
    socket.on("message_reacted", onReact);
    socket.on("error_toast", onErr);

    socket.on("users_list", onUsersList);

    // ✅ Admin
    socket.on("admin_notice", onAdminNotice);
    socket.on("admin_kick", onAdminKick);
    socket.on("admin_ban", onAdminBan);

    socket.on("dm_ready", onDmReady);
    socket.on("dm_snapshot", onDmSnap);
    socket.on("dm_new_message", onDmNew);
    socket.on("dm_reacted", onDmReacted);

    return ()=>{
      socket.off("room_snapshot", onSnap);
      socket.off("new_message", onNew);
      socket.off("presence", onPresence);
      socket.off("message_deleted", onDeleted);
      socket.off("message_reacted", onReact);
      socket.off("error_toast", onErr);

      socket.off("users_list", onUsersList);

      socket.off("admin_notice", onAdminNotice);
      socket.off("admin_kick", onAdminKick);
      socket.off("admin_ban", onAdminBan);

      socket.off("dm_ready", onDmReady);
      socket.off("dm_snapshot", onDmSnap);
      socket.off("dm_new_message", onDmNew);
      socket.off("dm_reacted", onDmReacted);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Se entrar em grupo e senha estiver errada, reabre o modal se não veio snapshot.
  useEffect(()=>{
    if(openAuth) return;
    const t = setTimeout(()=>{
      if(mode === "group" && !room){
        setOpenAuth(true);
      }
    }, 1200);
    return ()=>clearTimeout(t);
  }, [openAuth, room, mode]);

  function setReplyFromMessage(m){
    setReply({
      id: m.id,
      nick: m.nick,
      type: m.type,
      preview: m.type === "text" ? m.content : (m.type === "image" ? "[imagem]" : "[áudio]")
    });
  }

  function openPickerForMessage(ev, m, isDm=false){
    setPicker({
      messageId: m.id,
      x: ev.clientX,
      y: ev.clientY,
      dm: isDm
    });
  }

  function closePicker(){
    setPicker(null);
  }

  function reactPick(emoji){
    if(!picker) return;
    if(picker.dm){
      if(!dmId) return closePicker();
      socket.emit("react_dm", { dmId, messageId: picker.messageId, emoji });
    }else{
      socket.emit("react_message", { roomId, messageId: picker.messageId, emoji });
    }
    closePicker();
  }

  async function enter(e){
    e.preventDefault();
    const n = nick.trim();
    if(n.length < 2){ setToast("Apelido inválido"); return; }

    if(mode === "public"){
      socket.emit("join_public", { nick: n });
      setOpenAuth(false);
      return;
    }

    socket.emit("join_group", { roomId, nick: n, password });
    setOpenAuth(false);
  }

  function sendText(){
    const t = text.trim();
    if(!t) return;
    socket.emit("send_message", {
      roomId,
      type:"text",
      content: t,
      replyTo: reply
    });
    setText("");
    setReply(null);
  }

  async function sendImage(file){
    if(!file) return;
    if(file.size > 2_000_000){ setToast("Imagem muito grande (máx 2MB)"); return; }
    const dataUrl = await toDataUrl(file);
    socket.emit("send_message", { roomId, type:"image", content: dataUrl, replyTo: reply });
    setReply(null);
  }

  async function recordAudio(){
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e)=>chunks.push(e.data);
      rec.onstop = async ()=>{
        stream.getTracks().forEach(t=>t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        if(blob.size > 2_500_000){ setToast("Áudio muito grande (máx ~2.5MB)"); return; }
        const dataUrl = await blobToDataUrl(blob);
        socket.emit("send_message", { roomId, type:"audio", content: dataUrl, replyTo: reply });
        setReply(null);
      };
      rec.start();
      setToast("Gravando... clique novamente para parar");
      setTimeout(()=>{ if(rec.state !== "inactive") rec.stop(); }, 10_000);
      recordAudio._rec = rec;
    }catch{
      setToast("Sem permissão de microfone");
    }
  }

  function toggleAudio(){
    const r = recordAudio._rec;
    if(r && r.state !== "inactive"){
      r.stop();
      recordAudio._rec = null;
      setToast("Enviando áudio...");
      return;
    }
    recordAudio();
  }

  async function copyInvite(){
    try{
      await navigator.clipboard.writeText(inviteLink);
      setToast("Link copiado!");
    }catch{
      setToast("Não consegui copiar. Copie manualmente.");
    }
  }

  function openDmWith(peerSocketId){
    if(!peerSocketId) return;
    socket.emit("start_dm", { peerSocketId });
  }

  function sendDmText(){
    const t = dmText.trim();
    if(!t || !dmId) return;
    socket.emit("send_dm", { dmId, type:"text", content: t, replyTo: null });
    setDmText("");
  }

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">{room?.name || (mode==="public" ? "Geral" : "Grupo privado")}</div>
            <div className="brand-sub">
              {mode==="public" ? "Sala pública temporária" : `ID: ${roomId}`}
            </div>
          </div>
        </div>

        <div className="top-actions">
          {mode==="group" && (
            <button className="btn" onClick={copyInvite}>Copiar link</button>
          )}
          <button className="btn danger" onClick={()=>nav("/")}>Sair</button>
        </div>
      </header>

      <main className="chat">
        <div className="chat-left">
          <div className="room-card">
            <div className="room-label">Status</div>
            <div className="muted">
              Nada é salvo. Ao fechar o chat, suas mensagens somem.
            </div>

            {mode==="group" && (
              <div className="invite">
                <div className="room-label">Convite</div>
                <div className="pill mono">{inviteLink}</div>
              </div>
            )}

            <div style={{ marginTop: 10 }} className="muted">
              Dica: <b>clique</b> numa mensagem para responder. <b>duplo clique</b> para reagir.
            </div>
          </div>

          <div className="room-card" style={{ marginTop: 12 }}>
            <div className="room-label">Online</div>

            {usersOnline.length === 0 && <div className="muted">Ninguém online.</div>}

            <div style={{ display:"grid", gap:8 }}>
              {usersOnline.map(u=>{
                const me = u.nick === nick.trim();
                return (
                  <div
                    key={u.socketId}
                    style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}
                  >
                    <div style={{ fontWeight:800 }}>
                      {u.nick}{me ? " (você)" : ""}
                    </div>
                    <button
                      className="btn"
                      onClick={()=>openDmWith(u.socketId)}
                      disabled={me}
                      title="Mensagem privada"
                    >
                      DM
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="chat-main">
          <div className="messages" ref={listRef}>
            {msgs.map(m=>(
              <div key={m.id} className={"msg " + (m.nick === nick.trim() ? "me" : "")}>
                <div className="msg-top">
                  <span className="nick">{m.nick}</span>
                  <span className="time">{nowTime(m.ts)}</span>
                </div>

                {m.replyTo && (
                  <div className="bubble" style={{ opacity:.92, borderStyle:"dashed", marginBottom:8 }}>
                    <div style={{ fontSize:12, color:"rgba(233,238,247,.68)" }}>
                      Respondendo <b>{m.replyTo.nick}</b>
                    </div>
                    <div className="mono" style={{ marginTop:6 }}>
                      {m.replyTo.preview}
                    </div>
                  </div>
                )}

                {m.type === "text" && (
                  <div
                    className="bubble"
                    onClick={()=>setReplyFromMessage(m)}
                    onDoubleClick={(ev)=>openPickerForMessage(ev, m, false)}
                    title="Clique para responder • Duplo clique para reagir"
                  >
                    {m.content}
                  </div>
                )}

                {m.type === "image" && (
                  <div
                    className="bubble media"
                    onClick={()=>setReplyFromMessage(m)}
                    onDoubleClick={(ev)=>openPickerForMessage(ev, m, false)}
                    title="Clique para responder • Duplo clique para reagir"
                  >
                    <img src={m.content} alt="imagem" />
                  </div>
                )}

                {m.type === "audio" && (
                  <div
                    className="bubble media"
                    onClick={()=>setReplyFromMessage(m)}
                    onDoubleClick={(ev)=>openPickerForMessage(ev, m, false)}
                    title="Clique para responder • Duplo clique para reagir"
                  >
                    <audio controls src={m.content} />
                  </div>
                )}

                <div className="reactions" style={{ marginTop:8 }}>
                  {m.reactions && Object.keys(m.reactions).map(k=>(
                    <span key={k} className="rchip">{k} {m.reactions[k]}</span>
                  ))}
                </div>
              </div>
            ))}

            {msgs.length === 0 && (
              <div className="empty">
                Nenhuma mensagem ainda. Seja o primeiro a falar 🙂
              </div>
            )}
          </div>

          {reply && (
            <div style={{
              padding:"10px 12px",
              borderTop:"1px solid rgba(255,255,255,.08)",
              background:"rgba(12,18,32,.55)"
            }}>
              <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center" }}>
                <div style={{ fontSize:12.5, color:"rgba(233,238,247,.68)" }}>
                  Respondendo <b>{reply.nick}</b>: <span className="mono">{reply.preview}</span>
                </div>
                <button className="btn" onClick={()=>setReply(null)}>Cancelar</button>
              </div>
            </div>
          )}

          <div className="composer">
            <input
              value={text}
              onChange={(e)=>setText(e.target.value)}
              placeholder="Digite uma mensagem..."
              onKeyDown={(e)=>{ if(e.key==="Enter") sendText(); }}
            />

            <label className="btn icon" title="Enviar foto">
              📷
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(e)=>sendImage(e.target.files?.[0])}
              />
            </label>

            <button className="btn icon" onClick={toggleAudio} title="Áudio (até 10s)">🎙️</button>
            <button className="btn primary" onClick={sendText}>Enviar</button>
          </div>
        </div>
      </main>

      {/* Emoji Picker (retrátil) */}
      {picker && (
        <div onClick={closePicker} style={{ position:"fixed", inset:0, zIndex:70 }}>
          <div
            onClick={(e)=>e.stopPropagation()}
            style={{
              position:"fixed",
              left: Math.min(picker.x, window.innerWidth - 260),
              top: Math.min(picker.y, window.innerHeight - 120),
              padding:10,
              borderRadius:14,
              border:"1px solid rgba(255,255,255,.10)",
              background:"rgba(15,22,36,.92)",
              boxShadow:"0 10px 40px rgba(0,0,0,.45)",
              display:"flex",
              gap:8,
              flexWrap:"wrap",
              maxWidth: 260
            }}
          >
            {QUICK_REACTIONS.map(e=>(
              <button key={e} className="react" onClick={()=>reactPick(e)}>{e}</button>
            ))}
          </div>
        </div>
      )}

      {/* Modal: Entrar no Geral / Grupo */}
      <Modal open={openAuth} title={mode==="public" ? "Entrar no Geral" : "Entrar no grupo"}>
        <form onSubmit={enter} className="form">
          <label>
            Apelido
            <input
              value={nick}
              onChange={(e)=>setNick(e.target.value)}
              required
              minLength={2}
              maxLength={18}
              placeholder="Ex: Lucas"
            />
          </label>

          {mode==="group" && (
            <label>
              Senha do grupo
              <input
                value={password}
                onChange={(e)=>setPassword(e.target.value)}
                type="password"
                required
                minLength={3}
                placeholder="Senha"
              />
            </label>
          )}

          <div className="row">
            <button type="button" className="btn" onClick={()=>nav("/")}>Voltar</button>
            <button className="btn primary" type="submit">Entrar</button>
          </div>
        </form>
      </Modal>

      {/* Modal: DM */}
      <Modal open={dmOpen} title={dmPeer ? `Privado com ${dmPeer.nick}` : "Privado"}>
        <div style={{ display:"grid", gap:10 }}>
          <div
            ref={dmListRef}
            style={{
              height: 360,
              overflow:"auto",
              padding:10,
              border:"1px solid rgba(255,255,255,.10)",
              borderRadius:14,
              background:"rgba(255,255,255,.03)"
            }}
          >
            {dmMsgs.map(m=>(
              <div key={m.id} style={{ marginBottom: 10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"rgba(233,238,247,.68)" }}>
                  <b style={{ color:"#e9eef7" }}>{m.nick}</b>
                  <span>{nowTime(m.ts)}</span>
                </div>

                {m.replyTo && (
                  <div className="bubble" style={{ opacity:.92, borderStyle:"dashed", marginTop:6 }}>
                    <div style={{ fontSize:12, color:"rgba(233,238,247,.68)" }}>
                      Respondendo <b>{m.replyTo.nick}</b>
                    </div>
                    <div className="mono" style={{ marginTop:6 }}>{m.replyTo.preview}</div>
                  </div>
                )}

                <div
                  className="bubble"
                  style={{ marginTop:6 }}
                  onDoubleClick={(ev)=>openPickerForMessage(ev, m, true)}
                  title="Duplo clique para reagir"
                >
                  {m.type === "text" ? m.content : (m.type === "image" ? "[imagem]" : "[áudio]")}
                </div>

                <div className="reactions" style={{ marginTop:6 }}>
                  {m.reactions && Object.keys(m.reactions).map(k=>(
                    <span key={k} className="rchip">{k} {m.reactions[k]}</span>
                  ))}
                </div>
              </div>
            ))}
            {dmMsgs.length === 0 && <div className="muted">Nenhuma mensagem privada ainda.</div>}
          </div>

          <div style={{ display:"flex", gap:10 }}>
            <input
              value={dmText}
              onChange={(e)=>setDmText(e.target.value)}
              placeholder="Digite no privado..."
              style={{
                flex:1,
                borderRadius:12,
                border:"1px solid rgba(255,255,255,.10)",
                background:"rgba(255,255,255,.03)",
                color:"#e9eef7",
                padding:"10px 12px",
                outline:"none"
              }}
              onKeyDown={(e)=>{ if(e.key==="Enter") sendDmText(); }}
            />
            <button className="btn primary" onClick={sendDmText}>Enviar</button>
            <button className="btn" onClick={()=>setDmOpen(false)}>Fechar</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function toDataUrl(file){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = ()=>resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{
    const fr = new FileReader();
    fr.onload = ()=>resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

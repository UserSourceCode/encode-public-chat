import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

function useQuery(){
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

export default function Room(){
  const nav = useNavigate();
  const params = useParams();
  const q = useQuery();

  const isGeneral = useMemo(() => {
    // rota /geral
    return window.location.hash.includes("/geral") || window.location.pathname.includes("/geral");
  }, []);

  const roomId = useMemo(() => (params.roomId || "geral"), [params.roomId]);
  const nick = useMemo(() => String(q.get("nick") || "").trim(), [q]);
  const pass = useMemo(() => String(q.get("pass") || ""), [q]);

  const [toast, setToast] = useState("");
  const [connected, setConnected] = useState(false);

  // chat
  const [text, setText] = useState("");
  const [messages, setMessages] = useState([]);

  // users
  const [usersList, setUsersList] = useState([]); // [{socketId,nick,role?}]
  const [myRole, setMyRole] = useState("member"); // member | admin (apenas em grupo)

  // modal usuário (admin do grupo)
  const [userModal, setUserModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [banMinutes, setBanMinutes] = useState(60);
  const [banReason, setBanReason] = useState("Acesso bloqueado pelo admin do grupo.");
  const [warnMsg, setWarnMsg] = useState("Por favor, mantenha o respeito e siga as regras.");

  const sockRef = useRef(null);

  useEffect(() => {
    // validação simples
    if(!nick || nick.length < 2){
      setToast("Informe um apelido válido.");
      nav("/");
      return;
    }
    if(!isGeneral && (!roomId || !pass)){
      setToast("Grupo requer senha.");
      nav("/");
      return;
    }

    const socket = io("/", { transports: ["websocket"] });
    sockRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);

      if(isGeneral){
        // ✅ Geral não tem admin. Role sempre member.
        socket.emit("join_public", { nick });
        setMyRole("member");
      }else{
        const adminKey = sessionStorage.getItem(`group_admin_key:${roomId}`) || "";
        socket.emit("join_group", {
          roomId,
          nick,
          password: pass,
          adminKey: adminKey || undefined
        });
      }
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    // mensagens
    socket.on("message", (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    socket.on("room_snapshot", (snap) => {
      // snap.messages opcional
      if(Array.isArray(snap?.messages)){
        setMessages(snap.messages);
      }
      if(Array.isArray(snap?.users)){
        setUsersList(snap.users);
      }
    });

    socket.on("users_list", ({ users }) => {
      setUsersList(Array.isArray(users) ? users : []);
    });

    // ✅ papel do usuário em grupos
    socket.on("you_role", ({ role }) => {
      if(!isGeneral){
        setMyRole(role || "member");
      }else{
        setMyRole("member");
      }
    });

    // avisos privados/ações
    socket.on("error_toast", ({ message }) => setToast(message || "Erro"));
    socket.on("private_warn", ({ message }) => setToast(message || "Aviso do admin"));
    socket.on("admin_notice", ({ message }) => setToast(message || "Aviso"));
    socket.on("admin_kick", ({ message }) => {
      setToast(message || "Você foi removido.");
      setTimeout(()=>nav("/"), 500);
    });
    socket.on("admin_ban", ({ message }) => {
      setToast(message || "Você foi banido.");
      setTimeout(()=>nav("/"), 600);
    });

    return () => {
      try{
        socket.disconnect();
      }catch{}
      sockRef.current = null;
    };
  }, [nick, pass, roomId, isGeneral, nav]);

  const canSend = useMemo(() => text.trim().length > 0, [text]);

  function sendText(e){
    e?.preventDefault?.();
    const socket = sockRef.current;
    if(!socket || !connected) return;

    const t = text.trim();
    if(!t) return;

    // ✅ respeita seu backend: em geral -> send_public, em grupo -> send_group
    if(isGeneral){
      socket.emit("send_public", { text: t });
    }else{
      socket.emit("send_group", { roomId, text: t });
    }

    setText("");
  }

  function openUserActions(u){
    if(isGeneral) return;          // ✅ geral sem admin
    if(myRole !== "admin") return; // ✅ só admin abre
    setSelectedUser(u);
    setBanMinutes(60);
    setBanReason("Acesso bloqueado pelo admin do grupo.");
    setWarnMsg("Por favor, mantenha o respeito e siga as regras.");
    setUserModal(true);
  }

  function promoteAdmin(){
    const socket = sockRef.current;
    if(!socket || !selectedUser?.socketId) return;
    if(!window.confirm(`Promover ${selectedUser.nick} a admin do grupo?`)) return;
    socket.emit("group_promote_admin", { targetSocketId: selectedUser.socketId });
    setUserModal(false);
  }

  function demoteAdmin(){
    const socket = sockRef.current;
    if(!socket || !selectedUser?.socketId) return;
    if(!window.confirm(`Demover ${selectedUser.nick} (tirar admin)?`)) return;
    socket.emit("group_demote_admin", { targetSocketId: selectedUser.socketId });
    setUserModal(false);
  }

  function kickUser(){
    const socket = sockRef.current;
    if(!socket || !selectedUser?.socketId) return;
    if(!window.confirm(`Remover ${selectedUser.nick} do grupo (kick)?`)) return;
    socket.emit("group_kick", {
      targetSocketId: selectedUser.socketId,
      message: "Você foi removido pelo administrador do grupo."
    });
    setUserModal(false);
  }

  function warnUser(){
    const socket = sockRef.current;
    if(!socket || !selectedUser?.socketId) return;
    socket.emit("group_warn", {
      targetSocketId: selectedUser.socketId,
      message: String(warnMsg || "").slice(0, 220)
    });
    setToast("Aviso enviado (privado).");
    setUserModal(false);
  }

  function banIp(){
    const socket = sockRef.current;
    if(!socket || !selectedUser?.socketId) return;
    if(!window.confirm(`Banir ${selectedUser.nick} do grupo?`)) return;
    socket.emit("group_ban_ip", {
      targetSocketId: selectedUser.socketId,
      minutes: Number(banMinutes || 0),
      reason: String(banReason || "").slice(0, 220)
    });
    setUserModal(false);
  }

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">
              {isGeneral ? "Geral" : "Grupo"}
            </div>
            <div className="brand-sub">
              {isGeneral ? "Chat Público" : `Sala: ${roomId}`} • {connected ? "online" : "offline"}
              {!isGeneral && myRole === "admin" ? " • você é admin" : ""}
            </div>
          </div>
        </div>

        <div className="top-actions">
          {!isGeneral && myRole === "admin" && (
            <span className="badge good">Admin do grupo</span>
          )}
          <button className="btn" onClick={()=>nav("/")}>Sair</button>
        </div>
      </header>

      <main className="chat-shell">
        <div className="chat-left">
          <div className="chat-card">
            <div className="chat-title">Mensagens</div>

            <div className="chat-messages">
              {messages.length === 0 && <div className="muted">Sem mensagens ainda.</div>}

              {messages.map((m, idx)=>(
                <div key={idx} className="msg">
                  <div className="msg-top">
                    <b>{m.nick || "?"}</b>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {m.at ? new Date(m.at).toLocaleTimeString("pt-BR") : ""}
                    </span>
                  </div>
                  <div className="msg-text">{m.text}</div>
                </div>
              ))}
            </div>

            <form className="chat-send" onSubmit={sendText}>
              <input
                className="home-input"
                value={text}
                onChange={(e)=>setText(e.target.value)}
                placeholder="Digite uma mensagem..."
              />
              <button className="btn primary" type="submit" disabled={!canSend || !connected}>
                Enviar
              </button>
            </form>

            <div className="muted" style={{ marginTop: 8 }}>
              {isGeneral
                ? "No Geral não existe admin."
                : "Admin existe somente dentro do grupo (criador e promovidos)."}
            </div>
          </div>
        </div>

        <div className="chat-right">
          <div className="chat-card">
            <div className="chat-title">
              Usuários ({usersList.length})
            </div>

            <div className="users-list">
              {usersList.map(u => (
                <button
                  key={u.socketId}
                  type="button"
                  className={"user-row " + ((!isGeneral && myRole==="admin") ? "clickable" : "")}
                  onClick={()=>openUserActions(u)}
                  title={!isGeneral && myRole==="admin" ? "Clique para ações" : ""}
                >
                  <div>
                    <div className="user-nick">{u.nick}</div>
                    {!isGeneral && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {u.role === "admin" ? "admin" : "membro"}
                      </div>
                    )}
                  </div>

                  {!isGeneral && u.role === "admin" && (
                    <span className="pill">admin</span>
                  )}
                </button>
              ))}

              {usersList.length === 0 && (
                <div className="muted">Nenhum usuário.</div>
              )}
            </div>

            {!isGeneral && myRole !== "admin" && (
              <div className="muted" style={{ marginTop: 10 }}>
                Apenas admins podem abrir ações ao clicar no usuário.
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ✅ Modal ações do usuário */}
      <Modal open={userModal} title="Ações do grupo" onClose={()=>setUserModal(false)}>
        {!selectedUser ? (
          <div className="muted">Nenhum usuário selecionado.</div>
        ) : (
          <div className="form">
            <div className="muted">
              Usuário: <b style={{ color:"var(--text)" }}>{selectedUser.nick}</b>{" "}
              {!isGeneral && selectedUser.role === "admin" && <span className="pill">admin</span>}
            </div>

            <div className="row" style={{ marginTop: 10, flexWrap:"wrap" }}>
              <button className="btn primary" type="button" onClick={promoteAdmin}>
                Promover admin
              </button>

              <button
                className="btn"
                type="button"
                onClick={demoteAdmin}
                disabled={selectedUser.role !== "admin"}
                title={selectedUser.role !== "admin" ? "Usuário não é admin" : ""}
              >
                Demover admin
              </button>

              <button className="btn danger" type="button" onClick={kickUser}>
                Kick
              </button>
            </div>

            <hr className="sep" style={{ margin: "12px 0" }} />

            <label>
              Aviso privado (só para ele)
              <textarea
                value={warnMsg}
                onChange={(e)=>setWarnMsg(e.target.value)}
                maxLength={220}
              />
            </label>
            <div className="row">
              <button className="btn" type="button" onClick={warnUser}>
                Enviar aviso
              </button>
            </div>

            <hr className="sep" style={{ margin: "12px 0" }} />

            <label>
              Duração do ban (minutos) — 0 = permanente
              <input
                type="number"
                min="0"
                max="43200"
                value={banMinutes}
                onChange={(e)=>setBanMinutes(clamp(Number(e.target.value||0), 0, 43200))}
              />
            </label>

            <label>
              Motivo do ban
              <textarea
                value={banReason}
                onChange={(e)=>setBanReason(e.target.value)}
                maxLength={220}
              />
            </label>

            <div className="row" style={{ justifyContent:"space-between" }}>
              <button className="btn danger" type="button" onClick={banIp}>
                Banir IP
              </button>
              <button className="btn" type="button" onClick={()=>setUserModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

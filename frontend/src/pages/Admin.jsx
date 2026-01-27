import React, { useEffect, useMemo, useState } from "react";
import Toast from "../ui/Toast.jsx";

function fmtDate(ts){
  if(!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

export default function Admin(){
  const [toast, setToast] = useState("");
  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || "");
  const [pass, setPass] = useState("");
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const authHeaders = useMemo(()=>{
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [token]);

  async function login(e){
    e.preventDefault();
    setBusy(true);
    try{
      const r = await fetch("/api/admin/login", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ password: pass })
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || "Falha no login");
      sessionStorage.setItem("admin_token", j.token);
      setToken(j.token);
      setPass("");
      setToast("Admin autenticado.");
    }catch(err){
      setToast(err.message || "Erro");
    }finally{
      setBusy(false);
    }
  }

  async function load(){
    if(!token) return;
    try{
      const r = await fetch("/api/admin/state", { headers: { ...authHeaders } });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || "Não autorizado");
      setState(j);
    }catch(err){
      setToast(err.message || "Erro");
      // se token expirou
      if(String(err.message||"").toLowerCase().includes("não autorizado")){
        sessionStorage.removeItem("admin_token");
        setToken("");
      }
    }
  }

  useEffect(()=>{
    load();
    // refresh automático a cada 3s
    if(!token) return;
    const t = setInterval(load, 3000);
    return ()=>clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function logout(){
    sessionStorage.removeItem("admin_token");
    setToken("");
    setState(null);
    setToast("Logout.");
  }

  async function apiPost(url, body){
    setBusy(true);
    try{
      const r = await fetch(url, {
        method:"POST",
        headers:{ "Content-Type":"application/json", ...authHeaders },
        body: JSON.stringify(body || {})
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.error || "Erro");
      setToast("Ação aplicada.");
      await load();
    }catch(err){
      setToast(err.message || "Erro");
    }finally{
      setBusy(false);
    }
  }

  if(!token){
    return (
      <div className="shell">
        <Toast msg={toast} onClose={()=>setToast("")} />
        <header className="topbar">
          <div className="brand">
            <div className="logo">EP</div>
            <div>
              <div className="brand-title">Área Reservada</div>
              <div className="brand-sub">Administração e moderação</div>
            </div>
          </div>
        </header>

        <main className="home">
          <div className="card">
            <h1>Login do Administrador</h1>
            <p className="muted">Acesso restrito. Use a senha definida em <span className="pill mono">ADMIN_PASS</span>.</p>

            <form className="form" onSubmit={login}>
              <label>
                Senha
                <input value={pass} onChange={(e)=>setPass(e.target.value)} type="password" required minLength={3} placeholder="Digite a senha" />
              </label>
              <div className="row">
                <button className="btn primary" disabled={busy} type="submit">
                  {busy ? "Entrando..." : "Entrar"}
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand">
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">Área Reservada</div>
            <div className="brand-sub">Moderação: usuários, grupos e mensagens</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="btn" onClick={load} disabled={busy}>Atualizar</button>
          <button className="btn danger" onClick={logout}>Sair</button>
        </div>
      </header>

      <main className="chat" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {/* COLUNA 1 */}
        <div className="chat-main" style={{ minHeight: "75vh" }}>
          <div className="messages">
            <div className="room-label">Controles</div>

            <div className="card" style={{ marginTop: 10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Criação de grupos</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    {state?.freezeGroups ? "BLOQUEADA (ninguém cria grupo)" : "LIBERADA"}
                  </div>
                </div>

                <button
                  className={"btn " + (state?.freezeGroups ? "primary" : "")}
                  disabled={busy}
                  onClick={() => apiPost("/api/admin/freeze-groups", { enabled: !state?.freezeGroups })}
                >
                  {state?.freezeGroups ? "Desbloquear" : "Bloquear"}
                </button>
              </div>
            </div>

            <div className="room-label" style={{ marginTop: 18 }}>Usuários online</div>
            {(state?.users || []).map(u => (
              <div key={u.socketId} className="card" style={{ marginTop: 10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>{u.nick}</div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Sala: <span className="pill mono">{u.roomId}</span> · IP: <span className="pill mono">{u.ip}</span>
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>Entrou: {fmtDate(u.joinedAt)}</div>
                  </div>

                  <div style={{ display:"grid", gap:8 }}>
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        const msg = prompt("Mensagem para o usuário (aviso):", "Atenção: por favor respeite as regras.");
                        if (!msg) return;
                        apiPost("/api/admin/warn", { socketId: u.socketId, message: msg });
                      }}
                    >
                      Avisar
                    </button>

                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() => apiPost("/api/admin/kick", { socketId: u.socketId })}
                    >
                      Kick
                    </button>

                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        const minutes = Number(prompt("Banir por quantos minutos? (0 = até reiniciar)", "60") || "0");
                        const reason = prompt("Motivo:", "Moderação") || "Moderação";
                        apiPost("/api/admin/ban-ip", { ip: u.ip, minutes, reason });
                      }}
                    >
                      Ban IP
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {(!state?.users || state.users.length === 0) && (
              <div className="muted" style={{ marginTop: 10 }}>Nenhum usuário online.</div>
            )}

            <div className="room-label" style={{ marginTop: 18 }}>Bans</div>
            {(state?.bans || []).map(b => (
              <div key={b.ip} className="card" style={{ marginTop: 10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                  <div>
                    <div style={{ fontWeight: 900 }} className="mono">{b.ip}</div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Até: {b.until ? fmtDate(b.until) : "reinício do servidor"} · Motivo: {b.reason || "-"}
                    </div>
                  </div>
                  <button className="btn" disabled={busy} onClick={() => apiPost("/api/admin/unban-ip", { ip: b.ip })}>
                    Remover ban
                  </button>
                </div>
              </div>
            ))}
            {(!state?.bans || state.bans.length === 0) && (
              <div className="muted" style={{ marginTop: 10 }}>Nenhum IP banido.</div>
            )}
          </div>
        </div>

        {/* COLUNA 2 */}
        <div className="chat-main" style={{ minHeight: "75vh" }}>
          <div className="messages">
            <div className="room-label">Salas (Geral / Grupos)</div>

            {(state?.rooms || [])
              .filter(r => r.type === "public" || r.type === "group")
              .map(r => (
                <div key={r.id} className="card" style={{ marginTop: 10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>
                        {r.type === "public" ? "Geral" : (r.name || "Grupo")}
                      </div>
                      <div className="muted" style={{ marginTop: 4 }}>
                        ID: <span className="pill mono">{r.id}</span> · Online: <b>{r.onlineCount}</b> · Msg: <b>{r.msgCount}</b>
                      </div>
                      <div className="muted" style={{ marginTop: 4 }}>Criado: {fmtDate(r.createdAt)}</div>
                    </div>

                    <button className="btn danger" disabled={busy} onClick={() => apiPost("/api/admin/clear-room", { roomId: r.id })}>
                      Limpar
                    </button>
                  </div>

                  <details style={{ marginTop: 10 }}>
                    <summary className="btn" style={{ width:"fit-content" }}>Ver mensagens</summary>
                    <div style={{ marginTop: 10, display:"grid", gap:8 }}>
                      {(state?.messages?.[r.id] || []).slice(-80).map(m => (
                        <div key={m.id} className="bubble" style={{ maxWidth:"100%" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", gap:8 }}>
                            <b>{m.nick}</b>
                            <span className="muted" style={{ fontSize:12 }}>{fmtDate(m.ts)}</span>
                          </div>
                          {m.replyTo && (
                            <div className="pill mono" style={{ marginTop: 8, display:"inline-block" }}>
                              Respondendo {m.replyTo.nick}: {m.replyTo.preview}
                            </div>
                          )}
                          <div style={{ marginTop: 8 }}>
                            {m.type === "text" ? m.content : (m.type === "image" ? "[imagem]" : "[áudio]")}
                          </div>
                        </div>
                      ))}
                      {(state?.messages?.[r.id] || []).length === 0 && <div className="muted">Sem mensagens.</div>}
                    </div>
                  </details>
                </div>
              ))}

            <div className="room-label" style={{ marginTop: 18 }}>DMs (metadados)</div>
            {(state?.dms || []).map(dm => (
              <div key={dm.id} className="card" style={{ marginTop: 10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>DM</div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Participantes: {(dm.participants || []).map(p => p.nick).join(" ↔ ") || "—"}
                    </div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      Msg: <b>{dm.msgCount}</b> · Online na DM: <b>{dm.onlineCount}</b> · Criado: {fmtDate(dm.createdAt)}
                    </div>
                  </div>

                  <button className="btn danger" disabled={busy} onClick={() => apiPost("/api/admin/close-dm", { dmId: dm.id })}>
                    Encerrar DM
                  </button>
                </div>
              </div>
            ))}

            {(!state?.dms || state.dms.length === 0) && (
              <div className="muted" style={{ marginTop: 10 }}>Nenhum DM ativo.</div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

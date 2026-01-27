import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

function fmtTime(ts){
  if(!ts) return "—";
  return new Date(ts).toLocaleString("pt-BR", {
    day:"2-digit", month:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
}
function fmtSince(ts){
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  return h>0 ? `${h}h ${m}m` : `${m}m ${ss}s`;
}
function fmtDur(ms){
  const s = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  if(h>0) return `${h}h ${m}m`;
  if(m>0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
function fmtBytes(b){
  const n = Number(b || 0);
  if(n < 1024) return `${n} B`;
  const kb = n / 1024;
  if(kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if(mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export default function Admin(){
  const nav = useNavigate();

  const [toast, setToast] = useState("");
  const [openLogin, setOpenLogin] = useState(false);
  const [pass, setPass] = useState("");

  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || "");
  const [exp, setExp] = useState(() => Number(sessionStorage.getItem("admin_exp") || 0));

  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);

  // tabs do admin
  const [tab, setTab] = useState("visao"); // visao | salas | moderacao | ram

  // modal sala
  const [openRoom, setOpenRoom] = useState(false);
  const [roomDetail, setRoomDetail] = useState(null);
  const [roomLoading, setRoomLoading] = useState(false);

  // moderação (actions)
  const [actionModal, setActionModal] = useState(false);
  const [actionTarget, setActionTarget] = useState(null); // {socketId,nick}
  const [actionType, setActionType] = useState("warn"); // warn|kick|ban
  const [actionMsg, setActionMsg] = useState("");
  const [banMinutes, setBanMinutes] = useState(60);

  const isAuthed = useMemo(()=>{
    if(!token) return false;
    if(exp && Date.now() > exp) return false;
    return true;
  }, [token, exp]);

  async function api(path, opts={}){
    const r = await fetch(path, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const j = await r.json().catch(()=>null);
    if(!r.ok){
      throw new Error(j?.error || `Erro ${r.status}`);
    }
    return j;
  }

  async function login(e){
    e.preventDefault();
    try{
      const j = await fetch("/api/admin/login", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ password: pass })
      }).then(r=>r.json());

      if(!j.ok){
        setToast(j.error || "Senha inválida");
        return;
      }

      sessionStorage.setItem("admin_token", j.token);
      sessionStorage.setItem("admin_exp", String(j.expiresAt || 0));
      setToken(j.token);
      setExp(j.expiresAt || 0);
      setPass("");
      setOpenLogin(false);
      setToast("Acesso liberado.");
    }catch{
      setToast("Falha no login.");
    }
  }

  function logout(){
    sessionStorage.removeItem("admin_token");
    sessionStorage.removeItem("admin_exp");
    setToken("");
    setExp(0);
    setMetrics(null);
    setRoomDetail(null);
    setOpenRoom(false);
    setToast("Sessão encerrada.");
  }

  async function loadMetrics(){
    if(!isAuthed) return;
    setLoading(true);
    try{
      const j = await api("/api/admin/metrics");
      setMetrics(j);
    }catch(e){
      setToast(e.message || "Erro ao carregar métricas");
      const m = String(e.message || "").toLowerCase();
      if(m.includes("não autorizado") || m.includes("sessão")){
        logout();
      }
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{
    if(!isAuthed){
      setOpenLogin(true);
      return;
    }
    loadMetrics();
    const t = setInterval(loadMetrics, 2000);
    return ()=>clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  async function openRoomDetails(id){
    if(!id) return;
    if(!isAuthed) return;

    setOpenRoom(true);
    setRoomLoading(true);
    setRoomDetail(null);
    try{
      const j = await api(`/api/admin/room/${encodeURIComponent(id)}`);
      setRoomDetail(j.room);
    }catch(e){
      setToast(e.message || "Erro ao abrir sala");
      setOpenRoom(false);
    }finally{
      setRoomLoading(false);
    }
  }

  async function setFlags(partial){
    try{
      const j = await api("/api/admin/flags", {
        method:"POST",
        body: JSON.stringify(partial)
      });
      setToast("Configuração atualizada.");
      setMetrics(prev => prev ? ({ ...prev, flags: { ...prev.flags, ...j.flags } }) : prev);
      loadMetrics();
    }catch(e){
      setToast(e.message || "Falha ao atualizar flags.");
    }
  }

  async function freezeRoom(id, freeze){
    try{
      await api(`/api/admin/room/${encodeURIComponent(id)}/freeze`, {
        method:"POST",
        body: JSON.stringify({ freeze })
      });
      setToast(freeze ? "Sala congelada." : "Sala descongelada.");
      loadMetrics();
      if(roomDetail?.id === id){
        setRoomDetail(prev => prev ? ({ ...prev, frozen: freeze }) : prev);
      }
    }catch(e){
      setToast(e.message || "Falha ao congelar sala.");
    }
  }

  async function deleteGroup(id){
    if(!id) return;
    const ok = window.confirm("Tem certeza que deseja excluir este grupo? Os usuários serão desconectados.");
    if(!ok) return;

    try{
      await api(`/api/admin/room/${encodeURIComponent(id)}`, { method:"DELETE" });
      setToast("Grupo excluído.");
      setOpenRoom(false);
      setRoomDetail(null);
      loadMetrics();
    }catch(e){
      setToast(e.message || "Falha ao excluir grupo.");
    }
  }

  function openAction(type, user){
    setActionType(type);
    setActionTarget(user);
    setActionMsg(type === "warn" ? "Por favor, mantenha o respeito e siga as regras." :
                 type === "kick" ? "Você foi removido pelo administrador." :
                 "Acesso bloqueado pelo administrador.");
    setBanMinutes(60);
    setActionModal(true);
  }

  async function runAction(e){
    e?.preventDefault?.();
    if(!actionTarget?.socketId) return;

    try{
      if(actionType === "warn"){
        await api("/api/admin/warn", {
          method:"POST",
          body: JSON.stringify({
            socketId: actionTarget.socketId,
            message: actionMsg
          })
        });
        setToast("Aviso enviado.");
      }else if(actionType === "kick"){
        await api("/api/admin/kick", {
          method:"POST",
          body: JSON.stringify({
            socketId: actionTarget.socketId,
            message: actionMsg
          })
        });
        setToast("Usuário removido.");
      }else{
        await api("/api/admin/ban-ip", {
          method:"POST",
          body: JSON.stringify({
            socketId: actionTarget.socketId,
            minutes: Number(banMinutes || 0),
            reason: actionMsg
          })
        });
        setToast("IP banido.");
      }
      setActionModal(false);
      loadMetrics();
      if(roomDetail?.id){
        // recarrega detalhes se modal estava aberto (para atualizar lista)
        openRoomDetails(roomDetail.id);
      }
    }catch(e2){
      setToast(e2.message || "Falha na ação.");
    }
  }

  const ram = metrics?.ram || {};
  const uptimeSec = metrics?.uptimeSec || 0;

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">Área Reservada</div>
            <div className="brand-sub">Admin • Monitoramento e moderação</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="btn" onClick={loadMetrics} disabled={!isAuthed || loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </button>
          <button className="btn danger" onClick={logout} disabled={!isAuthed}>
            Sair do admin
          </button>
        </div>
      </header>

      <main className="admin-shell">
        <div className="admin-hero">
          <div>
            <div className="admin-title">Painel do Administrador</div>
            <div className="admin-sub">
              Desde o boot: <b>{metrics?.bootAt ? fmtSince(metrics.bootAt) : "—"}</b> • Uptime: <b>{uptimeSec}s</b> • Atualiza a cada 2s
            </div>
          </div>
          <div className="admin-tools">
            <span className="badge mono">Sessão: {exp ? fmtTime(exp) : "—"}</span>
            <span className="badge">Online: <b>{metrics?.onlineNow ?? "—"}</b></span>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          <button className={"tab " + (tab==="visao" ? "active" : "")} onClick={()=>setTab("visao")}>Visão geral</button>
          <button className={"tab " + (tab==="salas" ? "active" : "")} onClick={()=>setTab("salas")}>Salas</button>
          <button className={"tab " + (tab==="moderacao" ? "active" : "")} onClick={()=>setTab("moderacao")}>Moderação</button>
          <button className={"tab " + (tab==="ram" ? "active" : "")} onClick={()=>setTab("ram")}>RAM</button>
        </div>

        {/* VISÃO GERAL */}
        {tab === "visao" && (
          <div className="admin-grid">
            <div className="admin-card">
              <h2>Online agora</h2>
              <div className="admin-badges">
                <span className="badge good">Online: <b>{metrics?.onlineNow ?? "—"}</b></span>
                <span className="badge">Salas: <b>{metrics?.roomsTotal ?? "—"}</b></span>
                <span className="badge">Grupos: <b>{metrics?.groupsTotal ?? "—"}</b></span>
                <span className="badge">DMs ativos: <b>{metrics?.dmActive ?? "—"}</b></span>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Contagem do servidor atual (1 instância). Sem persistência: reiniciou, zera.
              </div>
            </div>

            <div className="admin-card">
              <h2>Picos</h2>
              <div className="admin-badges">
                <span className="badge warn">Pico online: <b>{metrics?.peakOnline ?? "—"}</b></span>
                <span className="badge mono">Quando: {metrics?.peakOnlineAt ? fmtTime(metrics.peakOnlineAt) : "—"}</span>
                <span className="badge">Pico (últ. 60s): <b>{metrics?.peakOnlineLast60 ?? "—"}</b></span>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Picos por sala aparecem na aba “Salas”.
              </div>
            </div>

            <div className="admin-card">
              <h2>Tempo médio de sessão</h2>
              <div className="admin-badges">
                <span className="badge good">Online agora: <b>{metrics ? fmtDur(metrics.avgSessionNowMs || 0) : "—"}</b></span>
                <span className="badge">Histórico (boot): <b>{metrics ? fmtDur(metrics.avgSessionAllMs || 0) : "—"}</b></span>
                <span className="badge mono">Sessões encerradas: <b>{metrics?.sessionsClosedCount ?? "—"}</b></span>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Histórico inclui sessões encerradas + ativas (desde o boot).
              </div>
            </div>

            <div className="admin-card">
              <h2>Mensagens por minuto</h2>
              <div className="admin-badges">
                <span className="badge good">Agora (últ. 60s): <b>{metrics?.msgsPerMinNow ?? "—"}</b></span>
                <span className="badge warn">Pico: <b>{metrics?.peakMsgsPerMin ?? "—"}</b></span>
                <span className="badge mono">Quando: {metrics?.peakMsgsPerMinAt ? fmtTime(metrics.peakMsgsPerMinAt) : "—"}</span>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Conta mensagens do Geral + Grupos + DMs.
              </div>
            </div>

            <div className="admin-card">
              <h2>Controles</h2>
              <div className="controls">
                <div className="control">
                  <div>
                    <div className="control-title">Criação de grupos</div>
                    <div className="muted">{metrics?.flags?.groupCreationEnabled ? "LIBERADA" : "BLOQUEADA"}</div>
                  </div>
                  <button
                    className={"btn " + (metrics?.flags?.groupCreationEnabled ? "danger" : "primary")}
                    onClick={()=>setFlags({ groupCreationEnabled: !metrics?.flags?.groupCreationEnabled })}
                  >
                    {metrics?.flags?.groupCreationEnabled ? "Bloquear" : "Liberar"}
                  </button>
                </div>

                <div className="control">
                  <div>
                    <div className="control-title">Congelar Geral</div>
                    <div className="muted">{metrics?.flags?.generalFrozen ? "CONGELADO" : "ATIVO"}</div>
                  </div>
                  <button
                    className={"btn " + (metrics?.flags?.generalFrozen ? "primary" : "danger")}
                    onClick={()=>setFlags({ generalFrozen: !metrics?.flags?.generalFrozen })}
                  >
                    {metrics?.flags?.generalFrozen ? "Descongelar" : "Congelar"}
                  </button>
                </div>
              </div>

              <div className="muted" style={{ marginTop: 10 }}>
                Dica: na aba “Salas”, você congela/descongela qualquer sala individual.
              </div>
            </div>

            <div className="admin-card">
              <h2>Dica</h2>
              <div className="muted">
                Clique em uma sala na aba “Salas” para abrir detalhes: usuários, tempo ativa, ações rápidas e mais.
              </div>
            </div>
          </div>
        )}

        {/* SALAS */}
        {tab === "salas" && (
          <div className="admin-card full">
            <h2>Salas (geral / grupos / dms)</h2>

            <table className="admin-table clickable-rows">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Sala</th>
                  <th>ID</th>
                  <th>Online agora</th>
                  <th>Pico sala</th>
                  <th>Quando</th>
                  <th>Congelada</th>
                </tr>
              </thead>
              <tbody>
                {(metrics?.byRoom || []).map(r => (
                  <tr key={r.id} onClick={()=>openRoomDetails(r.id)}>
                    <td>
                      <span className={"badge " + (r.type==="group" ? "warn" : r.type==="dm" ? "danger" : "good")}>
                        {r.type==="public" ? "Pública" : r.type==="group" ? "Grupo" : "DM"}
                      </span>
                    </td>
                    <td style={{ fontWeight: 900 }}>{r.name}</td>
                    <td className="mono">{r.id}</td>
                    <td><b>{r.onlineNow}</b></td>
                    <td>{r.peakOnline}</td>
                    <td className="mono">{r.peakOnlineAt ? fmtTime(r.peakOnlineAt) : "—"}</td>
                    <td>{r.frozen ? "Sim" : "Não"}</td>
                  </tr>
                ))}
                {(!metrics?.byRoom || metrics.byRoom.length===0) && (
                  <tr><td colSpan="7" className="muted">Sem dados ainda.</td></tr>
                )}
              </tbody>
            </table>

            <div className="muted" style={{ marginTop: 10 }}>
              Clique em uma linha para abrir detalhes da sala.
            </div>
          </div>
        )}

        {/* MODERAÇÃO */}
        {tab === "moderacao" && (
          <div className="admin-grid">
            <div className="admin-card">
              <h2>Usuários online (global)</h2>
              <div className="muted" style={{ marginBottom: 10 }}>
                Selecione uma sala na aba “Salas” para ver usuários por sala. Aqui é uma visão rápida.
              </div>

              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Apelido</th>
                    <th>Sala</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // monta lista rápida a partir de byRoom (apenas contagem) não tem nicks.
                    // então mostramos instrução e levamos o admin para clicar na sala.
                    return (
                      <tr>
                        <td colSpan="3" className="muted">
                          Para moderar usuários (avisar/kick/ban), clique em uma sala na aba “Salas”
                          e use o modal de detalhes (lá tem a lista completa com botões).
                        </td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>

            <div className="admin-card">
              <h2>Bloqueios (IP)</h2>
              <div className="muted">
                IP banido impede o mesmo usuário de voltar (mesmo trocando apelido).<br/>
                A lista detalhada de bans pode ser adicionada no próximo passo.
              </div>
            </div>
          </div>
        )}

        {/* RAM */}
        {tab === "ram" && (
          <div className="admin-grid">
            <div className="admin-card">
              <h2>Consumo de memória (RAM)</h2>
              <div className="admin-badges">
                <span className="badge">RSS: <b>{fmtBytes(ram.rss)}</b></span>
                <span className="badge">Heap usado: <b>{fmtBytes(ram.heapUsed)}</b></span>
                <span className="badge">Heap total: <b>{fmtBytes(ram.heapTotal)}</b></span>
                <span className="badge">External: <b>{fmtBytes(ram.external)}</b></span>
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                RSS é o mais importante (memória total do processo).
              </div>
            </div>

            <div className="admin-card">
              <h2>Observação</h2>
              <div className="muted">
                Como o projeto é sem persistência, o consumo sobe conforme mensagens/imagens/áudios
                e depois cai quando salas ficam vazias e são limpas.
              </div>
            </div>
          </div>
        )}
      </main>

      {/* LOGIN */}
      <Modal open={openLogin} title="Acesso restrito" onClose={()=>nav("/")}>
        <form onSubmit={login} className="form">
          <label>
            Senha do administrador
            <input
              type="password"
              value={pass}
              onChange={(e)=>setPass(e.target.value)}
              placeholder="Digite a senha"
              required
              minLength={4}
            />
          </label>
          <div className="row">
            <button type="button" className="btn" onClick={()=>nav("/")}>Voltar</button>
            <button className="btn primary" type="submit">Entrar</button>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Dica: configure <span className="pill mono">ADMIN_PASS</span> no Render.
          </div>
        </form>
      </Modal>

      {/* MODAL DETALHES SALA */}
      <Modal open={openRoom} title="Detalhes da sala" onClose={()=>setOpenRoom(false)}>
        {roomLoading && <div className="muted">Carregando...</div>}

        {!roomLoading && roomDetail && (
          <div className="room-detail">
            <div className="admin-badges">
              <span className="badge">{roomDetail.type==="public" ? "Pública" : roomDetail.type==="group" ? "Grupo" : "DM"}</span>
              <span className="badge mono">ID: <b>{roomDetail.id}</b></span>
              <span className="badge">Online: <b>{roomDetail.onlineNow}</b></span>
              <span className="badge">Mensagens: <b>{roomDetail.messagesCount}</b></span>
              <span className={"badge " + (roomDetail.frozen ? "warn" : "good")}>
                {roomDetail.frozen ? "CONGELADA" : "ATIVA"}
              </span>
            </div>

            <div className="muted">
              Criada em: <b style={{ color:"var(--text)" }}>{roomDetail.createdAt ? fmtTime(roomDetail.createdAt) : "—"}</b><br/>
              Ativa há: <b style={{ color:"var(--text)" }}>{roomDetail.activeForMs!=null ? fmtDur(roomDetail.activeForMs) : "—"}</b><br/>
              Última atividade: <b style={{ color:"var(--text)" }}>{roomDetail.lastActivityAt ? fmtTime(roomDetail.lastActivityAt) : "—"}</b><br/>
              Pico: <b style={{ color:"var(--text)" }}>{roomDetail.peak?.peak ?? 0}</b> {roomDetail.peak?.at ? `em ${fmtTime(roomDetail.peak.at)}` : ""}
            </div>

            <div className="row" style={{ justifyContent:"space-between" }}>
              <div className="admin-badges">
                <span className="badge">Nome: <b>{roomDetail.name}</b></span>
              </div>
              <div className="row" style={{ justifyContent:"flex-end" }}>
                <button
                  className={"btn " + (roomDetail.frozen ? "primary" : "danger")}
                  type="button"
                  onClick={()=>freezeRoom(roomDetail.id, !roomDetail.frozen)}
                >
                  {roomDetail.frozen ? "Descongelar" : "Congelar"}
                </button>

                {roomDetail.type === "group" && (
                  <button className="btn danger" type="button" onClick={()=>deleteGroup(roomDetail.id)}>
                    Excluir grupo
                  </button>
                )}
              </div>
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 1000, marginBottom: 8 }}>Usuários na sala</div>

              <div className="users-list">
                {(!roomDetail.users || roomDetail.users.length===0) && (
                  <div className="muted">Nenhum usuário nesta sala.</div>
                )}

                {(roomDetail.users || []).map(u => (
                  <div key={u.socketId} className="user-row">
                    <div>
                      <div className="user-nick">{u.nick}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Conectado: {u.connectedAt ? fmtTime(u.connectedAt) : "—"}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Socket: <span className="mono">{u.socketId}</span>
                      </div>
                    </div>

                    <div className="user-actions">
                      <button className="btn" type="button" onClick={()=>openAction("warn", u)}>Avisar</button>
                      <button className="btn danger" type="button" onClick={()=>openAction("kick", u)}>Kick</button>
                      <button className="btn danger" type="button" onClick={()=>openAction("ban", u)}>Ban IP</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="muted" style={{ marginTop: 10 }}>
                * “Ban IP” bloqueia o IP do usuário (mesmo se mudar de apelido).
              </div>
            </div>
          </div>
        )}

        {!roomLoading && !roomDetail && (
          <div className="muted">Sem detalhes.</div>
        )}
      </Modal>

      {/* MODAL AÇÃO MODERAÇÃO */}
      <Modal
        open={actionModal}
        title={actionType === "warn" ? "Enviar aviso" : actionType === "kick" ? "Remover usuário" : "Banir IP"}
        onClose={()=>setActionModal(false)}
      >
        <form onSubmit={runAction} className="form">
          <div className="muted">
            Alvo: <b style={{ color:"var(--text)" }}>{actionTarget?.nick || "—"}</b>{" "}
            <span className="pill mono">{actionTarget?.socketId || ""}</span>
          </div>

          {actionType === "ban" && (
            <label>
              Duração (minutos) — 0 = permanente
              <input
                type="number"
                min="0"
                max="43200"
                value={banMinutes}
                onChange={(e)=>setBanMinutes(e.target.value)}
              />
            </label>
          )}

          <label>
            Mensagem
            <textarea
              value={actionMsg}
              onChange={(e)=>setActionMsg(e.target.value)}
              maxLength={220}
              placeholder="Escreva a mensagem..."
              required
            />
          </label>

          <div className="row">
            <button type="button" className="btn" onClick={()=>setActionModal(false)}>Cancelar</button>
            <button className={"btn " + (actionType === "warn" ? "primary" : "danger")} type="submit">
              Confirmar
            </button>
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            {actionType === "warn" && "Envia um aviso que aparece no chat do usuário."}
            {actionType === "kick" && "Remove o usuário e desconecta imediatamente."}
            {actionType === "ban" && "Bane o IP do usuário (não volta nem mudando o apelido)."}
          </div>
        </form>
      </Modal>
    </div>
  );
}

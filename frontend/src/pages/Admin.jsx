// frontend/src/pages/Admin.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

/* =========================
   Utils
========================= */
function fmtTime(ts){
  if(!ts) return "—";
  return new Date(ts).toLocaleString("pt-BR", {
    day:"2-digit", month:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit"
  });
}
function fmtSince(ts){
  if(!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  return h>0 ? `${h}h ${m}m` : `${m}m ${ss}s`;
}
function fmtDur(ms){
  const s = Math.max(0, Math.floor((ms||0)/1000));
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
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function normalizeSeries(arr){
  const a = Array.isArray(arr) ? arr.map(x => Number(x || 0)) : [];
  if(a.length === 0) return new Array(60).fill(0);
  if(a.length >= 60) return a.slice(-60);
  const pad = new Array(60 - a.length).fill(0);
  return [...pad, ...a];
}

function buildPath(series, w=520, h=150, pad=12){
  const s = normalizeSeries(series);
  const max = Math.max(1, ...s);
  const min = Math.min(...s);
  const span = Math.max(1, max - min);

  const innerW = w - pad*2;
  const innerH = h - pad*2;

  const pts = s.map((v, i) => {
    const x = pad + (i/(s.length-1)) * innerW;
    const y = pad + (1 - ((v - min) / span)) * innerH;
    return {x, y, v};
  });

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for(let i=1;i<pts.length;i++){
    d += ` L ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)}`;
  }
  const area = `${d} L ${pts[pts.length-1].x.toFixed(2)} ${(h-pad).toFixed(2)} L ${pts[0].x.toFixed(2)} ${(h-pad).toFixed(2)} Z`;
  return { d, area, max, min, last: pts[pts.length-1]?.v ?? 0 };
}

/* =========================
   Mini Charts (SVG)
========================= */
function LineGlowChart({ title, subtitle, series, height=160 }){
  const w = 560;
  const h = height;
  const safeId = useMemo(()=>String(title||"chart").replace(/[^\w]+/g,"_"), [title]);
  const { d, area, max, last } = useMemo(()=>buildPath(series, w, h, 14), [series, w, h]);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          <div className="muted">{subtitle}</div>
        </div>
        <div className="chart-meta">
          <span className="badge good">Agora: <b>{last}</b></span>
          <span className="badge warn">Pico: <b>{max}</b></span>
        </div>
      </div>

      <div className="chart-wrap">
        <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id={`gArea_${safeId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(45,108,223,.35)"/>
              <stop offset="100%" stopColor="rgba(45,108,223,0)"/>
            </linearGradient>
            <filter id={`softGlow_${safeId}`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3" result="blur"/>
              <feMerge>
                <feMergeNode in="blur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>

          <path d={area} fill={`url(#gArea_${safeId})`} />
          <path d={d} fill="none" stroke="rgba(45,108,223,.95)" strokeWidth="2.6" filter={`url(#softGlow_${safeId})`} />
        </svg>
      </div>
    </div>
  );
}

function PieCard({ title, subtitle, items }){
  const total = items.reduce((a,b)=>a+Number(b.value||0), 0) || 1;
  const segs = items
    .map(x => ({ ...x, value: Number(x.value||0) }))
    .filter(x => x.value > 0);

  const stops = [];
  let acc = 0;
  for(const it of segs){
    const p = (it.value / total) * 100;
    const from = acc;
    const to = acc + p;
    const hue = (Math.floor(from * 3.6) + 210) % 360;
    stops.push({ from, to, color: `hsla(${hue}, 85%, 60%, .92)` });
    acc = to;
  }

  const conic = stops.length
    ? `conic-gradient(${stops.map(s => `${s.color} ${s.from}% ${s.to}%`).join(",")})`
    : `conic-gradient(rgba(255,255,255,.12) 0% 100%)`;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          <div className="muted">{subtitle}</div>
        </div>
        <div className="chart-meta">
          <span className="badge mono">Total: <b>{total}</b></span>
        </div>
      </div>

      <div className="pie-row">
        <div className="pie" style={{ backgroundImage: conic }} />
        <div className="pie-legend">
          {items.map((it, idx)=>(
            <div key={idx} className="legend-row">
              <div className="legend-dot" />
              <div className="legend-label">{it.label}</div>
              <div className="legend-val"><b>{it.value}</b></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* =========================
   Main Admin
========================= */
export default function Admin(){
  const nav = useNavigate();

  const [toast, setToast] = useState("");
  const [openLogin, setOpenLogin] = useState(false);
  const [pass, setPass] = useState("");

  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || "");
  const [exp, setExp] = useState(() => Number(sessionStorage.getItem("admin_exp") || 0));

  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);

  // tabs
  const [tab, setTab] = useState("visao"); // visao | salas | moderacao | bans | ram
  const [filter, setFilter] = useState("");

  // modal sala
  const [openRoom, setOpenRoom] = useState(false);
  const [roomDetail, setRoomDetail] = useState(null);
  const [roomLoading, setRoomLoading] = useState(false);

  // moderação (actions)
  const [actionModal, setActionModal] = useState(false);
  const [actionTarget, setActionTarget] = useState(null); // {socketId,nick,connectedAt}
  const [actionType, setActionType] = useState("warn"); // warn|kick|ban
  const [actionMsg, setActionMsg] = useState("");
  const [banMinutes, setBanMinutes] = useState(60);

  // bans list (feature-detect)
  const [bans, setBans] = useState([]);
  const [bansSupported, setBansSupported] = useState(true);
  const [bansLoading, setBansLoading] = useState(false);

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

  async function loadBans(){
    if(!isAuthed) return;
    setBansLoading(true);
    try{
      const j = await api("/api/admin/bans"); // se existir no backend
      setBans(Array.isArray(j?.bans) ? j.bans : []);
      setBansSupported(true);
    }catch(e){
      const msg = String(e.message || "");
      if(msg.includes("404") || msg.toLowerCase().includes("rota")){
        setBansSupported(false);
      }else{
        setToast(e.message || "Falha ao carregar bans.");
      }
    }finally{
      setBansLoading(false);
    }
  }

  async function unban(ip){
    if(!ip) return;
    const ok = window.confirm(`Desbanir IP ${ip}?`);
    if(!ok) return;
    try{
      await api("/api/admin/unban", { method:"POST", body: JSON.stringify({ ip }) });
      setToast("IP desbanido.");
      loadBans();
    }catch(e){
      setToast(e.message || "Falha ao desbanir.");
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

  useEffect(()=>{
    if(tab === "bans"){
      loadBans();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function openRoomDetails(id){
    if(!id || !isAuthed) return;

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
      const j = await api("/api/admin/flags", { method:"POST", body: JSON.stringify(partial) });
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
    setActionMsg(
      type === "warn" ? "Por favor, mantenha o respeito e siga as regras." :
      type === "kick" ? "Você foi removido pelo administrador." :
      "Acesso bloqueado pelo administrador."
    );
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
          body: JSON.stringify({ socketId: actionTarget.socketId, message: actionMsg })
        });
        setToast("Aviso enviado.");
      }else if(actionType === "kick"){
        await api("/api/admin/kick", {
          method:"POST",
          body: JSON.stringify({ socketId: actionTarget.socketId, message: actionMsg })
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
      if(roomDetail?.id) openRoomDetails(roomDetail.id);
    }catch(e2){
      setToast(e2.message || "Falha na ação.");
    }
  }

  /* =========================
     Derived
  ========================= */
  const uptimeSec = metrics?.uptimeSec || 0;
  const ram = metrics?.ram || {};
  const seriesOnline = metrics?.series?.onlineLast60 || [];
  const seriesMsgs = metrics?.series?.msgsLast60 || [];

  const byRoom = Array.isArray(metrics?.byRoom) ? metrics.byRoom : [];

  const filteredRooms = useMemo(()=>{
    const f = String(filter || "").trim().toLowerCase();
    if(!f) return byRoom;
    return byRoom.filter(r => {
      const hay = `${r.name} ${r.id} ${r.type}`.toLowerCase();
      return hay.includes(f);
    });
  }, [byRoom, filter]);

  const roomsSummary = useMemo(()=>{
    const pub = byRoom.filter(r=>r.type==="public").length;
    const grp = byRoom.filter(r=>r.type==="group").length;
    const dm = byRoom.filter(r=>r.type==="dm").length;
    return { pub, grp, dm };
  }, [byRoom]);

  const onlineDistribution = useMemo(()=>{
    const pub = byRoom.filter(r=>r.type==="public").reduce((a,b)=>a+(b.onlineNow||0),0);
    const grp = byRoom.filter(r=>r.type==="group").reduce((a,b)=>a+(b.onlineNow||0),0);
    const dm = byRoom.filter(r=>r.type==="dm").reduce((a,b)=>a+(b.onlineNow||0),0);
    return [
      { label: "Geral/Públicas", value: pub },
      { label: "Grupos", value: grp },
      { label: "Privados (DM)", value: dm },
    ];
  }, [byRoom]);

  const topRooms = useMemo(()=>{
    return [...byRoom]
      .sort((a,b)=> (b.onlineNow - a.onlineNow) || (b.messagesCount - a.messagesCount))
      .slice(0, 6)
      .map(r => ({ label: r.name.length>14 ? r.name.slice(0,14)+"…" : r.name, value: r.onlineNow||0 }));
  }, [byRoom]);

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
            <span className="badge good">Online: <b>{metrics?.onlineNow ?? "—"}</b></span>
          </div>
        </div>

        {/* TABS */}
        <div className="tabs">
          <button className={"tab " + (tab==="visao" ? "active" : "")} onClick={()=>setTab("visao")}>Visão geral</button>
          <button className={"tab " + (tab==="salas" ? "active" : "")} onClick={()=>setTab("salas")}>Salas</button>
          <button className={"tab " + (tab==="moderacao" ? "active" : "")} onClick={()=>setTab("moderacao")}>Moderação</button>
          <button className={"tab " + (tab==="bans" ? "active" : "")} onClick={()=>setTab("bans")}>Bloqueios</button>
          <button className={"tab " + (tab==="ram" ? "active" : "")} onClick={()=>setTab("ram")}>RAM</button>
        </div>

        {/* VISÃO GERAL */}
        {tab === "visao" && (
          <>
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
                <h2>Picos + Sessão</h2>
                <div className="admin-badges">
                  <span className="badge warn">Pico online: <b>{metrics?.peakOnline ?? "—"}</b></span>
                  <span className="badge mono">Quando: {metrics?.peakOnlineAt ? fmtTime(metrics.peakOnlineAt) : "—"}</span>
                </div>
                <div className="admin-badges" style={{ marginTop: 10 }}>
                  <span className="badge good">Sessão média (agora): <b>{metrics ? fmtDur(metrics.avgSessionNowMs || 0) : "—"}</b></span>
                  <span className="badge">Sessão média (boot): <b>{metrics ? fmtDur(metrics.avgSessionAllMs || 0) : "—"}</b></span>
                  <span className="badge mono">Encerradas: <b>{metrics?.sessionsClosedCount ?? "—"}</b></span>
                </div>
                <div className="muted" style={{ marginTop: 10 }}>
                  Métricas são em RAM (desde o boot).
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
                  Dica: na aba “Salas”, você congela/descongela qualquer sala.
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
            </div>

            <div className="admin-grid" style={{ marginTop: 14 }}>
              <LineGlowChart
                title="Online (últimos 60s)"
                subtitle="Curva com picos em tempo real (servidor)"
                series={seriesOnline}
              />
              <LineGlowChart
                title="Mensagens (últimos 60s)"
                subtitle="Volume por segundo, somado (Geral + Grupos + DMs)"
                series={seriesMsgs}
              />
              <PieCard
                title="Distribuição de usuários (agora)"
                subtitle="Como o online está dividido"
                items={onlineDistribution}
              />
              <PieCard
                title="Top salas (online agora)"
                subtitle="As 6 salas com maior presença"
                items={topRooms.length ? topRooms : [{label:"Sem dados", value:0}]}
              />
            </div>
          </>
        )}

        {/* SALAS */}
        {tab === "salas" && (
          <div className="admin-card full">
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap: 12, flexWrap:"wrap" }}>
              <div>
                <h2 style={{ marginBottom: 6 }}>Salas (geral / grupos / dms)</h2>
                <div className="muted">
                  Tipos: Públicas <b>{roomsSummary.pub}</b> • Grupos <b>{roomsSummary.grp}</b> • DMs <b>{roomsSummary.dm}</b>
                </div>
              </div>

              <div style={{ display:"flex", gap: 10, alignItems:"center", flexWrap:"wrap" }}>
                <input
                  className="home-input"
                  style={{ width: 320 }}
                  value={filter}
                  onChange={(e)=>setFilter(e.target.value)}
                  placeholder="Filtrar por nome, id ou tipo…"
                />
                <button className="btn" onClick={()=>setFilter("")}>Limpar</button>
              </div>
            </div>

            <table className="admin-table clickable-rows" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Sala</th>
                  <th>ID</th>
                  <th>Online agora</th>
                  <th>Msgs</th>
                  <th>Pico sala</th>
                  <th>Quando</th>
                  <th>Congelada</th>
                </tr>
              </thead>
              <tbody>
                {filteredRooms.map(r => (
                  <tr key={r.id} onClick={()=>openRoomDetails(r.id)}>
                    <td>
                      <span className={"badge " + (r.type==="group" ? "warn" : r.type==="dm" ? "danger" : "good")}>
                        {r.type==="public" ? "Pública" : r.type==="group" ? "Grupo" : "DM"}
                      </span>
                    </td>
                    <td style={{ fontWeight: 900 }}>{r.name}</td>
                    <td className="mono">{r.id}</td>
                    <td><b>{r.onlineNow}</b></td>
                    <td>{r.messagesCount}</td>
                    <td>{r.peakOnline}</td>
                    <td className="mono">{r.peakOnlineAt ? fmtTime(r.peakOnlineAt) : "—"}</td>
                    <td>{r.frozen ? "Sim" : "Não"}</td>
                  </tr>
                ))}
                {filteredRooms.length === 0 && (
                  <tr><td colSpan="8" className="muted">Nenhuma sala encontrada.</td></tr>
                )}
              </tbody>
            </table>

            <div className="muted" style={{ marginTop: 10 }}>
              Clique em uma sala para abrir detalhes (tempo ativa, usuários, ações).
            </div>
          </div>
        )}

        {/* MODERAÇÃO */}
        {tab === "moderacao" && (
          <div className="admin-grid">
            <div className="admin-card">
              <h2>Fluxo de moderação</h2>
              <div className="muted">
                1) Vá em <b>Salas</b> • 2) Clique na sala • 3) No modal, use <b>Avisar/Kick/Ban IP</b>.
              </div>
              <div className="muted" style={{ marginTop: 10 }}>
                Dica: “Congelar” bloqueia envio (Geral/Grupo/DM). “Excluir grupo” derruba o grupo inteiro.
              </div>
            </div>

            <div className="admin-card">
              <h2>Atalhos</h2>
              <div className="controls">
                <div className="control">
                  <div>
                    <div className="control-title">Abrir salas</div>
                    <div className="muted">Gerencie salas e usuários</div>
                  </div>
                  <button className="btn primary" onClick={()=>setTab("salas")}>Ir para Salas</button>
                </div>

                <div className="control">
                  <div>
                    <div className="control-title">Bloqueios (IP)</div>
                    <div className="muted">Ver e desbanir</div>
                  </div>
                  <button className="btn" onClick={()=>setTab("bans")}>Ir para Bloqueios</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BANS */}
        {tab === "bans" && (
          <div className="admin-card full">
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap: 12, flexWrap:"wrap" }}>
              <div>
                <h2 style={{ marginBottom: 6 }}>Bloqueios (IP)</h2>
                <div className="muted">Lista e desbanimento (quando suportado pelo backend).</div>
              </div>

              <div style={{ display:"flex", gap: 10 }}>
                <button className="btn" onClick={loadBans} disabled={!bansSupported || bansLoading}>
                  {bansLoading ? "Carregando..." : "Atualizar"}
                </button>
              </div>
            </div>

            {!bansSupported && (
              <div className="muted" style={{ marginTop: 12 }}>
                Sua API ainda não expõe <span className="pill mono">/api/admin/bans</span> e
                <span className="pill mono"> /api/admin/unban</span>.
                Quando você quiser, eu te passo o backend desses endpoints.
              </div>
            )}

            {bansSupported && (
              <table className="admin-table" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>IP</th>
                    <th>Até</th>
                    <th>Motivo</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {bans.map((b, idx)=>(
                    <tr key={idx}>
                      <td className="mono">{b.ip || "—"}</td>
                      <td className="mono">{b.until ? fmtTime(b.until) : "Permanente"}</td>
                      <td>{b.reason || "—"}</td>
                      <td>
                        <button className="btn" onClick={()=>unban(b.ip)}>Desbanir</button>
                      </td>
                    </tr>
                  ))}
                  {bans.length === 0 && (
                    <tr><td colSpan="4" className="muted">Nenhum ban ativo.</td></tr>
                  )}
                </tbody>
              </table>
            )}
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

            <PieCard
              title="RAM (proporção)"
              subtitle="Heap usado vs heap livre + External"
              items={[
                { label: "Heap usado", value: ram.heapUsed || 0 },
                { label: "Heap livre", value: Math.max(0, (ram.heapTotal||0) - (ram.heapUsed||0)) },
                { label: "External", value: ram.external || 0 },
              ]}
            />

            <div className="admin-card">
              <h2>Observação</h2>
              <div className="muted">
                Como não há banco, o consumo cresce conforme mensagens/imagens/áudios,
                e cai quando salas ficam vazias e são limpas.
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
              <span className="badge">
                {roomDetail.type==="public" ? "Pública" : roomDetail.type==="group" ? "Grupo" : "DM"}
              </span>
              <span className="badge mono">ID: <b>{roomDetail.id}</b></span>
              <span className="badge good">Online: <b>{roomDetail.onlineNow}</b></span>
              <span className="badge">Mensagens: <b>{roomDetail.messagesCount}</b></span>
              <span className={"badge " + (roomDetail.frozen ? "warn" : "good")}>
                {roomDetail.frozen ? "CONGELADA" : "ATIVA"}
              </span>
            </div>

            <div className="muted" style={{ marginTop: 8 }}>
              Criada em: <b style={{ color:"var(--text)" }}>{roomDetail.createdAt ? fmtTime(roomDetail.createdAt) : "—"}</b><br/>
              Ativa há: <b style={{ color:"var(--text)" }}>{roomDetail.activeForMs!=null ? fmtDur(roomDetail.activeForMs) : "—"}</b><br/>
              Última atividade: <b style={{ color:"var(--text)" }}>{roomDetail.lastActivityAt ? fmtTime(roomDetail.lastActivityAt) : "—"}</b><br/>
              Pico: <b style={{ color:"var(--text)" }}>{roomDetail.peak?.peak ?? 0}</b> {roomDetail.peak?.at ? `em ${fmtTime(roomDetail.peak.at)}` : ""}
            </div>

            <div className="row" style={{ justifyContent:"space-between", marginTop: 10 }}>
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

            <div style={{ marginTop: 10 }}>
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
                onChange={(e)=>setBanMinutes(clamp(Number(e.target.value||0), 0, 43200))}
              />
            </label>
          )}

          <label>
            Mensagem
            <textarea
              value={actionMsg}
              onChange={(e)=>setActionMsg(e.target.value)}
              placeholder="Digite a mensagem…"
              maxLength={220}
              rows={4}
              required
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {String(actionMsg || "").length}/220
            </div>
          </label>

          <div className="row" style={{ justifyContent:"flex-end" }}>
            <button type="button" className="btn" onClick={()=>setActionModal(false)}>Cancelar</button>
            <button
              className={"btn " + (actionType === "warn" ? "primary" : "danger")}
              type="submit"
            >
              {actionType === "warn" ? "Enviar aviso" : actionType === "kick" ? "Remover" : "Banir IP"}
            </button>
          </div>

          <div className="muted" style={{ marginTop: 8 }}>
            Dica: você pode congelar a sala antes de agir, para parar o fluxo.
          </div>
        </form>
      </Modal>
    </div>
  );
}

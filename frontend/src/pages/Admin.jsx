import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

/* =======================
   Utils
======================= */
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
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function seriesStats(arr){
  const a = Array.isArray(arr) ? arr : [];
  if(!a.length) return { min:0, max:0, last:0, avg:0 };
  let min = Infinity, max = -Infinity, sum = 0;
  for(const v of a){
    const n = Number(v||0);
    min = Math.min(min, n);
    max = Math.max(max, n);
    sum += n;
  }
  return { min, max, last: Number(a[a.length-1]||0), avg: sum/a.length };
}

/* =======================
   Mini Charts (SVG)
======================= */
function LineAreaChart({ data=[], height=78, padding=8, labelLeft="", labelRight="", asCount=true }){
  const w = 320; // viewBox width
  const h = height;
  const a = Array.isArray(data) ? data.map(x=>Number(x||0)) : [];
  const { max } = seriesStats(a);
  const m = Math.max(1, max);

  const innerW = w - padding*2;
  const innerH = h - padding*2;

  const pts = a.map((v,i)=>{
    const x = padding + (a.length<=1 ? 0 : (i/(a.length-1))*innerW);
    const y = padding + (1 - (v/m))*innerH;
    return { x, y, v };
  });

  const dLine = pts.map((p,i)=>`${i===0?"M":"L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const dArea = `${dLine} L ${(padding+innerW).toFixed(2)} ${(padding+innerH).toFixed(2)} L ${padding.toFixed(2)} ${(padding+innerH).toFixed(2)} Z`;

  const last = a.length ? a[a.length-1] : 0;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="muted">{labelLeft}</span>
        <span className="badge mono">{asCount ? String(last) : fmtDur(last)}</span>
        <span className="muted">{labelRight}</span>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="svgchart" role="img" aria-label="Gráfico">
        <defs>
          <linearGradient id="gradA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* baseline */}
        <path d={`M ${padding} ${padding+innerH} L ${padding+innerW} ${padding+innerH}`} className="gridline" />
        {/* area */}
        <path d={dArea} fill="url(#gradA)" />
        {/* line */}
        <path d={dLine} className="line" />
        {/* last dot */}
        {pts.length>0 && (
          <circle cx={pts[pts.length-1].x} cy={pts[pts.length-1].y} r="3.4" className="dot" />
        )}
      </svg>
    </div>
  );
}

function PieChart({ parts=[], size=110 }){
  // parts: [{label, value}]
  const total = parts.reduce((s,p)=>s+Math.max(0,Number(p.value||0)),0) || 1;
  const r = 42;
  const cx = 55, cy = 55;
  const C = 2*Math.PI*r;

  let acc = 0;
  const segs = parts.map((p, idx)=>{
    const v = Math.max(0, Number(p.value||0));
    const frac = v / total;
    const len = frac * C;
    const dash = `${len.toFixed(2)} ${(C-len).toFixed(2)}`;
    const off = (C*acc);
    acc += frac;
    return { ...p, dash, off, idx };
  });

  return (
    <div className="pie">
      <svg viewBox="0 0 110 110" width={size} height={size} className="svgpie" role="img" aria-label="Pizza">
        <circle cx={cx} cy={cy} r={r} className="pie-bg" />
        {segs.map((s)=>(
          <circle
            key={s.idx}
            cx={cx} cy={cy} r={r}
            className={`pie-seg seg-${s.idx%4}`}
            strokeDasharray={s.dash}
            strokeDashoffset={(-s.off).toFixed(2)}
          />
        ))}
        <circle cx={cx} cy={cy} r={r-12} className="pie-hole" />
        <text x={55} y={58} textAnchor="middle" className="pie-text">{total}</text>
        <text x={55} y={74} textAnchor="middle" className="pie-sub">salas</text>
      </svg>

      <div className="pie-legend">
        {parts.map((p, idx)=>(
          <div key={idx} className="legend-item">
            <span className={`legend-dot seg-${idx%4}`} />
            <span>{p.label}</span>
            <b>{p.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =======================
   Page
======================= */
const TABS = [
  { id:"visao", label:"Visão geral" },
  { id:"online", label:"Online" },
  { id:"sessoes", label:"Sessões" },
  { id:"mensagens", label:"Mensagens" },
  { id:"memoria", label:"Memória" },
  { id:"salas", label:"Salas & Grupos" },
  { id:"moderacao", label:"Moderação" },
];

export default function Admin(){
  const nav = useNavigate();

  const [tab, setTab] = useState("visao");

  const [toast, setToast] = useState("");
  const [openLogin, setOpenLogin] = useState(false);
  const [pass, setPass] = useState("");

  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || "");
  const [exp, setExp] = useState(() => Number(sessionStorage.getItem("admin_exp") || 0));

  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(false);

  // Room detail modal
  const [roomOpen, setRoomOpen] = useState(false);
  const [roomDetail, setRoomDetail] = useState(null);
  const [roomLoading, setRoomLoading] = useState(false);

  // Moderação modal
  const [modOpen, setModOpen] = useState(false);
  const [modTarget, setModTarget] = useState(null); // { socketId, nick, roomId }
  const [modMsg, setModMsg] = useState("Por favor, respeite as regras. Caso continue, seu acesso poderá ser bloqueado.");
  const [banMinutes, setBanMinutes] = useState(30);

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
    setToast("Sessão encerrada.");
  }

  async function loadMetrics({ silent=false } = {}){
    if(!isAuthed) return;
    if(!silent) setLoading(true);
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
      if(!silent) setLoading(false);
    }
  }

  useEffect(()=>{
    if(!isAuthed){
      setOpenLogin(true);
      return;
    }
    loadMetrics();
    const t = setInterval(()=>loadMetrics({ silent:true }), 2000);
    return ()=>clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  const ram = metrics?.ram || {};
  const uptimeSec = metrics?.uptimeSec || 0;
  const seriesOnline = metrics?.series?.onlineLast60 || [];
  const seriesMsgs = metrics?.series?.msgsLast60 || [];

  const roomsList = metrics?.byRoom || [];
  const publicCount = roomsList.filter(r=>r.type==="public").length;
  const groupCount = roomsList.filter(r=>r.type==="group").length;
  const dmCount = roomsList.filter(r=>r.type==="dm").length;

  async function openRoom(id){
    if(!id) return;
    setRoomOpen(true);
    setRoomDetail(null);
    setRoomLoading(true);
    try{
      const j = await api(`/api/admin/room/${encodeURIComponent(id)}`);
      setRoomDetail(j);
    }catch(e){
      setToast(e.message || "Erro ao abrir sala");
      setRoomOpen(false);
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
      setMetrics(m => m ? ({...m, flags: j.flags}) : m);
      await loadMetrics({ silent:true });
    }catch(e){
      setToast(e.message || "Falha ao atualizar flags");
    }
  }

  async function toggleFreezeRoom(roomId, freeze){
    try{
      await api(`/api/admin/room/${encodeURIComponent(roomId)}/freeze`, {
        method:"POST",
        body: JSON.stringify({ freeze })
      });
      setToast(freeze ? "Sala congelada." : "Sala descongelada.");
      await loadMetrics({ silent:true });
      if(roomOpen && roomDetail?.room?.id === roomId){
        await openRoom(roomId);
      }
    }catch(e){
      setToast(e.message || "Falha ao congelar/descongelar");
    }
  }

  async function deleteGroup(roomId){
    if(!confirm("Tem certeza que deseja ENCERRAR este grupo? Isso desconecta todos e apaga as mensagens.")) return;
    try{
      await api(`/api/admin/room/${encodeURIComponent(roomId)}`, { method:"DELETE" });
      setToast("Grupo encerrado.");
      setRoomOpen(false);
      await loadMetrics();
    }catch(e){
      setToast(e.message || "Falha ao encerrar grupo");
    }
  }

  function openMod(user, roomId){
    setModTarget({ socketId: user.socketId, nick: user.nick, roomId });
    setModOpen(true);
  }

  async function doWarn(){
    if(!modTarget?.socketId) return;
    try{
      await api("/api/admin/warn", {
        method:"POST",
        body: JSON.stringify({ socketId: modTarget.socketId, message: modMsg })
      });
      setToast("Aviso enviado.");
      setModOpen(false);
    }catch(e){
      setToast(e.message || "Falha ao enviar aviso");
    }
  }
  async function doKick(){
    if(!modTarget?.socketId) return;
    try{
      await api("/api/admin/kick", {
        method:"POST",
        body: JSON.stringify({ socketId: modTarget.socketId, message: modMsg })
      });
      setToast("Usuário removido.");
      setModOpen(false);
      await loadMetrics({ silent:true });
    }catch(e){
      setToast(e.message || "Falha ao remover");
    }
  }
  async function doBan(){
    if(!modTarget?.socketId) return;
    try{
      await api("/api/admin/ban-ip", {
        method:"POST",
        body: JSON.stringify({
          socketId: modTarget.socketId,
          minutes: Number(banMinutes || 0),
          reason: modMsg
        })
      });
      setToast("IP banido.");
      setModOpen(false);
      await loadMetrics({ silent:true });
    }catch(e){
      setToast(e.message || "Falha ao banir");
    }
  }

  // ---------------- UI blocks ----------------
  const flagsUI = (
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
            <div className="control-title">Sala Geral</div>
            <div className="muted">{metrics?.flags?.generalFrozen ? "CONGELADA (ninguém envia msg)" : "ATIVA"}</div>
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
        Congelar = impede envio de mensagens (continua lendo).
      </div>
    </div>
  );

  const headerRight = (
    <div className="top-actions">
      <button className="btn" onClick={()=>loadMetrics()} disabled={!isAuthed || loading}>
        {loading ? "Atualizando..." : "Atualizar"}
      </button>
      <button className="btn danger" onClick={logout} disabled={!isAuthed}>
        Sair
      </button>
    </div>
  );

  return (
    <div className="shell">
      <Toast msg={toast} onClose={()=>setToast("")} />

      <header className="topbar">
        <div className="brand clickable" onClick={()=>nav("/")}>
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">Área Reservada</div>
            <div className="brand-sub">Painel administrativo</div>
          </div>
        </div>
        {headerRight}
      </header>

      <main className="admin-shell">
        {/* Hero */}
        <div className="admin-hero">
          <div>
            <div className="admin-title">Admin • Monitoramento em tempo real</div>
            <div className="admin-sub">
              Boot: <b>{metrics?.bootAt ? fmtSince(metrics.bootAt) : "—"}</b>
              {" "}• Uptime: <b>{uptimeSec}s</b>
              {" "}• Atualiza a cada 2s
            </div>
          </div>
          <div className="admin-tools">
            <span className="badge mono">Sessão: {exp ? fmtTime(exp) : "—"}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="tabs">
          {TABS.map(t=>(
            <button
              key={t.id}
              className={"tab " + (tab===t.id ? "active" : "")}
              onClick={()=>setTab(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {!metrics ? (
          <div className="admin-card">
            <h2>Carregando…</h2>
            <div className="muted">Aguardando dados do servidor.</div>
          </div>
        ) : (
          <>
            {/* VISÃO GERAL */}
            {tab==="visao" && (
              <div className="admin-grid">
                {flagsUI}

                <div className="admin-card">
                  <h2>Resumo</h2>
                  <div className="admin-badges">
                    <span className="badge good">Online: <b>{metrics.onlineNow}</b></span>
                    <span className="badge warn">Pico global: <b>{metrics.peakOnline}</b></span>
                    <span className="badge mono">Quando: <b>{metrics.peakOnlineAt ? fmtTime(metrics.peakOnlineAt) : "—"}</b></span>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <LineAreaChart
                      data={seriesOnline}
                      labelLeft="Online (últimos 60s)"
                      labelRight={`pico60: ${metrics.peakOnlineLast60}`}
                    />
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Mensagens</h2>
                  <div className="admin-badges">
                    <span className="badge good">Agora (60s): <b>{metrics.msgsPerMinNow}</b></span>
                    <span className="badge warn">Pico: <b>{metrics.peakMsgsPerMin}</b></span>
                    <span className="badge mono">Quando: <b>{metrics.peakMsgsPerMinAt ? fmtTime(metrics.peakMsgsPerMinAt) : "—"}</b></span>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <LineAreaChart
                      data={seriesMsgs}
                      labelLeft="Mensagens (últimos 60s)"
                      labelRight="(geral + grupos + dms)"
                    />
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Distribuição de salas</h2>
                  <PieChart
                    parts={[
                      { label:"Públicas", value: publicCount },
                      { label:"Grupos", value: groupCount },
                      { label:"DMs", value: dmCount },
                    ]}
                  />
                  <div className="muted" style={{ marginTop: 8 }}>
                    DMs aparecem quando alguém abre um privado.
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Memória (agora)</h2>
                  <div className="admin-badges">
                    <span className="badge">RSS: <b>{fmtBytes(ram.rss)}</b></span>
                    <span className="badge">Heap: <b>{fmtBytes(ram.heapUsed)}</b> / {fmtBytes(ram.heapTotal)}</span>
                    <span className="badge">External: <b>{fmtBytes(ram.external)}</b></span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    RSS é a memória total do processo.
                  </div>
                </div>
              </div>
            )}

            {/* ONLINE */}
            {tab==="online" && (
              <div className="admin-grid">
                <div className="admin-card">
                  <h2>Online agora</h2>
                  <div className="admin-badges">
                    <span className="badge good">Online: <b>{metrics.onlineNow}</b></span>
                    <span className="badge">Salas: <b>{metrics.roomsTotal}</b></span>
                    <span className="badge">Grupos: <b>{metrics.groupsTotal}</b></span>
                    <span className="badge">DMs: <b>{metrics.dmActive}</b></span>
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <LineAreaChart
                      data={seriesOnline}
                      labelLeft="Online (60s)"
                      labelRight={`pico60: ${metrics.peakOnlineLast60}`}
                    />
                  </div>

                  <div className="muted" style={{ marginTop: 8 }}>
                    Pico global (desde o boot): {metrics.peakOnline} em {metrics.peakOnlineAt ? fmtTime(metrics.peakOnlineAt) : "—"}
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Controles rápidos</h2>
                  {flagsUI}
                </div>
              </div>
            )}

            {/* SESSÕES */}
            {tab==="sessoes" && (
              <div className="admin-grid">
                <div className="admin-card">
                  <h2>Tempo médio de sessão</h2>
                  <div className="admin-badges">
                    <span className="badge good">Online agora: <b>{fmtDur(metrics.avgSessionNowMs || 0)}</b></span>
                    <span className="badge">Histórico (boot): <b>{fmtDur(metrics.avgSessionAllMs || 0)}</b></span>
                    <span className="badge mono">Encerradas: <b>{metrics.sessionsClosedCount}</b></span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Histórico inclui sessões encerradas + ativas (desde o boot).
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Uptime</h2>
                  <div className="admin-badges">
                    <span className="badge mono">Uptime: <b>{uptimeSec}s</b></span>
                    <span className="badge mono">Boot: <b>{metrics.bootAt ? fmtTime(metrics.bootAt) : "—"}</b></span>
                  </div>
                </div>
              </div>
            )}

            {/* MENSAGENS */}
            {tab==="mensagens" && (
              <div className="admin-grid">
                <div className="admin-card">
                  <h2>Mensagens por minuto</h2>
                  <div className="admin-badges">
                    <span className="badge good">Agora (60s): <b>{metrics.msgsPerMinNow}</b></span>
                    <span className="badge warn">Pico: <b>{metrics.peakMsgsPerMin}</b></span>
                    <span className="badge mono">Quando: <b>{metrics.peakMsgsPerMinAt ? fmtTime(metrics.peakMsgsPerMinAt) : "—"}</b></span>
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <LineAreaChart
                      data={seriesMsgs}
                      labelLeft="Mensagens (60s)"
                      labelRight="tempo real"
                    />
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Conta geral + grupos + DMs.
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Congelar geral</h2>
                  <div className="muted">Use isso quando houver spam.</div>
                  <div style={{ marginTop: 10 }}>
                    <button
                      className={"btn " + (metrics.flags?.generalFrozen ? "primary" : "danger")}
                      onClick={()=>setFlags({ generalFrozen: !metrics.flags?.generalFrozen })}
                    >
                      {metrics.flags?.generalFrozen ? "Descongelar Geral" : "Congelar Geral"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* MEMÓRIA */}
            {tab==="memoria" && (
              <div className="admin-grid">
                <div className="admin-card">
                  <h2>Consumo de RAM</h2>
                  <div className="admin-badges">
                    <span className="badge">RSS: <b>{fmtBytes(ram.rss)}</b></span>
                    <span className="badge">Heap usado: <b>{fmtBytes(ram.heapUsed)}</b></span>
                    <span className="badge">Heap total: <b>{fmtBytes(ram.heapTotal)}</b></span>
                    <span className="badge">External: <b>{fmtBytes(ram.external)}</b></span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Se o RSS subir muito, pode ser excesso de uploads (imagem/áudio) — reduza limites.
                  </div>
                </div>

                <div className="admin-card">
                  <h2>Boas práticas</h2>
                  <ul className="list">
                    <li>Evite arquivos grandes (áudio/foto) para manter memória baixa.</li>
                    <li>Grupos e DMs são apagados quando ficam vazios.</li>
                    <li>Reinício do Render zera picos/histórico (sem persistência).</li>
                  </ul>
                </div>
              </div>
            )}

            {/* SALAS */}
            {tab==="salas" && (
              <>
                <div className="admin-card">
                  <h2>Salas (clique para detalhes)</h2>
                  <div className="muted">Ao clicar em uma sala, você vê usuários, tempo ativa e ações.</div>

                  <table className="admin-table clickable-rows">
                    <thead>
                      <tr>
                        <th>Tipo</th>
                        <th>Sala</th>
                        <th>ID</th>
                        <th>Online</th>
                        <th>Pico</th>
                        <th>Congelada</th>
                        <th>Última atividade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(roomsList || []).map(r => (
                        <tr key={r.id} onClick={()=>openRoom(r.id)}>
                          <td>
                            <span className={"badge " + (r.type==="group" ? "warn" : r.type==="dm" ? "danger" : "good")}>
                              {r.type==="public" ? "Pública" : r.type==="group" ? "Grupo" : "DM"}
                            </span>
                          </td>
                          <td style={{ fontWeight: 900 }}>{r.name}</td>
                          <td className="mono">{r.id}</td>
                          <td><b>{r.onlineNow}</b></td>
                          <td>{r.peakOnline}</td>
                          <td>{r.frozen ? <span className="badge danger">Sim</span> : <span className="badge good">Não</span>}</td>
                          <td className="mono">{r.lastActivityAt ? fmtTime(r.lastActivityAt) : "—"}</td>
                        </tr>
                      ))}
                      {(!roomsList || roomsList.length===0) && (
                        <tr><td colSpan="7" className="muted">Sem dados ainda.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* MODERAÇÃO */}
            {tab==="moderacao" && (
              <div className="admin-grid">
                {flagsUI}

                <div className="admin-card">
                  <h2>Como moderar</h2>
                  <div className="muted">
                    Abra uma sala em <b>Salas & Grupos</b>, veja a lista de usuários e clique em “Moderar”.
                    <br/>
                    Ações disponíveis: <b>Aviso</b>, <b>Remover</b>, <b>Banir IP</b>.
                  </div>
                  <div className="muted" style={{ marginTop: 10 }}>
                    Obs: ban por IP pode ser impreciso se várias pessoas estiverem na mesma rede.
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Modal login */}
      <Modal open={openLogin} title="Acesso restrito">
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

      {/* Modal detalhes sala */}
      <Modal open={roomOpen} title="Detalhes da sala" onClose={()=>setRoomOpen(false)}>
        {roomLoading && <div className="muted">Carregando…</div>}

        {!roomLoading && roomDetail?.room && (
          <div className="room-detail">
            <div className="admin-badges" style={{ marginBottom: 10 }}>
              <span className="badge mono">ID: <b>{roomDetail.room.id}</b></span>
              <span className="badge">
                Tipo: <b>{roomDetail.room.type === "public" ? "Pública" : roomDetail.room.type === "group" ? "Grupo" : "DM"}</b>
              </span>
              <span className="badge">Online: <b>{roomDetail.room.onlineNow}</b></span>
              <span className="badge warn">Pico: <b>{roomDetail.room.peak?.peak || 0}</b></span>
              <span className="badge mono">Pico em: <b>{roomDetail.room.peak?.at ? fmtTime(roomDetail.room.peak.at) : "—"}</b></span>
            </div>

            <div className="admin-card mini">
              <h3 style={{ marginBottom: 6 }}>{roomDetail.room.name}</h3>
              <div className="muted">
                Ativa há: <b>{roomDetail.room.createdAt ? fmtSince(roomDetail.room.createdAt) : "—"}</b>
                {" "}• Criada em: <b>{roomDetail.room.createdAt ? fmtTime(roomDetail.room.createdAt) : "—"}</b>
                {" "}• Última atividade: <b>{roomDetail.room.lastActivityAt ? fmtTime(roomDetail.room.lastActivityAt) : "—"}</b>
              </div>

              <div className="row" style={{ marginTop: 12, gap: 8, flexWrap:"wrap" }}>
                <button
                  className={"btn " + (roomDetail.room.frozen ? "primary" : "danger")}
                  onClick={()=>toggleFreezeRoom(roomDetail.room.id, !roomDetail.room.frozen)}
                >
                  {roomDetail.room.frozen ? "Descongelar sala" : "Congelar sala"}
                </button>

                {roomDetail.room.type === "group" && (
                  <button className="btn danger" onClick={()=>deleteGroup(roomDetail.room.id)}>
                    Encerrar grupo
                  </button>
                )}
              </div>
            </div>

            <div className="admin-card mini" style={{ marginTop: 12 }}>
              <h3>Usuários online</h3>
              {(roomDetail.room.users || []).length === 0 ? (
                <div className="muted">Nenhum usuário online nesta sala.</div>
              ) : (
                <div className="users-list">
                  {roomDetail.room.users.map(u => (
                    <div key={u.socketId} className="user-row">
                      <div>
                        <div className="user-nick">{u.nick}</div>
                        <div className="muted mono">Conectado: {u.connectedAt ? fmtSince(u.connectedAt) : "—"}</div>
                      </div>
                      <div className="user-actions">
                        <button className="btn" onClick={()=>openMod(u, roomDetail.room.id)}>Moderar</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Modal moderação */}
      <Modal open={modOpen} title="Moderação" onClose={()=>setModOpen(false)}>
        {!modTarget ? (
          <div className="muted">Selecione um usuário.</div>
        ) : (
          <div className="form">
            <div className="admin-badges" style={{ marginBottom: 10 }}>
              <span className="badge">Usuário: <b>{modTarget.nick}</b></span>
              <span className="badge mono">ID: <b>{modTarget.socketId.slice(0, 8)}…</b></span>
            </div>

            <label>
              Mensagem (aviso/motivo)
              <textarea
                rows={4}
                value={modMsg}
                onChange={(e)=>setModMsg(e.target.value)}
                placeholder="Digite o aviso / motivo"
              />
            </label>

            <label>
              Banir por quantos minutos? (0 = permanente)
              <input
                type="number"
                min={0}
                value={banMinutes}
                onChange={(e)=>setBanMinutes(e.target.value)}
              />
            </label>

            <div className="row" style={{ gap: 8, flexWrap:"wrap" }}>
              <button type="button" className="btn" onClick={doWarn}>Enviar aviso</button>
              <button type="button" className="btn danger" onClick={doKick}>Remover agora</button>
              <button type="button" className="btn danger" onClick={doBan}>Banir IP</button>
            </div>

            <div className="muted" style={{ marginTop: 10 }}>
              Ban por IP pode afetar pessoas na mesma rede (ex.: Wi-Fi compartilhado).
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

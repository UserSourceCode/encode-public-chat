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
            <div className="brand-sub">Dashboard (tempo real)</div>
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
            <div className="admin-title">Visão geral</div>
            <div className="admin-sub">
              Desde o boot: <b>{metrics?.bootAt ? fmtSince(metrics.bootAt) : "—"}</b> • Uptime: <b>{uptimeSec}s</b> • Atualiza a cada 2s
            </div>
          </div>
          <div className="admin-tools">
            <span className="badge mono">Sessão: {exp ? fmtTime(exp) : "—"}</span>
          </div>
        </div>

        <div className="admin-grid">
          <div className="admin-card">
            <h2>Online agora</h2>
            <div className="admin-row">
              <div className="admin-badges">
                <span className="badge good">Online: <b>{metrics?.onlineNow ?? "—"}</b></span>
                <span className="badge">Salas: <b>{metrics?.roomsTotal ?? "—"}</b></span>
                <span className="badge">Grupos: <b>{metrics?.groupsTotal ?? "—"}</b></span>
                <span className="badge">DMs ativos: <b>{metrics?.dmActive ?? "—"}</b></span>
              </div>
            </div>
            <div className="muted">Contagem do servidor atual (1 instância).</div>
          </div>

          <div className="admin-card">
            <h2>Picos</h2>
            <div className="admin-row">
              <div className="admin-badges">
                <span className="badge warn">Pico online: <b>{metrics?.peakOnline ?? "—"}</b></span>
                <span className="badge mono">Quando: {metrics?.peakOnlineAt ? fmtTime(metrics.peakOnlineAt) : "—"}</span>
              </div>
            </div>
            <div className="muted">Sem persistência: reiniciou, zera.</div>
          </div>

          <div className="admin-card">
            <h2>Tempo médio de sessão</h2>
            <div className="admin-row">
              <div className="admin-badges">
                <span className="badge good">Online agora: <b>{metrics ? fmtDur(metrics.avgSessionNowMs || 0) : "—"}</b></span>
                <span className="badge">Histórico (boot): <b>{metrics ? fmtDur(metrics.avgSessionAllMs || 0) : "—"}</b></span>
                <span className="badge mono">Sessões encerradas: <b>{metrics?.sessionsClosedCount ?? "—"}</b></span>
              </div>
            </div>
            <div className="muted">Histórico inclui sessões encerradas + ativas (desde o boot).</div>
          </div>

          <div className="admin-card">
            <h2>Mensagens por minuto</h2>
            <div className="admin-row">
              <div className="admin-badges">
                <span className="badge good">Agora (últimos 60s): <b>{metrics?.msgsPerMinNow ?? "—"}</b></span>
                <span className="badge warn">Pico: <b>{metrics?.peakMsgsPerMin ?? "—"}</b></span>
                <span className="badge mono">Quando: {metrics?.peakMsgsPerMinAt ? fmtTime(metrics.peakMsgsPerMinAt) : "—"}</span>
              </div>
            </div>
            <div className="muted">Conta mensagens do Geral + Grupos + DMs.</div>
          </div>

          <div className="admin-card">
            <h2>Consumo de memória (RAM)</h2>
            <div className="admin-row">
              <div className="admin-badges">
                <span className="badge">RSS: <b>{fmtBytes(ram.rss)}</b></span>
                <span className="badge">Heap usado: <b>{fmtBytes(ram.heapUsed)}</b></span>
                <span className="badge">Heap total: <b>{fmtBytes(ram.heapTotal)}</b></span>
                <span className="badge">External: <b>{fmtBytes(ram.external)}</b></span>
              </div>
            </div>
            <div className="muted">RSS é o mais importante (memória total do processo).</div>
          </div>

          <div className="admin-card">
            <h2>Dica</h2>
            <div className="muted">
              Se você quiser, no próximo passo eu separo “mensagens por minuto” por sala (Geral / cada Grupo / DMs),
              mantendo ainda tudo sem banco.
            </div>
          </div>
        </div>

        <div className="admin-card">
          <h2>Online por sala (agora + pico)</h2>

          <table className="admin-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Sala</th>
                <th>ID</th>
                <th>Online agora</th>
                <th>Pico sala</th>
                <th>Quando</th>
              </tr>
            </thead>
            <tbody>
              {(metrics?.byRoom || []).map(r => (
                <tr key={r.id}>
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
                </tr>
              ))}
              {(!metrics?.byRoom || metrics.byRoom.length===0) && (
                <tr><td colSpan="6" className="muted">Sem dados ainda.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

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
    </div>
  );
}

import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Home(){
  const nav = useNavigate();

  const [tab, setTab] = useState("geral"); // geral | criar | entrar
  const [nick, setNick] = useState("");

  const [groupName, setGroupName] = useState("Grupo");
  const [groupPass, setGroupPass] = useState("");

  const [roomId, setRoomId] = useState("");
  const [roomPass, setRoomPass] = useState("");

  const canNick = useMemo(()=>nick.trim().length >= 2, [nick]);

  async function createGroup(e){
    e.preventDefault();
    if(!canNick) return;

    try{
      const r = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          name: groupName,
          password: groupPass,
          nick
        })
      });

      const j = await r.json().catch(()=>null);
      if(!j?.ok) return alert(j?.error || "Erro ao criar grupo");

      // ✅ salva a chave do criador para este grupo
      if(j.adminKey && j.groupId){
        sessionStorage.setItem(`group_admin_key:${j.groupId}`, String(j.adminKey));
      }

      nav(`/g/${j.groupId}?nick=${encodeURIComponent(nick.trim())}&pass=${encodeURIComponent(groupPass)}`);
    }catch{
      alert("Falha ao criar grupo.");
    }
  }

  function enterPublic(e){
    e.preventDefault();
    if(!canNick) return;
    nav(`/geral?nick=${encodeURIComponent(nick.trim())}`);
  }

  function enterGroup(e){
    e.preventDefault();
    if(!canNick) return;
    if(!roomId.trim()) return alert("Informe o ID do grupo.");
    if(!roomPass) return alert("Informe a senha do grupo.");
    nav(`/g/${encodeURIComponent(roomId.trim())}?nick=${encodeURIComponent(nick.trim())}&pass=${encodeURIComponent(roomPass)}`);
  }

  return (
    <div className="home-wrap">
      <div className="home-hero">
        <div className="home-brand">
          <div className="home-logo">EP</div>
          <div>
            <div className="home-title">Encode ProTech</div>
            <div className="home-sub">Chat Público + Grupos Privados (sem salvar nada)</div>
          </div>
        </div>
      </div>

      <div className="home-container">
        <div className="home-card">
          <h1>Entrar no chat</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            Tudo é temporário: mensagens ficam apenas em RAM enquanto há usuários conectados.
          </p>

          <div className="home-tabs">
            <button className={"home-tab " + (tab==="geral" ? "active" : "")} onClick={()=>setTab("geral")} type="button">
              Geral
            </button>
            <button className={"home-tab " + (tab==="criar" ? "active" : "")} onClick={()=>setTab("criar")} type="button">
              Criar grupo
            </button>
            <button className={"home-tab " + (tab==="entrar" ? "active" : "")} onClick={()=>setTab("entrar")} type="button">
              Entrar em grupo
            </button>
          </div>

          <div className="home-panel">
            <label className="home-label">
              Apelido
              <input
                className="home-input"
                value={nick}
                onChange={(e)=>setNick(e.target.value)}
                placeholder="Ex.: Lucas"
                minLength={2}
                maxLength={18}
                required
              />
            </label>

            {tab === "geral" && (
              <form onSubmit={enterPublic} className="home-form">
                <div className="home-tip">
                  Você entra com <span className="pill mono">apelido</span> e conversa no <b>Geral</b>.
                </div>
                <button className="btn primary" disabled={!canNick} type="submit">
                  Entrar no Geral
                </button>
              </form>
            )}

            {tab === "criar" && (
              <form onSubmit={createGroup} className="home-form">
                <label className="home-label">
                  Nome do grupo
                  <input
                    className="home-input"
                    value={groupName}
                    onChange={(e)=>setGroupName(e.target.value)}
                    placeholder="Ex.: Amigos"
                    maxLength={32}
                    required
                  />
                </label>

                <label className="home-label">
                  Senha do grupo
                  <input
                    className="home-input"
                    type="password"
                    value={groupPass}
                    onChange={(e)=>setGroupPass(e.target.value)}
                    placeholder="Mínimo 3 caracteres"
                    minLength={3}
                    required
                  />
                </label>

                <div className="home-tip">
                  Um ID será gerado para o grupo. O grupo existe enquanto houver gente conectada.
                  <br/>
                  <b>Quem cria vira admin</b> (somente dentro do grupo).
                </div>

                <button className="btn primary" disabled={!canNick || groupPass.length < 3} type="submit">
                  Criar e entrar
                </button>
              </form>
            )}

            {tab === "entrar" && (
              <form onSubmit={enterGroup} className="home-form">
                <label className="home-label">
                  ID do grupo
                  <input
                    className="home-input mono"
                    value={roomId}
                    onChange={(e)=>setRoomId(e.target.value)}
                    placeholder="Ex.: g_a1b2c3d4e5"
                    required
                  />
                </label>

                <label className="home-label">
                  Senha do grupo
                  <input
                    className="home-input"
                    type="password"
                    value={roomPass}
                    onChange={(e)=>setRoomPass(e.target.value)}
                    placeholder="Digite a senha"
                    required
                  />
                </label>

                <button className="btn primary" disabled={!canNick || !roomId.trim() || !roomPass} type="submit">
                  Entrar no grupo
                </button>
              </form>
            )}
          </div>

          <div className="home-foot muted">
            Encode ProTech • Sem persistência • Pronto para Render
          </div>
        </div>
      </div>
    </div>
  );
}

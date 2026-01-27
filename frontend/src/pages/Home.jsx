import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "../ui/Modal.jsx";
import Toast from "../ui/Toast.jsx";

export default function Home() {
  const nav = useNavigate();

  const [toast, setToast] = useState("");

  const [openCreate, setOpenCreate] = useState(false);
  const [openJoin, setOpenJoin] = useState(false);

  async function createGroup(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);

    const nick = String(form.get("nick") || "");
    const name = String(form.get("name") || "");
    const password = String(form.get("password") || "");

    const r = await fetch(`/api/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password, nick })
    });

    const j = await r.json();
    if (!j.ok) {
      setToast(j.error || "Erro ao criar grupo");
      return;
    }

    setToast("Grupo criado! Entrando...");
    setOpenCreate(false);

    // entra direto (o Room pede senha/nick se ainda não tiver)
    nav(`/g/${j.groupId}`);
  }

  async function joinGroup(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);

    const id = String(form.get("id") || "").trim();
    const pass = String(form.get("password") || "");
    const nick = String(form.get("nick") || "").trim();

    if (!id.startsWith("g_")) {
      setToast("ID inválido. Exemplo: g_xxxxxxxxxx");
      return;
    }
    if (pass.length < 3) {
      setToast("Senha muito curta.");
      return;
    }
    if (nick.length < 2) {
      setToast("Apelido inválido.");
      return;
    }

    // temporário (não é persistência do chat, só pra preencher o modal)
    sessionStorage.setItem("join_nick", nick);
    sessionStorage.setItem("join_pass", pass);

    setOpenJoin(false);
    nav(`/g/${id}`);
  }

  return (
    <div className="shell">
      <Toast msg={toast} onClose={() => setToast("")} />

      <header className="topbar">
        <div className="brand">
          <div className="logo">EP</div>
          <div>
            <div className="brand-title">Encode ProTech</div>
            <div className="brand-sub">Chat Público + Grupos Privados (sem salvar nada)</div>
          </div>
        </div>
      </header>

      <main className="home">
        <div className="card">
          <h1>Entrar no chat</h1>
          <p className="muted">
            Tudo é temporário: mensagens ficam apenas em RAM enquanto há usuários conectados.
          </p>

          <div className="actions">
            <button className="btn primary" onClick={() => nav("/geral")}>
              Geral
            </button>

            <button className="btn" onClick={() => setOpenCreate(true)}>
              Criar grupo
            </button>

            <button className="btn" onClick={() => setOpenJoin(true)}>
              Entrar em grupo
            </button>
          </div>

          <div className="note">
            Você entra informando <span className="pill">ID</span> + <span className="pill">senha</span> +{" "}
            <span className="pill">apelido</span>.
          </div>
        </div>
      </main>

      {/* MODAL - CRIAR */}
      <Modal open={openCreate} title="Criar grupo privado">
        <form onSubmit={createGroup} className="form">
          <label>
            Seu apelido
            <input name="nick" placeholder="Ex: Lucas" required minLength={2} maxLength={18} />
          </label>

          <label>
            Nome do grupo
            <input name="name" placeholder="Ex: Encode Squad" maxLength={32} />
          </label>

          <label>
            Senha do grupo
            <input name="password" type="password" placeholder="Crie uma senha" required minLength={3} />
          </label>

          <div className="row">
            <button type="button" className="btn" onClick={() => setOpenCreate(false)}>
              Cancelar
            </button>
            <button className="btn primary" type="submit">
              Criar
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL - ENTRAR */}
      <Modal open={openJoin} title="Entrar em um grupo">
        <form onSubmit={joinGroup} className="form">
          <label>
            ID do grupo
            <input name="id" placeholder="Ex: g_xxxxxxxxxx" required minLength={3} />
          </label>

          <label>
            Senha do grupo
            <input name="password" type="password" placeholder="Senha" required minLength={3} />
          </label>

          <label>
            Seu apelido
            <input name="nick" placeholder="Ex: Maria" required minLength={2} maxLength={18} />
          </label>

          <div className="row">
            <button type="button" className="btn" onClick={() => setOpenJoin(false)}>
              Cancelar
            </button>
            <button className="btn primary" type="submit">
              Entrar
            </button>
          </div>
        </form>
      </Modal>

      <footer className="footer">
        <span className="muted">Encode ProTech · Sem persistência · Pronto para Render</span>
      </footer>
    </div>
  );
}

import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";

import Home from "./pages/Home.jsx";
import Room from "./pages/Room.jsx";
import Admin from "./pages/Admin.jsx";

export default function App(){
  return (
    <Routes>
      {/* Página inicial (nova Home bonita) */}
      <Route path="/" element={<Home />} />

      {/* Sala Geral (usa Room.jsx) */}
      <Route path="/geral" element={<Room />} />

      {/* Grupo privado por ID */}
      <Route path="/g/:id" element={<Room />} />

      {/* (Opcional) se você tiver DM por rota no futuro */}
      {/* <Route path="/dm/:id" element={<Room />} /> */}

      {/* Admin (área reservada) */}
      <Route path="/area-reservada" element={<Admin />} />

      {/* Fallback: qualquer rota desconhecida volta pra Home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

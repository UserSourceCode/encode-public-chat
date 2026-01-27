import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Home from "./pages/Home.jsx";
import Room from "./pages/Room.jsx";
import Admin from "./pages/Admin.jsx";

export default function App(){
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/geral" element={<Room mode="public" />} />
      <Route path="/g/:id" element={<Room mode="group" />} />

      {/* Área reservada (PT-BR) */}
      <Route path="/area-reservada" element={<Admin />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import React, { useEffect } from "react";

export default function Modal({ open, title, children, onClose }){
  useEffect(() => {
    if(!open) return;
    function onKey(e){
      if(e.key === "Escape"){
        onClose?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if(!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e)=>{
        // fecha ao clicar no fundo (não fecha se clicar dentro do modal)
        if(e.target === e.currentTarget){
          onClose?.();
        }
      }}
    >
      <div className="modal">
        <div className="modal-top">
          <div className="modal-title">{title}</div>

          <button
            type="button"
            className="modal-x"
            aria-label="Fechar"
            onClick={()=>onClose?.()}
            title="Fechar"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

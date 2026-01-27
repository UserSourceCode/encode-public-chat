import React, { useEffect } from "react";

export default function Modal({ open, title, children, onClose }){
  useEffect(() => {
    if(!open) return;
    const onKey = (e) => {
      if(e.key === "Escape"){
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if(!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e)=>{
        // clique fora fecha (se onClose existir)
        if(e.target === e.currentTarget) onClose?.();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal">
        <div className="modal-top">
          <div className="modal-title">{title}</div>

          {!!onClose && (
            <button
              type="button"
              className="modal-close"
              aria-label="Fechar"
              onClick={onClose}
              title="Fechar"
            >
              ✕
            </button>
          )}
        </div>

        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

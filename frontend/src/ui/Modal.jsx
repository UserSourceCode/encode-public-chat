import React from "react";

export default function Modal({ open, title, children }){
  if(!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-top">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

import React, { useEffect } from "react";

export default function Toast({ msg, onClose }){
  useEffect(()=>{
    if(!msg) return;
    const t = setTimeout(onClose, 1800);
    return ()=>clearTimeout(t);
  }, [msg, onClose]);

  if(!msg) return null;
  return <div className="toast">{msg}</div>;
}

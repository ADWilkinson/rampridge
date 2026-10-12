import { useEffect, useRef, type CSSProperties } from "react";
import { useWalletGestureRequest } from "./gesture";

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  background: "rgba(0, 0, 0, 0.55)",
};

const panel: CSSProperties = {
  maxWidth: 360,
  width: "100%",
  padding: "16px 18px",
  background: "#3e3529",
  border: "2px solid #000",
  boxShadow: "inset 0 0 0 1px #5a5142",
  color: "#ff981f",
  font: "inherit",
  textAlign: "center",
};

const button: CSSProperties = {
  minWidth: 120,
  minHeight: 36,
  margin: "12px 6px 0",
  padding: "6px 12px",
  background: "#2c261d",
  border: "1px solid #000",
  color: "#ffff00",
  font: "inherit",
  cursor: "pointer",
};

/**
 * Shown when the browser blocked a Peer wallet window: one click re-opens it
 * inside a real user gesture. Rendered once by AppProviders.
 */
export function WalletGesturePrompt() {
  const request = useWalletGestureRequest();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") request.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  if (!request) return null;
  return (
    <div style={overlay}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="wallet-gesture-title"
        aria-describedby="wallet-gesture-body"
        style={panel}
      >
        <p id="wallet-gesture-title" style={{ margin: 0, fontWeight: 700 }}>
          Continue in your Peer wallet
        </p>
        <p id="wallet-gesture-body" style={{ margin: "8px 0 0", color: "#ffffff" }}>
          {request.label}. Your browser needs one more click to open the Peer wallet window.
        </p>
        <button ref={confirmRef} type="button" style={button} onClick={() => request.confirm()}>
          Open Peer wallet
        </button>
        <button type="button" style={button} onClick={() => request.cancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

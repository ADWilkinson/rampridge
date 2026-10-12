/**
 * Branding preview: logo on the dark title backdrop, the Privy mark on light
 * and dark modal backgrounds, and favicons at 1x and zoomed. The link preview
 * cards are not baked (scripts/og makes them).
 */
export async function runUi(hud: (s: string) => void): Promise<void> {
  document.body.style.overflow = "auto";
  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:28px 16px;display:grid;gap:16px;font:16px 'RS Plain 12',monospace;color:#ff981f";
  wrap.innerHTML = `
    <div style="background:#000;padding:24px;text-align:center"><img id="logo" src="/game/ui/logo.png" style="width:636px"></div>
    <div style="display:flex;gap:16px;align-items:center">
      <div style="background:#fff;padding:16px;border-radius:12px"><img src="/game/ui/privy-logo.png" style="width:205px"></div>
      <div style="background:#1a1a1a;padding:16px;border-radius:12px"><img src="/game/ui/privy-logo.png" style="width:205px"></div>
      <img src="/game/ui/favicon.png">
      <img src="/game/ui/favicon.png" style="width:96px;image-rendering:pixelated">
      <img src="/game/ui/apple-touch-icon.png" style="width:90px;border-radius:20px">
    </div>
  `;
  document.body.appendChild(wrap);
  await Promise.all([...wrap.querySelectorAll("img")].map((i) => i.decode()));
  hud("ui art: logo.png, privy-logo.png, favicon.png, apple-touch-icon.png");
}

import { BUY_PLATFORMS, isBuyPlatformId } from "@/peer/platforms";

/**
 * Item-sized badge for a payment platform: the brand colour with a monogram in
 * the RuneScape bold font, so platforms read like inventory items next to the
 * original sprites. Shared by the buy and bank interfaces.
 */
export function PlatformIcon({ platform, size = 32, title }: { platform: string; size?: number; title?: string }) {
  const known = isBuyPlatformId(platform) ? BUY_PLATFORMS[platform] : null;
  const name = known?.name ?? platform;
  const color = known?.color ?? "#5a5345";
  const monogram = platformMonogram(platform, name);
  return (
    <span
      role="img"
      aria-label={title ?? name}
      title={title ?? name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        boxSizing: "border-box",
        background: color,
        border: "1px solid #000",
        boxShadow: "inset 1px 1px 0 rgba(255,255,255,0.25), inset -1px -1px 0 rgba(0,0,0,0.45)",
        borderRadius: Math.round(size / 6),
        color: "#fff",
        fontFamily: '"RS Bold 12", sans-serif',
        fontSize: Math.max(12, Math.round(size * 0.45)),
        lineHeight: 1,
        textShadow: "1px 1px 0 #000",
        flex: "none",
      }}
    >
      {monogram}
    </span>
  );
}

/** The letters drawn on a platform's badge: its own monogram, or the first letter of its name. */
export function platformMonogram(platform: string, name: string = platform): string {
  return (Object.hasOwn(MONOGRAMS, platform) ? MONOGRAMS[platform] : undefined) ?? name.slice(0, 1).toUpperCase();
}

const MONOGRAMS: Record<string, string> = {
  venmo: "V",
  cashapp: "$",
  revolut: "R",
  wise: "W",
  zelle: "Z",
  paypal: "P",
  monzo: "M",
  chime: "C",
  n26: "N",
  luxon: "L",
  mercadopago: "MP",
  monobank: "mb",
  xmoney: "X",
  alipay: "A",
  upi: "U",
};

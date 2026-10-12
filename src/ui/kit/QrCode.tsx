import { useMemo } from "react";
import { cx } from "./cx";
import { encodeQr, qrPath, type QrEcc } from "./qr";

export interface QrCodeProps {
  value: string;
  /** Rendered size in CSS pixels (rounded down to whole pixels per module). */
  size?: number;
  ecc?: QrEcc;
  /** Accessible description, e.g. "QR code to pay with Revolut". */
  label: string;
  className?: string;
}

/** A scannable QR code (black on white with the standard quiet zone). */
export function QrCode({ value, size = 148, ecc = "M", label, className }: QrCodeProps) {
  const qr = useMemo(() => encodeQr(value, ecc), [value, ecc]);
  const border = 4;
  const modules = qr.size + border * 2;
  const px = Math.max(1, Math.floor(size / modules));
  const side = px * modules;
  return (
    <svg className={cx("rs-qr", className)} width={side} height={side} viewBox={`0 0 ${modules} ${modules}`} role="img" aria-label={label}>
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={qrPath(qr, border)} fill="#000000" />
    </svg>
  );
}

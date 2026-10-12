import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "@/ui/kit/cx";
import { useFitScale } from "@/ui/kit/hooks";
import { PleaseWait } from "@/ui/kit/PleaseWait";
import { useSprite } from "@/ui/kit/sprites";

export interface TitleScreenProps {
  /** Enter as a guest with a generated name. */
  onPlay: () => void;
  /** Opens wallet login (Privy). */
  onExistingUser: () => void;
  onHowItWorks: () => void;
  peerHref?: string;
  termsHref?: string;
  /** Which action is in progress. */
  busy?: "play" | "login" | null;
  /** Plain-English error from the last attempt. */
  error?: string | null;
  /** Logo image; the gold wordmark shows until it has loaded, and stays if it fails. */
  logoSrc?: string;
  /** Rendered above the title box (e.g. the How it works scroll). */
  children?: ReactNode;
  className?: string;
}

/** The gold bevelled wordmark used when no logo image is available. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <h1 className={cx("rs-wordmark", className)} aria-label="RampRidge">
      <span className="rs-wordmark__text" aria-hidden="true" data-text="RampRidge">
        RampRidge
      </span>
    </h1>
  );
}

function TitleButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="rs-titlebtn rs-b12" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/**
 * The login screen over the engine's title-mode render: logo, the stone title
 * box with "Welcome to RampRidge", the tagline and the two buttons, footer
 * links underneath.
 */
export function TitleScreen({
  onPlay,
  onExistingUser,
  onHowItWorks,
  peerHref = "https://peer.xyz",
  termsHref = "/terms",
  busy = null,
  error = null,
  logoSrc = "/game/ui/logo.png",
  children,
  className,
}: TitleScreenProps) {
  const [logo, setLogo] = useState<"loading" | "loaded" | "failed">("loading");
  const box = useSprite("titleBox");
  const boxRef = useRef<HTMLDivElement>(null);
  // The 360px box and its buttons shrink as one unit on phones narrower than the box plus gutters.
  const scale = useFitScale(boxRef, true, 0);
  const showImage = Boolean(logoSrc) && logo !== "failed";
  return (
    <div className={cx("rs-title rs-game", className)}>
      <div className="rs-title__logo">
        {showImage && (
          <img
            ref={(img) => {
              // Already decoded (cache): the load event may have fired before React listened.
              if (img?.complete && img.naturalWidth > 0) setLogo("loaded");
            }}
            src={logoSrc}
            alt={logo === "loaded" ? "RampRidge" : ""}
            width={1272}
            height={198}
            className={cx(logo !== "loaded" && "is-loading")}
            onLoad={() => setLogo("loaded")}
            onError={() => setLogo("failed")}
          />
        )}
        {(!showImage || logo !== "loaded") && <Wordmark />}
      </div>
      <div
        ref={boxRef}
        className={cx("rs-title__box", box.status === "missing" && "rs-title__box--fallback")}
        style={{ "--rs-fit-scale": scale } as CSSProperties}
      >
        <p className="rs-title__welcome rs-b12">Welcome to RampRidge</p>
        <p className="rs-title__tagline rs-p12">Buy and sell USDC for cash with real players. Settled on-chain by Peer.</p>
        {busy ? (
          <p className="rs-title__busy rs-b12">
            <PleaseWait text={busy === "play" ? "Entering the bank" : "Opening login"} />
          </p>
        ) : (
          <div className="rs-title__buttons">
            <TitleButton onClick={onPlay}>Play now</TitleButton>
            <TitleButton onClick={onExistingUser}>Existing user</TitleButton>
          </div>
        )}
        {error && (
          <p className="rs-title__error rs-p12" role="alert">
            {error}
          </p>
        )}
      </div>
      <nav className="rs-title__footer rs-p12" aria-label="About RampRidge">
        <button type="button" className="rs-textbtn rs-textbtn--yellow rs-p12" onClick={onHowItWorks}>
          How it works
        </button>
        <span aria-hidden="true">|</span>
        <a className="rs-textbtn rs-textbtn--yellow rs-p12" href={peerHref} target="_blank" rel="noreferrer">
          Peer
        </a>
        <span aria-hidden="true">|</span>
        <a className="rs-textbtn rs-textbtn--yellow rs-p12" href={termsHref}>
          Terms
        </a>
      </nav>
      {children}
    </div>
  );
}

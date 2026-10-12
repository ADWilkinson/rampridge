import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useGame } from "@/ui/interfaces/context";
import { PlatformIcon } from "@/ui/interfaces/shared/PlatformIcon";
import { ParchmentScroll, Sprite, cx } from "@/ui/kit";
import { PEER_DOCS_URL } from "./links";
import { BUY_STEP_TEXT, SELL_STEP_TEXT, type StepText } from "./steps";
import "./info.css";

export type HowItWorksPage = "buy" | "sell";

interface Step extends StepText {
  icon: ReactNode;
}

/** Payment apps stacked like a deck of cards, the top one in full: "your usual app". */
function PlatformFan() {
  return (
    <span className="info-fan">
      <PlatformIcon platform="wise" size={32} />
      <PlatformIcon platform="venmo" size={32} />
      <PlatformIcon platform="revolut" size={32} />
    </span>
  );
}

/** One sprite per buy step, in BUY_STEP_TEXT's order. */
const BUY_ICONS: readonly ReactNode[] = [
  <Sprite name="geBuy" canvas />,
  <Sprite name="itemBankNote" />,
  <PlatformFan />,
  <Sprite name="tick" canvas scale={2} />,
  <Sprite name="itemCoins10000" />,
];

/** One sprite per sell step, in SELL_STEP_TEXT's order. */
const SELL_ICONS: readonly ReactNode[] = [
  <Sprite name="geSell" canvas />,
  <PlatformFan />,
  <Sprite name="itemCoins1000" />,
];

const withIcons = (text: readonly StepText[], icons: readonly ReactNode[]): Step[] => text.map((t, i) => ({ ...t, icon: icons[i] }));
const BUY_STEPS = withIcons(BUY_STEP_TEXT, BUY_ICONS);
const SELL_STEPS = withIcons(SELL_STEP_TEXT, SELL_ICONS);

const PAGES: readonly { id: HowItWorksPage; label: string; steps: readonly Step[] }[] = [
  { id: "buy", label: "Buying USDC", steps: BUY_STEPS },
  { id: "sell", label: "Selling USDC", steps: SELL_STEPS },
];

export interface HowItWorksScrollProps {
  onClose: () => void;
  initialPage?: HowItWorksPage;
}

/**
 * "How it works" as a parchment scroll with two pages, buying (5 steps) and
 * selling (3 steps), each step illustrated with an item sprite. Usable
 * outside the game (title screen) as it needs only `onClose`.
 */
export function HowItWorksScroll({ onClose, initialPage = "buy" }: HowItWorksScrollProps) {
  const [page, setPage] = useState<HowItWorksPage>(initialPage);
  const base = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    PAGES.findIndex((p) => p.id === page),
  );

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const last = PAGES.length - 1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? last : (index + (e.key === "ArrowRight" ? 1 : -1) + PAGES.length) % PAGES.length;
    setPage(PAGES[next]!.id);
    tabs.current[next]?.focus();
  };

  return (
    <ParchmentScroll title="How it works" onClose={onClose} width={500} className="info-scroll info-howto">
      <div className="info-howto__tabs" role="tablist" aria-label="Guide pages" onKeyDown={onTabKey}>
        {PAGES.map((p, i) => (
          <button
            key={p.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${p.id}`}
            aria-selected={p.id === page}
            aria-controls={`${base}-panel-${p.id}`}
            tabIndex={p.id === page ? 0 : -1}
            className={cx("info-howto__tab rs-b12", p.id === page && "is-selected")}
            onClick={() => setPage(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {/* Both pages share one grid cell so the scroll keeps its size when switching. */}
      <div className="info-pages">
        {PAGES.map((p) => {
          const shown = p.id === page;
          return (
            <ol
              key={p.id}
              className={cx("info-steps", !shown && "is-hidden")}
              role="tabpanel"
              id={`${base}-panel-${p.id}`}
              aria-labelledby={`${base}-tab-${p.id}`}
              aria-hidden={!shown}
              inert={!shown}
            >
              {p.steps.map((s, i) => (
                <li key={s.lead} className="info-step">
                  <span className="info-step__icon" aria-hidden="true">
                    {s.icon}
                  </span>
                  <span className="info-step__text rs-p12">
                    <span className="info-step__lead rs-b12">
                      <span className="info-step__num">{i + 1}.</span> {s.lead}
                    </span>{" "}
                    {s.body}
                  </span>
                </li>
              ))}
            </ol>
          );
        })}
      </div>
      <p className="info-foot rs-p12">
        Read more at{" "}
        <a className="rs-textbtn rs-textbtn--blue rs-p12" href={PEER_DOCS_URL} target="_blank" rel="noreferrer">
          docs.peer.xyz
        </a>
      </p>
    </ParchmentScroll>
  );
}

/** The in-game "How it works" interface. */
export function HowItWorksInterface() {
  const { close } = useGame();
  return <HowItWorksScroll onClose={close} />;
}

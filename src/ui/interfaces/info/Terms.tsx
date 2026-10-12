import type { ReactNode } from "react";
import { useGame } from "@/ui/interfaces/context";
import { HELP_HANDLE, HELP_SAFETY_LINE, HelpLink } from "@/ui/interfaces/shared/help";
import { ParchmentScroll } from "@/ui/kit";
import { PEER_TERMS_URL } from "./links";
import "./info.css";

const TERMS: readonly { heading: string; body: ReactNode }[] = [
  {
    heading: "A fan tribute",
    body: "RampRidge is an unofficial fan tribute. RuneScape and Old School RuneScape are trademarks of Jagex Ltd. RampRidge is not affiliated with or endorsed by Jagex.",
  },
  {
    heading: "Your money",
    body: (
      <>
        Trades settle through the Peer protocol's smart contracts on Base. RampRidge never holds your funds or your payment credentials. Use of the Peer
        protocol is subject to Peer's terms at{" "}
        <a className="rs-textbtn rs-textbtn--blue rs-p12" href={PEER_TERMS_URL} target="_blank" rel="noreferrer">
          peer.xyz/tos
        </a>
        .
      </>
    ),
  },
  {
    heading: "Trading with people",
    body: "Every trade is between you and another person. Pay only the exact amount, to the handle shown, from your own account. Payment apps may limit or reverse transfers they consider risky. Crypto prices and availability can change.",
  },
  {
    heading: "What others see",
    body: "Your display name, chat and position in the room are public. Chat is filtered. Verifying your wallet proves you own it and stores its address with your player.",
  },
  {
    heading: "No guarantees",
    body: "RampRidge comes with no guarantees. You are responsible for following the laws where you live.",
  },
  {
    heading: "Help",
    body: (
      <>
        Problem with a trade? Message <HelpLink label={HELP_HANDLE} tone="blue" /> on X. {HELP_SAFETY_LINE}
      </>
    ),
  },
];

/** The terms as a parchment scroll. Usable outside the game (title screen) as it needs only `onClose`. */
export function TermsScroll({ onClose }: { onClose: () => void }) {
  return (
    <ParchmentScroll title="Terms" onClose={onClose} width={480} className="info-scroll info-terms">
      {TERMS.map((t) => (
        <section key={t.heading} className="info-terms__section">
          <h3 className="info-terms__heading rs-b12">{t.heading}</h3>
          <p className="rs-p12">{t.body}</p>
        </section>
      ))}
    </ParchmentScroll>
  );
}

/** The in-game "Terms" interface. */
export function TermsInterface() {
  const { close } = useGame();
  return <TermsScroll onClose={close} />;
}

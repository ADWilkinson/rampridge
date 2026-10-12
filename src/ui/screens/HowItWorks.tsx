import { ParchmentScroll } from "@/ui/kit/ParchmentScroll";
import { HOW_IT_WORKS_STEPS } from "./howItWorksText";

export interface HowItWorksProps {
  onClose: () => void;
  /** Link for "Learn more about Peer". */
  learnMoreHref?: string;
}

/**
 * A parchment scroll explaining the Peer flow in five steps: the title
 * screen's version, shown until the in-game one (interfaces/info) loads.
 */
export function HowItWorks({ onClose, learnMoreHref = "https://peer.xyz" }: HowItWorksProps) {
  return (
    <ParchmentScroll title="How it works" onClose={onClose} width={440} className="rs-howto">
      <ol className="rs-howto__steps">
        {HOW_IT_WORKS_STEPS.map((s, i) => (
          <li key={s.title} className="rs-howto__step">
            <span className="rs-howto__num rs-b12" aria-hidden="true">
              {i + 1}.
            </span>
            <span>
              <strong className="rs-howto__lead rs-b12">{s.title}</strong> <span className="rs-p12">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="rs-howto__foot rs-p12">Trades settle on Base through the Peer protocol.</p>
      <p className="rs-howto__more rs-p12">
        <a className="rs-textbtn rs-textbtn--blue rs-p12" href={learnMoreHref} target="_blank" rel="noreferrer">
          Learn more about Peer
        </a>
      </p>
    </ParchmentScroll>
  );
}

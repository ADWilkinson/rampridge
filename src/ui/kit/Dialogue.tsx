import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "./cx";

export interface DialogueSpeaker {
  /** Drawn in dark red above the text. */
  name: string;
  /** NPCs speak from the left, the player from the right. */
  side?: "left" | "right";
  /** Chathead render (e.g. a canvas from the character runtime). */
  head?: ReactNode;
}

export interface DialogueOption {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface SpeechProps {
  kind?: "speech";
  speaker?: DialogueSpeaker;
  text: ReactNode;
  /** "Click here to continue"; omit when the next step is driven elsewhere. */
  onContinue?: () => void;
  continueLabel?: string;
}

interface OptionsProps {
  kind: "options";
  /** Defaults to "Select an Option". */
  title?: string;
  options: readonly DialogueOption[];
}

export type DialogueProps = (SpeechProps | OptionsProps) & { className?: string };

function typingInField(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
}

/**
 * The chatbox dialogue: a speaker with an optional chathead, centred black
 * text and "Click here to continue" in blue, or the "Select an Option" list.
 * Space continues and number keys pick options, as in the original. Fills
 * its parent; GameFrame shows it in place of the chat messages.
 */
export function Dialogue(props: DialogueProps) {
  const continueRef = useRef<HTMLButtonElement>(null);
  const firstOption = useRef<HTMLButtonElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    (continueRef.current ?? firstOption.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingInField()) return;
      const p = propsRef.current;
      if (p.kind === "options") {
        const n = Number(e.key);
        const opt = Number.isInteger(n) && n >= 1 ? p.options[n - 1] : undefined;
        if (opt && !opt.disabled) {
          e.preventDefault();
          opt.onSelect();
        }
      } else if (e.key === " " && p.onContinue && document.activeElement !== continueRef.current) {
        e.preventDefault();
        p.onContinue();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (props.kind === "options") {
    return (
      <div className={cx("rs-dialogue rs-dialogue--options rs-game", props.className)} role="group" aria-label={props.title ?? "Select an Option"}>
        <div className="rs-dialogue__main">
          <p className="rs-dialogue__title rs-p12">{props.title ?? "Select an Option"}</p>
          <div className="rs-dialogue__options">
            {props.options.map((o, i) => (
              <button
                key={`${i}-${o.label}`}
                ref={i === 0 ? firstOption : undefined}
                type="button"
                className="rs-dialogue__option rs-p12"
                disabled={o.disabled}
                onClick={o.onSelect}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const { speaker, text, onContinue, continueLabel = "Click here to continue", className } = props;
  const side = speaker?.side ?? "left";
  const head = speaker?.head ? <div className="rs-dialogue__head">{speaker.head}</div> : null;
  return (
    <div className={cx("rs-dialogue rs-game", className)} role="group" aria-label={speaker ? `${speaker.name} says` : "Message"}>
      {side === "left" && head}
      <div className="rs-dialogue__main">
        {speaker && <p className="rs-dialogue__name rs-p12">{speaker.name}</p>}
        <div className="rs-dialogue__text rs-p12" aria-live="polite">
          {text}
        </div>
        {onContinue && (
          <button ref={continueRef} type="button" className="rs-dialogue__continue rs-textbtn rs-textbtn--blue rs-p12" onClick={onContinue} aria-keyshortcuts="Space">
            {continueLabel}
          </button>
        )}
      </div>
      {side === "right" && head}
    </div>
  );
}

/** The parchment chat area (519 x 142) on its own, for dialogues outside the game frame. */
export function ChatArea({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx("rs-chatarea rs-game", className)}>{children}</div>;
}

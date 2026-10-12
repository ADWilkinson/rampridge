import { useState, type CSSProperties, type ReactNode } from "react";
import { DEFAULT_STEPS, clampAmount, formatAmount, stepAmount, stepLabel, type AmountRules } from "./amount";
import { StoneButton } from "./buttons";
import { ChatboxPrompt, type ChatPromptRequest } from "./ChatPrompt";
import { cx } from "./cx";

export interface NumberInputProps {
  /** Text drawn in the box, e.g. "1,250" or "£101.50". */
  display: ReactNode;
  /** Opens the amount prompt. */
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  style?: CSSProperties;
}

/** The Grand Exchange value box: white text on the dark inset; clicking asks for an amount. */
export function NumberInput({ display, onClick, disabled, ariaLabel, className, style }: NumberInputProps) {
  return (
    <button type="button" className={cx("rs-numbox rs-p12", className)} style={style} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {display}
    </button>
  );
}

export interface AmountPadProps {
  value: number;
  onChange: (value: number) => void;
  /** Orange label above the box, e.g. "Quantity:" or "Amount (GBP):". */
  label?: ReactNode;
  /** Step buttons, default +1, +10, +100, +1K. */
  steps?: readonly number[];
  rules?: AmountRules;
  /** Formats the value in the box (default: grouped with the rule's decimals). */
  format?: (value: number) => string;
  /** Chatbox prompt title for the "..." button. */
  promptTitle?: string;
  promptHint?: ReactNode;
  /** Show the -/+ buttons either side of the box (they step by the smallest step). */
  plusMinus?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Grand Exchange style amount entry: the value box with -/+, a row of +1,
 * +10, +100, +1K buttons and "..." which asks "Enter amount:" right under the
 * pad. (The original client asks in the chatbox, but on a large screen that is
 * far from the window and reads as nothing happening, so the question opens
 * where the player is looking.) Typing goes straight in; Enter confirms and
 * Escape cancels; touch screens also get OK and Cancel.
 */
export function AmountPad({
  value,
  onChange,
  label,
  steps = DEFAULT_STEPS,
  rules = {},
  format,
  promptTitle = "Enter amount:",
  promptHint,
  plusMinus = true,
  disabled = false,
  className,
}: AmountPadProps) {
  const [inline, setInline] = useState<ChatPromptRequest | null>(null);
  const decimals = rules.decimals ?? 0;
  const show = format ?? ((v: number) => formatAmount(v, decimals));
  const smallest = steps.length ? Math.min(...steps.map(Math.abs)) : 1;
  const set = (v: number) => onChange(clampAmount(v, rules));

  const ask = () => {
    const request: ChatPromptRequest = {
      title: promptTitle,
      kind: "amount",
      decimals,
      hint: promptHint,
      onSubmit: (_raw, amount) => {
        if (amount !== null) set(amount);
      },
    };
    setInline(request);
  };

  return (
    <div className={cx("rs-amount rs-p12", className)}>
      {label && <span className="rs-amount__label">{label}</span>}
      <div className="rs-amount__row">
        {plusMinus && (
          <StoneButton className="rs-amount__pm" onClick={() => set(stepAmount(value, -smallest, rules))} disabled={disabled || value <= (rules.min ?? 0)} aria-label={`Decrease by ${smallest}`}>
            -
          </StoneButton>
        )}
        <NumberInput display={show(value)} onClick={ask} disabled={disabled} ariaLabel={`${typeof label === "string" ? label.replace(/:$/, "") : "Amount"}: ${show(value)}. Enter an amount`} style={{ flex: 1 }} />
        {plusMinus && (
          <StoneButton
            className="rs-amount__pm"
            onClick={() => set(stepAmount(value, smallest, rules))}
            disabled={disabled || (rules.max !== undefined && value >= rules.max)}
            aria-label={`Increase by ${smallest}`}
          >
            +
          </StoneButton>
        )}
      </div>
      <div className="rs-amount__row rs-amount__steps">
        {steps.map((s) => (
          <StoneButton key={s} onClick={() => set(stepAmount(value, s, rules))} disabled={disabled || (rules.max !== undefined && value >= rules.max)} aria-label={`Add ${s.toLocaleString("en-US")}`}>
            {stepLabel(s)}
          </StoneButton>
        ))}
        <StoneButton onClick={ask} disabled={disabled} aria-label="Enter an amount">
          ...
        </StoneButton>
      </div>
      {inline && (
        <div className="rs-amount__inline-prompt rs-chatarea">
          <ChatboxPrompt request={inline} onDone={() => setInline(null)} />
        </div>
      )}
    </div>
  );
}

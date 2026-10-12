import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { NAME_MAX_LENGTH } from "@shared/protocol";
import { normaliseName, nameKey } from "@shared/chat";
import { TextButton } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";
import { PleaseWait } from "@/ui/kit/PleaseWait";

export interface NameAvailability {
  available: boolean;
  /** Plain-English reason when not available, e.g. "That name is taken." */
  reason?: string;
}

export type NameCheck = (name: string) => Promise<NameAvailability>;

export type NameStatus =
  | { state: "idle" }
  | { state: "invalid"; message: string }
  | { state: "checking" }
  | { state: "available"; name: string }
  | { state: "unavailable"; message: string }
  | { state: "error"; message: string };

/** Client-side rule check, mirroring the server (shared/chat.ts). */
export function validateName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return { ok: false, message: "Enter a name." };
  if (trimmed.length > NAME_MAX_LENGTH) return { ok: false, message: `Names are at most ${NAME_MAX_LENGTH} characters.` };
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(trimmed)) return { ok: false, message: "Use letters, numbers, spaces, - or _." };
  const name = normaliseName(trimmed);
  if (!name) return { ok: false, message: "That name is not allowed." };
  return { ok: true, name };
}

export interface NameFieldController {
  /** Runs the availability check (as the button does) and resolves with the result. */
  check: () => Promise<NameStatus>;
}

export interface NameFieldProps {
  value: string;
  onChange: (value: string) => void;
  onCheck: NameCheck;
  /** Reports the latest status so the parent can enable its confirm button. */
  onStatus?: (status: NameStatus) => void;
  /** Name the player already holds (shown as available without a check). */
  current?: string;
  label?: string;
  autoFocus?: boolean;
  /** Called on Enter. */
  onSubmit?: () => void;
  /** Lets a parent run the check before confirming. */
  controller?: Ref<NameFieldController>;
  className?: string;
}

/** Display-name input with "Check availability" and a coloured status line. */
export function NameField({ value, onChange, onCheck, onStatus, current, label = "Display name:", autoFocus, onSubmit, controller, className }: NameFieldProps) {
  const id = useId();
  const [status, setStatus] = useState<NameStatus>({ state: "idle" });
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const update = (s: NameStatus) => {
    setStatus(s);
    onStatusRef.current?.(s);
  };

  useEffect(() => {
    seq.current++;
    if (current && nameKey(value.trim()) === nameKey(current)) update({ state: "available", name: current });
    else update({ state: "idle" });
    // Status resets whenever the text changes.
  }, [value, current]);

  const check = async (): Promise<NameStatus> => {
    if (status.state === "available" && nameKey(status.name) === nameKey(value.trim())) return status;
    const v = validateName(value);
    if (!v.ok) {
      const s: NameStatus = { state: "invalid", message: v.message };
      update(s);
      return s;
    }
    const n = ++seq.current;
    update({ state: "checking" });
    let s: NameStatus;
    try {
      const res = await onCheck(v.name);
      s = res.available ? { state: "available", name: v.name } : { state: "unavailable", message: res.reason ?? "That name is taken." };
    } catch {
      s = { state: "error", message: "Could not check the name. Try again." };
    }
    if (n === seq.current) update(s);
    return s;
  };

  useImperativeHandle(controller, () => ({ check }));

  return (
    <div className={cx("rs-namefield rs-p12", className)}>
      <label htmlFor={id} className="rs-namefield__label rs-c-orange rs-shadow">
        {label}
      </label>
      <div className="rs-namefield__row">
        {/* The wrapper's touch band (screens.css) gives the 22px field a 36px target without changing the layout. */}
        <span
          className="rs-textfield-hit"
          onClick={(e) => {
            if (e.target === e.currentTarget) inputRef.current?.focus();
          }}
        >
        <input
          ref={inputRef}
          id={id}
          className="rs-textfield rs-p12"
          value={value}
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-describedby={`${id}-status`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (onSubmit) onSubmit();
              else void check();
            }
          }}
        />
        </span>
        <TextButton tone="yellow" onClick={() => void check()} disabled={status.state === "checking"}>
          Check availability
        </TextButton>
      </div>
      <p id={`${id}-status`} className="rs-namefield__status rs-shadow" role="status" aria-live="polite">
        {status.state === "checking" && <PleaseWait className="rs-c-yellow" text="Checking" />}
        {status.state === "available" && <span className="rs-c-green">{status.name} is available.</span>}
        {(status.state === "invalid" || status.state === "unavailable" || status.state === "error") && <span className="rs-c-stone-red">{status.message}</span>}
        {status.state === "idle" && <span className="rs-c-quiet">Up to {NAME_MAX_LENGTH} letters, numbers, spaces, - or _.</span>}
      </p>
    </div>
  );
}

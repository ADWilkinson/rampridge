import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { filterAmountKeystrokes } from "./amount";
import { StoneButton } from "./buttons";
import { cx } from "./cx";
import { useEscapeLayer, useTouch } from "./hooks";
import { isKeyboardFocusedControl, isTextField, promptKeyAction, promptOutcome, trackKeyboardFocus } from "./promptKeys";

export interface ChatPromptRequest {
  /** e.g. "Enter amount:" */
  title: string;
  /** "amount" accepts digits, a dot and k/m/b; "text" accepts anything up to maxLength. */
  kind?: "amount" | "text";
  /** Decimal places for amounts (default 0). */
  decimals?: number;
  initial?: string;
  maxLength?: number;
  /** A short line under the value, e.g. "Between 10 and 1,000". */
  hint?: ReactNode;
  /** Called with the parsed number for amounts, the trimmed text otherwise. */
  onSubmit: (value: string, amount: number | null) => void;
  onCancel?: () => void;
}

export interface ChatPromptApi {
  /** The prompt shown in the chatbox, or null. */
  current: ChatPromptRequest | null;
  /**
   * Shows `request` in the chatbox (replacing any open prompt). Returns a
   * dispose function that closes it if it is still the open prompt.
   */
  open: (request: ChatPromptRequest) => () => void;
  /**
   * Closes the open prompt without calling onCancel. With `request`, closes
   * it only while that request is still the open one.
   */
  close: (request?: ChatPromptRequest) => void;
}

const ChatPromptContext = createContext<ChatPromptApi | null>(null);

/**
 * Hosts the chatbox input prompt ("Enter amount:"). GameFrame provides it and
 * draws the active prompt in the chatbox; components ask for input with
 * `useChatPrompt()?.open(...)`.
 */
export function ChatPromptProvider({ children }: { children?: ReactNode }) {
  const [current, setCurrent] = useState<ChatPromptRequest | null>(null);
  const close = useCallback((request?: ChatPromptRequest) => {
    setCurrent((c) => (request === undefined || c === request ? null : c));
  }, []);
  const open = useCallback(
    (request: ChatPromptRequest) => {
      setCurrent(request);
      return () => close(request);
    },
    [close],
  );
  const api = useMemo(() => ({ current, open, close }), [current, open, close]);
  useEffect(() => trackKeyboardFocus(), []);
  return <ChatPromptContext.Provider value={api}>{children}</ChatPromptContext.Provider>;
}

/**
 * Ties prompts opened from inside it to its lifetime: when it unmounts, a
 * prompt one of its children opened is closed, the way closing an interface
 * in the client also closes its input dialog. Window and ParchmentScroll wrap
 * their content in one.
 */
export function ChatPromptScope({ children }: { children?: ReactNode }) {
  const parent = useContext(ChatPromptContext);
  const parentRef = useRef(parent);
  parentRef.current = parent;
  // The provider holds one prompt at a time, so only the latest one matters.
  const opened = useRef<ChatPromptRequest | null>(null);
  useEffect(
    () => () => {
      if (opened.current) parentRef.current?.close(opened.current);
      opened.current = null;
    },
    [],
  );
  const api = useMemo<ChatPromptApi | null>(
    () =>
      parent && {
        current: parent.current,
        close: parent.close,
        open: (request) => {
          opened.current = request;
          const dispose = parent.open(request);
          return () => {
            if (opened.current === request) opened.current = null;
            dispose();
          };
        },
      },
    [parent],
  );
  return <ChatPromptContext.Provider value={api}>{children}</ChatPromptContext.Provider>;
}

/** The prompt host, or null outside a provider (callers then render ChatboxPrompt inline). */
export function useChatPrompt(): ChatPromptApi | null {
  return useContext(ChatPromptContext);
}

export interface ChatboxPromptProps {
  request: ChatPromptRequest;
  /** Called after submit or cancel so the host can clear the prompt. */
  onDone: () => void;
  className?: string;
}

/** Mounted prompts, newest last: only the newest one takes routed keystrokes. */
const promptStack: number[] = [];
let nextPromptId = 1;

/**
 * The chatbox input line: black title, the typed value in blue with a
 * blinking asterisk. Enter submits, Esc cancels. Fills its parent. While it
 * is open, keystrokes typed anywhere outside another text field go to it,
 * like the client's input dialog.
 *
 * With touch input it also shows OK and Cancel: phone number keypads have no
 * Enter key, and their "Done" only hides the keyboard, which keeps the typed
 * value for OK. The input sits in a form so a keyboard's Go/Done action key
 * submits too.
 */
export function ChatboxPrompt({ request, onDone, className }: ChatboxPromptProps) {
  const kind = request.kind ?? "amount";
  const decimals = request.decimals ?? 0;
  const maxLength = request.maxLength ?? (kind === "amount" ? 16 : 80);
  const [value, setValueState] = useState(request.initial ?? "");
  const [invalid, setInvalid] = useState(false);
  const touch = useTouch();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);

  const setValue = (next: string) => {
    const clean = (kind === "amount" ? filterAmountKeystrokes(next) : next).slice(0, maxLength);
    valueRef.current = clean;
    setInvalid(false);
    setValueState(clean);
  };

  const cancel = () => {
    request.onCancel?.();
    onDone();
  };
  useEscapeLayer(cancel);

  const submit = () => {
    const outcome = promptOutcome(valueRef.current, kind, decimals);
    if (outcome.type === "cancel") {
      cancel();
      return;
    }
    if (outcome.type === "invalid") {
      setInvalid(true);
      return;
    }
    request.onSubmit(outcome.value, outcome.amount);
    onDone();
  };

  // Latest handlers for the window listener, which is bound once.
  const handlers = useRef({ submit, setValue });
  handlers.current = { submit, setValue };

  useEffect(() => {
    trackKeyboardFocus();
    const id = nextPromptId++;
    promptStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || promptStack[promptStack.length - 1] !== id) return;
      const el = input.current;
      if (!el) return;
      const active = document.activeElement;
      const action = promptKeyAction(e, {
        inPrompt: active === el,
        inTextField: isTextField(active),
        keyboardControl: isKeyboardFocusedControl(active),
      });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      const { submit: doSubmit, setValue: doSet } = handlers.current;
      if (action.type === "submit") doSubmit();
      else if (action.type === "backspace") doSet(valueRef.current.slice(0, -1));
      else doSet(valueRef.current + action.text);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = promptStack.indexOf(id);
      if (i >= 0) promptStack.splice(i, 1);
    };
  }, []);

  return (
    <form
      className={cx("rs-prompt rs-game", touch && "rs-prompt--touch", className)}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="rs-p12" id={titleId}>
        {request.title}
      </p>
      <p className="rs-prompt__value rs-p12" aria-hidden="true">
        {value}
        <span className="rs-caret">*</span>
      </p>
      {invalid ? (
        <p className="rs-prompt__hint rs-p11" role="alert">
          That is not a valid amount.
        </p>
      ) : (
        request.hint && <p className="rs-prompt__hint rs-p11">{request.hint}</p>
      )}
      <input
        ref={input}
        className="rs-prompt__input"
        aria-labelledby={titleId}
        autoFocus
        value={value}
        inputMode={kind === "amount" ? (decimals > 0 ? "decimal" : "numeric") : "text"}
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={maxLength}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={(e) => {
          // Keep the prompt focused like the client unless focus moved into another control. With touch the
          // keyboard's "Done" blurs on purpose: the value stays and OK submits it.
          if (!touch && !e.relatedTarget) e.currentTarget.focus({ preventScroll: true });
        }}
      />
      {touch && (
        <div className="rs-prompt__actions">
          <StoneButton submit>OK</StoneButton>
          <StoneButton onClick={cancel}>Cancel</StoneButton>
        </div>
      )}
    </form>
  );
}

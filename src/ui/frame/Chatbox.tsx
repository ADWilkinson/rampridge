import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHAT_MAX_LENGTH } from "@shared/protocol";
import { ChatboxPrompt, useChatPrompt, type ChatPromptRequest } from "@/ui/kit/ChatPrompt";
import { cx } from "@/ui/kit/cx";
import { useLayoutMode } from "@/ui/kit/hooks";
import { ScrollArea } from "@/ui/kit/ScrollArea";
import { CHAT_TABS, chatMessageOf, draftAfterFailedSend, latestTime, lineText, linesForTab, unreadTabs, type ChatLine, type ChatTab } from "./chat";

export interface ChatboxProps {
  lines: readonly ChatLine[];
  /** Shown before the input: "Name: *". */
  playerName: string;
  /**
   * Called with the trimmed message on Enter. The input clears at once; when
   * the returned promise resolves false (or rejects), e.g. rate limited, the
   * message comes back into the input unless the player has typed again.
   */
  onSend: (text: string) => void | Promise<boolean>;
  /** When set, the input line shows this reason in place of the input (e.g. "Connecting..."). */
  inputDisabledReason?: string;
  /** Replaces the messages and input (dialogues), like the original. */
  overlay?: ReactNode;
  /** Controlled tab (optional). */
  tab?: ChatTab;
  onTabChange?: (tab: ChatTab) => void;
  /** Send printable keystrokes typed anywhere to the chat input (default true). */
  captureTyping?: boolean;
  maxLength?: number;
  /** Force the phone layout (one line until tapped); defaults to the screen's layout mode. */
  mobile?: boolean;
  /** Phones: the full chatbox shows instead of one line. Controlled when set (GameFrame owns it). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}

function isTextField(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

/** A fresh prompt input for each request, so a chained prompt starts empty. */
const requestKeys = new WeakMap<ChatPromptRequest, number>();
let nextRequestKey = 1;
function requestKey(request: ChatPromptRequest): number {
  let key = requestKeys.get(request);
  if (key === undefined) {
    key = nextRequestKey++;
    requestKeys.set(request, key);
  }
  return key;
}

function LineView({ line }: { line: ChatLine }) {
  switch (line.kind) {
    case "public":
      return (
        <>
          <span className="rs-chat__name">{line.name}: </span>
          <span className="rs-chat__public">{line.text}</span>
        </>
      );
    case "private":
      return (
        <span className="rs-chat__private">
          From {line.name}: {line.text}
        </span>
      );
    case "trade":
      return <span className="rs-chat__trade">{line.name ? `${line.name} ${line.text}` : line.text}</span>;
    case "news":
      return <span className="rs-chat__news">News: {line.text}</span>;
    case "game":
      return <span className="rs-chat__game">{line.text}</span>;
  }
}

/**
 * The parchment chatbox with All / Game / Public / Trade tabs, the message
 * list (original colours, newest at the bottom), the "Name: *" input line and
 * Enter to send. On phones it collapses to the newest line until tapped, and
 * always shows while a prompt or dialogue needs an answer.
 */
export function Chatbox({
  lines,
  playerName,
  onSend,
  inputDisabledReason,
  overlay,
  tab: tabProp,
  onTabChange,
  captureTyping = true,
  maxLength = CHAT_MAX_LENGTH,
  mobile: mobileProp,
  expanded: expandedProp,
  onExpandedChange,
  className,
}: ChatboxProps) {
  const autoMobile = useLayoutMode().sheet;
  const mobile = mobileProp ?? autoMobile;
  const [tabState, setTabState] = useState<ChatTab>("all");
  const tab = tabProp ?? tabState;
  const [seen, setSeen] = useState<Partial<Record<ChatTab, number>>>({});
  const [draft, setDraft] = useState("");
  const [expandedState, setExpandedState] = useState(false);
  const expanded = expandedProp ?? expandedState;
  const setExpanded = (next: boolean) => {
    if (expandedProp === undefined) setExpandedState(next);
    onExpandedChange?.(next);
  };
  const input = useRef<HTMLInputElement>(null);
  const prompt = useChatPrompt();

  const visible = useMemo(() => linesForTab(lines, tab), [lines, tab]);
  const newest = latestTime(lines);
  const unread = useMemo(() => unreadTabs(lines, tab, seen), [lines, tab, seen]);

  // Viewing a tab marks it (and, for All, everything) as read.
  useEffect(() => {
    setSeen((s) => (s[tab] === newest ? s : { ...s, [tab]: newest }));
  }, [tab, newest]);

  const selectTab = (t: ChatTab) => {
    if (tabProp === undefined) setTabState(t);
    onTabChange?.(t);
  };

  const promptRequest = prompt?.current ?? null;
  const covered = Boolean(overlay) || Boolean(promptRequest);
  const canType = !inputDisabledReason && !covered;

  useEffect(() => {
    if (!captureTyping || !canType) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || isTextField(document.activeElement)) return;
      if (e.key === " " && document.activeElement instanceof HTMLButtonElement) return;
      if (mobile && !expanded) setExpanded(true);
      input.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [captureTyping, canType, mobile, expanded]);

  const send = () => {
    const text = chatMessageOf(draft, maxLength);
    if (!text) return;
    setDraft("");
    const sent = onSend(text);
    if (sent) {
      const restore = () => setDraft((current) => draftAfterFailedSend(current, text));
      sent.then((ok) => {
        if (!ok) restore();
      }, restore);
    }
  };

  const last = lines[lines.length - 1];

  if (mobile && !expanded && !covered) {
    return (
      <button type="button" className={cx("rs-chat rs-chat--collapsed rs-game rs-p12", className)} onClick={() => setExpanded(true)} aria-label="Open chat">
        <span className="rs-chat__peek">{last ? <LineView line={last} /> : <span className="rs-chat__game">Tap to chat.</span>}</span>
        {unread.size > 0 && <span className="rs-chat__peek-dot" aria-label="New messages" />}
      </button>
    );
  }

  return (
    <section className={cx("rs-chat rs-game", mobile && "rs-chat--mobile", className)} aria-label="Chat">
      <div className="rs-chat__area rs-chatarea">
        {promptRequest ? (
          <ChatboxPrompt key={requestKey(promptRequest)} request={promptRequest} onDone={() => prompt?.close(promptRequest)} />
        ) : overlay ? (
          overlay
        ) : (
          <>
            <ScrollArea className="rs-chat__messages" contentClassName="rs-chat__list" stickToBottom label="Chat messages">
              <ol className="rs-chat__lines rs-p12" aria-live="polite" aria-relevant="additions">
                {visible.map((l) => (
                  <li key={l.id} className="rs-chat__line" title={new Date(l.time).toLocaleTimeString()} aria-label={lineText(l)}>
                    <LineView line={l} />
                  </li>
                ))}
              </ol>
            </ScrollArea>
            <div className="rs-chat__sep" aria-hidden="true" />
            {/* data-world-keys: the arrow keys keep turning the camera while typing, as in the client (the caret stays at the end). */}
            <div className="rs-chat__input rs-p12" data-world-keys onClick={() => input.current?.focus()}>
              <span className="rs-chat__line-text">
                <span className="rs-chat__name">{playerName}: </span>
                {inputDisabledReason ? (
                  <span className="rs-chat__disabled">{inputDisabledReason}</span>
                ) : (
                  <>
                    <span className="rs-chat__draft">{draft}</span>
                    <span className="rs-chat__draft rs-caret" aria-hidden="true">
                      *
                    </span>
                  </>
                )}
              </span>
              {!inputDisabledReason && (
                <input
                  ref={input}
                  className="rs-chat__field"
                  value={draft}
                  maxLength={maxLength}
                  aria-label="Chat message"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="send"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      send();
                    } else if (e.key === "Escape") {
                      e.currentTarget.blur();
                    }
                  }}
                />
              )}
            </div>
          </>
        )}
        {/* Over a prompt or dialogue the chat cannot be put away: they need an answer first. */}
        {mobile && !covered && (
          <button type="button" className="rs-chat__collapse rs-p11" onClick={() => setExpanded(false)} aria-label="Hide chat">
            Hide
          </button>
        )}
      </div>
      <div className="rs-chat__buttons" role="tablist" aria-label="Chat filters">
        {CHAT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cx("rs-chattab rs-p11", tab === t.id && "rs-chattab--selected", unread.has(t.id) && "rs-chattab--unread")}
            onClick={() => selectTab(t.id)}
          >
            <span className="rs-chattab__name">{t.label}</span>
            {t.id !== "all" && <span className="rs-chattab__state">On</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

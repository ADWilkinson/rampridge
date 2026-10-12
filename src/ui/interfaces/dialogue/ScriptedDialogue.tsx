import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialogue, useEscapeLayer } from "@/ui/kit";
import { useGame, type ChatheadSubject } from "@/ui/interfaces/context";
import { splitWarning, type DialogueAction, type DialogueLine, type DialogueNode, type DialogueScript } from "./script";
import "./dialogue.css";

export interface ScriptedDialogueProps {
  script: DialogueScript;
  /** Node to show first (defaults to the script's start; the dev harness uses it). */
  startAt?: string;
}

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Option index for "1".."9" on the main row or the number pad, else -1. */
function digitIndex(e: KeyboardEvent): number {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) - 1 : -1;
}

/**
 * Runs a dialogue script in the chatbox: NPC lines with "Click here to
 * continue", player lines on the right, and "Select an Option" lists.
 * Space or Enter continues, keys 1-5 pick options, Esc ends the
 * conversation. Choosing an option that opens an interface hands over to the
 * shell through `open()`; ending calls `close()`.
 *
 * Placement: rendered as GameFrame's `chat.overlay` it fills the chatbox, as
 * in the original. Rendered anywhere else it draws its own 519 x 142 chat
 * parchment, so it still works when the shell centres it like a window.
 */
export function ScriptedDialogue(props: ScriptedDialogueProps) {
  // A different conversation (another NPC) starts again from its first line.
  return <Conversation key={props.script.id} {...props} />;
}

/**
 * A chathead for the whole conversation: drawn once into a detached element
 * that each line's head slot borrows (the kit Dialogue remounts per line), so
 * moving to the next line never rebuilds the model. Null while there is no
 * subject, where the shell draws no chatheads, or once drawing failed (no
 * WebGL, no model): the line then shows no head at all.
 */
function useChathead(subject: ChatheadSubject | null): HTMLElement | null {
  const { renderChathead } = useGame();
  const key = subject ? JSON.stringify(subject) : "";
  const latest = useRef(subject);
  latest.current = subject;
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const who = latest.current;
    if (!who || !renderChathead) return;
    const el = document.createElement("div");
    el.className = "npcd__head";
    let live = true;
    let handle: ReturnType<NonNullable<typeof renderChathead>> = null;
    try {
      handle = renderChathead(el, who, { onFail: () => live && setElement(null) });
    } catch (err) {
      console.warn("[chathead]", err);
    }
    if (!handle) return;
    setElement(el);
    return () => {
      live = false;
      handle?.dispose();
      el.remove();
      setElement(null);
    };
  }, [key, renderChathead]);
  return element;
}

/** Puts the conversation's chathead element into this line's head slot. */
function HeadSlot({ element }: { element: HTMLElement }) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = slot.current;
    if (!host) return;
    host.appendChild(element);
    return () => {
      if (element.parentNode === host) host.removeChild(element);
    };
  }, [element]);
  return <div ref={slot} className="npcd__headSlot" aria-hidden="true" />;
}

/** A line's text with its warning (the whole line or one part) in red. */
function LineText({ line }: { line: DialogueLine }) {
  const [before, warning, after] = splitWarning(line);
  if (!warning) return <>{line.text}</>;
  return (
    <span>
      {before}
      <span className="npcd__warning">{warning}</span>
      {after}
    </span>
  );
}

function Conversation({ script, startAt }: ScriptedDialogueProps) {
  const game = useGame();
  const [nodeId, setNodeId] = useState(() => (startAt && script.nodes[startAt] ? startAt : script.start));
  const root = useRef<HTMLDivElement>(null);
  /** Set once the conversation has handed over or ended, so a double click cannot act twice. */
  const finished = useRef(false);

  const node: DialogueNode | undefined = script.nodes[nodeId] ?? script.nodes[script.start];
  // The player's own head is drawn from their first line on, and kept for the rest of the conversation.
  const [playerSpoke, setPlayerSpoke] = useState(false);
  const playerSpeaking = node?.kind === "player";
  useEffect(() => {
    if (playerSpeaking) setPlayerSpoke(true);
  }, [playerSpeaking]);
  const npcHead = useChathead(script.npcHead ?? null);
  const playerHead = useChathead((playerSpoke || playerSpeaking) && game.me ? { pid: game.me.pid } : null);

  const run = (action: DialogueAction) => {
    if (finished.current) return;
    switch (action.type) {
      case "goto":
        setNodeId(action.node);
        return;
      case "open":
        finished.current = true;
        game.open(action.target);
        return;
      case "close":
        finished.current = true;
        game.close();
        return;
    }
  };

  const end = () => run({ type: "close" });
  useEscapeLayer(end, true);

  // Keys work wherever focus is, unless the player is typing in a field.
  // Registered in the capture phase on window so it runs before the
  // chatbox's "type anywhere" capture: whichever runs first, the key is
  // consumed here and never reaches the chat input.
  const latest = useRef({ node, run });
  latest.current = { node, run };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTextField(e.target)) return;
      const box = root.current;
      const current = latest.current.node;
      if (!box || !current) return;
      const inside = e.target instanceof Node && box.contains(e.target);
      const neutral = e.target === document.body || e.target === document.documentElement || e.target === window || e.target === document;
      let action: DialogueAction | null = null;
      if (current.kind === "options") {
        const i = digitIndex(e);
        action = i >= 0 ? (current.options[i]?.action ?? null) : null;
      } else if ((e.key === " " || e.key === "Enter") && (inside || neutral)) {
        action = current.next;
      }
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // The chatbox may already have pulled focus to its input for this key.
      if (isTextField(document.activeElement) && document.activeElement !== e.target) {
        (document.activeElement as HTMLElement).blur();
        if (e.target instanceof HTMLElement && e.target.isConnected) e.target.focus({ preventScroll: true });
      }
      latest.current.run(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!node) return null;
  const speakerName = node.kind === "npc" ? script.npcName : (game.me?.name ?? "You");
  const head = node.kind === "npc" ? npcHead : node.kind === "player" ? playerHead : null;

  return (
    <div ref={root} className="npcd rs-chatarea rs-game" data-node={nodeId}>
      {/* Persists across lines (the kit Dialogue remounts per line), so screen readers announce each new line. */}
      <p className="rs-visually-hidden" aria-live="polite">
        {node.kind === "options" ? (node.title ?? "Select an Option") : `${speakerName}: ${node.text}`}
      </p>
      {node.kind === "options" ? (
        <Dialogue
          key={nodeId}
          kind="options"
          title={node.title}
          options={node.options.map((o) => ({ label: o.label, onSelect: () => run(o.action) }))}
        />
      ) : (
        <Dialogue
          key={nodeId}
          speaker={{ name: speakerName, side: node.kind === "npc" ? "left" : "right", head: head ? <HeadSlot element={head} /> : undefined }}
          text={<LineText line={node} />}
          onContinue={() => run(node.next)}
        />
      )}
    </div>
  );
}

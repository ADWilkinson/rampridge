import type { ChatheadSubject, InterfaceId, OpenInterface } from "@/ui/interfaces/context";

/**
 * Chat-head dialogue trees as plain data, so every branch can be checked in
 * tests: each node is an NPC line, a player line or a "Select an Option"
 * list, and every step either moves to another node, opens an interface or
 * ends the conversation.
 */

export type DialogueAction =
  /** Show another node of the same conversation. */
  | { type: "goto"; node: string }
  /** Hand over to another interface (the shell replaces the dialogue). */
  | { type: "open"; target: OpenInterface }
  /** End the conversation. */
  | { type: "close" };

export interface DialogueLine {
  /** NPC lines show the NPC's name on the left; player lines the player's on the right. */
  kind: "npc" | "player";
  text: string;
  /**
   * Drawn in red, for the one warning a player must not miss: true for the
   * whole line, or the part of `text` to draw in red.
   */
  warning?: boolean | string;
  next: DialogueAction;
}

export interface DialogueChoice {
  label: string;
  action: DialogueAction;
}

export interface DialogueOptions {
  kind: "options";
  /** Defaults to "Select an Option", as in the original. */
  title?: string;
  options: readonly DialogueChoice[];
}

export type DialogueNode = DialogueLine | DialogueOptions;

export interface DialogueScript {
  /** Stable id; a different id restarts the conversation from `start`. */
  id: string;
  /** Name drawn above NPC lines ("Banker"). */
  npcName: string;
  /** Whose chathead NPC lines show; none when absent. Player lines show the player's own. */
  npcHead?: ChatheadSubject;
  start: string;
  nodes: Readonly<Record<string, DialogueNode>>;
}

/** The original shows at most five options, picked with keys 1-5. */
export const MAX_OPTIONS = 5;

/**
 * Longest line that still fits the chatbox on a 390 px phone (three lines of
 * RS Plain 12 under the speaker's name and "Click here to continue").
 */
export const MAX_LINE_CHARS = 170;

/** Every interface id the shell can open (kept complete by the type checker). */
const INTERFACE_IDS: Record<InterfaceId, true> = {
  bank: true,
  exchange: true,
  trade: true,
  payment: true,
  verify: true,
  sell: true,
  collection: true,
  send: true,
  receive: true,
  dialogue: true,
  intro: true,
  "how-it-works": true,
  terms: true,
};

export function isInterfaceId(value: string): value is InterfaceId {
  return Object.prototype.hasOwnProperty.call(INTERFACE_IDS, value);
}

/** The actions a node can take next. */
export function nodeActions(node: DialogueNode): DialogueAction[] {
  return node.kind === "options" ? node.options.map((o) => o.action) : [node.next];
}

function actionProblem(action: DialogueAction, script: DialogueScript): string | null {
  switch (action.type) {
    case "goto":
      return script.nodes[action.node] ? null : `goes to missing node "${action.node}"`;
    case "close":
      return null;
    case "open": {
      const target = action.target;
      if (!isInterfaceId(target.id)) return `opens unknown interface "${String(target.id)}"`;
      if (target.id === "trade" && !target.target) return "opens a trade without a target";
      if (target.id === "dialogue" && !target.name) return "opens a dialogue without an NPC name";
      return null;
    }
  }
}

/**
 * Structural problems with a script, as readable strings (empty when valid):
 * missing start or targets, unknown interfaces, empty or overlong text,
 * option counts outside 1..5, duplicate labels, unreachable nodes, and nodes
 * from which the player can never leave the conversation.
 */
export function validateScript(script: DialogueScript): string[] {
  const problems: string[] = [];
  const ids = Object.keys(script.nodes);
  if (!script.npcName.trim()) problems.push("script has no NPC name");
  if (!script.nodes[script.start]) problems.push(`start node "${script.start}" is missing`);

  for (const id of ids) {
    const node = script.nodes[id]!;
    if (node.kind === "options") {
      if (node.options.length === 0 || node.options.length > MAX_OPTIONS) {
        problems.push(`${id}: has ${node.options.length} options (1-${MAX_OPTIONS} allowed)`);
      }
      const labels = new Set<string>();
      for (const option of node.options) {
        if (!option.label.trim()) problems.push(`${id}: has an option with no label`);
        if (labels.has(option.label)) problems.push(`${id}: repeats the option "${option.label}"`);
        labels.add(option.label);
      }
    } else {
      if (!node.text.trim()) problems.push(`${id}: has no text`);
      if (node.text.length > MAX_LINE_CHARS) problems.push(`${id}: text is ${node.text.length} characters (max ${MAX_LINE_CHARS})`);
      if (typeof node.warning === "string" && (!node.warning.trim() || !node.text.includes(node.warning))) {
        problems.push(`${id}: its warning is not part of its text`);
      }
    }
    for (const action of nodeActions(node)) {
      const problem = actionProblem(action, script);
      if (problem) problems.push(`${id}: ${problem}`);
    }
  }

  // Every node is reachable from the start.
  const reachable = new Set<string>();
  const queue = script.nodes[script.start] ? [script.start] : [];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = script.nodes[id];
    if (!node) continue;
    for (const action of nodeActions(node)) if (action.type === "goto" && script.nodes[action.node]) queue.push(action.node);
  }
  for (const id of ids) if (!reachable.has(id)) problems.push(`${id}: is unreachable from "${script.start}"`);

  // Every node can reach an exit (open or close), so no conversation loops forever.
  const exits = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of ids) {
      if (exits.has(id)) continue;
      const leaves = nodeActions(script.nodes[id]!).some((a) => a.type !== "goto" || exits.has(a.node));
      if (leaves) {
        exits.add(id);
        grew = true;
      }
    }
  }
  for (const id of ids) if (!exits.has(id)) problems.push(`${id}: never leads out of the conversation`);

  return problems;
}

/**
 * A line's text split around its warning: `[before, warning, after]`, with
 * the whole text as the warning when `warning` is true and none when it is
 * absent or not part of the text.
 */
export function splitWarning(line: Pick<DialogueLine, "text" | "warning">): [string, string, string] {
  if (line.warning === true) return ["", line.text, ""];
  if (typeof line.warning !== "string" || !line.warning) return [line.text, "", ""];
  const at = line.text.indexOf(line.warning);
  if (at < 0) return [line.text, "", ""];
  return [line.text.slice(0, at), line.warning, line.text.slice(at + line.warning.length)];
}

/** Every interface a script can open, for tests and the dev harness. */
export function scriptTargets(script: DialogueScript): OpenInterface[] {
  const out: OpenInterface[] = [];
  for (const node of Object.values(script.nodes)) {
    for (const action of nodeActions(node)) if (action.type === "open") out.push(action.target);
  }
  return out;
}

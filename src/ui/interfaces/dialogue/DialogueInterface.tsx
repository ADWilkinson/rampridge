import { useMemo } from "react";
import { BUY_PLATFORMS, isBuyPlatformId } from "@/peer/platforms";
import type { InterfaceProps, OpenInterface } from "@/ui/interfaces/context";
import type { DialogueScript } from "./script";
import { ScriptedDialogue } from "./ScriptedDialogue";
import { bankerScript, merchantScript } from "./scripts";

type DialogueOpen = Extract<OpenInterface, { id: "dialogue" }>;

/** Display name for a merchant's platform id ("revolut" -> "Revolut"), or null when unknown. */
export function platformDisplayName(platform: string): string | null {
  return isBuyPlatformId(platform) ? BUY_PLATFORMS[platform].name : null;
}

/** The conversation for a `{ id: "dialogue" }` descriptor. */
export function dialogueScriptFor(open: DialogueOpen): DialogueScript {
  if (open.npc === "merchant") {
    return merchantScript(open.name, open.merchant, open.merchant ? platformDisplayName(open.merchant.platform) : null);
  }
  return bankerScript(open.name);
}

/** Banker "Talk-to" and merchant dialogues, drawn in the chatbox. */
export function DialogueInterface({ open }: InterfaceProps<"dialogue">) {
  const script = useMemo(() => dialogueScriptFor(open), [open]);
  return <ScriptedDialogue script={script} />;
}

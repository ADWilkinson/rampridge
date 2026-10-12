import type { InterfaceId, InterfaceModule } from "@/ui/interfaces/context";
import { DialogueInterface } from "./DialogueInterface";

export const interfaces: InterfaceModule["interfaces"] = {
  dialogue: DialogueInterface,
};

/**
 * Interfaces from this folder that belong in the chatbox, as in the original:
 * render them as GameFrame's `chat.overlay` instead of in the centred
 * interface layer. (They still draw their own chat parchment if centred.)
 */
export const chatboxInterfaces: readonly InterfaceId[] = ["dialogue"];

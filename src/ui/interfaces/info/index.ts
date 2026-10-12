import type { InterfaceId, InterfaceModule } from "@/ui/interfaces/context";
import { HowItWorksInterface } from "./HowItWorks";
import { IntroInterface } from "./Intro";
import { TermsInterface } from "./Terms";

export const interfaces: InterfaceModule["interfaces"] = {
  intro: IntroInterface,
  "how-it-works": HowItWorksInterface,
  terms: TermsInterface,
};

/**
 * Interfaces from this folder that belong in the chatbox (GameFrame
 * `chat.overlay`) rather than the centred interface layer.
 */
export const chatboxInterfaces: readonly InterfaceId[] = ["intro"];

/** Context-free scrolls for use outside the game, e.g. the title screen's footer links. */
export { HowItWorksScroll, type HowItWorksPage, type HowItWorksScrollProps } from "./HowItWorks";
export { TermsScroll } from "./Terms";

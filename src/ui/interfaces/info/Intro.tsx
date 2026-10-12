import { useMemo } from "react";
import { useGame } from "@/ui/interfaces/context";
import { ScriptedDialogue } from "@/ui/interfaces/dialogue/ScriptedDialogue";
import { introLoggedIn, introScript } from "./introScript";

/** First-visit welcome from the door banker, drawn in the chatbox. */
export function IntroInterface() {
  const loggedIn = introLoggedIn(useGame());
  const script = useMemo(() => introScript({ loggedIn }), [loggedIn]);
  return <ScriptedDialogue script={script} />;
}

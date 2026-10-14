/**
 * Buying USDC: the Grand Exchange, the trade window (merchants and player
 * stalls), the Payment scroll and Peer verification, plus the practice trade
 * that walks the same windows with no money. The shell renders the component
 * registered for the open interface id.
 */
import "./buy.css";
import type { InterfaceModule } from "../context";
import { ExchangeInterface } from "./Exchange";
import { PaymentInterface } from "./Payment";
import { PracticeInterface, practiceAware } from "./Practice";
import { TradeInterface } from "./Trade";
import { VerifyInterface } from "./Verify";

export const interfaces: InterfaceModule["interfaces"] = {
  exchange: ExchangeInterface,
  trade: TradeInterface,
  payment: practiceAware(PaymentInterface),
  verify: practiceAware(VerifyInterface),
  practice: PracticeInterface,
};

/**
 * Optional for the shell: mount once inside the game (under GameContext and
 * the QueryClientProvider) so "Your offer has been placed." and a completed
 * purchase's fireworks, coins sound, chat message and world announcement fire
 * even when no buy interface is open. Each interface also mounts it; every
 * event fires once.
 */
export { useBuyOrderEvents } from "./events";

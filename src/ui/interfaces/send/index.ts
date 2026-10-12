/**
 * Wallet interfaces: Send USDC (to any address on Base, with a review and a
 * chain check for any send whose outcome is unknown) and Receive (the
 * wallet's address with a QR code). The shell discovers this module with
 * import.meta.glob and renders the component for the open id.
 */
import "./send.css";

import type { InterfaceModule } from "../context";
import { ReceiveInterface } from "./ReceiveInterface";
import { SendInterface } from "./SendInterface";

export const interfaces: InterfaceModule["interfaces"] = {
  send: SendInterface,
  receive: ReceiveInterface,
};

export { SendDepsProvider, type SendDeps } from "./deps";

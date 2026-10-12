/**
 * Bank interfaces: the Bank of RampRidge (your sell offers as bank items),
 * the Sell dialogue (create a Peer Cash deposit) and the Collection box
 * (completed and closed offers with their fills). The shell discovers this
 * module with import.meta.glob and renders the component for the open id.
 */
import "./bank.css";

import type { InterfaceModule } from "../context";
import { BankInterface } from "./BankInterface";
import { CollectionInterface } from "./CollectionInterface";
import { SellInterface } from "./SellInterface";

export const interfaces: InterfaceModule["interfaces"] = {
  bank: BankInterface,
  sell: SellInterface,
  collection: CollectionInterface,
};

export { BankDepsProvider, type BankDeps } from "./deps";

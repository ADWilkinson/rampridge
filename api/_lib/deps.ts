/**
 * Everything a handler touches outside its own logic. Production wiring is
 * lazy: nothing reads the environment or opens a connection until a request
 * needs it.
 */

import { createChainGateway } from "./chain.js";
import type { ChainGateway } from "./chain.js";
import { getDb } from "./db.js";
import type { Db } from "./db.js";
import { cronSecret, sessionNotBefore, sessionSecret } from "./env.js";
import { fetchOrderbookTable } from "./market.js";
import type { TableFetcher } from "./market.js";
import type { WorldRules } from "../../shared/world.js";
import { cryptoRandomBytes } from "./random.js";
import type { RandomBytes } from "./random.js";
import { bakedWorldRules } from "./worldRules.js";

export interface ApiDeps {
  db: () => Db;
  now: () => number;
  sessionSecret: () => Uint8Array;
  /** SESSION_NOT_BEFORE: tokens issued before this unix second are refused (null: no cut-off). */
  sessionNotBefore: () => number | null;
  cronSecret: () => string;
  chain: () => ChainGateway;
  fetchTable: TableFetcher;
  randomBytes: RandomBytes;
  /** 0 <= n < 1, used for spawn placement. */
  random: () => number;
  /** Collision and spawn tiles for move validation and joins. */
  worldRules: () => WorldRules;
}

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export function productionDeps(): ApiDeps {
  return {
    db: getDb,
    now: () => Date.now(),
    sessionSecret,
    sessionNotBefore,
    cronSecret,
    chain: lazy(() => createChainGateway()),
    fetchTable: fetchOrderbookTable,
    randomBytes: cryptoRandomBytes,
    random: Math.random,
    worldRules: bakedWorldRules,
  };
}

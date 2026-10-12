import type { Appearance, PlayerRecord, Tile, WorldRequest } from "@shared/protocol";
import { DEFAULT_APPEARANCE, SPAWN_TILE, currentTiles } from "@shared/world";
import type { Engine } from "@/game";
import { MAX_RATE_LIMIT_WAIT_MS, postAct, startPresence, type Presence } from "@/net/actions";
import { ApiError } from "@/net/http";
import { getSession, type Session } from "@/net/session";
import { serverNow, useWorldStore } from "@/net/store";
import { lazyChunk } from "./lazyChunk";

/**
 * The player's presence in their world: the join (which picks the world),
 * the realtime connection to that world, heartbeats, hops between worlds,
 * and keeping the engine's local player on the tile the server has for it.
 * The server is the authority; whenever it disagrees (a rejected move, a
 * rejoin after a pause) the local player snaps back to the server's tile.
 */

const RECORD_WAIT_MS = 6_000;

/**
 * The realtime client and the Firebase SDK under it, as their own chunk: the
 * title doesn't need them, so they download once the title is up (Game) or
 * when the player enters, whichever is first. A failed download is retried
 * on the next call.
 */
export const loadWorldClient = lazyChunk(() => import("@/net/world"), {
  chunk: /\/world-[^/]*\.js$/,
  message: "The game didn't finish loading. Check your connection and try again.",
  label: "world",
});

/** Clock slack when matching our join to the record it wrote. */
const JOIN_SLACK_MS = 5_000;

/** The tile a record stands on now, or is stepping onto. */
export function tileOf(record: Pick<PlayerRecord, "p" | "t" | "r">, now: number): Tile | null {
  const tiles = currentTiles(record, now);
  return tiles[tiles.length - 1] ?? null;
}

function waitForRecord(pid: string, since: number, timeoutMs: number): Promise<PlayerRecord | null> {
  return new Promise((resolve) => {
    const fresh = (players: Record<string, PlayerRecord>) => {
      const record = players[pid];
      return record && record.j >= since ? record : null;
    };
    const now = fresh(useWorldStore.getState().players);
    if (now) {
      resolve(now);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(useWorldStore.getState().players[pid] ?? null);
    }, timeoutMs);
    const unsubscribe = useWorldStore.subscribe((state) => {
      const record = fresh(state.players);
      if (!record) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(record);
    });
  });
}

/**
 * A join the server refused (the bank is full, too many players from one
 * network, a temporary ban): a 429 with a wait far longer than a throttle,
 * which postAct gives up on at once instead of sleeping through.
 */
export function isJoinRefusal(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 429 && (err.retryAfterMs ?? 0) > MAX_RATE_LIMIT_WAIT_MS;
}

/**
 * Tells the player, once, why an automatic rejoin was refused. Presence
 * retries the join with every heartbeat (15 s), so the same refusal stays
 * quiet until the player is back in (`reset`). Errors before the player is
 * in the world are the entry path's to show (the title), not the chatbox's.
 */
export class RejoinNotice {
  private readonly shown = new Set<string>();
  inWorld = false;

  constructor(private readonly post: (text: string) => void) {}

  note(err: unknown): void {
    if (!this.inWorld || !isJoinRefusal(err) || this.shown.has(err.message)) return;
    this.shown.add(err.message);
    this.post(err.message);
  }

  reset(): void {
    this.shown.clear();
  }
}

export class WorldSession {
  private presence: Presence | null = null;
  private readonly rejoinNotice = new RejoinNotice((text) => useWorldStore.getState().addGameMessage(text));
  private disconnectWorld: (() => void) | null = null;
  private connecting: Promise<void> | null = null;
  /** The world the realtime view is open on. */
  private viewing: number | null = null;
  private stopWatching: (() => void) | null = null;
  private stopFollowing: (() => void) | null = null;
  private appearance: Appearance | null = null;
  /** What the first join of an entry asks for (a ?world= link, a shared trade's world, or "auto"); later rejoins ask for the world the player is in. */
  private firstRequest: WorldRequest | null = null;
  /** `j` of the record our latest join wrote; a newer one means the server rejoined us at the spawn. */
  private joinedAt = 0;

  constructor(private readonly engine: Engine) {}

  get inWorld(): boolean {
    return this.presence !== null;
  }

  /**
   * Opens the realtime view of `world`, closing the view of any other world
   * (a hop starts the new world's players, chat and news afresh). Idempotent
   * for the world already open. Resolves once it is connecting; rejects when
   * the realtime client could not be downloaded (a later call tries again).
   */
  connect(world: number): Promise<void> {
    if (this.connecting && this.viewing === world) return this.connecting;
    this.disconnectWorld?.();
    let stopped = false;
    let disconnect: (() => void) | null = null;
    const stop = () => {
      stopped = true;
      disconnect?.();
    };
    this.disconnectWorld = stop;
    this.viewing = world;
    const connecting = loadWorldClient().then(
      ({ connectWorldStore }) => {
        if (!stopped) disconnect = connectWorldStore(world);
      },
      (err: unknown) => {
        if (this.disconnectWorld === stop) {
          this.disconnectWorld = null;
          this.connecting = null;
          this.viewing = null;
        }
        throw err;
      },
    );
    this.connecting = connecting;
    return connecting;
  }

  /**
   * Joins a world with `appearance` (`request`: "auto", or a world number the
   * server honours when it has room), opens that world's realtime view and
   * places the local player where the server put it. Resolves with the world;
   * rejects with the API error when the join fails.
   */
  async enter(session: Session, appearance: Appearance, request: WorldRequest = "auto"): Promise<number> {
    this.appearance = appearance;
    this.firstRequest = request;
    // Normally already in: the realtime client downloads while the title shows.
    const client = loadWorldClient();
    this.presence?.stop();
    const since = serverNow() - JOIN_SLACK_MS;
    this.rejoinNotice.inWorld = false;
    this.rejoinNotice.reset();
    const presence = startPresence({
      appearance: () => this.appearance ?? appearance,
      world: () => this.firstRequest ?? getSession()?.world ?? "auto",
      onError: (err) => {
        console.warn("[presence]", err instanceof Error ? err.message : err);
        this.rejoinNotice.note(err);
      },
    });
    this.presence = presence;
    let world: number;
    try {
      await Promise.all([presence.rejoin(), client]);
      this.firstRequest = null;
      const joined = getSession()?.world;
      if (!joined) throw new ApiError(500, "server", "The bank didn't say which world you are on. Please try again.");
      world = joined;
      await this.connect(world);
    } catch (err) {
      presence.stop();
      this.presence = null;
      this.firstRequest = null;
      throw err;
    }
    const record = await waitForRecord(session.pid, since, RECORD_WAIT_MS);
    this.place(session, record);
    this.engine.setTitleMode(false);
    this.watchRejoins(session.pid);
    this.followWorld();
    this.rejoinNotice.inWorld = true;
    return world;
  }

  /**
   * World Switcher: moves the player to `world`. The join answers with a
   * token for the new world; following it (followWorld) opens that world's
   * view, and the rejoin watcher places the player on the tile they hopped
   * from. Rejects with the server's reason ("World 302 is full.") and leaves
   * everything as it was.
   */
  async hop(world: number): Promise<void> {
    if (!this.presence) return;
    await this.presence.hop(world);
  }

  /** Whenever the session's world changes (a hop, or a rejoin the server placed elsewhere), watch that world instead. */
  private followWorld(): void {
    this.stopFollowing?.();
    this.stopFollowing = useWorldStore.subscribe((state, prev) => {
      const world = state.me?.world ?? null;
      if (world === null || world === (prev.me?.world ?? null) || world === this.viewing || !this.presence) return;
      void this.connect(world).catch((err: unknown) => console.warn("[world]", err instanceof Error ? err.message : err));
    });
  }

  private place(session: Pick<Session, "pid" | "name">, record: PlayerRecord | null): void {
    const tile = (record && tileOf(record, serverNow())) ?? SPAWN_TILE;
    if (record) this.joinedAt = record.j;
    this.engine.setLocalPlayer({
      pid: session.pid,
      name: record?.n ?? session.name,
      appearance: this.appearance ?? record?.a ?? DEFAULT_APPEARANCE,
      tile,
    });
  }

  private watchRejoins(pid: string): void {
    this.stopWatching?.();
    this.stopWatching = useWorldStore.subscribe((state, prev) => {
      const record = state.players[pid];
      if (!record || record === prev.players[pid] || record.j <= this.joinedAt) return;
      // Heartbeats paused (hidden tab, lost connection) and presence joined us again at the spawn.
      this.place({ pid, name: record.n }, record);
      // Back in: a later refusal is news again.
      this.rejoinNotice.reset();
    });
  }

  /**
   * Takes the player back from another tab that took over (useWorldStore's
   * `playingElsewhere`): claims the presence and joins again. The rejoin
   * watcher then places the player where the server spawned it.
   */
  async resume(): Promise<void> {
    if (!this.presence) return;
    await this.presence.resume();
  }

  /** Snaps the local player to the server's tile for it. */
  resync(): void {
    const me = getSession();
    if (!me || !this.presence) return;
    const record = useWorldStore.getState().players[me.pid];
    if (record) this.place(me, record);
  }

  /** Posts a path the engine chose; re-syncs when the server rejects it. */
  async move(path: Tile[], run: boolean): Promise<void> {
    if (!this.presence || path.length < 2) return;
    try {
      await postAct({ type: "move", path, run });
    } catch (err) {
      if (!(err instanceof ApiError)) return;
      if (err.code === "not_joined") {
        await this.presence?.rejoin().catch((refused: unknown) => this.rejoinNotice.note(refused));
      } else if (err.status === 400 || err.status === 409) {
        this.resync();
      }
    }
  }

  setAppearance(appearance: Appearance): void {
    this.appearance = appearance;
  }

  /** Leaves the world (removes the player for everyone) and closes the realtime view. */
  leave(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopFollowing?.();
    this.stopFollowing = null;
    this.presence?.stop();
    this.presence = null;
    this.disconnectWorld?.();
    this.disconnectWorld = null;
    this.connecting = null;
    this.viewing = null;
    this.joinedAt = 0;
    this.rejoinNotice.inWorld = false;
    // The title scene shows the bank without other players.
    this.engine.syncPlayers([], serverNow());
    this.engine.setStalls({});
    this.engine.setTitleMode(true);
  }
}

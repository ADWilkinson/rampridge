import { useEffect, useState } from "react";
import { CloseButton, StoneButton } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";
import { PleaseWait } from "@/ui/kit/PleaseWait";
import { ScrollArea } from "@/ui/kit/ScrollArea";

/** One world in the switcher. `players` is null for the player's own world after it was closed. */
export interface WorldSwitcherRow {
  id: number;
  players: number | null;
  full: boolean;
  closed: boolean;
}

export interface LogoutPanelProps {
  onLogout: () => void;
  busy?: boolean;
  /** The world the player is on, shown on the tab and highlighted in the switcher. */
  world?: number | null;
  /** The switcher's list: null while it loads. */
  worlds?: WorldSwitcherRow[] | null;
  /** Why the list could not load (shown in place of the list). */
  worldsError?: string | null;
  /** The switcher opened or closed: the caller polls the list only while it is open. */
  onSwitcherChange?: (open: boolean) => void;
  /** Hop to a world; the panel says "Please wait..." while `hopping` names it. */
  onHop?: (world: number) => void;
  hopping?: number | null;
}

function playersText(row: WorldSwitcherRow): string {
  if (row.players === null) return "-";
  return row.full ? "FULL" : String(row.players);
}

function rowLabel(row: WorldSwitcherRow, current: boolean): string {
  const parts = [`World ${row.id}`];
  parts.push(row.players === null ? "closed" : row.full ? "full" : `${row.players} ${row.players === 1 ? "player" : "players"}`);
  if (current) parts.push("your current world");
  return parts.join(", ");
}

/**
 * The logout tab, worded as the original, with its World Switcher: the list
 * of worlds with their player counts and the current one highlighted. A
 * click on another world hops there ("Please wait..." while it does).
 */
export function LogoutPanel({ onLogout, busy = false, world = null, worlds = null, worldsError = null, onSwitcherChange, onHop, hopping = null }: LogoutPanelProps) {
  const [switcher, setSwitcher] = useState(false);
  const canSwitch = onHop !== undefined && world !== null;

  useEffect(() => {
    onSwitcherChange?.(switcher && canSwitch);
  }, [switcher, canSwitch, onSwitcherChange]);
  useEffect(() => () => onSwitcherChange?.(false), [onSwitcherChange]);

  if (busy) {
    return (
      <div className="rs-panel rs-logout rs-p12">
        <PleaseWait className="rs-c-yellow rs-shadow" />
      </div>
    );
  }

  if (!switcher || !canSwitch) {
    return (
      <div className="rs-panel rs-logout rs-p12">
        <p className="rs-logout__text rs-c-orange rs-shadow">When you have finished playing RampRidge, always use the button below to logout safely.</p>
        {canSwitch && (
          <div className="rs-logout__world">
            <p className="rs-c-yellow rs-shadow">You are on World {world}.</p>
            <StoneButton onClick={() => setSwitcher(true)}>World Switcher</StoneButton>
          </div>
        )}
        <StoneButton size="big" onClick={onLogout}>
          Click here to logout
        </StoneButton>
      </div>
    );
  }

  return (
    <div className="rs-panel rs-worlds rs-p12" role="group" aria-label="World Switcher">
      <div className="rs-worlds__head">
        <span className="rs-c-orange rs-shadow">Current World</span>
        <span className="rs-worlds__current rs-b12 rs-c-yellow rs-shadow">{world}</span>
        <CloseButton className="rs-worlds__close" label="Close the World Switcher" onClick={() => setSwitcher(false)} />
      </div>
      <div className="rs-worlds__cols rs-p11 rs-c-orange rs-shadow" aria-hidden="true">
        <span>World</span>
        <span>Players</span>
      </div>
      {hopping !== null ? (
        <div className="rs-worlds__wait">
          <PleaseWait className="rs-c-yellow rs-shadow" />
          <span className="rs-p11 rs-c-orange rs-shadow">Switching to World {hopping}</span>
        </div>
      ) : worlds === null ? (
        <div className="rs-worlds__wait">
          {worldsError ? <span className="rs-p11 rs-c-stone-red rs-shadow">{worldsError}</span> : <PleaseWait className="rs-c-yellow rs-shadow" text="Loading" />}
        </div>
      ) : (
        <ScrollArea className="rs-worlds__list" label="Worlds">
          <ul className="rs-worlds__rows">
            {worlds.map((row) => {
              const current = row.id === world;
              const disabled = current || row.full || row.closed;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className={cx("rs-worlds__row", current && "rs-worlds__row--current", (row.full || row.closed) && !current && "rs-worlds__row--full")}
                    disabled={disabled}
                    aria-current={current ? "true" : undefined}
                    aria-label={rowLabel(row, current)}
                    title={current ? "You are here" : row.full ? "This world is full" : `Switch to World ${row.id}`}
                    onClick={() => onHop?.(row.id)}
                  >
                    <span className="rs-worlds__id">{row.id}</span>
                    <span className={cx("rs-worlds__count", row.full && "rs-c-stone-red")}>{playersText(row)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
      <div className="rs-worlds__foot">
        <StoneButton onClick={onLogout}>Logout</StoneButton>
      </div>
    </div>
  );
}

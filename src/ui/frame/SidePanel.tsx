import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/ui/kit/cx";
import { useEscapeLayer, useLayoutMode } from "@/ui/kit/hooks";
import { Sprite } from "@/ui/kit/Sprite";
import type { SpriteName } from "@/ui/kit/sprites";

export type SideTabId = "inventory" | "account" | "emotes" | "settings" | "logout";

interface TabSlot {
  id: SideTabId;
  label: string;
  icon: SpriteName;
  row: 0 | 1;
  col: number;
}

/** Tabs sit where the original client put the equivalent tab. */
export const SIDE_TABS: readonly TabSlot[] = [
  { id: "inventory", label: "Inventory", icon: "tabIconInventory", row: 0, col: 3 },
  { id: "account", label: "Account", icon: "tabIconAccount", row: 1, col: 1 },
  { id: "logout", label: "Logout", icon: "tabIconLogout", row: 1, col: 3 },
  { id: "settings", label: "Settings", icon: "tabIconSettings", row: 1, col: 4 },
  { id: "emotes", label: "Emotes", icon: "tabIconEmotes", row: 1, col: 5 },
];

/**
 * The original tabs the bank has no use for, drawn dimmed on their own
 * stones (as the fixed client lays them out) so the panel reads as the real
 * one instead of a row of blank stones. Decoration only: no hover, no click,
 * hidden from assistive tech. Desktop only; the phone strip shows real tabs.
 */
export const SIDE_DECOR: readonly { icon: SpriteName; row: 0 | 1; col: number }[] = [
  { icon: "tabIconCombat", row: 0, col: 0 },
  { icon: "tabIconStats", row: 0, col: 1 },
  { icon: "tabIconQuests", row: 0, col: 2 },
  { icon: "tabIconEquipment", row: 0, col: 4 },
  { icon: "tabIconPrayer", row: 0, col: 5 },
  { icon: "tabIconMagic", row: 0, col: 6 },
  { icon: "tabIconClanChat", row: 1, col: 0 },
  { icon: "tabIconFriends", row: 1, col: 2 },
  { icon: "tabIconMusic", row: 1, col: 6 },
];

/** Stone columns of both tab rows (measured from SIDE_BACKGROUND_TOP/BOTTOM). */
const COL_X = [6, 44, 77, 110, 143, 176, 209] as const;
const COL_W = [38, 33, 33, 33, 33, 33, 38] as const;
const ROW_Y = [1, 299] as const;

function highlightFor(row: 0 | 1, col: number): SpriteName {
  if (col === 0) return row === 0 ? "sideHighlightTopLeft" : "sideHighlightBottomLeft";
  if (col === 6) return row === 0 ? "sideHighlightTopRight" : "sideHighlightBottomRight";
  return "sideHighlightMiddle";
}

export interface SidePanelProps {
  /** Open tab, or null when the panel is closed (click the open tab to close it). */
  active: SideTabId | null;
  onChange: (tab: SideTabId | null) => void;
  /** Panel content per tab; tabs without content are not shown. */
  panels: Partial<Record<SideTabId, ReactNode>>;
  /** Force the phone layout (tab strip and sheet); defaults to the screen's layout mode. */
  mobile?: boolean;
  className?: string;
}

/**
 * The stone side panel (two rows of seven tab stones around the 190x261
 * panel). On phones it becomes a row of tab icons that opens the panel as a
 * sheet.
 */
export function SidePanel({ active, onChange, panels, mobile: mobileProp, className }: SidePanelProps) {
  const autoMobile = useLayoutMode().sheet;
  const mobile = mobileProp ?? autoMobile;
  const tabs = SIDE_TABS.filter((t) => panels[t.id] !== undefined);
  const strip = useRef<HTMLDivElement>(null);
  useEscapeLayer(() => onChange(null), mobile && active !== null);

  const toggle = (id: SideTabId) => onChange(active === id ? null : id);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (!next) return;
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  const body = active ? panels[active] : null;

  if (mobile) {
    return (
      <div className={cx("rs-side rs-side--mobile rs-game", className)}>
        {active && body !== null && (
          <div className="rs-side__sheet" role="tabpanel" aria-label={SIDE_TABS.find((t) => t.id === active)?.label}>
            <div className="rs-side__sheet-body">{body}</div>
          </div>
        )}
        <div ref={strip} className="rs-side__strip" role="tablist" aria-label="Side panel">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              data-tab={t.id}
              type="button"
              role="tab"
              aria-selected={active === t.id}
              aria-label={t.label}
              className={cx("rs-side__mtab", active === t.id && "rs-side__mtab--active")}
              onClick={() => toggle(t.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <Sprite name={t.icon} canvas fallback={<span className="rs-side__icon-fallback rs-p11">{t.label.slice(0, 3)}</span>} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cx("rs-side rs-game", !active && "rs-side--closed", className)}>
      <span className="rs-side__top" aria-hidden="true" />
      {active && (
        <>
          <span className="rs-side__left-top" aria-hidden="true" />
          <span className="rs-side__left-bottom" aria-hidden="true" />
          <span className="rs-side__right" aria-hidden="true" />
          <div className="rs-side__body" role="tabpanel" id={`rs-side-panel-${active}`} aria-labelledby={`rs-side-tab-${active}`}>
            {body}
          </div>
        </>
      )}
      <span className="rs-side__bottom" aria-hidden="true" />
      <div className="rs-side__decor" aria-hidden="true">
        {SIDE_DECOR.map((d) => (
          <span
            key={d.icon}
            className="rs-side__stone"
            style={{ left: COL_X[d.col], top: d.row === 0 ? ROW_Y[0] : active ? ROW_Y[1] : ROW_Y[1] - 261, width: COL_W[d.col] }}
          >
            <Sprite name={d.icon} canvas />
          </span>
        ))}
      </div>
      <div ref={strip} role="tablist" aria-label="Side panel" className="rs-side__tabs">
        {tabs.map((t, i) => {
          const selected = active === t.id;
          const y = t.row === 0 ? ROW_Y[0] : active ? ROW_Y[1] : ROW_Y[1] - 261;
          return (
            <button
              key={t.id}
              id={`rs-side-tab-${t.id}`}
              data-tab={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={selected ? `rs-side-panel-${t.id}` : undefined}
              aria-label={t.label}
              className="rs-side__tab"
              style={{ left: COL_X[t.col], top: y, width: COL_W[t.col] }}
              onClick={() => toggle(t.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {selected && <Sprite name={highlightFor(t.row, t.col)} className="rs-side__highlight" fallback={<span className="rs-side__highlight-fallback" />} />}
              <Sprite name={t.icon} canvas className="rs-side__icon" fallback={<span className="rs-side__icon-fallback rs-p11">{t.label.slice(0, 3)}</span>} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

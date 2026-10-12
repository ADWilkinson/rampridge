import { useRef, useState, type ReactNode } from "react";
import type { Appearance } from "@shared/protocol";
import type { DesignerCatalog } from "@/game/osrs/types";
import { ArrowButton, StoneButton, TextButton } from "@/ui/kit/buttons";
import { cx } from "@/ui/kit/cx";
import { useEscapeLayer, useIsMobile } from "@/ui/kit/hooks";
import { PleaseWait } from "@/ui/kit/PleaseWait";
import { Window } from "@/ui/kit/Window";
import { cycleOption, kitSlotEditable, switchBody } from "./design";
import { NameField, type NameCheck, type NameFieldController } from "./NameField";

export const KIT_LABELS = ["Head", "Jaw", "Torso", "Arms", "Hands", "Legs", "Feet"] as const;
export const COLOUR_LABELS = ["Hair", "Torso", "Legs", "Feet", "Skin"] as const;

export interface CharacterDesignProps {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
  /** From CharacterFactory.designer(). */
  catalog: DesignerCatalog;
  /** The live model preview (renderCharacterPreview from the character runtime). */
  preview?: ReactNode;
  name: string;
  onNameChange: (name: string) => void;
  onCheckName: NameCheck;
  /** Name the player already holds, accepted without a check. */
  currentName?: string;
  /** Called once the name is confirmed available. */
  onAccept: (result: { appearance: Appearance; name: string }) => void;
  /** Skip design and keep the generated look and name. */
  onSkip?: () => void;
  busy?: boolean;
  error?: string | null;
}

function Swatch({ color }: { color?: string }) {
  return <span className="rs-swatch" style={{ background: color ?? "transparent" }} aria-hidden="true" />;
}

/**
 * The original character designer, titled "Welcome to RampRidge": arrows for
 * each body part on the left, colours on the right with swatches, the model
 * preview and gender in the middle, then the display name and Accept.
 */
/** Height the window grows by while it shows an error, so the error stays inside it on every layout. */
const ERROR_ROOM = 20;
const ERROR_ROOM_MOBILE = 34;

export function CharacterDesign({
  appearance,
  onChange,
  catalog,
  preview,
  name,
  onNameChange,
  onCheckName,
  currentName,
  onAccept,
  onSkip,
  busy = false,
  error = null,
}: CharacterDesignProps) {
  const mobile = useIsMobile();
  const nameField = useRef<NameFieldController>(null);
  const [palette, setPalette] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  useEscapeLayer(() => setPalette(null), palette !== null);

  const kitLists = catalog.kits[appearance.body];
  const setKit = (slot: number, dir: 1 | -1) => {
    const kits = [...appearance.kits] as Appearance["kits"];
    kits[slot] = cycleOption(kitLists[slot] ?? [], kits[slot]!, dir);
    onChange({ ...appearance, kits });
  };
  const setColour = (channel: number, index: number) => {
    const colors = [...appearance.colors] as Appearance["colors"];
    colors[channel] = index;
    onChange({ ...appearance, colors });
  };
  const stepColour = (channel: number, dir: 1 | -1) => setColour(channel, cycleOption(catalog.colors[channel] ?? [], appearance.colors[channel]!, dir));

  const accept = async () => {
    if (busy || checking) return;
    setChecking(true);
    const status = await nameField.current?.check();
    setChecking(false);
    if (status?.state === "available") onAccept({ appearance, name: status.name });
  };

  return (
    <Window
      title="Welcome to RampRidge"
      width={mobile ? 372 : 520}
      // A refusal ("The bank is full right now. ...") gets its own lines under the buttons, two on a phone.
      height={(mobile ? 664 : 390) + (error ? (mobile ? ERROR_ROOM_MOBILE : ERROR_ROOM) : 0)}
      className={cx("rs-design", mobile && "rs-design--mobile")}
      ariaLabel="Character design"
    >
      <div className="rs-design__grid">
        <section className="rs-design__col rs-design__parts" aria-labelledby="rs-design-parts">
          <h3 id="rs-design-parts" className="rs-design__heading rs-b12">
            Design
          </h3>
          {KIT_LABELS.map((label, slot) => {
            const off = !kitSlotEditable(catalog, appearance.body, slot);
            return (
              <div key={label} className="rs-design__row">
                <ArrowButton direction="left" label={`Previous ${label.toLowerCase()}`} disabled={off} onClick={() => setKit(slot, -1)} />
                <span className="rs-design__label rs-p12">{label}</span>
                <ArrowButton direction="right" label={`Next ${label.toLowerCase()}`} disabled={off} onClick={() => setKit(slot, 1)} />
              </div>
            );
          })}
        </section>

        <section className="rs-design__centre" aria-label="Preview and gender">
          <div className="rs-design__preview">{preview}</div>
          <h3 className="rs-design__heading rs-b12">Gender</h3>
          <div className="rs-design__gender" role="radiogroup" aria-label="Gender">
            <StoneButton selected={appearance.body === 0} role="radio" aria-checked={appearance.body === 0} onClick={() => onChange(switchBody(appearance, catalog, 0))}>
              Male
            </StoneButton>
            <StoneButton selected={appearance.body === 1} role="radio" aria-checked={appearance.body === 1} onClick={() => onChange(switchBody(appearance, catalog, 1))}>
              Female
            </StoneButton>
          </div>
        </section>

        <section className="rs-design__col rs-design__colours" aria-labelledby="rs-design-colours">
          <h3 id="rs-design-colours" className="rs-design__heading rs-b12">
            Colour
          </h3>
          {COLOUR_LABELS.map((label, channel) => {
            const opts = catalog.colors[channel] ?? [];
            const current = opts.find((o) => o.index === appearance.colors[channel]);
            const off = opts.length < 2;
            return (
              <div key={label} className="rs-design__row">
                <ArrowButton direction="left" label={`Previous ${label.toLowerCase()} colour`} disabled={off} onClick={() => stepColour(channel, -1)} />
                <button
                  type="button"
                  className="rs-design__label rs-design__colour rs-p12"
                  disabled={off}
                  aria-expanded={palette === channel}
                  aria-label={`${label} colour, choose from ${opts.length}`}
                  onClick={() => setPalette(palette === channel ? null : channel)}
                >
                  <Swatch color={current?.swatch} />
                  {label}
                </button>
                <ArrowButton direction="right" label={`Next ${label.toLowerCase()} colour`} disabled={off} onClick={() => stepColour(channel, 1)} />
                {palette === channel && (
                  <div className="rs-palette" role="listbox" aria-label={`${label} colours`}>
                    {opts.map((o, i) => (
                      <button
                        key={o.index}
                        type="button"
                        role="option"
                        aria-selected={o.index === appearance.colors[channel]}
                        aria-label={`${label} colour ${i + 1}`}
                        className={cx("rs-palette__swatch", o.index === appearance.colors[channel] && "rs-palette__swatch--on")}
                        style={{ background: o.swatch }}
                        onClick={() => {
                          setColour(channel, o.index);
                          setPalette(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      <div className="rs-design__footer">
        <NameField value={name} onChange={onNameChange} onCheck={onCheckName} current={currentName} controller={nameField} onSubmit={() => void accept()} className="rs-design__name" />
        <div className="rs-design__actions">
          {busy || checking ? (
            <PleaseWait className="rs-c-yellow rs-shadow rs-p12" />
          ) : (
            <StoneButton size="big" onClick={() => void accept()}>
              Accept
            </StoneButton>
          )}
          {onSkip && !busy && (
            <TextButton tone="orange" onClick={onSkip}>
              Skip for now
            </TextButton>
          )}
        </div>
        {error && (
          <p className="rs-design__error rs-p12" role="alert">
            {error}
          </p>
        )}
      </div>
    </Window>
  );
}

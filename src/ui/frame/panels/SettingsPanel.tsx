import { Checkbox, VolumeSlider } from "@/ui/kit/Checkbox";
import { HUD_HIDE_SHORTCUT, useHudVisibility } from "../hud";

export interface GameSettings {
  /** 0 (off) to 4. */
  soundVolume: number;
  /** 0 (off) to 4. Kept for saved settings; no music ships yet, so the panel has no music control. */
  musicVolume: number;
  /** Coloured and moving overhead chat. */
  chatEffects: boolean;
  /** Stops chat motion, fireworks and interface animation. */
  reducedMotion: boolean;
}

export interface SettingsPanelProps {
  settings: GameSettings;
  onChange: (patch: Partial<GameSettings>) => void;
}

/**
 * The settings tab: the sound volume bar, then the option checkboxes. The
 * client's music bar is left out until the bake renders music. Inside a
 * desktop GameFrame it also offers "Hide interface" for filming the bank.
 */
export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const hud = useHudVisibility();
  return (
    <div className="rs-panel rs-settings rs-p12">
      <h3 className="rs-panel__title rs-b12">Settings</h3>
      <p className="rs-settings__label rs-c-orange rs-shadow">Sound effect volume</p>
      <VolumeSlider label="Sound effects" icon="optionIconSound" mutedIcon="optionIconSoundOff" value={settings.soundVolume} onChange={(v) => onChange({ soundVolume: v })} />
      <hr className="rs-panel__rule" />
      <div className="rs-settings__checks">
        <Checkbox label="Chat effects" checked={settings.chatEffects} onChange={(v) => onChange({ chatEffects: v })} />
        <Checkbox label="Reduced motion" checked={settings.reducedMotion} onChange={(v) => onChange({ reducedMotion: v })} />
        {hud?.available && (
          <Checkbox
            label={`Hide interface (${HUD_HIDE_SHORTCUT})`}
            checked={false}
            disabled={!hud.canHide}
            onChange={(v) => {
              if (v) hud.hide();
            }}
          />
        )}
      </div>
    </div>
  );
}

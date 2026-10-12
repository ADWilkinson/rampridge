import { EMOTES, type EmoteId } from "@shared/protocol";
import { Sprite } from "@/ui/kit/Sprite";
import type { SpriteName } from "@/ui/kit/sprites";
import { useHudHover } from "../hudHover";
import type { MenuEntry } from "../menu";

export const EMOTE_LABELS: Readonly<Record<EmoteId, string>> = {
  yes: "Yes",
  no: "No",
  bow: "Bow",
  angry: "Angry",
  think: "Think",
  wave: "Wave",
  shrug: "Shrug",
  cheer: "Cheer",
  beckon: "Beckon",
  laugh: "Laugh",
  jump: "Jump for Joy",
  dance: "Dance",
  clap: "Clap",
  cry: "Cry",
};

const EMOTE_SPRITES: Readonly<Record<EmoteId, SpriteName>> = {
  yes: "emoteYes",
  no: "emoteNo",
  bow: "emoteBow",
  angry: "emoteAngry",
  think: "emoteThink",
  wave: "emoteWave",
  shrug: "emoteShrug",
  cheer: "emoteCheer",
  beckon: "emoteBeckon",
  laugh: "emoteLaugh",
  jump: "emoteJump",
  dance: "emoteDance",
  clap: "emoteClap",
  cry: "emoteCry",
};

export interface EmotesPanelProps {
  onEmote: (emote: EmoteId) => void;
  /** Mouseover line ("Yes"); inside GameFrame it feeds the HUD automatically. */
  onHover?: (entry: MenuEntry | null) => void;
  disabled?: boolean;
}

/** The emotes tab: the 14 emotes in the original order, as figure icons. */
export function EmotesPanel({ onEmote, onHover: onHoverProp, disabled = false }: EmotesPanelProps) {
  const hud = useHudHover();
  const onHover = onHoverProp ?? hud;
  return (
    <div className="rs-panel rs-emotes" role="group" aria-label="Emotes">
      {EMOTES.map((id) => (
        <button
          key={id}
          type="button"
          className="rs-emote"
          aria-label={EMOTE_LABELS[id]}
          disabled={disabled}
          onClick={() => onEmote(id)}
          onPointerEnter={() => onHover?.({ verb: EMOTE_LABELS[id] })}
          onPointerLeave={() => onHover?.(null)}
        >
          <Sprite name={EMOTE_SPRITES[id]} canvas fallback={<span className="rs-emote__fallback rs-p11">{EMOTE_LABELS[id]}</span>} />
        </button>
      ))}
    </div>
  );
}

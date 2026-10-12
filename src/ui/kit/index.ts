/**
 * OSRS interface kit. Import from "@/ui/kit" so the stylesheet loads; call
 * `ensureSprites()` early (the loading screen) so sprites are ready.
 */
import "./kit.css";

export { AmountPad, NumberInput, type AmountPadProps, type NumberInputProps } from "./AmountPad";
export { DEFAULT_STEPS, clampAmount, filterAmountKeystrokes, formatAmount, parseAmount, roundTo, stepAmount, stepLabel, type AmountRules } from "./amount";
export {
  ArrowButton,
  BUTTON_TILES,
  CloseButton,
  NineSlice,
  StoneButton,
  TextButton,
  type ArrowButtonProps,
  type CloseButtonProps,
  type NineSliceTiles,
  type StoneButtonProps,
  type TextButtonProps,
  type TextTone,
} from "./buttons";
export { ChatPromptProvider, ChatboxPrompt, useChatPrompt, type ChatPromptRequest, type ChatboxPromptProps } from "./ChatPrompt";
export { Checkbox, Toggle, VolumeSlider, type CheckboxProps, type ToggleProps, type VolumeSliderProps } from "./Checkbox";
export { CountdownText, type CountdownTextProps } from "./CountdownText";
export { cx } from "./cx";
export { ChatArea, Dialogue, type DialogueOption, type DialogueProps, type DialogueSpeaker } from "./Dialogue";
export {
  STACK_COLORS,
  formatCountdown,
  formatDecimal,
  formatDurationWords,
  formatNumber,
  formatStack,
  orbTextColor,
  shortAddress,
  showsStack,
  type StackLabel,
  type StackTier,
} from "./format";
export {
  currentLayoutMode,
  focusableIn,
  useCompactLandscape,
  useEscapeLayer,
  useFitScale,
  useFocusTrap,
  useIsMobile,
  useLayoutMode,
  useMediaQuery,
  useNow,
  useReducedMotion,
  useTick,
  useTouch,
} from "./hooks";
export {
  COMPACT_LANDSCAPE_QUERY,
  MIN_FIT_SCALE,
  MIN_LEGIBLE_SCALE,
  NARROW_QUERY,
  TOUCH_QUERY,
  UI_ZOOM,
  UI_ZOOM_QUERY,
  fitScale,
  layoutMode,
  needsUpright,
  uiZoomFor,
  type LayoutMode,
} from "./layout";
export { ItemGrid, ItemSlot, StackCount, type ItemData, type ItemGridProps, type ItemSlotProps } from "./ItemSlot";
export { ParchmentScroll, type ParchmentScrollProps } from "./ParchmentScroll";
export { UprightNotice, type UprightNoticeProps } from "./UprightNotice";
export { PleaseWait, type PleaseWaitProps } from "./PleaseWait";
export { ProgressBar, type ProgressBarProps, type ProgressState } from "./ProgressBar";
export { encodeQr, qrPath, type QrEcc, type QrMatrix } from "./qr";
export { QrCode, type QrCodeProps } from "./QrCode";
export { ScrollArea, Scrollbar, type ScrollAreaProps, type ScrollbarProps } from "./ScrollArea";
export { Sprite, spriteSize, type SpriteProps } from "./Sprite";
export {
  SPRITES,
  SPRITE_BASE,
  UI_SPRITE_IDS,
  UI_SPRITE_REFS,
  coinsSpriteFor,
  ensureSprites,
  loadSprite,
  parseSpriteManifest,
  spriteBackground,
  spriteFileName,
  spriteState,
  spriteUrl,
  spritesSettled,
  useSprite,
  useSpriteById,
  useSpritesReady,
  type SpriteDef,
  type SpriteManifest,
  type SpriteName,
  type SpriteRef,
  type SpriteState,
  type SpriteStatus,
} from "./sprites";
export { Tabs, type TabItem, type TabsProps } from "./Tabs";
export { Tooltip, TooltipBox, type TooltipBoxProps, type TooltipProps } from "./Tooltip";
export { Frame, Window, WindowHost, type WindowProps } from "./Window";
export { cssZoomOf, menuPlacement, screenScaleY, tooltipPlacement, type Placement } from "./zoom";

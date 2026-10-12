/** Non-trading screens: loader, title, character design, rename, how it works. */
import "@/ui/kit";
import "./screens.css";

export { COLOUR_LABELS, CharacterDesign, KIT_LABELS, type CharacterDesignProps } from "./CharacterDesign";
export { JAW_SLOT, cycleOption, kitSlotEditable, switchBody } from "./design";
export { HowItWorks, type HowItWorksProps } from "./HowItWorks";
export { LoadingScreen, type LoadingScreenProps } from "./LoadingScreen";
export { NameEntry, type NameEntryProps } from "./NameEntry";
export { NameField, validateName, type NameAvailability, type NameCheck, type NameFieldController, type NameFieldProps, type NameStatus } from "./NameField";
export { TitleScreen, Wordmark, type TitleScreenProps } from "./TitleScreen";

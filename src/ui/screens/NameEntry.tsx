import { useRef, useState } from "react";
import { StoneButton } from "@/ui/kit/buttons";
import { PleaseWait } from "@/ui/kit/PleaseWait";
import { Window } from "@/ui/kit/Window";
import { NameField, type NameCheck, type NameFieldController } from "./NameField";

export interface NameEntryProps {
  /** The current name, prefilled. */
  initialName: string;
  onCheck: NameCheck;
  /** Saves the new name; reject or return an error string to show it. */
  onSubmit: (name: string) => Promise<string | void> | string | void;
  onClose: () => void;
}

/** The rename dialog: one name field with an availability check, then "Set name". */
export function NameEntry({ initialName, onCheck, onSubmit, onClose }: NameEntryProps) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<NameFieldController>(null);

  const submit = async () => {
    if (saving) return;
    setError(null);
    const status = await field.current?.check();
    if (status?.state !== "available") return;
    if (status.name === initialName) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await onSubmit(status.name);
      if (typeof res === "string") setError(res);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not change your name. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Window title="Change display name" width={380} height={196} onClose={onClose} className="rs-nameentry">
      <div className="rs-window__pad rs-nameentry__body">
        <p className="rs-p12 rs-c-orange rs-shadow">This is the name other players see above your head and in chat.</p>
        <NameField value={name} onChange={setName} onCheck={onCheck} current={initialName} controller={field} onSubmit={() => void submit()} label="New name:" autoFocus />
        <div className="rs-nameentry__actions">
          {saving ? (
            <PleaseWait className="rs-c-yellow rs-shadow rs-p12" />
          ) : (
            <>
              <StoneButton onClick={() => void submit()}>Set name</StoneButton>
              <StoneButton onClick={onClose}>Cancel</StoneButton>
            </>
          )}
        </div>
        {error && (
          <p className="rs-c-stone-red rs-shadow rs-p12" role="alert">
            {error}
          </p>
        )}
      </div>
    </Window>
  );
}

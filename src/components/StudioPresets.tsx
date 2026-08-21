import { useEffect, useState } from "react";
import { Bookmark, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deletePreset,
  readPresets,
  savePreset,
  type StudioPreset,
  type StudioPresetInput,
} from "@/lib/studio-presets";

type Props = {
  /** Current form state to capture when saving. */
  current: Omit<StudioPresetInput, "name">;
  /** Applies a stored preset back onto the form. */
  onLoad: (preset: StudioPreset) => void;
};

/** Save/load named payload presets for quick iteration in the Studio. */
export function StudioPresets({ current, onLoad }: Props) {
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    setPresets(readPresets());
  }, []);

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("Name the preset first.");
      return;
    }
    if (!current.style.trim()) {
      toast.error("Add a style or genre before saving a preset.");
      return;
    }
    setPresets(savePreset({ ...current, name: trimmed }));
    setName("");
    toast.success(`Preset “${trimmed}” saved.`);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-background/40 p-3">
      <div className="flex items-center gap-2">
        <Bookmark className="size-4 text-primary" aria-hidden />
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Payload presets
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1 space-y-1">
          <Label htmlFor="preset-name" className="sr-only">
            Preset name
          </Label>
          <Input
            id="preset-name"
            value={name}
            placeholder="Preset name — e.g. Gritty trap anthem"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
            }}
          />
        </div>
        <Button variant="outline" className="gap-2" onClick={handleSave}>
          <Save className="size-4" aria-hidden />
          Save preset
        </Button>
      </div>

      {presets.length > 0 ? (
        <ul className="space-y-2">
          {presets.map((preset) => (
            <li
              key={preset.id}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{preset.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {preset.style || "No style"}
                  {preset.lyrics.trim() ? " · lyrics saved" : " · no lyrics"}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onLoad(preset);
                  toast.success(`Loaded “${preset.name}”.`);
                }}
              >
                Load
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete preset ${preset.name}`}
                onClick={() => {
                  setPresets(deletePreset(preset.id));
                  toast.success("Preset deleted.");
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Save the current style, genre chips, vocal traits and lyric blocks to reload them in one tap.
        </p>
      )}
    </div>
  );
}

export default StudioPresets;

import { useEffect, useState } from "react";
import { BookmarkPlus, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteStyleTemplate,
  readStyleTemplates,
  saveStyleTemplate,
  type StyleTemplate,
} from "@/lib/style-templates";

type Props = {
  /** Current Style & Sound Prompt text. */
  current: string;
  /** Inserts a template into the prompt field. */
  onInsert: (text: string, mode: "replace" | "append") => void;
};

/** Save the current Style & Sound Prompt as a named template and reuse it later. */
export function StylePromptTemplates({ current, onInsert }: Props) {
  const [templates, setTemplates] = useState<StyleTemplate[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    setTemplates(readStyleTemplates());
  }, []);

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("Name the template first.");
      return;
    }
    if (!current.trim()) {
      toast.error("Write a style prompt before saving a template.");
      return;
    }
    setTemplates(saveStyleTemplate(trimmed, current));
    setName("");
    toast.success(`Template “${trimmed}” saved.`);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-2">
        <BookmarkPlus className="size-4 text-primary" aria-hidden />
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Prompt templates
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex-1">
          <Label htmlFor="style-template-name" className="sr-only">
            Template name
          </Label>
          <Input
            id="style-template-name"
            value={name}
            placeholder="Template name — e.g. Outlaw country baritone"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSave();
              }
            }}
          />
        </div>
        <Button type="button" variant="outline" className="gap-2" onClick={handleSave}>
          <BookmarkPlus className="size-4" aria-hidden />
          Save current prompt
        </Button>
      </div>

      {templates.length > 0 ? (
        <ul className="space-y-2">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/20 p-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{tpl.name}</p>
                <p className="truncate text-xs text-muted-foreground">{tpl.text}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onInsert(tpl.text, "replace")}
              >
                Insert as template
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Append template ${tpl.name}`}
                onClick={() => onInsert(tpl.text, "append")}
              >
                <Plus className="size-4" aria-hidden />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Delete template ${tpl.name}`}
                onClick={() => {
                  setTemplates(deleteStyleTemplate(tpl.id));
                  toast.success("Template deleted.");
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Save the current Style &amp; Sound Prompt under a name, then insert or append it into any
          future track.
        </p>
      )}
    </div>
  );
}

export default StylePromptTemplates;

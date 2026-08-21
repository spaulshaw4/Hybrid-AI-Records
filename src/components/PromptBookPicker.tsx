import { useMemo, useState } from "react";
import { usePersistentState, STUDIO_KEYS } from "@/lib/studio-persist";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROMPT_BOOK } from "@/lib/prompt-book";
import { Shuffle, Plus, RefreshCw } from "lucide-react";

type Props = {
  /** Called with the chosen prompt text; parent decides append vs replace. */
  onUse: (prompt: string, mode: "replace" | "append") => void;
};

export function PromptBookPicker({ onUse }: Props) {
  const [genreId, setGenreId] = usePersistentState(
    STUDIO_KEYS.promptBookGenre,
    PROMPT_BOOK[0]?.id ?? "",
  );
  const [index, setIndex] = useState(0);

  const genre = useMemo(
    () => PROMPT_BOOK.find((g) => g.id === genreId) ?? PROMPT_BOOK[0],
    [genreId],
  );
  const prompt = genre?.prompts[index % (genre.prompts.length || 1)] ?? "";

  if (!genre) return null;

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Prompt book
        </span>
        <Select
          value={genre.id}
          onValueChange={(v) => {
            setGenreId(v);
            setIndex(0);
          }}
        >
          <SelectTrigger className="h-8 w-[190px] text-xs">
            <SelectValue placeholder="Pick a genre" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {PROMPT_BOOK.map((g) => (
              <SelectItem key={g.id} value={g.id} className="text-xs">
                {g.genre}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1 text-xs"
          onClick={() => setIndex((i) => i + 1)}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Next
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1 text-xs"
          onClick={() => {
            const g = PROMPT_BOOK[Math.floor(Math.random() * PROMPT_BOOK.length)];
            setGenreId(g.id);
            setIndex(Math.floor(Math.random() * g.prompts.length));
          }}
        >
          <Shuffle className="h-3.5 w-3.5" aria-hidden />
          Surprise me
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{prompt}</p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => onUse(prompt, "replace")}
        >
          Use this prompt
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 text-xs"
          onClick={() => onUse(prompt, "append")}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Append
        </Button>
      </div>
    </div>
  );
}

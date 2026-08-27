import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[60px] w-full select-text rounded-lg border border-zinc-700/80 bg-zinc-950/60 px-3 py-2 text-base text-zinc-100 shadow-sm pointer-events-auto placeholder:text-zinc-500 focus-visible:border-red-500/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };

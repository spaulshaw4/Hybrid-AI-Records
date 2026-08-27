import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full select-text rounded-lg border border-zinc-700/80 bg-zinc-950/60 px-3 py-1 text-base text-zinc-100 shadow-sm pointer-events-auto transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-zinc-100 placeholder:text-zinc-500 focus-visible:border-red-500/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** Bloco de carregamento. Compor com a forma do conteúdo final. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-[skeleton-pulse_1.6s_ease-in-out_infinite] rounded-control bg-surface-2 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

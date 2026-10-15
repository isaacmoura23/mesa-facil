import Link from "next/link";
import { UtensilsCrossed } from "lucide-react";
import { brand } from "@/config/brand";
import { cn } from "@/lib/utils/cn";

type BrandMarkProps = {
  href?: string;
  className?: string;
  /** Oculta o nome (apenas o símbolo). */
  compact?: boolean;
};

export function BrandMark({ href = "/", className, compact = false }: BrandMarkProps) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2.5 rounded-control", className)}
      aria-label={compact ? brand.name : undefined}
    >
      <span
        aria-hidden="true"
        className="flex size-8 items-center justify-center rounded-control bg-accent text-accent-fg"
      >
        <UtensilsCrossed className="size-[1.125rem]" />
      </span>
      {compact ? null : (
        <span className="text-base font-semibold tracking-tight text-fg">
          {brand.name}
        </span>
      )}
    </Link>
  );
}

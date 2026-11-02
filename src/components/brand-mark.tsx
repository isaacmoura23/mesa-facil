import Image from "next/image";
import Link from "next/link";
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
      {/* Logo em fundo branco: aparece igual no tema claro e no escuro. */}
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white ring-1 ring-line"
      >
        <Image src="/logo-small.png" alt="" width={44} height={44} className="size-full object-contain p-0.5" />
      </span>
      {compact ? null : (
        <span className="text-base font-semibold tracking-tight text-fg">
          {brand.name}
        </span>
      )}
    </Link>
  );
}

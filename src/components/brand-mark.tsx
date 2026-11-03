import Image from "next/image";
import Link from "next/link";
import { brand } from "@/config/brand";
import { cn } from "@/lib/utils/cn";

type BrandMarkProps = {
  href?: string;
  className?: string;
  /** Oculta o nome (apenas o símbolo). */
  compact?: boolean;
  /**
   * Marca de um restaurante (painéis /app e /operacao): mostra o nome e a logo cadastrados no lugar
   * da marca do Mesa Fácil. Sem logo, aparece a inicial do nome.
   */
  restaurant?: { name: string; logoUrl: string | null };
};

export function BrandMark({ href = "/", className, compact = false, restaurant }: BrandMarkProps) {
  const name = restaurant?.name ?? brand.name;
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2.5 rounded-control", className)}
      aria-label={compact ? name : undefined}
    >
      {/* Logo em fundo branco: aparece igual no tema claro e no escuro. */}
      <span
        aria-hidden="true"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl ring-1 ring-line",
          restaurant && !restaurant.logoUrl ? "bg-accent-soft text-lg font-semibold text-accent-soft-fg" : "bg-white",
        )}
      >
        {!restaurant ? (
          <Image src="/logo-small.png" alt="" width={44} height={44} className="size-full object-contain p-0.5" />
        ) : restaurant.logoUrl ? (
          <Image src={restaurant.logoUrl} alt="" width={44} height={44} className="size-full object-contain" />
        ) : (
          restaurant.name.trim().charAt(0).toUpperCase() || "?"
        )}
      </span>
      {compact ? null : (
        <span className={cn("text-base font-semibold tracking-tight text-fg", restaurant && "max-w-[9.5rem] truncate")}>
          {name}
        </span>
      )}
    </Link>
  );
}

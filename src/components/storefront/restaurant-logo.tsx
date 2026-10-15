import { cn } from "@/lib/utils/cn";
import { ProductImage, hasProductImage } from "./product-image";

type RestaurantLogoProps = {
  name: string;
  logoPath: string | null;
  className?: string;
};

/** Logo do restaurante; sem logo, mostra a inicial do nome sobre o acento. */
export function RestaurantLogo({ name, logoPath, className }: RestaurantLogoProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-control bg-accent text-sm font-semibold text-accent-fg",
        className,
      )}
    >
      {hasProductImage(logoPath) ? (
        <ProductImage path={logoPath} alt="" sizes="64px" className="object-contain bg-surface" />
      ) : (
        name.trim().charAt(0).toUpperCase() || "R"
      )}
    </span>
  );
}

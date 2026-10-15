import Image from "next/image";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ProductThumbProps = {
  url: string | null;
  /** Texto alternativo; use o nome do produto. */
  name: string;
  size?: "md" | "lg";
};

/**
 * Miniatura do produto. As imagens do Storage já são pequenas e o otimizador
 * do Next recusa hosts locais, então usamos `unoptimized`.
 */
export function ProductThumb({ url, name, size = "md" }: ProductThumbProps) {
  const dimension = size === "lg" ? 96 : 56;
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-control border border-line bg-surface-2",
        size === "lg" ? "size-24" : "size-14",
      )}
    >
      {url ? (
        <Image
          src={url}
          alt={name}
          width={dimension}
          height={dimension}
          unoptimized
          className="size-full object-cover"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted" role="img" aria-label="Sem imagem">
          <ImageOff aria-hidden="true" className={size === "lg" ? "size-7" : "size-5"} />
        </div>
      )}
    </div>
  );
}

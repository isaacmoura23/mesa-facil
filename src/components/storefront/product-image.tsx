import Image from "next/image";
import { publicImageUrl } from "@/lib/storage";
import { cn } from "@/lib/utils/cn";

/** O otimizador do Next recusa IPs locais; em dev o Storage local é servido direto. */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

type ProductImageProps = {
  path: string | null;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
};

/**
 * Imagem do bucket público. Preenche o contêiner pai (que precisa ser
 * `relative` e ter dimensões). Sem imagem cadastrada não renderiza nada:
 * nunca inventamos foto.
 */
export function ProductImage({ path, alt, sizes, priority, className }: ProductImageProps) {
  const src = publicImageUrl(path);
  if (!src) return null;
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={isLocalUrl(src)}
      className={cn("object-cover", className)}
    />
  );
}

export function hasProductImage(path: string | null): boolean {
  return publicImageUrl(path) !== null;
}

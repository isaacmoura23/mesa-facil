import { getPublicEnvStatus } from "@/lib/env";

export const PUBLIC_BUCKET = "restaurant-public";

/**
 * URL pública de um arquivo do bucket `restaurant-public`.
 * `path` segue o padrão `restaurants/{restaurant_id}/products/...` ou `.../logo/...`.
 * Retorna null se o Supabase não estiver configurado ou o caminho for inválido.
 */
export function publicImageUrl(path: string | null | undefined): string | null {
  if (!path || path.includes("..") || path.startsWith("/")) return null;
  const status = getPublicEnvStatus();
  if (!status.ok) return null;
  const base = status.env.supabaseUrl.replace(/\/$/, "");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${encoded}`;
}

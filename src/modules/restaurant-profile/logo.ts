import { IMAGE_EXTENSIONS } from "@/modules/menu/image";

/**
 * Caminho do logotipo no bucket `restaurant-public`:
 * `restaurants/{restaurant_id}/logo/{uuid}.{ext}` (a policy do Storage e o CHECK
 * `restaurants_logo_path_scope` exigem esta pasta). Regras de tipo e tamanho são
 * as mesmas das imagens de produto (`@/modules/menu/image`).
 */
export function buildLogoPath(restaurantId: string, mimeType: string): string {
  const extension = IMAGE_EXTENSIONS[mimeType] ?? "jpg";
  return `restaurants/${restaurantId}/logo/${crypto.randomUUID()}.${extension}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_EXACT = new RegExp(`^${UUID}$`);

/**
 * O caminho tem exatamente o formato permitido para o logotipo deste restaurante? Sem flag `i` (o CHECK do
 * banco recusa maiúsculas) e com o id validado como UUID antes de entrar no padrão (F-49).
 */
export function isOwnLogoPath(path: string, restaurantId: string): boolean {
  if (!UUID_EXACT.test(restaurantId)) return false;
  return new RegExp(`^restaurants/${restaurantId}/logo/${UUID}[.](jpg|png|webp|avif)$`).test(path);
}

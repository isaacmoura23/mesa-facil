/**
 * Regras de imagem de produto, compartilhadas entre o navegador (validação
 * imediata e upload) e o servidor (validação do caminho e dos metadados).
 * O bucket `restaurant-public` impõe os mesmos limites no próprio Storage.
 */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export const ALLOWED_IMAGE_TYPES = Object.keys(IMAGE_EXTENSIONS);
export const IMAGE_ACCEPT = ALLOWED_IMAGE_TYPES.join(",");

export const IMAGE_RULES_TEXT = "JPG, PNG, WebP ou AVIF, até 5 MB.";

/** Retorna a mensagem de erro (PT-BR) ou `null` se o arquivo é aceitável. */
export function validateImageFile(file: { type: string; size: number }): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return "Formato não aceito. Envie uma imagem JPG, PNG, WebP ou AVIF.";
  }
  if (file.size <= 0) return "O arquivo está vazio.";
  if (file.size > MAX_IMAGE_BYTES) {
    return "A imagem tem mais de 5 MB. Reduza o tamanho e tente novamente.";
  }
  return null;
}

/** `restaurants/{restaurant_id}/products/{uuid}.{ext}` */
export function buildProductImagePath(restaurantId: string, mimeType: string): string {
  const extension = IMAGE_EXTENSIONS[mimeType] ?? "jpg";
  return `restaurants/${restaurantId}/products/${crypto.randomUUID()}.${extension}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_EXACT = new RegExp(`^${UUID}$`);

/**
 * Confere se o caminho tem exatamente o formato permitido para o restaurante (igual ao CHECK do banco: tudo em
 * minúsculas, sem flag `i`). O id do restaurante só entra no padrão depois de validado como UUID (F-20), então
 * nenhum metacaractere de RegExp passa.
 */
export function isOwnProductImagePath(path: string, restaurantId: string): boolean {
  if (!UUID_EXACT.test(restaurantId)) return false;
  return new RegExp(`^restaurants/${restaurantId}/products/${UUID}[.](jpg|png|webp|avif)$`).test(path);
}

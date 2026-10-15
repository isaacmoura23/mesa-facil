/**
 * Tag de cache do cardápio público de um restaurante.
 *
 * Replica a string de `menuCacheTag(slug)` em `src/modules/storefront/data.ts`
 * (a vitrine faz `cacheTag(...)` do `public_menu` com ela). Fica duplicada de
 * propósito para este módulo não importar código `server-only` da vitrine;
 * se a origem mudar, atualize aqui também.
 */
export function storefrontMenuTag(slug: string): string {
  return `storefront:menu:${slug}`;
}

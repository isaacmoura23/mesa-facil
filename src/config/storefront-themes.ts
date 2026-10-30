/**
 * Tema visual da vitrine por restaurante (`/r/[slug]`). O restante do sistema
 * (painéis, operação, plataforma) não muda. Um restaurante sem entrada aqui
 * usa o tema padrão. Cada tema é uma classe definida em `globals.css`.
 */
const STOREFRONT_THEMES: Record<string, string> = {
  qibuxo: "theme-qibuxo",
};

export function storefrontThemeClass(slug: string): string {
  return STOREFRONT_THEMES[slug] ?? "";
}

/**
 * Máscaras e normalização dos dados de contato e da vitrine. Funções puras,
 * usadas no navegador (máscara e validação imediata) e no servidor (autoridade).
 * Os formatos replicam os CHECKs de `restaurant_settings` (migração 0113).
 */

export type Normalized<T> = { ok: true; value: T } | { ok: false; message: string };

const digitsOf = (text: string): string => text.replace(/\D/g, "");

/** (11) 91234-5678 / (11) 3456-7890, a partir de até 11 dígitos nacionais. */
export function maskBrazilianNumber(digits: string): string {
  const d = digits.slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Máscara de digitação. Começando com "+", o número é tratado como internacional (sem máscara). */
export function maskPhoneInput(value: string): string {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("+")) return `+${digitsOf(trimmed).slice(0, 15)}`;
  return maskBrazilianNumber(digitsOf(trimmed));
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/** Valor salvo ("+5511912345678") -> texto do campo ("(11) 91234-5678"). */
export function whatsappToInput(stored: string | null | undefined): string {
  if (!stored) return "";
  const digits = digitsOf(stored);
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    return maskBrazilianNumber(digits.slice(2));
  }
  return `+${digits}`;
}

/**
 * Texto do campo -> valor salvo: só dígitos, com "+" na frente e +55 quando o
 * código do país está ausente. Aceita número internacional começando com "+".
 * Vazio vira `null`.
 */
export function normalizeWhatsapp(raw: string): Normalized<string | null> {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };

  const international = text.startsWith("+");
  let digits = digitsOf(text);
  const invalid: Normalized<string | null> = {
    ok: false,
    message: "WhatsApp inválido. Use DDD + número, por exemplo (11) 91234-5678.",
  };

  if (!international) {
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    else if (!(digits.startsWith("55") && (digits.length === 12 || digits.length === 13))) return invalid;
  }

  if (digits.length < 10 || digits.length > 15) return invalid;
  if (digits.startsWith("55")) {
    // Brasil: 55 + DDD (2 dígitos, sem zero à esquerda) + 8 ou 9 dígitos.
    if (digits.length !== 12 && digits.length !== 13) return invalid;
    if (digits[2] === "0") return invalid;
  }
  return { ok: true, value: `+${digits}` };
}

// ---------------------------------------------------------------------------
// Telefone
// ---------------------------------------------------------------------------

/** Mesmo formato do CHECK `restaurant_settings_phone_fmt`. */
const PHONE_PATTERN = /^[0-9+()./ -]{6,30}$/;

export function normalizePhone(raw: string): Normalized<string | null> {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  const digitCount = digitsOf(text).length;
  if (!PHONE_PATTERN.test(text) || digitCount < 8 || digitCount > 15) {
    return { ok: false, message: "Telefone inválido. Use DDD + número, por exemplo (11) 3456-7890." };
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// Endereço
// ---------------------------------------------------------------------------

export const ADDRESS_MAX = 200;

/** Tamanho máximo do aviso fixo da vitrine (igual ao limite do banco). */
export const NOTICE_MAX = 240;

// ---------------------------------------------------------------------------
// URL da vitrine personalizada
// ---------------------------------------------------------------------------

/** Mesmo formato do CHECK `restaurant_settings_storefront_url_fmt`. */
const STOREFRONT_URL_PATTERN = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^\s<>"']*)?$/;

export const STOREFRONT_URL_MAX = 200;

export function normalizeStorefrontUrl(raw: string): Normalized<string | null> {
  let text = raw.trim();
  if (text === "") return { ok: true, value: null };

  if (/^http:\/\//i.test(text)) {
    return { ok: false, message: "Use um endereço seguro, começando com https://." };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  const invalid: Normalized<string | null> = {
    ok: false,
    message: "Endereço inválido. Exemplo: https://minha-vitrine.vercel.app",
  };
  if (text.length > STOREFRONT_URL_MAX) {
    return { ok: false, message: `Endereço muito longo (máximo de ${STOREFRONT_URL_MAX} caracteres).` };
  }
  if (!STOREFRONT_URL_PATTERN.test(text)) return invalid;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
      return invalid;
    }
  } catch {
    return invalid;
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// Domínios autorizados (origens do CORS)
// ---------------------------------------------------------------------------

export const MAX_STOREFRONT_ORIGINS = 5;

const HOST_PATTERN = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Normaliza uma origem digitada: minúsculas, sem barra final nem caminho/consulta,
 * sem porta padrão. Rejeita curingas, http, usuário/senha, IP e hosts sem ponto
 * (localhost já é liberado automaticamente em desenvolvimento).
 */
export function normalizeOrigin(raw: string): Normalized<string> {
  const text = raw.trim().toLowerCase();
  if (text === "") return { ok: false, message: "Informe o endereço do site." };
  if (text.includes("*")) {
    return { ok: false, message: "Curingas (*) não são aceitos. Informe o endereço exato do site." };
  }
  if (text.startsWith("http://")) {
    return { ok: false, message: "Use https://. Endereços http não são aceitos." };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text) && !text.startsWith("https://")) {
    return { ok: false, message: "Use um endereço que comece com https://." };
  }
  const candidate = text.startsWith("https://") ? text : `https://${text}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, message: "Endereço inválido. Exemplo: https://minha-vitrine.vercel.app" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Não inclua usuário ou senha no endereço." };
  }
  const host = url.hostname;
  const isIp = /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[");
  if (!HOST_PATTERN.test(host) || !host.includes(".") || isIp) {
    return {
      ok: false,
      message:
        "Informe um domínio de verdade, como minha-vitrine.vercel.app. Não use IP nem localhost (localhost já é liberado em desenvolvimento).",
    };
  }
  return { ok: true, value: url.origin };
}

export type OriginListResult =
  | { ok: true; value: string[] }
  | { ok: false; message: string; index?: number };

/** Normaliza e valida a lista inteira (máximo, duplicadas). */
export function normalizeOriginList(raws: readonly string[]): OriginListResult {
  if (raws.length > MAX_STOREFRONT_ORIGINS) {
    return { ok: false, message: `Use no máximo ${MAX_STOREFRONT_ORIGINS} domínios.` };
  }
  const result: string[] = [];
  for (const [index, raw] of raws.entries()) {
    const normalized = normalizeOrigin(raw);
    if (!normalized.ok) return { ok: false, message: normalized.message, index };
    if (result.includes(normalized.value)) {
      return { ok: false, message: `${normalized.value} está repetido.`, index };
    }
    result.push(normalized.value);
  }
  return { ok: true, value: result };
}

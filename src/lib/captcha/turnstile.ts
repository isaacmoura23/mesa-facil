import "server-only";
import { isIP } from "node:net";

/**
 * Cloudflare Turnstile (CAPTCHA gratuito). Desligado por padrão: só liga quando AS DUAS chaves existem
 * (NEXT_PUBLIC_TURNSTILE_SITE_KEY para o widget e TURNSTILE_SECRET_KEY para a verificação no servidor).
 * Sem chaves o checkout e o cadastro funcionam normalmente, sem widget e sem verificação.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5000;
export const MAX_CAPTCHA_TOKEN_LENGTH = 2048;

export function isCaptchaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY?.trim() && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
}

export type CaptchaFailure = "missing" | "invalid" | "unavailable";
export type CaptchaResult = { ok: true } | { ok: false; reason: CaptchaFailure };

export const CAPTCHA_MESSAGES: Record<CaptchaFailure, string> = {
  missing: "Confirme que você não é um robô e tente de novo.",
  invalid: "Não foi possível confirmar a verificação anti-robô. Atualize a verificação e tente de novo.",
  unavailable: "A verificação anti-robô está indisponível agora. Tente novamente em instantes.",
};

/**
 * Valida o token no Cloudflare. Falha FECHADA: sem token, token inválido ou serviço fora do ar = recusado.
 * Se o captcha estiver desligado devolve ok sem chamar a rede.
 */
export async function verifyCaptcha(token: unknown, ip?: string | null): Promise<CaptchaResult> {
  if (!isCaptchaEnabled()) return { ok: true };
  if (typeof token !== "string" || token.trim() === "") return { ok: false, reason: "missing" };
  if (token.length > MAX_CAPTCHA_TOKEN_LENGTH) return { ok: false, reason: "invalid" };

  const body = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY!.trim(), response: token });
  // `clientIp` agrupa IPv6 em /64 (não é um IP válido): só repassa IP exato.
  if (ip && isIP(ip) !== 0) body.set("remoteip", ip);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const data: unknown = await response.json();
    const success = typeof data === "object" && data !== null && (data as { success?: unknown }).success === true;
    return success ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Adaptador mínimo para o Upstash Redis (API REST) usando só `fetch`, sem dependência nova.
 * Liga sozinho quando UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN existem. Qualquer falha
 * (timeout, 5xx, resposta estranha) devolve `null` e quem chama cai no contador em memória:
 * o limitador nunca derruba o pedido por causa do Redis.
 *
 * Módulo PURO de servidor (não importa nada de Next) para poder ser testado.
 */

const TIMEOUT_MS = 1500;
const WARN_EVERY_MS = 60_000;

export type UpstashConfig = { url: string; token: string };

export function upstashConfig(env: Record<string, string | undefined> = process.env): UpstashConfig | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) return null;
  return { url, token };
}

let lastWarn = 0;
function warn(detail: string): void {
  const now = Date.now();
  if (now - lastWarn < WARN_EVERY_MS) return;
  lastWarn = now;
  console.warn(`[rate-limit] Upstash indisponível (${detail}); usando contador em memória.`);
}

let warnedMissing = false;
/** Em produção sem Upstash, avisa UMA vez que o limite vale só por instância. */
export function warnIfMemoryOnly(): void {
  if (warnedMissing || process.env.NODE_ENV !== "production" || upstashConfig()) return;
  warnedMissing = true;
  console.warn(
    "[rate-limit] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ausentes: o limite de requisições vale só por instância do servidor.",
  );
}

async function send(
  cfg: UpstashConfig,
  path: "multi-exec" | "pipeline",
  commands: (string | number)[][],
): Promise<unknown[] | null> {
  try {
    const response = await fetch(`${cfg.url}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      warn(`HTTP ${response.status}`);
      return null;
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      warn("resposta inesperada");
      return null;
    }
    return body.map((item) =>
      item && typeof item === "object" && "result" in item ? (item as { result: unknown }).result : null,
    );
  } catch (error) {
    warn(error instanceof Error ? error.name : "erro");
    return null;
  }
}

export type CounterResult = { count: number; ttlMs: number };

/**
 * Contador atômico de janela fixa: INCR + PEXPIRE NX + PTTL numa transação (MULTI/EXEC).
 * `null` = Upstash desligado ou com falha.
 */
export async function upstashIncr(key: string, windowMs: number): Promise<CounterResult | null> {
  const cfg = upstashConfig();
  if (!cfg) return null;
  const result = await send(cfg, "multi-exec", [
    ["INCR", key],
    ["PEXPIRE", key, windowMs, "NX"],
    ["PTTL", key],
  ]);
  if (!result) return null;
  const count = Number(result[0]);
  let ttl = Number(result[2]);
  if (!Number.isFinite(count)) return null;
  if (!Number.isFinite(ttl) || ttl < 0) {
    // Chave sem expiração (não deveria ocorrer): garante que ela expire.
    void send(cfg, "pipeline", [["PEXPIRE", key, windowMs]]);
    ttl = windowMs;
  }
  return { count, ttlMs: ttl };
}

/** Devolve uma tentativa (DECR). Melhor esforço. */
export async function upstashDecr(key: string): Promise<void> {
  const cfg = upstashConfig();
  if (!cfg) return;
  await send(cfg, "pipeline", [["DECR", key]]);
}

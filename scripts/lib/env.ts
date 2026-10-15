/**
 * Carrega as chaves do Supabase LOCAL para scripts e testes.
 * Ordem: variáveis de ambiente -> .env.local -> `npx supabase status -o env`.
 * NUNCA imprime chaves. Recusa qualquer URL que não seja localhost/127.0.0.1.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceKey: string;
}

export function projectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "supabase"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

export function assertLocalUrl(raw: string): void {
  if (!isLocalUrl(raw)) {
    throw new Error(
      `Recusado: a URL do Supabase (${raw}) não é localhost/127.0.0.1. ` +
        "Estes scripts/testes só rodam contra o Supabase LOCAL.",
    );
  }
}

function parseStatusEnv(): Record<string, string> {
  let out = "";
  try {
    out = execSync("npx supabase status -o env", {
      cwd: projectRoot(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      timeout: 60_000,
    });
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) result[m[1]] = m[2];
  }
  return result;
}

let cached: SupabaseEnv | undefined;

export function loadEnv(): SupabaseEnv {
  if (cached) return cached;

  const envLocal = path.join(projectRoot(), ".env.local");
  const fileEnv = existsSync(envLocal) ? dotenv.parse(readFileSync(envLocal)) : {};
  const pick = (k: string) => process.env[k] || fileEnv[k] || "";

  let url = pick("SUPABASE_URL") || pick("NEXT_PUBLIC_SUPABASE_URL");
  let anonKey = pick("SUPABASE_ANON_KEY") || pick("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  let serviceKey = pick("SUPABASE_SERVICE_ROLE_KEY");

  // Antes de gastar tempo com o CLI: se já temos uma URL, ela precisa ser local.
  if (url) assertLocalUrl(url);

  if (!url || !anonKey || !serviceKey) {
    const status = parseStatusEnv();
    url = url || status.API_URL || "";
    anonKey = anonKey || status.ANON_KEY || status.PUBLISHABLE_KEY || "";
    serviceKey = serviceKey || status.SERVICE_ROLE_KEY || status.SECRET_KEY || "";
  }

  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      "Não foi possível obter URL/anon/service keys do Supabase local. " +
        "Rode `npm run db:start` (ou defina SUPABASE_SERVICE_ROLE_KEY em .env.local).",
    );
  }
  assertLocalUrl(url);
  cached = { url: url.replace(/\/+$/, ""), anonKey, serviceKey };
  return cached;
}

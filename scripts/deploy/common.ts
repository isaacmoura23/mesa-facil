/**
 * Utilitários compartilhados pelos scripts de deploy (nuvem Supabase).
 * REGRA: nunca imprimir chaves, senhas nem a connection string. Tudo que sair em log passa por `redact`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { projectRoot } from "../lib/env";

export const CLOUD_SUFFIXES = [".supabase.co", ".supabase.com"] as const;

/** Host de um projeto Supabase NA NUVEM (ex.: abc.supabase.co, db.abc.supabase.co, aws-0-x.pooler.supabase.com). */
export function isSupabaseCloudHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return CLOUD_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

export type Flags = Record<string, string | true>;

/** Parser simples de `--flag` / `--flag=valor`. Recusa flags fora da lista (`known`). */
export function parseFlags(argv: string[], known: string[]): Flags {
  const out: Flags = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) throw new Error(`Argumento inesperado: ${raw}`);
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (!known.includes(key)) throw new Error(`Opção desconhecida: --${key} (válidas: ${known.map((k) => "--" + k).join(", ")})`);
    out[key] = eq === -1 ? true : raw.slice(eq + 1);
  }
  return out;
}

export const flagStr = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

const PLACEHOLDER = /(SEU-PROJETO|SUA-SENHA|YOUR-PASSWORD|YOUR_PASSWORD|\[PASSWORD\]|<password>|<senha>)/i;

export interface DeployEnv {
  file: string;
  values: Record<string, string>;
}

/**
 * Lê `.env.deploy` (ou o arquivo de --env-file) SEM tocar em process.env (evita misturar com variáveis do shell
 * e vazar para processos filhos). Falha de forma clara se não existir.
 */
export function loadDeployEnv(envFile?: string): DeployEnv {
  const file = envFile ? path.resolve(envFile) : path.join(projectRoot(), ".env.deploy");
  if (!existsSync(file)) {
    throw new Error(
      `Arquivo de ambiente não encontrado: ${file}\n` +
        "Copie scripts/deploy/env.deploy.template para .env.deploy (na raiz do projeto), preencha os valores do projeto Supabase " +
        "da NUVEM e rode novamente. O arquivo é ignorado pelo git; não o compartilhe.",
    );
  }
  const parsed = dotenv.parse(readFileSync(file));
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) values[k] = String(v).trim();
  return { file, values };
}

/** Exige chaves preenchidas e sem placeholders do modelo. Nunca ecoa valores. */
export function requireKeys(env: DeployEnv, keys: string[]): void {
  const missing = keys.filter((k) => !env.values[k]);
  if (missing.length) throw new Error(`Faltam variáveis em ${path.basename(env.file)}: ${missing.join(", ")}`);
  const ph = keys.filter((k) => PLACEHOLDER.test(env.values[k]));
  if (ph.length) throw new Error(`Variáveis ainda com o texto-modelo (preencha de verdade): ${ph.join(", ")}`);
}

/** Troca segredos por `***` em qualquer texto que vá para o console. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join("***");
    try {
      out = out.split(encodeURIComponent(s)).join("***");
    } catch {
      /* ignora */
    }
  }
  return out;
}

export interface DbTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * Parse tolerante da connection string (senha com @ ou / sem escape também funciona).
 * Não usa `new URL`: ele erra com senhas contendo caracteres especiais.
 */
export function parseDbUrl(raw: string): DbTarget {
  const m = /^postgres(?:ql)?:\/\/([^:/@]+):(.+)@([^@/:?#]+)(?::(\d+))?(?:\/([^?#]*))?(?:\?.*)?$/.exec(raw.trim());
  if (!m) throw new Error("SUPABASE_DB_URL inválida. Formato: postgresql://USUARIO:SENHA@HOST:PORTA/postgres");
  let password = m[2];
  try {
    password = decodeURIComponent(password);
  } catch {
    /* senha com % literal: usa como veio */
  }
  let user = m[1];
  try {
    user = decodeURIComponent(user);
  } catch {
    /* idem */
  }
  return { user, password, host: m[3].toLowerCase(), port: m[4] ? Number(m[4]) : 5432, database: m[5] || "postgres" };
}

/** `https://<ref>.supabase.co` -> ref. */
export function refFromApiUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const m = /^([a-z0-9]+)\.supabase\.(?:co|com)$/.exec(h);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** `db.<ref>.supabase.co` ou usuário `postgres.<ref>` (pooler) -> ref. */
export function refFromDbTarget(t: DbTarget): string | null {
  const d = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(t.host);
  if (d) return d[1];
  const u = /^[a-z_]+\.([a-z0-9]+)$/.exec(t.user);
  return u ? u[1] : null;
}

const hasAll = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && /[-_]/.test(s);

/** Senha forte aleatória (32 caracteres base64url, com minúscula, maiúscula, dígito e símbolo). */
export function randomPassword(): string {
  for (let i = 0; i < 50; i++) {
    const p = randomBytes(24).toString("base64url");
    if (hasAll(p)) return p;
  }
  return randomBytes(24).toString("base64url") + "aA1-";
}

/** Destino padrão das credenciais de demonstração (ignorado pelo git). */
export const DEFAULT_CREDENTIALS_FILE = () => path.join(projectRoot(), "scripts", "data", ".deploy-credentials.json");

export function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/**
 * Ambiente da importação. Por padrão SÓ aceita Supabase local (reusa scripts/lib/env.ts).
 * Com `--allow-remote` aceita outra URL, mas só depois de uma confirmação explícita:
 *   - interativa: digitar o host (sem TTY a execução é recusada); ou
 *   - não interativa: `--confirm-remote-host=<host exato>`, que precisa ser IDÊNTICO ao host da URL.
 * Com `--env-file=<caminho>` as chaves vêm SÓ desse arquivo (nada de .env.local, `supabase status` nem process.env).
 * NUNCA imprime chaves.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import dotenv from "dotenv";
import { assertLocalUrl, isLocalUrl, loadEnv, projectRoot, type SupabaseEnv } from "./env";

export interface ImportEnv extends SupabaseEnv {
  isLocal: boolean;
}

export interface ImportEnvOptions {
  allowRemote: boolean;
  /** Arquivo .env alternativo (ex.: .env.deploy). */
  envFile?: string | null;
  /** Host exato do SUPABASE_URL, como confirmação não interativa de --allow-remote. */
  confirmRemoteHost?: string | null;
}

export async function loadImportEnv(opts: ImportEnvOptions): Promise<ImportEnv> {
  if (opts.confirmRemoteHost && !opts.allowRemote) {
    throw new Error("Recusado: --confirm-remote-host só vale junto com --allow-remote.");
  }

  // Fonte das chaves: arquivo explícito (exclusivo) ou ambiente + .env.local.
  let pick: (k: string) => string;
  if (opts.envFile) {
    const file = path.resolve(opts.envFile);
    if (!existsSync(file)) throw new Error(`--env-file: arquivo não encontrado (${file}).`);
    const fileEnv = dotenv.parse(readFileSync(file));
    pick = (k) => (fileEnv[k] ?? "").trim();
  } else if (!opts.allowRemote) {
    // Comportamento original: recusa tudo que não seja localhost/127.0.0.1 (assertLocalUrl dentro de loadEnv).
    return { ...loadEnv(), isLocal: true };
  } else {
    const envLocal = path.join(projectRoot(), ".env.local");
    const fileEnv = existsSync(envLocal) ? dotenv.parse(readFileSync(envLocal)) : {};
    pick = (k) => process.env[k] || fileEnv[k] || "";
  }

  const url = (pick("SUPABASE_URL") || pick("NEXT_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
  const anonKey = pick("SUPABASE_ANON_KEY") || pick("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = pick("SUPABASE_SERVICE_ROLE_KEY");

  if (url && isLocalUrl(url)) {
    if (opts.envFile) {
      if (!anonKey || !serviceKey) throw new Error("--env-file (alvo local) exige NEXT_PUBLIC_SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY no arquivo.");
      return { url, anonKey, serviceKey, isLocal: true };
    }
    return { ...loadEnv(), isLocal: true }; // URL local: segue o caminho normal (aceita `supabase status`).
  }
  if (!opts.allowRemote) {
    if (url) assertLocalUrl(url); // lança a recusa padrão
    throw new Error("--env-file sem URL do Supabase (NEXT_PUBLIC_SUPABASE_URL).");
  }
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      "--allow-remote exige SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL), SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY " +
        `no ${opts.envFile ? "arquivo de --env-file" : "ambiente ou em .env.local"}.`,
    );
  }
  if (!/^https:\/\//.test(url)) throw new Error("--allow-remote só aceita URL https.");

  const host = new URL(url).host;
  if (opts.confirmRemoteHost) {
    // Confirmação não interativa: precisa ser EXATAMENTE o host do alvo.
    if (opts.confirmRemoteHost !== host) {
      throw new Error("Recusado: --confirm-remote-host não confere com o host do SUPABASE_URL. Nada foi alterado.");
    }
    console.warn(`[import] alvo REMOTO confirmado por --confirm-remote-host: ${host}`);
    return { url, anonKey, serviceKey, isLocal: false };
  }
  if (!process.stdin.isTTY) {
    throw new Error("Recusado: --allow-remote exige confirmação interativa (TTY) ou --confirm-remote-host=<host>. Rode num terminal.");
  }
  console.warn(`\nATENÇÃO: o alvo NÃO é o Supabase local: ${host}`);
  console.warn("A importação grava restaurantes, cardápio, contas de dono e arquivos neste projeto.");
  const answer = await ask(`Para continuar, digite exatamente o host (${host}): `);
  if (answer.trim() !== host) throw new Error("Confirmação incorreta. Nada foi alterado.");
  return { url, anonKey, serviceKey, isLocal: false };
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

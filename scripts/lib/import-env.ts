/**
 * Ambiente da importação. Por padrão SÓ aceita Supabase local (reusa scripts/lib/env.ts).
 * Com `--allow-remote` aceita outra URL, mas só depois de uma confirmação interativa explícita
 * (digitar o host) — sem TTY a execução é recusada. NUNCA imprime chaves.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import dotenv from "dotenv";
import { isLocalUrl, loadEnv, projectRoot, type SupabaseEnv } from "./env";

export interface ImportEnv extends SupabaseEnv {
  isLocal: boolean;
}

export async function loadImportEnv(opts: { allowRemote: boolean }): Promise<ImportEnv> {
  if (!opts.allowRemote) {
    // Recusa tudo que não seja localhost/127.0.0.1 (assertLocalUrl dentro de loadEnv).
    return { ...loadEnv(), isLocal: true };
  }

  const envLocal = path.join(projectRoot(), ".env.local");
  const fileEnv = existsSync(envLocal) ? dotenv.parse(readFileSync(envLocal)) : {};
  const pick = (k: string) => process.env[k] || fileEnv[k] || "";
  const url = (pick("SUPABASE_URL") || pick("NEXT_PUBLIC_SUPABASE_URL")).replace(/\/+$/, "");
  const anonKey = pick("SUPABASE_ANON_KEY") || pick("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = pick("SUPABASE_SERVICE_ROLE_KEY");

  if (url && isLocalUrl(url)) return { ...loadEnv(), isLocal: true }; // URL local: segue o caminho normal (aceita `supabase status`).
  if (!url || !anonKey || !serviceKey) {
    throw new Error(
      "--allow-remote exige SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL), SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY " +
        "no ambiente ou em .env.local.",
    );
  }
  if (!/^https:\/\//.test(url)) throw new Error("--allow-remote só aceita URL https.");

  const host = new URL(url).host;
  if (!process.stdin.isTTY) {
    throw new Error("Recusado: --allow-remote exige confirmação interativa (TTY). Rode num terminal.");
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

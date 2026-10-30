/**
 * Grava chaves de serviços externos em `.env.deploy` com a entrada ESCONDIDA (nada aparece na tela nem no chat).
 * Uso, no painel de Terminal (interativo):  npx.cmd tsx scripts/deploy/set-secret.ts
 *
 * Chaves aceitas: Upstash (rate limit), Cloudflare Turnstile (CAPTCHA). Pressione Enter sem digitar para pular uma.
 * Depois use `scripts/deploy/push-env.ts` (ou `vercel env add`) para enviar à Vercel.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_PATH = path.resolve(process.cwd(), ".env.deploy");

const FIELDS: { key: string; label: string; validate: (v: string) => string | null }[] = [
  {
    key: "UPSTASH_REDIS_REST_URL",
    label: "Upstash: REST URL (https://...upstash.io)",
    validate: (v) => (/^https:\/\/[a-z0-9.-]+\.upstash\.io\/?$/i.test(v) ? null : "deve ser https://<nome>.upstash.io"),
  },
  {
    key: "UPSTASH_REDIS_REST_TOKEN",
    label: "Upstash: REST Token",
    validate: (v) => (v.length >= 20 && !/\s/.test(v) ? null : "token curto demais ou com espaços"),
  },
  {
    key: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    label: "Turnstile: Site Key (pública)",
    validate: (v) => (/^[0-9A-Za-z_-]{10,}$/.test(v) ? null : "formato inesperado"),
  },
  {
    key: "TURNSTILE_SECRET_KEY",
    label: "Turnstile: Secret Key",
    validate: (v) => (/^[0-9A-Za-z_-]{10,}$/.test(v) ? null : "formato inesperado"),
  },
];

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stdout.write(prompt);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function upsert(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(content) ? content.replace(re, () => line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
}

async function main(): Promise<void> {
  if (!fs.existsSync(ENV_PATH)) {
    console.error("Arquivo .env.deploy não encontrado na pasta atual. Rode na raiz do projeto.");
    process.exit(1);
  }
  let content = fs.readFileSync(ENV_PATH, "utf8");
  const saved: string[] = [];
  for (const f of FIELDS) {
    const v = await askHidden(`${f.label} (Enter para pular): `);
    if (!v) continue;
    const err = f.validate(v);
    if (err) {
      console.error(`  ${f.key}: ${err}. Não gravei este.`);
      continue;
    }
    content = upsert(content, f.key, v);
    saved.push(f.key);
  }
  if (!saved.length) {
    console.log("Nada gravado.");
    return;
  }
  fs.writeFileSync(ENV_PATH, content, "utf8");
  await new Promise((r) => setTimeout(r, 1500));
  const back = fs.readFileSync(ENV_PATH, "utf8");
  const lost = saved.filter((k) => !new RegExp(`^${k}=.+$`, "m").test(back));
  if (lost.length) {
    console.error(`ATENÇÃO: não ficaram gravados: ${lost.join(", ")}. Feche o .env.deploy no editor e rode de novo.`);
    process.exit(1);
  }
  console.log(`Gravado e conferido em ${ENV_PATH}: ${saved.join(", ")}`);
  console.log("NÃO abra nem salve o .env.deploy no editor agora.");
}

main().catch((e) => {
  console.error("Erro:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

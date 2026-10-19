/**
 * Pede a conexão do banco (Supabase Session pooler) com a entrada ESCONDIDA e grava em `.env.deploy`.
 * Uso, no painel de Terminal (precisa ser interativo):  npx.cmd tsx scripts/deploy/set-db-url.ts
 * Nunca imprime a senha. Confere formato, host da Supabase e se o projeto bate com NEXT_PUBLIC_SUPABASE_URL.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ENV_PATH = path.resolve(process.cwd(), ".env.deploy");

function readEnvLine(content: string, key: string): string | null {
  const m = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Silencia o eco dos caracteres digitados/colados.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stdout.write(prompt);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(ENV_PATH)) {
    console.error("Arquivo .env.deploy não encontrado na pasta atual. Rode na raiz do projeto.");
    process.exit(1);
  }
  const content = fs.readFileSync(ENV_PATH, "utf8");
  const apiUrl = readEnvLine(content, "NEXT_PUBLIC_SUPABASE_URL") ?? "";
  const ref = apiUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/)?.[1];
  if (!ref) {
    console.error("NEXT_PUBLIC_SUPABASE_URL no .env.deploy não parece a URL do projeto (https://<id>.supabase.co).");
    process.exit(1);
  }

  console.log(`Projeto: ${ref}`);
  console.log("Cole a conexão do Session pooler (formato URI) JÁ com a senha no lugar de [YOUR-PASSWORD].");
  console.log("A digitação fica invisível; confirme com Enter.");
  const raw = await askHidden("Conexão do banco: ");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error("Valor inválido: não é uma URL. Copie o texto inteiro do painel (começa com postgresql://).");
    process.exit(1);
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const problems: string[] = [];
  if (!/^postgres(ql)?:$/.test(url.protocol)) problems.push("o texto deve começar com postgresql://");
  if (!/\.supabase\.(com|co)$/.test(url.hostname)) problems.push(`host inesperado (${url.hostname}); use o da Supabase`);
  if (!password) problems.push("falta a senha (ficou vazio entre ':' e '@')");
  if (/\[|\]|YOUR-PASSWORD|SUA-SENHA/i.test(raw)) problems.push("a senha ainda é o marcador [YOUR-PASSWORD]; troque pela senha real, sem colchetes");
  if (!user.endsWith(`.${ref}`) && user !== "postgres") problems.push(`o usuário deve ser postgres.${ref} (copie do botão Connect do projeto)`);
  if (url.port === "6543") problems.push("porta 6543 (transaction mode): use a 5432 do Session pooler");
  if (problems.length) {
    console.error("Não gravei nada. Problemas:\n - " + problems.join("\n - "));
    process.exit(1);
  }

  const line = `SUPABASE_DB_URL=${raw}`;
  const next = /^SUPABASE_DB_URL=.*$/m.test(content)
    ? content.replace(/^SUPABASE_DB_URL=.*$/m, () => line)
    : `${content.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, next, "utf8");
  // Reler do disco para provar que a gravação ficou (um editor com versão antiga aberta pode sobrescrevê-la).
  await new Promise((r) => setTimeout(r, 1500));
  const back = readEnvLine(fs.readFileSync(ENV_PATH, "utf8"), "SUPABASE_DB_URL");
  if (back !== raw) {
    console.error(`ATENÇÃO: o arquivo ${ENV_PATH} não ficou com o valor gravado. Feche o .env.deploy no editor (sem salvar) e rode de novo.`);
    process.exit(1);
  }
  console.log(`Gravado e conferido em ${ENV_PATH}`);
  console.log(`host ${url.hostname}, usuário ${user}, porta ${url.port || "5432"}, senha com ${password.length} caracteres.`);
  console.log("NÃO abra nem salve o .env.deploy no editor agora: um editor com versão antiga pode desfazer a gravação.");
}

main().catch((e) => {
  console.error("Erro:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Importa, para o Supabase LOCAL, os restaurantes-piloto do dono da plataforma:
 *   - La Pastelaria                      (https://la-pastelaria.vercel.app)  slug `la-pastelaria`
 *   - Pastelaria e Pizzaria O Nailton    (https://onailton.vercel.app)       slug `o-nailton`
 *   - Qi Buxo (confeitaria)              (https://qibuxo-catalogo.vercel.app) slug `qibuxo`
 *
 *   npx tsx scripts/import-restaurants.ts [opções]
 *
 * Opções
 *   --dry-run            valida e resume os dados; não conecta no banco
 *   --reset              apaga e recria SÓ estes dois restaurantes (e seus arquivos no Storage); as contas locais ficam
 *   --only=<slug>        importa apenas um (la-pastelaria | o-nailton | qibuxo)
 *   --create-only        só cria o que falta; nunca atualiza o que já existe
 *   --prune              desativa (is_active=false) itens do restaurante que não estão nos dados
 *   --src-root=<dir>     raiz das pastas irmãs com imagens (padrão: pasta acima do projeto)
 *   --api-base=<url>     base da API pública para a verificação (padrão: http://localhost:3100)
 *   --no-api             não consulta a API pública na verificação (só a RPC public_menu)
 *   --allow-remote       permite alvo que não seja localhost, MAS exige confirmação (interativa: digitar o host;
 *                        ou não interativa: --confirm-remote-host)
 *   --confirm-remote-host=<host>  confirmação NÃO interativa de --allow-remote; precisa ser EXATAMENTE o host do
 *                        SUPABASE_URL (qualquer divergência recusa). Sem --allow-remote é recusado.
 *   --env-file=<caminho> usa SÓ esse arquivo (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY e SUPABASE_SERVICE_ROLE_KEY) em vez de
 *                        .env.local / `supabase status` (ex.: .env.deploy)
 *   --credentials-file=<caminho>  onde gravar as senhas dos donos (padrão: scripts/data/.local-owner-credentials.json)
 *
 * Segurança: recusa URL do Supabase que não seja localhost/127.0.0.1 (salvo --allow-remote + confirmação); usa a
 * service role só de .env.local / `supabase status` (ou do --env-file); nunca imprime chaves nem senhas.
 *
 * Fonte dos dados: scripts/data/*.json (transcritos dos sites públicos e dos cardápios-fonte nas pastas irmãs).
 * Nada é inventado: o que o site não informa fica de fora (ver docs no relatório do agente IMPORT).
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { removeRestaurantFolder } from "./lib/import-assets";
import { loadImportEnv } from "./lib/import-env";
import { importRestaurant, must, type Admin, type RestaurantReport, type SyncMode } from "./lib/import-sync";
import { countData, validateImportData, type ImportData } from "./lib/import-types";
import { verifyRestaurant } from "./lib/import-verify";
import { projectRoot } from "./lib/env";

const DATA_FILES = ["la-pastelaria.json", "o-nailton.json", "qibuxo.json"];

interface Args {
  dryRun: boolean;
  reset: boolean;
  only: string | null;
  createOnly: boolean;
  prune: boolean;
  srcRoot: string;
  apiBase: string | null;
  noApi: boolean;
  allowRemote: boolean;
  envFile: string | null;
  confirmRemoteHost: string | null;
  credentialsFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    reset: false,
    only: null,
    createOnly: false,
    prune: false,
    srcRoot: path.resolve(projectRoot(), ".."),
    apiBase: null,
    noApi: false,
    allowRemote: false,
    envFile: null,
    confirmRemoteHost: null,
    credentialsFile: null,
  };
  const known = new Set(["--dry-run", "--reset", "--create-only", "--prune", "--no-api", "--allow-remote"]);
  for (const raw of argv) {
    const [flag, ...rest] = raw.split("=");
    const val = rest.join("=");
    if (known.has(raw)) {
      if (raw === "--dry-run") a.dryRun = true;
      else if (raw === "--reset") a.reset = true;
      else if (raw === "--create-only") a.createOnly = true;
      else if (raw === "--prune") a.prune = true;
      else if (raw === "--no-api") a.noApi = true;
      else if (raw === "--allow-remote") a.allowRemote = true;
    } else if (flag === "--only" && val) a.only = val;
    else if (flag === "--src-root" && val) a.srcRoot = path.resolve(val);
    else if (flag === "--api-base" && val) a.apiBase = val;
    else if (flag === "--env-file" && val) a.envFile = path.resolve(val);
    else if (flag === "--confirm-remote-host" && val) a.confirmRemoteHost = val;
    else if (flag === "--credentials-file" && val) a.credentialsFile = path.resolve(val);
    else throw new Error(`Opção desconhecida: ${raw}`);
  }
  if (a.createOnly && a.prune) throw new Error("--create-only e --prune são incompatíveis.");
  return a;
}

function loadData(only: string | null): ImportData[] {
  const dir = path.join(projectRoot(), "scripts", "data");
  const all = DATA_FILES.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as ImportData);
  const chosen = only ? all.filter((d) => d.restaurant.slug === only) : all;
  if (!chosen.length) throw new Error(`--only=${only}: slug desconhecido (${all.map((d) => d.restaurant.slug).join(", ")})`);
  const errs = chosen.flatMap(validateImportData);
  if (errs.length) throw new Error("Dados inválidos:\n  - " + errs.join("\n  - "));
  return chosen;
}

// ---------------------------------------------------------------------------
// Contas locais dos donos
// ---------------------------------------------------------------------------
let credsOverride: string | null = null;
const CREDS_PATH = () => credsOverride ?? path.join(projectRoot(), "scripts", "data", ".local-owner-credentials.json");

interface Creds {
  _note: string;
  owners: Record<string, { email: string; password: string }>;
}

function readCreds(): Creds {
  const p = CREDS_PATH();
  if (existsSync(p)) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && typeof j.owners === "object") return j as Creds;
    } catch {
      /* arquivo corrompido: recria abaixo */
    }
  }
  return { _note: "Credenciais LOCAIS de desenvolvimento geradas por scripts/import-restaurants.ts. NÃO versionar nem compartilhar.", owners: {} };
}

function writeCreds(c: Creds) {
  writeFileSync(CREDS_PATH(), JSON.stringify(c, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** 24 caracteres base64url; regenera até ter minúscula, maiúscula, dígito e símbolo (políticas de senha da nuvem). */
function generatePassword(): string {
  for (let i = 0; i < 50; i++) {
    const p = randomBytes(18).toString("base64url");
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[-_]/.test(p)) return p;
  }
  return randomBytes(18).toString("base64url") + "aA1-";
}

async function listAllUsers(admin: Admin): Promise<{ id: string; email?: string }[]> {
  const all: { id: string; email?: string }[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`[import] listUsers: ${error.message}`);
    all.push(...data.users.map((u) => ({ id: u.id, email: u.email })));
    if (data.users.length < 200) break;
  }
  return all;
}

/** Cria (idempotente) o dono local do restaurante. A senha nasce na 1ª execução e fica só no arquivo de credenciais. */
async function ensureOwner(admin: Admin, data: ImportData, users: { id: string; email?: string }[], creds: Creds): Promise<{ id: string; email: string; createdUser: boolean }> {
  const slug = data.restaurant.slug;
  const email = `dono@${slug}.example.test`;
  const known = creds.owners[slug];
  const password = known?.password ?? generatePassword();
  if (!known || known.email !== email) {
    creds.owners[slug] = { email, password };
    writeCreds(creds); // grava ANTES de criar: nunca perdemos uma senha já aplicada
  }
  const existing = users.find((u) => u.email?.toLowerCase() === email);
  if (existing) {
    // O arquivo é a fonte da verdade: garante que a senha dele confere (também cobre conta criada fora do script).
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
    if (error) throw new Error(`[import] updateUser ${email}: ${error.message}`);
    return { id: existing.id, email, createdUser: false };
  }
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Dono ${data.restaurant.name}` },
  });
  if (error || !created.user) throw new Error(`[import] createUser ${email}: ${error?.message}`);
  users.push({ id: created.user.id, email });
  return { id: created.user.id, email, createdUser: true };
}

// ---------------------------------------------------------------------------
// Reset (só estes restaurantes)
// ---------------------------------------------------------------------------
async function resetRestaurant(admin: Admin, slug: string): Promise<string> {
  const row = must(await admin.from("restaurants").select("id").eq("slug", slug).maybeSingle(), "select restaurant (reset)");
  if (!row) return `${slug}: nada a apagar`;
  const files = await removeRestaurantFolder(admin, row.id);
  must(await admin.from("restaurants").delete().eq("id", row.id), "delete restaurant (reset)");
  return `${slug}: restaurante apagado (${files} arquivo(s) do Storage removido(s))`;
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------
const fmtStats = (s: { created: number; updated: number; unchanged: number; deactivated: number }) =>
  `+${s.created} novos, ~${s.updated} atualizados, =${s.unchanged} iguais${s.deactivated ? `, -${s.deactivated} desativados/removidos` : ""}`;

function printCounts(label: string, d: ImportData) {
  const c = countData(d);
  console.log(`  ${label}: ${c.categories} categorias, ${c.products} produtos (${c.productsWithVariants} com tamanhos = ${c.variants} variantes), ${c.modifierGroups} grupos de adicionais (${c.modifiers} opções, ${c.productGroupLinks} vínculos), ${c.badges} selos, ${c.productImages} imagens de produto`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const datasets = loadData(args.only);
  credsOverride = args.credentialsFile;

  console.log("[import] dados validados:");
  for (const d of datasets) printCounts(d.restaurant.slug, d);
  if (args.dryRun) {
    console.log("[import] --dry-run: nada foi gravado.");
    return 0;
  }

  const env = await loadImportEnv({ allowRemote: args.allowRemote, envFile: args.envFile, confirmRemoteHost: args.confirmRemoteHost });
  const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  console.log(`[import] alvo: ${env.url} (${env.isLocal ? "local" : "REMOTO confirmado"})`);

  if (args.reset) {
    console.log("[import] --reset:");
    for (const d of datasets) console.log("  " + (await resetRestaurant(admin, d.restaurant.slug)));
  }

  const mode: SyncMode = { createOnly: args.createOnly, prune: args.prune, srcRoot: args.srcRoot };
  const creds = readCreds();
  const users = await listAllUsers(admin);
  const reports: RestaurantReport[] = [];
  const ownerEmails: Record<string, string> = {};

  for (const d of datasets) {
    const owner = await ensureOwner(admin, d, users, creds);
    ownerEmails[d.restaurant.slug] = owner.email;
    console.log(`[import] ${d.restaurant.slug}: dono ${owner.email} (${owner.createdUser ? "conta criada" : "conta já existia"})`);
    reports.push(await importRestaurant(admin, d, owner.id, mode));
  }

  console.log("\n[import] resumo");
  for (const r of reports) {
    console.log(`\n  ${r.slug} (${r.id}) ${r.restaurantCreated ? "[criado]" : "[já existia]"}`);
    for (const [k, v] of Object.entries(r.stats)) console.log(`    ${k.padEnd(18)} ${fmtStats(v)}`);
    console.log(`    imagens            ${r.images.uploaded} enviada(s) ao Storage, ${r.images.skipped.length} pulada(s)`);
    for (const s of r.images.skipped) console.log(`      - pulada: ${s.file} (${s.reason})`);
    for (const w of r.warnings) console.log(`    aviso: ${w}`);
  }

  // Verificação sem privilégios: RPC public_menu (anon) e, se disponível, a API pública v1.
  console.log("\n[import] verificação (sem service role)");
  const apiBase = args.noApi ? undefined : (args.apiBase ?? (env.isLocal ? "http://localhost:3100" : undefined));
  let failed = false;
  for (const d of datasets) {
    for (const v of await verifyRestaurant({ url: env.url, anonKey: env.anonKey, data: d, apiBase })) {
      const netDown = v.problems.length === 1 && v.problems[0].startsWith("falha de rede");
      const status = v.problems.length === 0 ? "OK" : netDown ? "NÃO VERIFICADO" : "DIVERGÊNCIAS";
      console.log(`  ${d.restaurant.slug} · ${v.source}: ${status} (${v.categories} categorias, ${v.products} produtos)`);
      for (const p of v.problems) console.log(`      - ${p}`);
      if (v.problems.length && !netDown) failed = true;
    }
  }

  console.log(`\n[import] contas ${env.isLocal ? "locais " : ""}dos donos: ${Object.values(ownerEmails).join(", ")}`);
  console.log(`[import] senhas em ${path.relative(projectRoot(), CREDS_PATH()).replace(/\\/g, "/")} (arquivo ignorado pelo git; senhas não são impressas)`);
  return failed ? 1 : 0;
}

const invoked = process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "";
if (invoked === "import-restaurants") {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

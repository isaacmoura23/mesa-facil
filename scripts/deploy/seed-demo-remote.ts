/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Prepara a DEMO na nuvem (service role). Rode DEPOIS de apply-migrations.ts.
 *
 *   npx tsx scripts/deploy/seed-demo-remote.ts [opções]
 *
 *   --rotate-passwords      gera senhas novas para TODAS as contas de demo (padrão: contas existentes mantêm a senha)
 *   --skip-import           não reexecuta o importador dos pilotos (só contas, vínculos, mesas)
 *   --src-root=<dir>        pasta das imagens-fonte do Nailton (repassada ao importador; padrão: pasta acima do projeto)
 *   --env-file=<arq>        outro arquivo no lugar de .env.deploy
 *   --credentials-file=<arq> outro destino no lugar de scripts/data/.deploy-credentials.json
 *
 * O que faz
 *   (a) importa La Pastelaria e O Nailton (cardápio, horários, imagens no Storage) com scripts/import-restaurants.ts;
 *   (b) cria contas de demonstração com senhas aleatórias fortes (32 caracteres, crypto) e e-mail confirmado:
 *       dono (via importador) + gerente, caixa, cozinha e garçom da La Pastelaria; dono do O Nailton (via importador);
 *   (c) garante 6 mesas por restaurante, assinatura de teste (trial) e os vínculos corretos;
 *   (d) grava e-mail/papel/restaurante/SENHA só em scripts/data/.deploy-credentials.json (ignorado pelo git);
 *       o console mostra apenas e-mails e o caminho do arquivo.
 *
 * NÃO cria pedidos, clientes nem pagamentos: a operação fica vazia para você criar pedidos ao vivo pela vitrine.
 * Idempotente. Recusa qualquer URL que não seja de projeto Supabase na nuvem (*.supabase.co / *.supabase.com).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main as runImporter } from "../import-restaurants";
import {
  DEFAULT_CREDENTIALS_FILE,
  flagStr,
  isSupabaseCloudHost,
  loadDeployEnv,
  parseFlags,
  randomPassword,
  redact,
  requireKeys,
} from "./common";

type Admin = SupabaseClient;
type Row = Record<string, any>;

const PILOTS = [
  { slug: "la-pastelaria", name: "La Pastelaria" },
  { slug: "o-nailton", name: "O Nailton" },
] as const;

/** Equipe da La Pastelaria (o dono vem do importador). */
const STAFF = [
  { local: "gerente", role: "manager", label: "Gerente" },
  { local: "caixa", role: "cashier", label: "Caixa" },
  { local: "cozinha", role: "kitchen", label: "Cozinha" },
  { local: "garcom", role: "waiter", label: "Garçom" },
] as const;

const TABLE_COUNT = 6;

interface AccountEntry {
  email: string;
  role: string;
  restaurant: string;
  password: string | null;
}
interface Creds {
  _note?: string;
  generated_at?: string;
  owners?: Record<string, { email: string; password: string }>;
  accounts?: AccountEntry[];
  [k: string]: unknown;
}

function must(res: { data: any; error: { message: string; code?: string } | null }, what: string): any {
  if (res.error) throw new Error(`[seed-demo] ${what}: ${res.error.message} (${res.error.code ?? "?"})`);
  return res.data;
}

function readCreds(file: string): Creds {
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j === "object") return j as Creds;
    } catch {
      throw new Error(`Arquivo de credenciais corrompido: ${file}. Mova-o para outro lugar (não apague as senhas se ainda precisar delas) e rode de novo.`);
    }
  }
  return {};
}

function writeCreds(file: string, c: Creds): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: sem efeito */
  }
}

async function listAllUsers(admin: Admin): Promise<{ id: string; email?: string }[]> {
  const all: { id: string; email?: string }[] = [];
  for (let page = 1; page < 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`[seed-demo] listUsers: ${error.message}`);
    all.push(...data.users.map((u) => ({ id: u.id, email: u.email })));
    if (data.users.length < 200) break;
  }
  return all;
}

function upsertAccount(c: Creds, e: AccountEntry): void {
  const list = (c.accounts ||= []);
  const i = list.findIndex((a) => a.email === e.email);
  if (i >= 0) list[i] = e;
  else list.push(e);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseFlags(argv, ["rotate-passwords", "skip-import", "src-root", "env-file", "credentials-file"]);
  const rotate = !!flags["rotate-passwords"];
  const envFileFlag = flagStr(flags, "env-file");
  const env = loadDeployEnv(envFileFlag);
  requireKeys(env, ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  const url = env.values.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const serviceKey = env.values.SUPABASE_SERVICE_ROLE_KEY;
  const secrets = [serviceKey, env.values.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.values.SUPABASE_DB_URL];

  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("não é https");
    host = u.host;
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL inválida (esperado https://<projeto>.supabase.co).");
  }
  if (!isSupabaseCloudHost(new URL(url).hostname)) {
    throw new Error(`Recusado: ${host} não é um projeto Supabase na nuvem (*.supabase.co / *.supabase.com). Este script nunca roda contra outro alvo.`);
  }

  const credsFile = flagStr(flags, "credentials-file") ? path.resolve(flagStr(flags, "credentials-file")!) : DEFAULT_CREDENTIALS_FILE();
  const creds = readCreds(credsFile);
  console.log(`[seed-demo] alvo: ${host}${rotate ? "  (--rotate-passwords)" : ""}`);

  // Rotação dos donos: o importador trata o arquivo como fonte da verdade, então novas senhas entram nele ANTES.
  if (rotate && creds.owners) {
    for (const k of Object.keys(creds.owners)) creds.owners[k] = { ...creds.owners[k], password: randomPassword() };
    writeCreds(credsFile, creds);
  }

  // ---- (a) importador dos pilotos ----
  if (!flags["skip-import"]) {
    console.log("[seed-demo] importando La Pastelaria e O Nailton (pode levar alguns minutos por causa das imagens)...");
    const args = [
      `--env-file=${env.file}`,
      "--allow-remote",
      `--confirm-remote-host=${host}`,
      `--credentials-file=${credsFile}`,
      "--no-api",
    ];
    const src = flagStr(flags, "src-root");
    if (src) args.push(`--src-root=${src}`);
    const code = await runImporter(args);
    if (code !== 0) throw new Error(`O importador terminou com código ${code}. Veja as divergências acima; nada além do importado foi criado.`);
  }

  // ---- cliente admin ----
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const fresh = readCreds(credsFile); // o importador gravou os donos neste arquivo
  Object.assign(creds, fresh);

  const rest: Record<string, string> = {};
  for (const p of PILOTS) {
    const r = must(await admin.from("restaurants").select("id").eq("slug", p.slug).maybeSingle(), `restaurante ${p.slug}`);
    if (!r) throw new Error(`Restaurante ${p.slug} não existe (rode sem --skip-import).`);
    rest[p.slug] = r.id;
  }

  const users = await listAllUsers(admin);
  const byEmail = new Map(users.map((u) => [u.email?.toLowerCase(), u.id]));

  // ---- donos (criados pelo importador) ----
  const ownerIds: Record<string, string> = {};
  for (const p of PILOTS) {
    const o = creds.owners?.[p.slug];
    if (!o) throw new Error(`Credencial do dono de ${p.slug} ausente (o importador deveria tê-la gravado).`);
    const id = byEmail.get(o.email.toLowerCase());
    if (!id) throw new Error(`Conta do dono de ${p.slug} não encontrada no Auth.`);
    ownerIds[p.slug] = id;
    if (rotate) {
      // O importador já aplica a senha do arquivo; repete aqui para o caso de --skip-import.
      const { error } = await admin.auth.admin.updateUserById(id, { password: o.password, email_confirm: true });
      if (error) throw new Error(`[seed-demo] updateUser ${o.email}: ${redact(error.message, secrets)}`);
      console.log(`[seed-demo] senha rotacionada: ${o.email}`);
    }
    upsertAccount(creds, { email: o.email, role: "owner", restaurant: p.slug, password: o.password });
  }

  // ---- (b) equipe da La Pastelaria ----
  const slug = "la-pastelaria";
  const rid = rest[slug];
  for (const s of STAFF) {
    const email = `${s.local}@${slug}.example.test`;
    const fullName = `${s.label} La Pastelaria`;
    let id = byEmail.get(email);
    const known = creds.accounts?.find((a) => a.email === email);
    let password = known?.password ?? null;

    if (!id) {
      password = randomPassword();
      upsertAccount(creds, { email, role: s.role, restaurant: slug, password });
      writeCreds(credsFile, creds); // grava ANTES de criar: nunca perdemos uma senha aplicada
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
      if (error || !data.user) {
        throw new Error(
          `[seed-demo] createUser ${email}: ${redact(error?.message ?? "sem usuário", secrets)}` +
            (/invalid|domain/i.test(error?.message ?? "") ? "\n  O Auth da nuvem rejeitou o domínio .test. Altere o domínio dos e-mails de demo neste script e no importador (ensureOwner)." : ""),
        );
      }
      id = data.user.id;
      byEmail.set(email, id);
      console.log(`[seed-demo] conta criada: ${email}`);
    } else if (rotate) {
      password = randomPassword();
      upsertAccount(creds, { email, role: s.role, restaurant: slug, password });
      writeCreds(credsFile, creds);
      const { error } = await admin.auth.admin.updateUserById(id, { password, email_confirm: true });
      if (error) throw new Error(`[seed-demo] updateUser ${email}: ${redact(error.message, secrets)}`);
      console.log(`[seed-demo] senha rotacionada: ${email}`);
    } else {
      if (!password) console.warn(`[seed-demo] aviso: ${email} já existe mas não há senha no arquivo de credenciais; rode com --rotate-passwords.`);
      console.log(`[seed-demo] conta já existia (senha mantida): ${email}`);
    }
    upsertAccount(creds, { email, role: s.role, restaurant: slug, password });

    must(await admin.from("profiles").update({ full_name: fullName }).eq("id", id), "profile name");

    // vínculo (mesmo mecanismo do seed-dev: service role grava restaurant_memberships direto)
    const m = must(await admin.from("restaurant_memberships").select("id,role,status").eq("restaurant_id", rid).eq("user_id", id).maybeSingle(), "select membership");
    if (!m) {
      must(await admin.from("restaurant_memberships").insert({ restaurant_id: rid, user_id: id, role: s.role, status: "active", invited_by: ownerIds[slug] }), "insert membership");
    } else if (m.role !== s.role || m.status !== "active") {
      must(await admin.from("restaurant_memberships").update({ role: s.role, status: "active" }).eq("id", m.id), "update membership");
    }
  }
  writeCreds(credsFile, creds);

  // ---- (c) mesas e assinatura de teste (ambos os restaurantes) ----
  const plan = must(await admin.from("plans").select("id").eq("code", "basico").maybeSingle(), "plano basico");
  for (const p of PILOTS) {
    const r = rest[p.slug];
    const have = new Set((must(await admin.from("restaurant_tables").select("name").eq("restaurant_id", r), "list tables") as Row[]).map((t) => t.name));
    const missing: Row[] = [];
    for (let i = 1; i <= TABLE_COUNT; i++) {
      const name = `Mesa ${i}`;
      if (!have.has(name)) missing.push({ restaurant_id: r, name, area: "Salão", capacity: 4, sort_order: i });
    }
    if (missing.length) must(await admin.from("restaurant_tables").insert(missing), "insert tables");
    console.log(`[seed-demo] ${p.slug}: ${missing.length} mesa(s) criada(s), ${have.size} já existia(m)`);

    const live = must(await admin.from("subscriptions").select("id").eq("restaurant_id", r).in("status", ["trialing", "active", "past_due"]).limit(1), "subscriptions") as Row[];
    if (!live.length) {
      if (!plan) throw new Error("Plano 'basico' ausente: rode apply-migrations.ts (seed.sql) antes.");
      must(
        await admin.from("subscriptions").insert({ restaurant_id: r, plan_id: plan.id, status: "trialing", trial_ends_at: new Date(Date.now() + 90 * 864e5).toISOString() }),
        "insert subscription",
      );
      console.log(`[seed-demo] ${p.slug}: assinatura de teste (trial 90 dias) criada`);
    }
  }

  // ---- (d) credenciais ----
  creds._note = "Credenciais de DEMONSTRAÇÃO (nuvem). NÃO versionar nem compartilhar fora da reunião. Gerado por scripts/deploy/seed-demo-remote.ts.";
  creds.generated_at = new Date().toISOString();
  writeCreds(credsFile, creds);

  console.log("\n[seed-demo] contas de demonstração (senhas SOMENTE no arquivo abaixo):");
  for (const a of creds.accounts ?? []) console.log(`  ${a.role.padEnd(8)} ${a.restaurant.padEnd(14)} ${a.email}${a.password ? "" : "  (SEM senha registrada)"}`);
  console.log(`\n[seed-demo] credenciais em: ${path.relative(process.cwd(), credsFile).replace(/\\/g, "/")}`);
  console.log("[seed-demo] concluído. Nenhum pedido foi criado: a operação está vazia para a demonstração ao vivo.");
  return 0;
}

const invoked = process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "";
if (invoked === "seed-demo-remote") {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

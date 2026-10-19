/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Verificação ponta a ponta da demo publicada (Vercel + Supabase na nuvem). Só usa a chave ANON (pública) e as
 * credenciais de DEMO do arquivo scripts/data/.deploy-credentials.json. Nunca imprime chaves, tokens nem senhas.
 *
 *   npx tsx scripts/deploy/verify-remote.ts --site-url=https://SEU-SITE.vercel.app [--env-file=<arq>] [--credentials-file=<arq>]
 *
 * Imprime PASS/FAIL por item; sai com código 1 se houver qualquer FAIL.
 */
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_CREDENTIALS_FILE, flagStr, isSupabaseCloudHost, loadDeployEnv, parseFlags, redact, requireKeys } from "./common";

const SLUGS = ["la-pastelaria", "o-nailton"] as const;
const PRIVATE_TABLES = ["orders", "customers", "payments", "tabs"];
/** Tabelas por-restaurante que um usuário autenticado NÃO pode ver de outro restaurante. */
const ISOLATED_TABLES = ["restaurant_tables", "orders", "customers", "tabs", "payments", "restaurant_memberships", "print_jobs"];

let failures = 0;
const results: string[] = [];
function report(ok: boolean, item: string, extra = ""): void {
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"}  ${item}${extra ? `  (${extra})` : ""}`;
  results.push(line);
  console.log(line);
}

const decodeHtml = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

async function http(url: string, init: RequestInit = {}): Promise<{ status: number; text: string; headers: Headers } | { error: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      return { status: res.status, text: await res.text(), headers: res.headers };
    } catch (e) {
      if (attempt === 1) return { error: (e as Error).message.slice(0, 120) };
    }
  }
  return { error: "falha" };
}

const countProducts = (categories: any[] | undefined) => (categories ?? []).reduce((n, c) => n + (c.products?.length ?? 0), 0);
const productNames = (categories: any[] | undefined): string[] => (categories ?? []).flatMap((c) => (c.products ?? []).map((p: any) => String(p.name)));

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseFlags(argv, ["site-url", "env-file", "credentials-file"]);
  const siteRaw = flagStr(flags, "site-url");
  if (!siteRaw) throw new Error("Informe --site-url=https://SEU-SITE.vercel.app");
  const site = siteRaw.replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(site)) throw new Error("--site-url deve ser a origem https (ex.: https://meu-site.vercel.app), sem caminho.");

  const env = loadDeployEnv(flagStr(flags, "env-file"));
  requireKeys(env, ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
  const url = env.values.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "");
  const anon = env.values.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!isSupabaseCloudHost(new URL(url).hostname)) throw new Error("Recusado: NEXT_PUBLIC_SUPABASE_URL não é um projeto Supabase na nuvem.");
  const secrets = [anon];
  const restHeaders = { apikey: anon, Authorization: `Bearer ${anon}` };
  console.log(`[verify] site: ${site}\n[verify] supabase: ${new URL(url).host}\n`);

  // ---- 1. páginas do site ----
  for (const p of ["/", "/login"]) {
    const r = await http(site + p, { redirect: "follow" });
    report("status" in r && r.status === 200, `GET ${p} = 200`, "error" in r ? r.error : `status ${r.status}`);
  }

  // ---- 2. menu público via RPC (anon direto na nuvem) ----
  const rpcMenus: Record<string, any> = {};
  for (const slug of SLUGS) {
    const r = await http(`${url}/rest/v1/rpc/public_menu`, {
      method: "POST",
      headers: { ...restHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ p_slug: slug }),
    });
    let n = 0;
    if ("status" in r && r.status === 200) {
      try {
        rpcMenus[slug] = JSON.parse(r.text);
        n = countProducts(rpcMenus[slug]?.categories);
      } catch {
        /* n = 0 */
      }
    }
    report(n > 0, `RPC public_menu(${slug}) via anon retorna produtos`, "error" in r ? r.error : `status ${r.status}, ${n} produtos`);
  }

  // ---- 3. vitrine /r/<slug> contém itens do cardápio ----
  for (const slug of SLUGS) {
    const r = await http(`${site}/r/${slug}`, { redirect: "follow" });
    if ("error" in r || r.status !== 200) {
      report(false, `GET /r/${slug} = 200 com itens do cardápio`, "error" in r ? r.error : `status ${r.status}`);
      continue;
    }
    const html = decodeHtml(r.text);
    const names = [...new Set(productNames(rpcMenus[slug]?.categories))].slice(0, 12);
    const hits = names.filter((n) => html.includes(n)).length;
    const need = Math.min(3, names.length);
    report(names.length > 0 && hits >= need, `GET /r/${slug} = 200 com itens do cardápio`, `${hits}/${names.length} nomes de produto encontrados`);
  }

  // ---- 4. API pública v1 do site ----
  {
    const r = await http(`${site}/api/public/v1/restaurants/la-pastelaria/menu`);
    let n = 0;
    if ("status" in r && r.status === 200) {
      try {
        const j = JSON.parse(r.text);
        n = countProducts((j.data ?? j).categories);
      } catch {
        /* n = 0 */
      }
    }
    report(n > 0, "GET /api/public/v1/restaurants/la-pastelaria/menu retorna produtos", "error" in r ? r.error : `status ${r.status}, ${n} produtos`);
  }

  // ---- 5. rotas protegidas redirecionam quem não está logado ----
  for (const p of ["/app/la-pastelaria/dashboard", "/operacao/la-pastelaria/pedidos"]) {
    const r = await http(site + p, { redirect: "manual" });
    const redirected = "status" in r && [301, 302, 303, 307, 308].includes(r.status);
    const loc = "status" in r ? (r.headers.get("location") ?? "") : "";
    report(redirected, `GET ${p} sem sessão redireciona (não expõe a página)`, "error" in r ? r.error : `status ${r.status}${loc ? ` -> ${loc.split("?")[0]}` : ""}`);
  }

  // ---- 6. anon NÃO lê tabelas privadas (REST direto) ----
  for (const t of PRIVATE_TABLES) {
    const r = await http(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: restHeaders });
    let rows = -1;
    if ("status" in r) {
      try {
        const j = JSON.parse(r.text);
        rows = Array.isArray(j) ? j.length : 0;
      } catch {
        rows = 0;
      }
    }
    const ok = "status" in r && rows <= 0 && (r.status === 200 || r.status === 401 || r.status === 403 || r.status === 404);
    report(ok, `anon não lê ${t} (REST direto)`, "error" in r ? r.error : `status ${r.status}, ${Math.max(rows, 0)} linhas`);
  }

  // ---- 7. login da conta de demo + isolamento entre restaurantes ----
  const credsFile = flagStr(flags, "credentials-file") ? path.resolve(flagStr(flags, "credentials-file")!) : DEFAULT_CREDENTIALS_FILE();
  let accounts: { email: string; role: string; restaurant: string; password: string | null }[] = [];
  if (existsSync(credsFile)) {
    try {
      accounts = JSON.parse(readFileSync(credsFile, "utf8")).accounts ?? [];
    } catch {
      /* fica vazio */
    }
  }
  const find = (role: string, restaurant: string) => accounts.find((a) => a.role === role && a.restaurant === restaurant && a.password);

  const signIn = async (acc: { email: string; password: string | null }) => {
    const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: acc.email, password: acc.password! });
    return { client, ok: !error && !!data.session, err: error ? redact(error.message, [...secrets, acc.password ?? undefined]) : "" };
  };

  const cashier = find("cashier", "la-pastelaria");
  if (!cashier) {
    report(false, "login da conta de demo (caixa) e acesso à própria operação", `conta caixa/la-pastelaria sem senha em ${path.basename(credsFile)}`);
  } else {
    const s = await signIn(cashier);
    report(s.ok, "login da conta de demo (caixa da La Pastelaria)", s.ok ? "sessão obtida" : s.err);
    if (s.ok) {
      const mem = await s.client.from("restaurant_memberships").select("restaurant_id,role,status").eq("user_id", (await s.client.auth.getUser()).data.user?.id ?? "");
      const mine = (mem.data ?? []).filter((m: any) => m.status === "active");
      report(!mem.error && mine.length === 1 && mine[0].role === "cashier", "caixa vê o próprio vínculo (papel cashier)", mem.error ? mem.error.message : `${mine.length} vínculo(s) ativo(s)`);
      const tabs = await s.client.from("restaurant_tables").select("restaurant_id");
      const own = new Set(mine.map((m: any) => m.restaurant_id));
      const ownOnly = !tabs.error && (tabs.data ?? []).length > 0 && (tabs.data ?? []).every((t: any) => own.has(t.restaurant_id));
      report(ownOnly, "caixa acessa as mesas da própria operação (e só dela)", tabs.error ? tabs.error.message : `${(tabs.data ?? []).length} mesas`);
      await s.client.auth.signOut();
    }
  }

  // Isolamento: dono de A não lê dados de B (e vice-versa), com grupo de controle positivo.
  const owners = SLUGS.map((slug) => ({ slug, acc: find("owner", slug) }));
  if (owners.some((o) => !o.acc)) {
    report(false, "isolamento entre restaurantes (owner A x B)", `donos sem senha em ${path.basename(credsFile)}`);
  } else {
    const seen: Record<string, Set<string>> = {};
    for (const o of owners) {
      const s = await signIn(o.acc!);
      if (!s.ok) {
        report(false, `login do dono de ${o.slug}`, s.err);
        continue;
      }
      report(true, `login do dono de ${o.slug}`);
      const mem = await s.client.from("restaurant_memberships").select("restaurant_id,role,status");
      const ownIds = new Set((mem.data ?? []).filter((m: any) => m.status === "active").map((m: any) => m.restaurant_id));
      seen[o.slug] = ownIds;
      let leaked = 0;
      const problems: string[] = [];
      for (const t of ISOLATED_TABLES) {
        const r = await s.client.from(t).select("restaurant_id").limit(1000);
        if (r.error) {
          // sem privilégio de leitura também é isolamento; só registramos se não for erro de permissão.
          if (!/permission denied|42501|does not exist/i.test(r.error.message)) problems.push(`${t}: ${r.error.message.slice(0, 60)}`);
          continue;
        }
        const foreign = (r.data ?? []).filter((x: any) => !ownIds.has(x.restaurant_id)).length;
        if (foreign) {
          leaked += foreign;
          problems.push(`${t}: ${foreign} linha(s) de OUTRO restaurante`);
        }
      }
      report(ownIds.size === 1 && leaked === 0 && problems.length === 0, `dono de ${o.slug} não lê dados do outro restaurante`, problems.length ? problems.join("; ") : `${ISOLATED_TABLES.length} tabelas conferidas, ${ownIds.size} restaurante(s) no escopo`);
      await s.client.auth.signOut();
    }
    const a = seen[SLUGS[0]];
    const b = seen[SLUGS[1]];
    if (a && b) report([...a].every((id) => !b.has(id)), "escopos dos dois donos são disjuntos");
  }

  console.log(`\n[verify] ${results.length - failures} PASS, ${failures} FAIL`);
  return failures ? 1 : 0;
}

const invoked = process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "";
if (invoked === "verify-remote") {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

/**
 * Aplica TODAS as migrações de supabase/migrations/*.sql (ordem lexicográfica) + supabase/seed.sql (planos)
 * num projeto Supabase NA NUVEM, via `pg`.
 *
 *   npx tsx scripts/deploy/apply-migrations.ts [opções]
 *
 * Opções
 *   --dry-run         varredura estática + checagens no banco (somente leitura); lista o que seria aplicado; NÃO escreve
 *   --scan-only       só a varredura estática dos .sql (não lê .env.deploy, não conecta)
 *   --check-only      só as verificações de segurança pós-aplicação num banco já migrado (somente leitura)
 *   --force-seed      reaplica supabase/seed.sql mesmo sem migrações novas (sobrescreve planos editados)
 *   --env-file=<arq>  usa outro arquivo no lugar de .env.deploy
 *
 * Lê SUPABASE_DB_URL (e NEXT_PUBLIC_SUPABASE_URL, para conferir o projeto) de `.env.deploy`.
 *
 * Segurança
 *  - Recusa host que não termine em .supabase.co / .supabase.com.
 *  - Recusa banco NÃO vazio (tabelas em `public` ou schema app_private), a menos que supabase_migrations.schema_migrations
 *    contenha, SEM lacunas, as primeiras versões dos arquivos locais (modo retomada: aplica só as faltantes).
 *  - Cada migração roda na sua transação (BEGIN/COMMIT, ROLLBACK + parada no erro) junto com o registro da versão.
 *  - SSL: usa `ssl: { rejectUnauthorized: false }`. O pooler/endpoint da Supabase entrega certificado assinado pela CA
 *    própria do projeto (não está no bundle de CAs do Node); a conexão continua CRIPTOGRAFADA, mas sem validar a cadeia.
 *    Risco aceito para um deploy de demonstração; para endurecer, baixe o certificado em Project Settings -> Database
 *    e troque por `ssl: { ca }`.
 *  - Nunca imprime a connection string, a senha nem as chaves.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { projectRoot } from "../lib/env";
import {
  flagStr,
  isSupabaseCloudHost,
  loadDeployEnv,
  parseDbUrl,
  parseFlags,
  redact,
  refFromApiUrl,
  refFromDbTarget,
  requireKeys,
  type DbTarget,
} from "./common";

// ---------------------------------------------------------------------------
// Arquivos
// ---------------------------------------------------------------------------
interface Migration {
  file: string;
  version: string;
  name: string;
  sql: string;
}

function loadMigrations(): { migrations: Migration[]; seedSql: string | null } {
  const dir = path.join(projectRoot(), "supabase", "migrations");
  if (!existsSync(dir)) throw new Error(`Pasta de migrações não encontrada: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) throw new Error("Nenhuma migração .sql encontrada.");
  const seen = new Set<string>();
  const migrations = files.map((file) => {
    const m = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!m) throw new Error(`Nome de migração fora do padrão <versão>_<nome>.sql: ${file}`);
    if (seen.has(m[1])) throw new Error(`Versão duplicada: ${m[1]}`);
    seen.add(m[1]);
    return { file, version: m[1], name: m[2], sql: readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "") };
  });
  const seedPath = path.join(projectRoot(), "supabase", "seed.sql");
  return { migrations, seedSql: existsSync(seedPath) ? readFileSync(seedPath, "utf8").replace(/^﻿/, "") : null };
}

// ---------------------------------------------------------------------------
// Varredura estática (ALERTA = pode exigir privilégio que o `postgres` da nuvem não tem; NOTA = informativo)
// ---------------------------------------------------------------------------
type Level = "ALERTA" | "NOTA";
interface Finding {
  file: string;
  line: number;
  level: Level;
  msg: string;
  count: number;
}

/** Troca comentários e literais 'texto' por espaços, preservando quebras de linha (números de linha continuam válidos). */
export function blankNonCode(sql: string): string {
  const out = sql.split("");
  const n = sql.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      blank(i, end);
      i = end;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      blank(i, j + 1);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

const ALLOWED_EXTENSIONS = new Set([
  "pgcrypto", "uuid-ossp", "pg_trgm", "citext", "unaccent", "btree_gin", "btree_gist", "hstore", "ltree", "fuzzystrmatch",
  "tablefunc", "pg_stat_statements", "pgjwt", "vector", "postgis", "pg_cron", "pg_net", "pgsodium", "pgmq", "moddatetime",
  "intarray", "cube", "earthdistance", "isn", "lo", "plpgsql", "pg_graphql", "pg_jsonschema", "pg_hashids", "pgtap",
  "pg_repack", "hypopg", "index_advisor", "wrappers", "supabase_vault", "postgres_fdw", "pgaudit", "dict_int", "dict_xsyn",
  "seg", "tcn", "tsm_system_rows", "tsm_system_time", "pgrowlocks", "pgstattuple", "pg_buffercache", "plpgsql_check",
]);
const RESERVED_SCHEMAS = new Set([
  "auth", "storage", "extensions", "realtime", "graphql", "graphql_public", "vault", "pgsodium", "pgsodium_masks",
  "supabase_functions", "net", "cron", "pgbouncer", "pg_catalog", "information_schema", "public",
]);

interface Rule {
  re: RegExp;
  level: Level | ((m: RegExpExecArray) => Level | null);
  msg: string | ((m: RegExpExecArray) => string);
}

const RULES: Rule[] = [
  { re: /\balter\s+system\b/g, level: "ALERTA", msg: "ALTER SYSTEM exige superusuário (o papel postgres da nuvem não é superusuário)." },
  {
    re: /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([\w-]+)"?/g,
    level: (m) => (ALLOWED_EXTENSIONS.has(m[1]) ? "NOTA" : "ALERTA"),
    msg: (m) =>
      ALLOWED_EXTENSIONS.has(m[1])
        ? `CREATE EXTENSION ${m[1]}: extensão disponível na nuvem Supabase (postgres pode criá-la).`
        : `CREATE EXTENSION ${m[1]}: fora da lista de extensões conhecidas da Supabase; pode falhar com "permission denied" ou "not available".`,
  },
  {
    re: /\balter\b[^;]*?\bowner\s+to\s+"?(\w+)"?/g,
    level: (m) => (/\b(auth|storage|extensions|realtime|vault|graphql)\./.test(m[0]) || m[1] !== "postgres" ? "ALERTA" : "NOTA"),
    msg: (m) => `ALTER ... OWNER TO ${m[1]}: trocar dono exige ser dono atual E membro do papel de destino; objetos de sistema (auth/storage) pertencem a supabase_*_admin.`,
  },
  { re: /\breassign\s+owned\b/g, level: "ALERTA", msg: "REASSIGN OWNED exige privilégios elevados." },
  { re: /\bset\s+(?:session\s+|local\s+)?role\b(?!\s*=)/g, level: "ALERTA", msg: "SET ROLE: só funciona para papéis dos quais o postgres é membro (superusuário/supabase_admin não é)." },
  { re: /\bset\s+session\s+authorization\b/g, level: "ALERTA", msg: "SET SESSION AUTHORIZATION exige superusuário." },
  { re: /\brolbypassrls\b/g, level: "NOTA", msg: "Premissa BYPASSRLS do papel dono (migração 0001): este script confere o papel ANTES de aplicar." },
  { re: /\bforce\s+row\s+level\s+security\b/g, level: "NOTA", msg: "FORCE RLS: funções SECURITY DEFINER só funcionam se o dono (postgres) tiver BYPASSRLS." },
  { re: /\bsession_replication_role\b/g, level: "ALERTA", msg: "session_replication_role exige superusuário." },
  { re: /\bdisable\s+trigger\s+all\b/g, level: "ALERTA", msg: "DISABLE TRIGGER ALL inclui triggers de sistema (superusuário)." },
  {
    re: /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|alter\s+table(?:\s+only)?(?:\s+if\s+exists)?|drop\s+(?:table|trigger|policy|index|function)(?:\s+if\s+exists)?)\s+auth\.(\w+)/g,
    level: "ALERTA",
    msg: (m) => `Escrita/DDL direto em auth.${m[1]}: o schema auth pertence a supabase_auth_admin (use a Admin API).`,
  },
  { re: /\bcreate\s+(?:unique\s+)?index\b[^;]*?\bon\s+auth\./g, level: "ALERTA", msg: "CREATE INDEX em tabela do schema auth (dono: supabase_auth_admin)." },
  {
    re: /\bcreate\s+(?:or\s+replace\s+)?trigger\b[^;]*?\bon\s+auth\.users\b/g,
    level: "NOTA",
    msg: "TRIGGER em auth.users (handle_new_user): padrão documentado da Supabase; o postgres da nuvem consegue criá-lo.",
  },
  { re: /\breferences\s+auth\.users\b/g, level: "NOTA", msg: "FK para auth.users: permitido ao postgres na nuvem (padrão documentado)." },
  { re: /\balter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?storage\./g, level: "ALERTA", msg: "ALTER TABLE em storage.*: exige ser dono (supabase_storage_admin); falha com 'must be owner'." },
  { re: /\bcreate\s+policy\b[^;]*?\bon\s+storage\.objects\b/g, level: "NOTA", msg: "POLICY em storage.objects: permitido na nuvem (padrão documentado)." },
  { re: /\binsert\s+into\s+storage\.buckets\b/g, level: "NOTA", msg: "INSERT em storage.buckets: permitido ao postgres na nuvem." },
  { re: /\balter\s+publication\s+supabase_realtime\b/g, level: "NOTA", msg: "ALTER PUBLICATION supabase_realtime: a publicação existe na nuvem e pertence ao postgres." },
  { re: /\bcreate\s+publication\b/g, level: "NOTA", msg: "CREATE PUBLICATION: na nuvem supabase_realtime já existe (a migração protege com IF NOT EXISTS)." },
  {
    re: /\b(?:alter|create|drop)\s+(?:role|user)\b[^;]*/g,
    level: "ALERTA",
    msg: (m) =>
      /superuser|bypassrls|replication/.test(m[0])
        ? "Criação/alteração de papel com SUPERUSER/BYPASSRLS/REPLICATION: não permitido ao postgres da nuvem."
        : "CREATE/ALTER/DROP ROLE|USER: restrito (postgres tem CREATEROLE mas não altera papéis do sistema).",
  },
  {
    re: /\bcreate\s+schema\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/g,
    level: (m) => (RESERVED_SCHEMAS.has(m[1]) && m[1] !== "public" ? "ALERTA" : null),
    msg: (m) => `CREATE SCHEMA ${m[1]}: schema reservado/gerenciado pela Supabase.`,
  },
  { re: /\balter\s+default\s+privileges\b/g, level: (m) => (/for\s+(?:role|user)\s+(?!postgres\b)/.test(m[0]) ? "ALERTA" : "NOTA"), msg: "ALTER DEFAULT PRIVILEGES: vale só para objetos criados pelo papel indicado; FOR ROLE supabase_admin exige ser esse papel." },
  {
    re: /\b(?:grant|revoke)\b[^;]*?\b(?:to|from)\s+"?(supabase_\w+|authenticator|dashboard_user|pgbouncer|pgsodium_\w+)"?/g,
    level: "ALERTA",
    msg: (m) => `GRANT/REVOKE envolvendo o papel de sistema ${m[1]}: pode falhar na nuvem.`,
  },
  { re: /\bcreate\s+(?:unique\s+)?index\s+concurrently\b|\bdrop\s+index\s+concurrently\b/g, level: "ALERTA", msg: "INDEX CONCURRENTLY não roda dentro de transação (este script usa uma transação por migração)." },
  { re: /\bvacuum\b|\bcreate\s+database\b|\bdrop\s+database\b|\balter\s+database\b|\bcreate\s+tablespace\b/g, level: "ALERTA", msg: "Comando que não roda em transação e/ou exige privilégio de superusuário." },
  { re: /\balter\s+type\b[^;]*?\badd\s+value\b/g, level: "NOTA", msg: "ALTER TYPE ... ADD VALUE: ok no PG12+, mas o valor novo não pode ser usado na mesma transação." },
  { re: /^\s*(?:begin|commit|rollback|start\s+transaction)\s*;/gm, level: "ALERTA", msg: "Controle de transação explícito dentro da migração conflita com a transação por migração." },
  { re: /\blanguage\s+(?:c|plpython3u|plpythonu|plperlu|plperl|pltcl|pltclu)\b/g, level: "ALERTA", msg: "Linguagem de função não confiável/indisponível (exige superusuário)." },
  { re: /\bcreate\s+(?:event\s+trigger|language|foreign\s+data\s+wrapper|server)\b/g, level: "ALERTA", msg: "Objeto que normalmente exige superusuário." },
  { re: /\bcopy\b[^;]*?\b(?:from|to)\s+program\b|\bpg_read_file\b|\bpg_ls_dir\b|\blo_import\b|\blo_export\b/g, level: "ALERTA", msg: "Acesso ao sistema de arquivos/programas do servidor (superusuário)." },
  { re: /\b(?:update|insert\s+into|delete\s+from)\s+pg_\w+/g, level: "ALERTA", msg: "Escrita direta no catálogo do sistema." },
];

export function scanSql(file: string, sql: string): Finding[] {
  const code = blankNonCode(sql).toLowerCase();
  const lineStarts: number[] = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const found = new Map<string, Finding>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(code))) {
      if (m[0].length === 0) rule.re.lastIndex++;
      const level = typeof rule.level === "function" ? rule.level(m) : rule.level;
      if (!level) continue;
      const msg = typeof rule.msg === "function" ? rule.msg(m) : rule.msg;
      const key = level + "|" + msg;
      const prev = found.get(key);
      if (prev) prev.count++;
      else found.set(key, { file, line: lineOf(m.index + (/^\s/.test(m[0]) ? m[0].length - m[0].trimStart().length : 0)), level, msg, count: 1 });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function printScan(migrations: Migration[], seedSql: string | null): { alerts: number; notes: number; definers: number } {
  const all: Finding[] = [];
  let definers = 0;
  for (const mig of migrations) {
    all.push(...scanSql(mig.file, mig.sql));
    definers += (blankNonCode(mig.sql).toLowerCase().match(/\bsecurity\s+definer\b/g) ?? []).length;
  }
  if (seedSql) all.push(...scanSql("seed.sql", seedSql));
  const alerts = all.filter((f) => f.level === "ALERTA");
  const notes = all.filter((f) => f.level === "NOTA");
  console.log("\n[scan] varredura estática de privilégios (heurística; só para alertar, não bloqueia)");
  if (!alerts.length) console.log("  nenhum ALERTA.");
  for (const f of alerts) console.log(`  ALERTA ${f.file}:${f.line}${f.count > 1 ? ` (+${f.count - 1} ocorrência(s))` : ""}  ${f.msg}`);
  for (const f of notes) console.log(`  nota   ${f.file}:${f.line}${f.count > 1 ? ` (x${f.count})` : ""}  ${f.msg}`);
  console.log(`  total: ${alerts.length} alerta(s), ${notes.length} nota(s); ${definers} cláusula(s) SECURITY DEFINER nas migrações.`);
  return { alerts: alerts.length, notes: notes.length, definers };
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------
function connectHint(code: string | undefined, msg: string): string {
  if (code === "ENOTFOUND") return "Dica: host não resolvido. Confira o host em SUPABASE_DB_URL.";
  if (code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENETUNREACH" || code === "EHOSTUNREACH")
    return "Dica: sem rota até o banco. A conexão DIRETA (db.<ref>.supabase.co) é só IPv6 em planos gratuitos: use a string do Session pooler (aws-0-<região>.pooler.supabase.com:5432).";
  if (code === "28P01" || /password authentication failed/i.test(msg)) return "Dica: senha do banco incorreta (a do projeto, não a do painel nem a service role). Redefina em Project Settings -> Database.";
  if (/tenant or user not found/i.test(msg)) return "Dica: usuário/região do pooler incorretos. Copie a string exata em Connect -> Session pooler.";
  if (/SSL|certificate/i.test(msg)) return "Dica: problema de SSL; o script já usa SSL sem validação de cadeia. Verifique a porta (5432).";
  return "";
}

async function connect(t: DbTarget, secrets: string[]): Promise<Client> {
  const client = new Client({
    host: t.host,
    port: t.port,
    user: t.user,
    password: t.password,
    database: t.database,
    ssl: { rejectUnauthorized: false }, // criptografado, sem validar a cadeia (ver cabeçalho)
    connectionTimeoutMillis: 20_000,
    query_timeout: 300_000,
    keepAlive: true,
  });
  client.on("error", () => {
    /* erros assíncronos de conexão aparecem nas queries; evita crash por evento não tratado */
  });
  try {
    await client.connect();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const msg = redact(String(err.message ?? e), secrets);
    throw new Error(`Falha ao conectar em ${t.host}:${t.port} (${err.code ?? "sem código"}): ${msg}\n${connectHint(err.code, msg)}`.trim());
  }
  await client.query("set statement_timeout = '280s'");
  await client.query("set lock_timeout = '30s'");
  return client;
}

interface DbState {
  user: string;
  bypassrls: boolean;
  superuser: boolean;
  publicTables: number;
  hasAppPrivate: boolean;
  registryExists: boolean;
  applied: string[];
  statementsColumn: boolean;
}

async function inspect(c: Client): Promise<DbState> {
  const role = (
    await c.query<{ u: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "select current_user as u, r.rolsuper, r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user",
    )
  ).rows[0];
  const pt = (
    await c.query<{ n: string }>(
      "select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    )
  ).rows[0];
  const ap = (await c.query<{ e: boolean }>("select exists (select 1 from pg_catalog.pg_namespace where nspname = 'app_private') as e")).rows[0];
  const reg = (await c.query<{ r: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as r")).rows[0];
  let applied: string[] = [];
  let statementsColumn = false;
  if (reg.r) {
    applied = (await c.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")).rows.map((r) => r.version);
    statementsColumn =
      (
        await c.query(
          "select 1 from information_schema.columns where table_schema = 'supabase_migrations' and table_name = 'schema_migrations' and column_name = 'statements'",
        )
      ).rowCount === 1;
  }
  return {
    user: role.u,
    bypassrls: role.rolbypassrls,
    superuser: role.rolsuper,
    publicTables: Number(pt.n),
    hasAppPrivate: ap.e,
    registryExists: !!reg.r,
    applied,
    statementsColumn,
  };
}

function lineContext(sql: string, position: number): string {
  const before = sql.slice(0, Math.max(0, position - 1));
  const line = before.split("\n").length;
  const text = (sql.split("\n")[line - 1] ?? "").trim().slice(0, 160);
  return `linha ${line}: ${text}`;
}

async function runInTx(c: Client, label: string, sql: string, register: { version: string; name: string; statementsColumn: boolean } | null, secrets: string[]): Promise<void> {
  const t0 = Date.now();
  await c.query("begin");
  try {
    await c.query(sql);
    if (register) {
      if (register.statementsColumn) {
        await c.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)", [register.version, register.name, [sql]]);
      } else {
        await c.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [register.version, register.name]);
      }
    }
    await c.query("commit");
    await c.query("reset role").catch(() => undefined);
    console.log(`  ok  ${label} (${Date.now() - t0} ms)`);
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    const err = e as { message?: string; code?: string; detail?: string; hint?: string; position?: string; internalQuery?: string; where?: string };
    const lines = [`\nFALHA em ${label} (transação desfeita; nada desta migração foi gravado)`];
    lines.push(`  erro:   ${redact(String(err.message ?? e), secrets)}${err.code ? `  [SQLSTATE ${err.code}]` : ""}`);
    if (err.detail) lines.push(`  detalhe: ${redact(err.detail, secrets)}`);
    if (err.hint) lines.push(`  dica:    ${redact(err.hint, secrets)}`);
    if (err.position && !err.internalQuery) lines.push(`  onde:    ${lineContext(sql, Number(err.position))}`);
    if (err.where) lines.push(`  contexto: ${redact(err.where.split("\n")[0], secrets)}`);
    if (err.code === "42501" || /must be owner|permission denied/i.test(String(err.message))) {
      lines.push("  causa provável: privilégio que o papel postgres da nuvem não tem (veja os ALERTAS da varredura acima).");
    }
    lines.push("  Corrija e rode de novo: o script retoma a partir desta migração (as anteriores já estão registradas).");
    throw new Error(lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Verificações pós-aplicação
// ---------------------------------------------------------------------------
const PRIVATE_TABLES = ["orders", "customers", "payments", "tabs"];

async function postChecks(c: Client): Promise<boolean> {
  let ok = true;
  const line = (status: "OK" | "FALHA" | "AVISO", msg: string) => {
    if (status === "FALHA") ok = false;
    console.log(`  [${status}] ${msg}`);
  };
  console.log("\n[checks] verificações de segurança");

  const tables = (
    await c.query<{ relname: string; rls: boolean; frls: boolean }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as frls
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`,
    )
  ).rows;
  const noRls = tables.filter((t) => !t.rls).map((t) => t.relname);
  if (!tables.length) line("FALHA", "nenhuma tabela em public.");
  else if (noRls.length) line("FALHA", `RLS DESLIGADO em: ${noRls.join(", ")}`);
  else line("OK", `RLS habilitado nas ${tables.length} tabelas públicas (${tables.filter((t) => t.frls).length} com FORCE RLS).`);

  for (const name of PRIVATE_TABLES) {
    if (!tables.some((t) => t.relname === name)) {
      line("FALHA", `tabela privada ${name} não existe.`);
      continue;
    }
    const r = (await c.query<{ a: boolean }>("select has_any_column_privilege('anon', format('public.%I', $1::text), 'SELECT') as a", [name])).rows[0];
    line(r.a ? "FALHA" : "OK", r.a ? `anon TEM SELECT em ${name}` : `anon sem SELECT em ${name}`);
  }
  const anonReadable = (
    await c.query<{ relname: string }>(
      `select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p','v') and has_any_column_privilege('anon', c.oid, 'SELECT') order by 1`,
    )
  ).rows.map((r) => r.relname);
  console.log(`  [info] relações públicas legíveis por anon (ainda sujeitas a RLS): ${anonReadable.length ? anonReadable.join(", ") : "nenhuma"}`);

  const bucket = (await c.query<{ id: string; public: boolean }>("select id, public from storage.buckets where id = 'restaurant-public'")).rows[0];
  line(bucket ? "OK" : "FALHA", bucket ? `bucket restaurant-public existe (público=${bucket.public}).` : "bucket restaurant-public NÃO existe.");

  const defs = (
    await c.query<{ total: string; sem_path: string }>(
      `select count(*)::text as total,
              count(*) filter (where not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%'))::text as sem_path
         from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('public','app_private')
          and not exists (select 1 from pg_catalog.pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
    )
  ).rows[0];
  console.log(`  [info] funções SECURITY DEFINER (public + app_private): ${defs.total}`);
  if (Number(defs.sem_path) > 0) line("AVISO", `${defs.sem_path} função(ões) SECURITY DEFINER sem search_path fixo.`);
  else line("OK", "todas as funções SECURITY DEFINER têm search_path fixo.");

  const plans = Number((await c.query<{ n: string }>("select count(*)::text as n from public.plans")).rows[0].n);
  line(plans >= 2 ? "OK" : "AVISO", `${plans} plano(s) em public.plans${plans >= 2 ? "" : " (esperado >= 2: rode sem --check-only ou com --force-seed)"}`);
  return ok;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseFlags(argv, ["dry-run", "scan-only", "check-only", "force-seed", "env-file"]);
  const dryRun = !!flags["dry-run"];
  const { migrations, seedSql } = loadMigrations();
  console.log(`[apply] ${migrations.length} migração(ões) em supabase/migrations${seedSql ? " + supabase/seed.sql" : " (SEM seed.sql)"}`);

  if (!flags["check-only"]) printScan(migrations, seedSql);
  if (flags["scan-only"]) return 0;

  // ---- ambiente + validações de alvo (antes de qualquer conexão) ----
  const env = loadDeployEnv(flagStr(flags, "env-file"));
  requireKeys(env, ["SUPABASE_DB_URL"]);
  const target = parseDbUrl(env.values.SUPABASE_DB_URL);
  const secrets = [target.password, env.values.SUPABASE_DB_URL, env.values.SUPABASE_SERVICE_ROLE_KEY, env.values.NEXT_PUBLIC_SUPABASE_ANON_KEY];
  if (!isSupabaseCloudHost(target.host)) {
    throw new Error(`Recusado: o host do banco (${target.host}) não termina em .supabase.co nem .supabase.com. Este script só aplica em projeto Supabase NA NUVEM.`);
  }
  const apiUrl = env.values.NEXT_PUBLIC_SUPABASE_URL;
  if (apiUrl) {
    const a = refFromApiUrl(apiUrl);
    const d = refFromDbTarget(target);
    if (a && d && a !== d) throw new Error(`Recusado: SUPABASE_DB_URL aponta para o projeto "${d}" mas NEXT_PUBLIC_SUPABASE_URL para "${a}". Misturar projetos aqui apagaria/alteraria o banco errado.`);
  } else {
    console.log("[apply] aviso: NEXT_PUBLIC_SUPABASE_URL ausente; não foi possível conferir se o banco é do mesmo projeto da API.");
  }
  if (target.port === 6543) {
    console.log("[apply] aviso: porta 6543 = Transaction pooler. Migrações devem usar a porta 5432 (Session pooler ou conexão direta); o modo Transaction não é suportado para DDL multi-comando.");
  }
  console.log(`[apply] alvo: ${target.host}:${target.port} banco=${target.database}${dryRun ? "  (--dry-run: nada será gravado)" : ""}`);

  const client = await connect(target, secrets);
  try {
    const st = await inspect(client);
    console.log(`[apply] papel atual: ${st.user} (superuser=${st.superuser}, bypassrls=${st.bypassrls})`);

    // Premissa da migração 0001: BYPASSRLS (FORCE RLS + SECURITY DEFINER dependem disso).
    if (!st.superuser && !st.bypassrls && !flags["check-only"]) {
      throw new Error(
        `Recusado: o papel "${st.user}" não tem BYPASSRLS nem é superusuário. A migração 0001 exige isso (as funções SECURITY DEFINER ` +
          "sob FORCE RLS dependem do dono ignorar RLS). Na Supabase o papel `postgres` tem BYPASSRLS: use a connection string do usuário " +
          "postgres (postgres.<ref> no pooler), não `authenticator`, `anon` ou outro.",
      );
    }

    if (flags["check-only"]) {
      return (await postChecks(client)) ? 0 : 1;
    }

    // ---- vazio vs. retomada ----
    const localVersions = migrations.map((m) => m.version);
    const unknown = st.applied.filter((v) => !localVersions.includes(v));
    if (unknown.length) {
      throw new Error(`Recusado: supabase_migrations.schema_migrations tem versões que não existem em supabase/migrations (${unknown.slice(0, 3).join(", ")}...). Este banco pertence a outro projeto/histórico.`);
    }
    const prefixOk = st.applied.every((v, i) => v === localVersions[i]);
    if (!prefixOk) {
      throw new Error("Recusado: as versões já registradas não formam um prefixo contínuo das migrações locais (há lacuna). Não é seguro retomar automaticamente.");
    }
    const hasObjects = st.publicTables > 0 || st.hasAppPrivate;
    let mode: "nova" | "retomada";
    if (st.applied.length === 0) {
      if (hasObjects) {
        throw new Error(
          `Recusado: o banco NÃO está vazio (${st.publicTables} tabela(s) em public${st.hasAppPrivate ? ", schema app_private presente" : ""}) e não há histórico de migrações compatível. ` +
            "Use um projeto Supabase novo e vazio (ou apague o projeto e crie outro). Nada foi alterado.",
        );
      }
      mode = "nova";
    } else {
      if (!hasObjects) throw new Error("Recusado: o histórico diz que há migrações aplicadas, mas public está vazio (estado inconsistente). Nada foi alterado.");
      mode = "retomada";
    }

    const pending = migrations.filter((m) => !st.applied.includes(m.version));
    console.log(`[apply] modo: ${mode === "nova" ? "banco vazio (instalação nova)" : `RETOMADA (${st.applied.length} já aplicada(s))`}; pendentes: ${pending.length}`);
    for (const m of pending) console.log(`  ${dryRun ? "aplicaria" : "-"} ${m.file}`);
    if (seedSql) console.log(`  ${dryRun ? "aplicaria" : "-"} seed.sql (planos)${pending.length === 0 && !flags["force-seed"] ? " [só se a tabela plans estiver vazia]" : ""}`);

    if (dryRun) {
      console.log("\n[apply] --dry-run concluído: checagens OK, nada foi gravado.");
      return 0;
    }

    // ---- registro do CLI ----
    let statementsColumn = st.statementsColumn;
    if (!st.registryExists) {
      await client.query("begin");
      await client.query("create schema if not exists supabase_migrations");
      await client.query("create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)");
      await client.query("commit");
      statementsColumn = true;
    }

    // ---- aplica ----
    console.log("\n[apply] aplicando...");
    for (const m of pending) await runInTx(client, m.file, m.sql, { version: m.version, name: m.name, statementsColumn }, secrets);

    if (seedSql) {
      const plans = Number((await client.query<{ n: string }>("select count(*)::text as n from public.plans")).rows[0].n);
      if (pending.length > 0 || plans === 0 || flags["force-seed"]) await runInTx(client, "seed.sql", seedSql, null, secrets);
      else console.log("  --  seed.sql ignorado (planos já existem; use --force-seed para reaplicar)");
    }

    // ---- resumo ----
    const after = await inspect(client);
    const defs = (
      await client.query<{ n: string }>(
        `select count(*)::text as n from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where p.prosecdef and n.nspname in ('public','app_private')`,
      )
    ).rows[0].n;
    console.log("\n[apply] resumo");
    console.log(`  migrações aplicadas nesta execução: ${pending.length} (registradas no total: ${after.applied.length}/${migrations.length})`);
    console.log(`  tabelas em public: ${after.publicTables}; funções SECURITY DEFINER: ${defs}`);

    const checksOk = await postChecks(client);
    if (!checksOk) {
      console.error("\n[apply] ATENÇÃO: há verificações de segurança com FALHA. Não publique a demo antes de resolver.");
      return 1;
    }
    console.log("\n[apply] concluído. Próximo passo: npx tsx scripts/deploy/seed-demo-remote.ts");
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const invoked = process.argv[1] ? path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") : "";
if (invoked === "apply-migrations") {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

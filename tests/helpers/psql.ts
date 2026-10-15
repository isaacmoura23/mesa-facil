/**
 * Consulta somente-leitura ao catálogo do Postgres local via `docker exec ... psql`.
 * Usada APENAS para checar metadados (RLS ligado, GRANTs, search_path). Os testes de comportamento
 * continuam passando pela API. Se o Docker/contêiner não estiver acessível, devolve null (teste pulado).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "../../scripts/lib/env";

function projectId(): string {
  const cfg = path.join(projectRoot(), "supabase", "config.toml");
  if (existsSync(cfg)) {
    const m = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(cfg, "utf8"));
    if (m) return m[1];
  }
  return "test1";
}

export function dbContainer(): string {
  return `supabase_db_${projectId()}`;
}

export function psql(sql: string): string[] | null {
  try {
    const out = execFileSync("docker", ["exec", dbContainer(), "psql", "-U", "postgres", "-At", "-F", "|", "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

export const dockerAvailable = psql("select 1") !== null;

/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "vitest";

export interface PgResult {
  data?: unknown;
  error: { message: string; code?: string; details?: string; hint?: string } | null;
  count?: number | null;
  status?: number;
}

const DENIED_SRC =
  "42501|permission denied|row-level security|forbidden|not allowed|direct_write_forbidden|owner_|platform_only|cannot_modify_self";

/** Falhou por autorização (privilégio, RLS ou guarda de trigger/RPC). */
export function expectDenied(res: PgResult, why?: RegExp | string) {
  expect(res.error, "esperava erro de autorização, mas a operação passou").not.toBeNull();
  const text = `${res.error!.code ?? ""} ${res.error!.message}`;
  if (why) expect(text).toMatch(why instanceof RegExp ? why : new RegExp(why, "i"));
  else expect(text).toMatch(new RegExp(DENIED_SRC, "i"));
}

/** Falhou por regra de negócio (código estável no início da mensagem). */
export function expectRule(res: PgResult, code: RegExp | string) {
  expect(res.error, `esperava erro ${code}, mas a operação passou`).not.toBeNull();
  expect(res.error!.message).toMatch(code instanceof RegExp ? code : new RegExp(code));
}

export function rows(res: PgResult): any[] {
  return Array.isArray(res.data) ? (res.data as any[]) : [];
}

/** Leitura que não devolve nada: ou 0 linhas (RLS) ou erro de privilégio (sem GRANT). */
export function expectNoRows(res: PgResult) {
  if (res.error) {
    expect(`${res.error.code} ${res.error.message}`).toMatch(/42501|permission denied/i);
    return;
  }
  expect(rows(res)).toHaveLength(0);
}

/** UPDATE/DELETE com .select(): RLS filtrou tudo => 0 linhas afetadas; ou erro de negação. */
export function expectNotApplied(res: PgResult) {
  if (res.error) {
    expectDenied(res);
    return;
  }
  expect(rows(res), "linhas foram afetadas, mas não deveriam").toHaveLength(0);
}

export function expectOk(res: PgResult) {
  expect(res.error, res.error ? `${res.error.code}: ${res.error.message}` : "").toBeNull();
}

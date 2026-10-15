import { describe, expect, it } from "vitest";

const mod = await import("../../src/lib/validation/auth").catch(() => null);

describe.skipIf(!mod)("schemas de autenticação / cadastro de restaurante", () => {
  const { loginSchema, signupSchema, registerRestaurantSchema, slugify, toFieldErrors, SLUG_PATTERN } = mod!;

  it("login: e-mail válido (com trim) e senha obrigatória", () => {
    expect(loginSchema.safeParse({ email: "  owner.a@example.test ", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "sem-arroba", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.test", password: "" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.test", password: "x".repeat(257) }).success).toBe(false);
  });

  it("signup: senha forte, confirmação igual e nome mínimo", () => {
    const base = { fullName: "Maria Silva", email: "maria@example.test", password: "senha1234", confirmPassword: "senha1234" };
    expect(signupSchema.safeParse(base).success).toBe(true);
    expect(signupSchema.safeParse({ ...base, password: "curta1", confirmPassword: "curta1" }).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, password: "somenteletras", confirmPassword: "somenteletras" }).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, password: "12345678", confirmPassword: "12345678" }).success).toBe(false);
    const mismatch = signupSchema.safeParse({ ...base, confirmPassword: "outra1234" });
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) expect(toFieldErrors(mismatch.error)).toHaveProperty("confirmPassword");
    expect(signupSchema.safeParse({ ...base, fullName: "A" }).success).toBe(false);
  });

  it("slug do restaurante: normaliza caixa/espaços e segue o mesmo formato do banco", () => {
    const ok = registerRestaurantSchema.safeParse({ name: "Cantina do Zé", slug: "  Cantina-Do-ZE " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.slug).toBe("cantina-do-ze");
    for (const slug of ["ab", "-inicio", "fim-", "com espaco", "com_underscore", "duplo--hifen", "ç-acentuado", "a".repeat(64)]) {
      expect(registerRestaurantSchema.safeParse({ name: "Cantina", slug }).success, slug).toBe(false);
    }
    expect(SLUG_PATTERN.test("demo-a")).toBe(true);
  });

  it("slugify remove acentos, colapsa separadores e respeita o limite", () => {
    expect(slugify("Restaurante São João & Cia!")).toBe("restaurante-sao-joao-cia");
    expect(slugify("  --Açaí  da  Praça--  ")).toBe("acai-da-praca");
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(63);
    expect(slugify("%%%")).toBe("");
  });
});

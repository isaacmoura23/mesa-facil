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
    const pw = (password: string) => ({ fullName: "Maria Silva", email: "maria@example.test", password, confirmPassword: password });
    const base = pw("Senha12345");
    expect(signupSchema.safeParse(base).success).toBe(true);
    // Senha longa só com letras e números, sem símbolo (como as geradas para a equipe), continua valendo.
    expect(signupSchema.safeParse(pw("Abcdefghij1234Xy")).success).toBe(true);
    expect(signupSchema.safeParse(pw("Curta1")).success).toBe(false); // menos de 10
    expect(signupSchema.safeParse(pw("Senha1234")).success).toBe(false); // 9 caracteres
    expect(signupSchema.safeParse(pw("somenteletrasminusculas")).success).toBe(false);
    expect(signupSchema.safeParse(pw("sem1maiuscula23")).success).toBe(false);
    expect(signupSchema.safeParse(pw("SEM1MINUSCULA23")).success).toBe(false);
    expect(signupSchema.safeParse(pw("SemNumeroNenhum")).success).toBe(false);
    expect(signupSchema.safeParse(pw("1234567890")).success).toBe(false);
    const mismatch = signupSchema.safeParse({ ...base, confirmPassword: "Outra12345" });
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

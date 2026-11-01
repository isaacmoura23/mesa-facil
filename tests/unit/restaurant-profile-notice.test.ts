import { describe, expect, it } from "vitest";
import { NOTICE_MAX } from "../../src/modules/restaurant-profile/format";
import { contactSchema } from "../../src/modules/restaurant-profile/schemas";

const base = { whatsapp: "", phone: "", addressText: "", storefrontUrl: "" };

describe("contactSchema.notice (aviso no topo do cardápio)", () => {
  it("aceita texto, apara espaços e guarda null quando vazio", () => {
    expect(contactSchema.parse({ ...base, notice: "  Fechado no feriado  " }).notice).toBe("Fechado no feriado");
    expect(contactSchema.parse({ ...base, notice: "   " }).notice).toBeNull();
    expect(contactSchema.parse({ ...base }).notice).toBeNull();
  });

  it("recusa mais que o limite do banco", () => {
    expect(NOTICE_MAX).toBe(240);
    expect(contactSchema.safeParse({ ...base, notice: "x".repeat(NOTICE_MAX) }).success).toBe(true);
    expect(contactSchema.safeParse({ ...base, notice: "x".repeat(NOTICE_MAX + 1) }).success).toBe(false);
  });
});

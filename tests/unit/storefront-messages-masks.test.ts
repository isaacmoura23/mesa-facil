import { describe, expect, it } from "vitest";
import { CART_ERROR_MESSAGES, GENERIC_CART_ERROR, cartErrorMessage } from "../../src/modules/storefront/messages";
import { isValidBrPhone, isValidCep, maskCep, maskPhone, onlyDigits } from "../../src/modules/storefront/masks";

// Os 13 códigos do contrato (docs/CONTRACT.md) + 2 da migração 0112 + 5 da 0113 (variantes e limites de custo, F-21).
const CONTRACT_CODES = [
  "RESTAURANT_UNAVAILABLE",
  "RESTAURANT_CLOSED",
  "FULFILLMENT_DISABLED",
  "PRODUCT_UNAVAILABLE",
  "MODIFIER_UNAVAILABLE",
  "MODIFIER_NOT_ALLOWED",
  "MODIFIER_GROUP_MIN",
  "MODIFIER_GROUP_MAX",
  "INVALID_QUANTITY",
  "BELOW_MINIMUM",
  "ZONE_REQUIRED",
  "ZONE_UNAVAILABLE",
  "EMPTY_CART",
] as const;
const EXTRA_CODES = ["TOO_MANY_ITEMS", "NOTES_TOO_LONG"] as const;
const HEADLESS_CODES = ["VARIANT_REQUIRED", "VARIANT_NOT_ALLOWED", "VARIANT_UNAVAILABLE", "TOO_MANY_MODIFIERS", "TOO_MANY_ERRORS"] as const;
const ALL_CODES = [...CONTRACT_CODES, ...EXTRA_CODES, ...HEADLESS_CODES];

describe("messages — códigos de validate_cart", () => {
  it("os 20 códigos (13 do contrato + 2 da 0112 + 5 da 0113) têm mensagem PT-BR própria (diferente da genérica) e sem vazar texto técnico", () => {
    expect(Object.keys(CART_ERROR_MESSAGES).sort()).toEqual([...ALL_CODES].sort());
    expect(ALL_CODES).toHaveLength(20);
    for (const code of ALL_CODES) {
      const msg = cartErrorMessage(code);
      expect(msg, code).not.toBe(GENERIC_CART_ERROR);
      expect(msg.length, code).toBeGreaterThan(10);
      expect(msg, code).toMatch(/[a-záéíóúãõç]/i);
      expect(msg, code).not.toMatch(/_|sql|rpc|exception|error|undefined|null/i);
      expect(msg.trim()).toBe(msg);
    }
  });

  it("as mensagens são todas distintas", () => {
    const all = ALL_CODES.map((c) => cartErrorMessage(c));
    expect(new Set(all).size).toBe(all.length);
  });

  it("[F-23] TOO_MANY_ITEMS e NOTES_TOO_LONG têm mensagem própria (antes caíam na genérica)", () => {
    for (const code of EXTRA_CODES) expect(cartErrorMessage(code), code).not.toBe(GENERIC_CART_ERROR);
  });

  it("código desconhecido, vazio ou hostil NUNCA exibe texto cru: sempre a mensagem genérica", () => {
    for (const code of ["", "FOO", "restaurant_closed", " RESTAURANT_CLOSED", "'; drop table x;--", "<script>alert(1)</script>", "x".repeat(10000)]) {
      expect(cartErrorMessage(code), code.slice(0, 30)).toBe(GENERIC_CART_ERROR);
    }
  });

  // F-19 (corrigido com Object.hasOwn): nomes herdados de Object.prototype ("constructor", "toString", "__proto__"...) existiam
  // no objeto e eram devolvidos (uma função!) em vez da mensagem genérica.
  it("[F-19] códigos herdados do protótipo ('constructor', 'toString', '__proto__') devem cair na mensagem genérica", () => {
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(typeof cartErrorMessage(code), code).toBe("string");
      expect(cartErrorMessage(code), code).toBe(GENERIC_CART_ERROR);
    }
  });
});

describe("masks — telefone", () => {
  it("onlyDigits remove tudo que não é 0-9 (inclusive dígitos de outros alfabetos)", () => {
    expect(onlyDigits("(11) 91234-5678")).toBe("11912345678");
    expect(onlyDigits("a1b2c3")).toBe("123");
    expect(onlyDigits("١٢٣")).toBe("");
    expect(onlyDigits("")).toBe("");
  });

  it("maskPhone aplica a máscara progressivamente enquanto digita", () => {
    const steps: [string, string][] = [
      ["", ""],
      ["1", "(1"],
      ["11", "(11"],
      ["119", "(11) 9"],
      ["11912", "(11) 912"],
      ["119123", "(11) 9123"],
      ["1191234", "(11) 9123-4"],
      ["11912345", "(11) 9123-45"],
      ["1112345678", "(11) 1234-5678"],
      ["11912345678", "(11) 91234-5678"],
    ];
    for (const [typed, shown] of steps) expect(maskPhone(typed), typed).toBe(shown);
  });

  it("maskPhone é idempotente, ignora letras/símbolos e trunca em 11 dígitos", () => {
    for (const v of ["11912345678", "1112345678", "119", "(11) 9", "abc(11)9x1234y5678z"]) expect(maskPhone(maskPhone(v))).toBe(maskPhone(v));
    expect(maskPhone("abc")).toBe("");
    expect(maskPhone("+55 (11) 91234-5678")).toBe("(55) 11912-3456"); // +55 vira DDD: o campo é só nacional
    expect(maskPhone("119123456789999")).toBe("(11) 91234-5678");
    expect(maskPhone("💩11912345678")).toBe("(11) 91234-5678");
  });

  it("isValidBrPhone: celular (9 dígitos começando em 9) e fixo (8 dígitos começando em 2-5), DDD 11–99", () => {
    for (const ok of ["11912345678", "(11) 91234-5678", "1123456789", "(11) 2345-6789", "99987654321", "2133334444", "11 5555-5555"]) expect(isValidBrPhone(ok), ok).toBe(true);
    for (const bad of [
      "",
      "123",
      "1191234567", // 10 dígitos começando em 9 (nem fixo nem celular)
      "11812345678", // 11 dígitos sem 9
      "10912345678", // DDD 10
      "00912345678", // DDD 00
      "09912345678",
      "1161234567", // fixo começando em 6
      "1111234567", // fixo começando em 1
      "119123456789", // 12 dígitos
      "919123456", // 9 dígitos
      "abcdefghijk",
      "٠١٢٣٤٥٦٧٨٩٠١",
    ]) {
      expect(isValidBrPhone(bad), bad).toBe(false);
    }
  });
});

describe("masks — CEP", () => {
  it("maskCep progressivo, idempotente e truncado em 8 dígitos", () => {
    const steps: [string, string][] = [
      ["", ""],
      ["0", "0"],
      ["01310", "01310"],
      ["013101", "01310-1"],
      ["01310100", "01310-100"],
      ["013101009999", "01310-100"],
      ["01310-100", "01310-100"],
      ["abc", ""],
    ];
    for (const [typed, shown] of steps) expect(maskCep(typed), typed).toBe(shown);
    expect(maskCep(maskCep("01310100"))).toBe("01310-100");
  });

  it("isValidCep exige exatamente 8 dígitos (com ou sem hífen)", () => {
    expect(isValidCep("01310-100")).toBe(true);
    expect(isValidCep("01310100")).toBe(true);
    for (const bad of ["", "0131010", "013101000", "01310-10", "abcdefgh", "0131010x"]) expect(isValidCep(bad), bad).toBe(false);
  });
});

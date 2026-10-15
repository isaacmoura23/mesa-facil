/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_SELECTIONS,
  MAX_PRICE_CENTS,
  categorySchema,
  entityIdSchema,
  fieldErrorsOf,
  formToRecord,
  groupIdsSchema,
  imagePathSchema,
  modifierGroupSchema,
  modifierSchema,
  productSchema,
  reorderSchema,
} from "../../src/modules/menu/schemas";

const ID = "00000000-0000-4000-8000-0000000000a1";
const ID2 = "11111111-1111-4111-8111-111111111111";

describe("categorySchema", () => {
  it("nome obrigatório (trim), até 120; descrição opcional até 500; '' vira null/undefined", () => {
    const ok = categorySchema.parse({ id: "", name: "  Lanches  ", description: "  " });
    expect(ok).toEqual({ id: undefined, name: "Lanches", description: null });
    expect(categorySchema.parse({ id: ID, name: "x".repeat(120), description: "d".repeat(500) }).id).toBe(ID);
    for (const name of ["", "   ", "x".repeat(121)]) expect(categorySchema.safeParse({ id: "", name, description: "" }).success, JSON.stringify(name)).toBe(false);
    expect(categorySchema.safeParse({ id: "", name: "x", description: "d".repeat(501) }).success).toBe(false);
  });

  it("id só aceita uuid (ou vazio)", () => {
    for (const id of ["abc", "1", "' or 1=1 --", `${ID}x`]) expect(categorySchema.safeParse({ id, name: "x", description: "" }).success, id).toBe(false);
  });

  it("nunca aceita restaurant_id vindo do formulário (campo extra é descartado)", () => {
    const r = categorySchema.parse({ id: "", name: "x", description: "", restaurant_id: ID2 } as any);
    expect(JSON.stringify(r)).not.toContain("restaurant_id");
  });
});

describe("productSchema", () => {
  const base = { id: "", name: "X-Burger", description: "", price: "25,90", categoryId: "", isActive: "true", isAvailable: "true" };

  it("converte o formulário em centavos, categoria nula, booleanos", () => {
    expect(productSchema.parse(base)).toEqual({ id: undefined, name: "X-Burger", description: null, price: 2590, categoryId: null, isActive: true, isAvailable: true, badges: [], variants: [] });
    expect(productSchema.parse({ ...base, categoryId: ID, isActive: "false", isAvailable: "false" })).toMatchObject({ categoryId: ID, isActive: false, isAvailable: false });
  });

  it("preço: obrigatório, formatos BR, teto de R$ 99.999,99, sem lixo", () => {
    for (const [price, cents] of [["25,90", 2590], ["R$ 1.234,56", 123456], ["0", 0], ["99999,99", MAX_PRICE_CENTS], ["12.5", 1250]] as const) {
      expect((productSchema.parse({ ...base, price }) as any).price, price).toBe(cents);
    }
    for (const price of ["", "   ", "abc", "100000", "100.000,00", "99999,991", "9".repeat(30)]) {
      expect(productSchema.safeParse({ ...base, price }).success, price).toBe(false);
    }
    expect(MAX_PRICE_CENTS).toBe(9_999_999);
    expect(MAX_PRICE_CENTS).toBeLessThan(2 ** 31); // cabe no integer do banco
  });

  it("nome (1..160), descrição (até 1000) e booleanos estritos", () => {
    for (const name of ["", "  ", "x".repeat(161)]) expect(productSchema.safeParse({ ...base, name }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, name: "x".repeat(160) }).success).toBe(true);
    expect(productSchema.safeParse({ ...base, description: "d".repeat(1001) }).success).toBe(false);
    for (const v of ["on", "1", "TRUE", "", "yes", undefined]) {
      expect(productSchema.safeParse({ ...base, isActive: v }).success, String(v)).toBe(false);
      expect(productSchema.safeParse({ ...base, isAvailable: v }).success, String(v)).toBe(false);
    }
    expect(productSchema.safeParse({ ...base, categoryId: "nao-uuid" }).success).toBe(false);
  });

  it("[F-18] preço negativo ou malformado é rejeitado (parseToCents estrito)", () => {
    for (const price of ["-10", "-0,01", "1.2.3", "12,50,30", "1e5", ",", "."]) {
      const r = productSchema.safeParse({ ...base, price });
      expect(r.success, price).toBe(false);
      if (!r.success) expect(fieldErrorsOf(r.error).price, price).toBe("Preço inválido. Use o formato 25,90.");
    }
  });

  describe("Etapa 2.5: tamanhos (variants) e selos (badges)", () => {
    const v = (over: Record<string, unknown> = {}) => ({ id: "", name: "P", price: "10,00", isDefault: true, isAvailable: true, ...over });
    const withVariants = (list: unknown[], extra: Record<string, unknown> = {}) => productSchema.safeParse({ ...base, price: "", variants: JSON.stringify(list), ...extra });

    it("com tamanhos o preço do produto não é digitado (price = null) e cada tamanho vira centavos", () => {
      const r = withVariants([v(), v({ name: "G", price: "R$ 20,50", isDefault: false })]);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.price).toBeNull();
        expect(r.data.variants.map((x) => [x.name, x.price, x.isDefault])).toEqual([["P", 1000, true], ["G", 2050, false]]);
      }
    });

    it("exatamente um tamanho padrão; nomes únicos (sem diferenciar caixa); preço válido; nome obrigatório", () => {
      expect(withVariants([v({ isDefault: false })]).success).toBe(false);
      expect(withVariants([v(), v({ name: "G" })]).success).toBe(false); // dois padrão
      const dup = withVariants([v(), v({ name: "p", isDefault: false })]);
      expect(dup.success).toBe(false);
      if (!dup.success) expect(fieldErrorsOf(dup.error)["variants.1.name"]).toBe("Já existe um tamanho com esse nome neste produto.");
      const badPrice = withVariants([v({ price: "-5" })]);
      expect(badPrice.success).toBe(false);
      if (!badPrice.success) expect(fieldErrorsOf(badPrice.error)["variants.0.price"]).toBeTruthy();
      expect(withVariants([v({ name: "  " })]).success).toBe(false);
      expect(withVariants([v({ name: "x".repeat(41) })]).success).toBe(false);
    });

    it("JSON inválido ou lista gigante => erro; sem tamanhos e sem preço => erro de preço", () => {
      expect(productSchema.safeParse({ ...base, variants: "{nao-json" }).success).toBe(false);
      expect(withVariants(Array.from({ length: 60 }, (_, i) => v({ name: `t${i}`, isDefault: i === 0 }))).success).toBe(false);
      const r = productSchema.safeParse({ ...base, price: "", variants: "[]" });
      expect(r.success).toBe(false);
    });

    it("selos: só os 6 conhecidos, sem repetição, máximo 4; vazio => []", () => {
      const ok = productSchema.parse({ ...base, badges: "NEW, SPICY,NEW" });
      expect(ok.badges).toEqual(["NEW", "SPICY"]);
      expect(productSchema.parse({ ...base, badges: "" }).badges).toEqual([]);
      for (const badges of ["FOO", "new", "NEW,POPULAR,SWEET,SPICY,VEGETARIAN", "NEW;SPICY"]) {
        expect(productSchema.safeParse({ ...base, badges }).success, badges).toBe(false);
      }
    });
  });
});

describe("modifierGroupSchema", () => {
  const base = { id: "", name: "Adicionais", min: "0", max: "3" };
  it("converte min/max em números; mínimo ≤ máximo; máximo ≥ 1; tetos", () => {
    expect(modifierGroupSchema.parse(base)).toMatchObject({ name: "Adicionais", min: 0, max: 3 });
    expect(modifierGroupSchema.parse({ ...base, min: "2", max: "2" })).toMatchObject({ min: 2, max: 2 });
    expect(modifierGroupSchema.parse({ ...base, min: "0", max: String(MAX_GROUP_SELECTIONS) }).max).toBe(MAX_GROUP_SELECTIONS);
    for (const [min, max] of [["3", "2"], ["0", "0"], ["0", "51"], ["51", "51"], ["-1", "3"], ["a", "3"], ["", "3"], ["1.5", "3"], ["0", ""], ["0", "3 "], ["1e1", "20"]] as const) {
      const r = modifierGroupSchema.safeParse({ ...base, min, max });
      // "0","3 " é aceito porque o campo é aparado antes (trim)
      if (min === "0" && max === "3 ") expect(r.success).toBe(true);
      else expect(r.success, `${min}/${max}`).toBe(false);
    }
    const r = modifierGroupSchema.safeParse({ ...base, min: "5", max: "2" });
    if (!r.success) expect(fieldErrorsOf(r.error)).toHaveProperty("min");
  });
  it("nome obrigatório até 120", () => {
    for (const name of ["", " ", "x".repeat(121)]) expect(modifierGroupSchema.safeParse({ ...base, name }).success).toBe(false);
  });
  it("o teto de 50 do app é menor ou igual ao que o contrato do servidor tolera por linha (c_max_mods)", () => {
    expect(MAX_GROUP_SELECTIONS).toBeLessThanOrEqual(50);
  });
});

describe("modifierSchema", () => {
  const base = { id: "", groupId: ID, name: "Bacon", price: "", isAvailable: "true" };
  it("preço opcional vira 0; formatos BR; teto", () => {
    expect(modifierSchema.parse(base)).toMatchObject({ price: 0, groupId: ID, isAvailable: true });
    expect(modifierSchema.parse({ ...base, price: "5,00" }).price).toBe(500);
    expect(modifierSchema.safeParse({ ...base, price: "100000" }).success).toBe(false);
    expect(modifierSchema.safeParse({ ...base, price: "abc" }).success).toBe(false);
  });
  it("grupo obrigatório e uuid; nome obrigatório", () => {
    for (const groupId of ["", "x", undefined]) expect(modifierSchema.safeParse({ ...base, groupId }).success).toBe(false);
    expect(modifierSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(modifierSchema.safeParse({ ...base, isAvailable: "maybe" }).success).toBe(false);
  });
});

describe("reorderSchema / groupIdsSchema / entityIdSchema / imagePathSchema", () => {
  it("reorder: espécie do enum, 1..500 ids únicos e válidos (≤ 1000 do servidor)", () => {
    for (const kind of ["category", "product", "modifier_group", "modifier"]) expect(reorderSchema.safeParse({ kind, ids: [ID] }).success, kind).toBe(true);
    for (const kind of ["", "foo", "categories", "Category", null, undefined]) expect(reorderSchema.safeParse({ kind, ids: [ID] }).success, String(kind)).toBe(false);
    expect(reorderSchema.safeParse({ kind: "product", ids: [] }).success).toBe(false);
    expect(reorderSchema.safeParse({ kind: "product", ids: [ID, ID] }).success).toBe(false);
    expect(reorderSchema.safeParse({ kind: "product", ids: [ID, "x"] }).success).toBe(false);
    const many = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(reorderSchema.safeParse({ kind: "product", ids: many }).success).toBe(true);
    expect(reorderSchema.safeParse({ kind: "product", ids: [...many, ID2] }).success).toBe(false);
  });

  it("groupIdsSchema: até 200 uuids", () => {
    expect(groupIdsSchema.safeParse([ID, ID2]).success).toBe(true);
    expect(groupIdsSchema.safeParse(Array.from({ length: 201 }, () => ID)).success).toBe(false);
    expect(groupIdsSchema.safeParse(["x"]).success).toBe(false);
  });

  it("entityIdSchema recusa tudo que não é uuid", () => {
    expect(entityIdSchema.safeParse(ID).success).toBe(true);
    for (const v of ["", "1", "' OR 1=1", null, 5, `${ID} `]) expect(entityIdSchema.safeParse(v).success, String(v)).toBe(false);
  });

  it("imagePathSchema: aparado, '' vira null, máximo 500 (a regra fina fica em image.ts)", () => {
    expect(imagePathSchema.parse("  ")).toBeNull();
    expect(imagePathSchema.parse(" restaurants/x/products/a.png ")).toBe("restaurants/x/products/a.png");
    expect(imagePathSchema.safeParse("x".repeat(501)).success).toBe(false);
  });
});

describe("formToRecord / fieldErrorsOf", () => {
  it("formToRecord ignora arquivos e mantém só texto", () => {
    const fd = new FormData();
    fd.set("name", "x");
    fd.set("file", new Blob(["abc"], { type: "image/png" }), "a.png");
    expect(formToRecord(fd)).toEqual({ name: "x" });
  });

  it("fieldErrorsOf devolve a primeira mensagem por campo", () => {
    const r = productSchema.safeParse({ id: "", name: "", description: "", price: "", categoryId: "", isActive: "true", isAvailable: "true" });
    expect(r.success).toBe(false);
    if (!r.success) {
      // O preço só é conferido depois que os campos básicos passam (o produto pode ter tamanhos): aqui só o nome falha.
      const errs = fieldErrorsOf(r.error);
      expect(Object.keys(errs).sort()).toEqual(["name"]);
      expect(errs.name).toBe("Informe o nome do produto.");
    }
    const r2 = productSchema.safeParse({ id: "", name: "ok", description: "", price: "", categoryId: "", isActive: "true", isAvailable: "true" });
    expect(r2.success).toBe(false);
    if (!r2.success) expect(Object.keys(fieldErrorsOf(r2.error))).toEqual(["price"]);
  });
});

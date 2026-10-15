import { describe, expect, it } from "vitest";
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_ACCEPT,
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  buildProductImagePath,
  isOwnProductImagePath,
  validateImageFile,
} from "../../src/modules/menu/image";
import { centsToInput, countLabel, moveId } from "../../src/modules/menu/format";
import { parseToCents } from "../../src/lib/format";

const RID = "00000000-0000-4000-8000-0000000000a1";
const RID_B = "00000000-0000-4000-8000-0000000000b1";
const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("validateImageFile", () => {
  it("aceita jpeg/png/webp/avif de 1 byte até exatamente 5 MB", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(validateImageFile({ type, size: 1 }), type).toBeNull();
      expect(validateImageFile({ type, size: MAX_IMAGE_BYTES }), type).toBeNull();
    }
    expect(ALLOWED_IMAGE_TYPES.sort()).toEqual(["image/avif", "image/jpeg", "image/png", "image/webp"]);
    expect(IMAGE_ACCEPT.split(",").sort()).toEqual(ALLOWED_IMAGE_TYPES.sort());
  });

  it("recusa SVG, GIF, HTML, PDF, tipo vazio e variações de caixa/parâmetros", () => {
    for (const type of ["image/svg+xml", "image/gif", "image/bmp", "image/tiff", "text/html", "application/pdf", "application/octet-stream", "", "IMAGE/PNG", "image/png; charset=utf-8", " image/png", "image/jpg", "image/*"]) {
      const msg = validateImageFile({ type, size: 100 });
      expect(msg, JSON.stringify(type)).toMatch(/formato/i);
    }
  });

  it("recusa vazio, negativo, NaN e acima de 5 MB (1 byte a mais)", () => {
    expect(validateImageFile({ type: "image/png", size: 0 })).toMatch(/vazio/i);
    expect(validateImageFile({ type: "image/png", size: -1 })).toMatch(/vazio/i);
    expect(validateImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toMatch(/5 MB/);
    expect(validateImageFile({ type: "image/png", size: Number.MAX_SAFE_INTEGER })).toMatch(/5 MB/);
    expect(validateImageFile({ type: "image/png", size: Infinity })).toMatch(/5 MB/);
    // NaN: nem "vazio" nem "grande" — hoje passa (documentado; File.size real nunca é NaN)
    expect(validateImageFile({ type: "image/png", size: NaN })).toBeNull();
  });

  it("5 MB do app == limite do bucket (5.242.880 bytes)", () => {
    expect(MAX_IMAGE_BYTES).toBe(5_242_880);
  });
});

describe("buildProductImagePath / isOwnProductImagePath", () => {
  it("gera restaurants/{id}/products/{uuid}.{ext} e é aceito pelo próprio validador; nomes únicos", () => {
    const seen = new Set<string>();
    for (const [mime, ext] of Object.entries(IMAGE_EXTENSIONS)) {
      const p = buildProductImagePath(RID, mime);
      expect(p).toMatch(new RegExp(`^restaurants/${RID}/products/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`));
      expect(isOwnProductImagePath(p, RID)).toBe(true);
      expect(isOwnProductImagePath(p, RID_B)).toBe(false);
      seen.add(p);
    }
    expect(seen.size).toBe(4);
    expect(buildProductImagePath(RID, "image/png")).not.toBe(buildProductImagePath(RID, "image/png"));
  });

  it("tipo desconhecido cai em .jpg (a validação de tipo vem antes, em validateImageFile)", () => {
    expect(buildProductImagePath(RID, "image/svg+xml")).toMatch(/\.jpg$/);
    expect(buildProductImagePath(RID, "")).toMatch(/\.jpg$/);
  });

  it("isOwnProductImagePath recusa outro restaurante, traversal, subpastas, extensões fora da lista e formatos soltos", () => {
    const own = `restaurants/${RID}/products/${UUID}`;
    expect(isOwnProductImagePath(`${own}.png`, RID)).toBe(true);
    expect(isOwnProductImagePath(`${own}.JPG`, RID)).toBe(true); // extensão sem diferença de caixa
    const bad = [
      `restaurants/${RID_B}/products/${UUID}.png`,
      `restaurants/${RID}/logo/${UUID}.png`,
      `restaurants/${RID}/products/../products/${UUID}.png`,
      `restaurants/${RID}/products/../../${RID_B}/products/${UUID}.png`,
      `restaurants/${RID}/products/sub/${UUID}.png`,
      `restaurants/${RID}/products/${UUID}.svg`,
      `restaurants/${RID}/products/${UUID}.gif`,
      `restaurants/${RID}/products/${UUID}.png.exe`,
      `restaurants/${RID}/products/${UUID}`,
      `restaurants/${RID}/products/${UUID}.png/`,
      `restaurants/${RID}/products/${UUID}.png\n`,
      `restaurants/${RID}/products/${UUID}.png?x=1`,
      `restaurants/${RID}/products/not-a-uuid.png`,
      `restaurants/${RID}/products/${UUID.slice(1)}.png`,
      `/restaurants/${RID}/products/${UUID}.png`,
      ` restaurants/${RID}/products/${UUID}.png`,
      `restaurant-public/restaurants/${RID}/products/${UUID}.png`,
      `http://x/restaurants/${RID}/products/${UUID}.png`,
      "",
      "..",
    ];
    for (const p of bad) expect(isOwnProductImagePath(p, RID), JSON.stringify(p)).toBe(false);
  });

  // F-20: a flag /i vale para o padrão INTEIRO (prefixo, uuid do restaurante), mas o CHECK do banco é case-sensitive.
  // O app aceita 'RESTAURANTS/...' e o uuid do restaurante em maiúsculas; o banco recusa depois (erro tardio, sem risco de segurança).
  it.fails("[F-20] prefixo/uuid em maiúsculas devem ser recusados como o CHECK do banco faz (a flag /i é ampla demais)", () => {
    expect(isOwnProductImagePath(`RESTAURANTS/${RID}/products/${UUID}.png`, RID)).toBe(false);
    expect(isOwnProductImagePath(`restaurants/${RID.toUpperCase()}/products/${UUID}.png`, RID)).toBe(false);
  });

  // F-20: o restaurantId é interpolado no RegExp sem escapar. Hoje vem do guard (uuid), então é latente; com um id
  // não-uuid (".*", "a|b") qualquer restaurante passa. Correção: validar o formato do id ou escapar.
  it.fails("[F-20] restaurantId com metacaracteres de regex não deve casar caminhos de outros restaurantes", () => {
    expect(isOwnProductImagePath(`restaurants/${RID_B}/products/${UUID}.png`, ".*")).toBe(false);
  });
});

describe("modules/menu/format", () => {
  it("centsToInput: centavos -> texto de campo de preço, e parse(centsToInput(c)) === c", () => {
    expect(centsToInput(0)).toBe("0,00");
    expect(centsToInput(5)).toBe("0,05");
    expect(centsToInput(99)).toBe("0,99");
    expect(centsToInput(2590)).toBe("25,90");
    expect(centsToInput(9_999_999)).toBe("99999,99");
    for (const c of [0, 1, 7, 10, 99, 100, 101, 1999, 2590, 123456, 9_999_999]) expect(parseToCents(centsToInput(c)), String(c)).toBe(c);
  });

  it("countLabel: singular só para 1 (zero é plural)", () => {
    expect(countLabel(0, "produto", "produtos")).toBe("0 produtos");
    expect(countLabel(1, "produto", "produtos")).toBe("1 produto");
    expect(countLabel(2, "produto", "produtos")).toBe("2 produtos");
  });

  it("moveId: sobe/desce uma posição, respeita as bordas, não muta e devolve cópia", () => {
    const ids = ["a", "b", "c"];
    expect(moveId(ids, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveId(ids, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveId(ids, 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveId(ids, 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveId(ids, -1, 1)).toEqual(["a", "b", "c"]);
    expect(moveId(ids, 7, -1)).toEqual(["a", "b", "c"]);
    expect(moveId([], 0, 1)).toEqual([]);
    expect(moveId(["x"], 0, 1)).toEqual(["x"]);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(moveId(ids, 0, -1)).not.toBe(ids);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Fluxo REAL de imagem de produto (o mesmo do painel do cardápio):
 *   1. gerente faz upload em restaurants/{A}/products/{uuid}.png (cliente autenticado, Storage);
 *   2. grava products.image_path com o MESMO caminho (PostgREST + RLS + CHECK);
 *   3. a URL pública abre sem autenticação com o conteúdo certo e o public_menu a devolve;
 *   4. caminhos de outro tenant / com ".." são rejeitados pela constraint; papéis sem permissão não escrevem;
 *   5. SVG e > 5 MB são rejeitados pelo bucket; a remoção do objeto funciona.
 * Complementa 11-storage (permissões do bucket) com o vínculo objeto <-> products.image_path.
 */
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { buildProductImagePath, isOwnProductImagePath, MAX_IMAGE_BYTES } from "../../src/modules/menu/image";
import { publicImageUrl, PUBLIC_BUCKET } from "../../src/lib/storage";
import { admin, anon, as, world } from "../helpers/clients";
import { expectNotApplied, rows } from "../helpers/expect";
import { Cleanup, uniq } from "../helpers/factory";
import { insertRow, clearTodayException, setOpenToday } from "../helpers/menu";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const BUCKET = PUBLIC_BUCKET;

// ---------- PNG gerado em memória (1x1 RGBA, cor configurável) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function makePng(rgba: [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // largura
  ihdr.writeUInt32BE(1, 4); // altura
  ihdr[8] = 8; // profundidade
  ihdr[9] = 6; // RGBA
  const raw = Buffer.from([0, ...rgba]); // filtro 0 + 1 pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const cleanup = new Cleanup();
const objects: string[] = [];
const track = (p: string) => {
  objects.push(p);
  return p;
};
let product: any; // produto efêmero de A
let productB: any; // produto efêmero de B

const upload = (who: Parameters<typeof as>[0] | "anon", name: string, body: Buffer, type = "image/png", upsert = false) =>
  (who === "anon" ? anon() : as(who)).storage.from(BUCKET).upload(name, body, { contentType: type, upsert });
const objectExists = async (name: string) => {
  const dir = name.split("/").slice(0, -1).join("/");
  const file = name.split("/").pop()!;
  const { data } = await admin().storage.from(BUCKET).list(dir, { search: file });
  return (data ?? []).some((o) => o.name === file);
};
const imagePathOf = async (id: string) => rows(await admin().from("products").select("image_path").eq("id", id))[0]?.image_path as string | null;
const setPath = (who: Parameters<typeof as>[0], id: string, image_path: string | null) =>
  as(who).from("products").update({ image_path }).eq("id", id).select("id,image_path");

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", loadEnv().url);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", loadEnv().anonKey);
  await setOpenToday(A().id, true);
  product = await insertRow("products", { restaurant_id: A().id, name: `zz-img-${uniq()}`, price_cents: 1500 });
  productB = await insertRow("products", { restaurant_id: B().id, name: `zz-img-b-${uniq()}`, price_cents: 1500 });
  cleanup.add(async () => void (await admin().from("products").delete().in("id", [product.id, productB.id])));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (objects.length) await admin().storage.from(BUCKET).remove(objects);
  await cleanup.run();
  await clearTodayException(A().id);
});

describe("fluxo feliz: upload -> image_path -> URL pública -> cardápio público", () => {
  const png = makePng([200, 30, 30, 255]);
  let path: string;

  it("PNG gerado em memória é um PNG válido de 1x1", () => {
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(40);
    expect(png.length).toBeLessThan(200);
  });

  it("gerente de A envia a imagem no caminho gerado pelo próprio app (restaurants/{A}/products/{uuid}.png)", async () => {
    path = track(buildProductImagePath(A().id, "image/png"));
    expect(path).toMatch(new RegExp(`^restaurants/${A().id}/products/[0-9a-f-]{36}\\.png$`));
    expect(isOwnProductImagePath(path, A().id)).toBe(true);
    const up = await upload("managerA", path, png);
    expect(up.error, up.error?.message).toBeNull();
    expect(up.data?.path).toBe(path);
    expect(await objectExists(path)).toBe(true);
  });

  it("grava products.image_path com o mesmo caminho (gerente, RLS menu.manage)", async () => {
    const res = await setPath("managerA", product.id, path);
    expect(res.error, res.error?.message).toBeNull();
    expect(rows(res)).toHaveLength(1);
    expect(await imagePathOf(product.id)).toBe(path);
  });

  it("a URL pública responde 200 SEM autenticação, com tipo e bytes corretos; app e supabase-js geram a mesma URL", async () => {
    const viaSdk = anon().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    expect(publicImageUrl(path)).toBe(viaSdk);
    const res = await fetch(viaSdk); // nenhum header de autenticação
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/png/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(png)).toBe(true);
    // o objeto salvo não foi reencodado/alterado
    const dl = await admin().storage.from(BUCKET).download(path);
    expect(Buffer.from(await dl.data!.arrayBuffer()).equals(png)).toBe(true);
  });

  it("o cardápio público (anon) devolve o image_path e a URL abre", async () => {
    const m = await anon().rpc("public_menu", { p_slug: "demo-a" });
    expect(m.error).toBeNull();
    const p = (m.data as any).categories.flatMap((c: any) => c.products).find((x: any) => x.id === product.id);
    expect(p?.image_path).toBe(path);
    const res = await fetch(publicImageUrl(p.image_path)!);
    expect(res.status).toBe(200);
  });

  it("o dono também lê/atualiza (menu.manage) e pode trocar a imagem (novo objeto) e limpar o campo", async () => {
    const path2 = track(buildProductImagePath(A().id, "image/png"));
    const png2 = makePng([10, 200, 10, 255]);
    expect((await upload("ownerA", path2, png2)).error).toBeNull();
    expect((await setPath("ownerA", product.id, path2)).error).toBeNull();
    expect(await imagePathOf(product.id)).toBe(path2);
    const r2 = await fetch(publicImageUrl(path2)!);
    expect(Buffer.from(await r2.arrayBuffer()).equals(png2)).toBe(true);
    expect((await setPath("managerA", product.id, null)).error).toBeNull();
    expect(await imagePathOf(product.id)).toBeNull();
    // imagem antiga continua servida até alguém remover o objeto (o painel remove depois de gravar o campo)
    expect((await fetch(publicImageUrl(path)!)).status).toBe(200);
  });
});

describe("image_path inválido é rejeitado pela constraint (nunca vira URL de outro tenant)", () => {
  const png = makePng([0, 0, 255, 255]);
  const bad = (): [string, string][] => [
    ["path do restaurante B", `restaurants/${B().id}/products/${crypto.randomUUID()}.png`],
    ["B com traversal a partir de A", `restaurants/${A().id}/products/../../${B().id}/products/x.png`],
    ["só '..'", ".."],
    ["'../' no começo", "../restaurants/x.png"],
    ["'..' no fim", `restaurants/${A().id}/products/..`],
    ["'..' no meio do nome", `restaurants/${A().id}/products/a..b.png`],
    ["barra inicial", `/restaurants/${A().id}/products/x.png`],
    ["pasta de logo em vez de products", `restaurants/${A().id}/logo/${crypto.randomUUID()}.png`],
    ["sem o prefixo restaurants/", `${A().id}/products/x.png`],
    ["prefixo de bucket", `restaurant-public/restaurants/${A().id}/products/x.png`],
    ["URL absoluta", `http://evil.example/restaurants/${A().id}/products/x.png`],
    ["URL do próprio storage de B", `${loadEnv().url}/storage/v1/object/public/${BUCKET}/restaurants/${B().id}/products/x.png`],
    ["uuid de A em maiúsculas", `restaurants/${A().id.toUpperCase()}/products/x.png`],
    ["B logo", `restaurants/${B().id}/logo/x.png`],
    ["muito longo (> 500)", `restaurants/${A().id}/products/${"a".repeat(480)}.png`],
    ["vazio de verdade (espaços)", "   "],
  ];

  it("gerente de A não consegue apontar image_path para B, '..', URL absoluta, logo/ ou texto livre", async () => {
    for (const [name, p] of bad()) {
      const res = await setPath("managerA", product.id, p);
      expect(res.error, `aceitou image_path inválido (${name}): ${p.slice(0, 80)}`).not.toBeNull();
      expect(await imagePathOf(product.id), name).toBeNull();
    }
  });

  it("nem na criação (INSERT) de produto", async () => {
    for (const [name, p] of bad().slice(0, 8)) {
      const res = await as("managerA").from("products").insert({ restaurant_id: A().id, name: `zz-img-ins-${uniq()}`, price_cents: 100, image_path: p }).select("id");
      expect(res.error, `INSERT aceitou (${name})`).not.toBeNull();
    }
    expect(rows(await admin().from("products").select("id").eq("restaurant_id", A().id).like("name", "zz-img-ins-%"))).toHaveLength(0);
  });

  it("o caminho exato do app (uuid.ext) é aceito pelo banco para todas as extensões; validador do app é mais estrito que o banco", async () => {
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["image/avif", "avif"],
    ] as const) {
      const p = buildProductImagePath(A().id, type);
      expect(p.endsWith(`.${ext}`)).toBe(true);
      expect(isOwnProductImagePath(p, A().id)).toBe(true);
      expect(isOwnProductImagePath(p, B().id)).toBe(false);
      const res = await setPath("managerA", product.id, p);
      expect(res.error, `${ext}: ${res.error?.message}`).toBeNull();
    }
    // tudo que o app recusa de "caminho de A" que o banco aceitaria não é problema; o inverso (app aceita, banco recusa) sim:
    for (const p of [`restaurants/${A().id}/products/${crypto.randomUUID()}.PNG`, `restaurants/${A().id}/products/${crypto.randomUUID()}.jpg`]) {
      if (isOwnProductImagePath(p, A().id)) expect((await setPath("managerA", product.id, p)).error, p).toBeNull();
    }
    await setPath("managerA", product.id, null);
  });

  it("o app recusa (isOwnProductImagePath) os mesmos caminhos que o banco recusa", () => {
    for (const [name, p] of bad()) expect(isOwnProductImagePath(p, A().id), name).toBe(false);
  });

  it("gerente de A não altera o image_path de produto de B (RLS), nem o de A para o de B", async () => {
    const mine = track(buildProductImagePath(A().id, "image/png"));
    expect((await upload("managerA", mine, png)).error).toBeNull();
    const res = await setPath("managerA", productB.id, `restaurants/${B().id}/products/${crypto.randomUUID()}.png`);
    expectNotApplied(res);
    expect(await imagePathOf(productB.id)).toBeNull();
    const res2 = await setPath("managerA", productB.id, mine);
    expectNotApplied(res2);
    expect(await imagePathOf(productB.id)).toBeNull();
    // e o inverso
    expectNotApplied(await setPath("managerB", product.id, `restaurants/${A().id}/products/${crypto.randomUUID()}.png`));
    expect(await imagePathOf(product.id)).toBeNull();
  });
});

describe("papéis sem menu.manage", () => {
  const png = makePng([1, 2, 3, 255]);

  for (const who of ["cashierA", "kitchenA", "waiterA", "waiter2A"] as const) {
    it(`${who}: não envia imagem de produto, não grava image_path e não troca o de outro`, async () => {
      const path = track(buildProductImagePath(A().id, "image/png"));
      const up = await upload(who, path, png);
      expect(up.error, `${who} enviou ${path}`).not.toBeNull();
      expect(await objectExists(path)).toBe(false);
      expectNotApplied(await setPath(who, product.id, path));
      expect(await imagePathOf(product.id)).toBeNull();
    });
  }

  it("gerente de A não escreve no Storage de B (upload nem upsert) e a pasta de B continua vazia", async () => {
    const forged = track(buildProductImagePath(B().id, "image/png"));
    expect((await upload("managerA", forged, png)).error).not.toBeNull();
    expect((await upload("managerA", forged, png, "image/png", true)).error).not.toBeNull();
    expect((await upload("ownerA", forged, png)).error).not.toBeNull();
    expect(await objectExists(forged)).toBe(false);
  });

  it("anônimo não envia", async () => {
    const path = track(buildProductImagePath(A().id, "image/png"));
    expect((await upload("anon", path, png)).error).not.toBeNull();
    expect(await objectExists(path)).toBe(false);
  });
});

describe("tipo e tamanho no bucket", () => {
  it("SVG (tipo e conteúdo) é rejeitado — vetor clássico de XSS por imagem", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.domain)"><script>alert(1)</script></svg>');
    for (const [type, ext] of [
      ["image/svg+xml", "svg"],
      ["image/svg", "svg"],
      ["text/xml", "svg"],
      ["text/html", "html"],
    ] as const) {
      const path = track(`restaurants/${A().id}/products/${crypto.randomUUID()}.${ext}`);
      const up = await upload("managerA", path, svg, type);
      expect(up.error, `${type} aceito`).not.toBeNull();
      expect(await objectExists(path)).toBe(false);
    }
  });

  it("arquivo > 5 MB é rejeitado e exatamente no limite do app é aceito; limite do bucket == limite do app", async () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    const bucket = await admin().storage.getBucket(BUCKET);
    expect(bucket.data?.file_size_limit).toBe(MAX_IMAGE_BYTES);
    expect([...(bucket.data?.allowed_mime_types ?? [])].sort()).toEqual(["image/avif", "image/jpeg", "image/png", "image/webp"]);

    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0);
    const bigPath = track(buildProductImagePath(A().id, "image/png"));
    const up = await upload("managerA", bigPath, big);
    expect(up.error).not.toBeNull();
    expect(await objectExists(bigPath)).toBe(false);

    const okPath = track(buildProductImagePath(A().id, "image/png"));
    const ok = await upload("managerA", okPath, Buffer.alloc(MAX_IMAGE_BYTES, 0));
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("o Storage serve sempre com o tipo declarado da imagem (nunca html/svg/javascript), mesmo com bytes estranhos", async () => {
    const path = track(buildProductImagePath(A().id, "image/png"));
    const up = await upload("managerA", path, Buffer.from("<html><script>alert(1)</script></html>"));
    if (up.error) return; // se o bucket passar a validar o conteúdo, ainda melhor (ver F-17)
    const res = await fetch(publicImageUrl(path)!);
    expect(res.headers.get("content-type")).toMatch(/^image\/png/);
    expect(res.headers.get("content-type")).not.toMatch(/html|javascript|svg|xml/i);
  });

  // F-17: o bucket só confere o Content-Type DECLARADO no upload; bytes que não são imagem (HTML, scripts) entram como
  // image/png. Risco baixo (servido como image/png; navegadores não "sniffam" imagem para HTML), mas sem nosniff.
  it.fails("[F-17] conteúdo que não é imagem (HTML declarado como image/png) deveria ser rejeitado no upload", async () => {
    const path = track(buildProductImagePath(A().id, "image/png"));
    const up = await upload("managerA", path, Buffer.from("<html><script>alert(document.cookie)</script></html>"));
    expect(up.error, "HTML foi aceito como image/png").not.toBeNull();
  });
});

describe("remoção", () => {
  const png = makePng([9, 9, 9, 255]);

  it("gerente remove o objeto: a URL pública deixa de abrir; o objeto some do bucket", async () => {
    const path = track(buildProductImagePath(A().id, "image/png"));
    expect((await upload("managerA", path, png)).error).toBeNull();
    expect((await fetch(publicImageUrl(path)!)).status).toBe(200);
    const rm = await as("managerA").storage.from(BUCKET).remove([path]);
    expect(rm.error).toBeNull();
    expect(rm.data).toHaveLength(1);
    expect(await objectExists(path)).toBe(false);
    const gone = await fetch(publicImageUrl(path)!);
    expect([400, 404]).toContain(gone.status);
  });

  it("fluxo de troca: grava o novo image_path, depois remove o antigo; produto passa a apontar para o novo", async () => {
    const oldP = track(buildProductImagePath(A().id, "image/png"));
    const newP = track(buildProductImagePath(A().id, "image/png"));
    expect((await upload("managerA", oldP, png)).error).toBeNull();
    expect((await setPath("managerA", product.id, oldP)).error).toBeNull();
    expect((await upload("managerA", newP, makePng([1, 1, 1, 255]))).error).toBeNull();
    expect((await setPath("managerA", product.id, newP)).error).toBeNull();
    expect((await as("managerA").storage.from(BUCKET).remove([oldP])).error).toBeNull();
    expect(await imagePathOf(product.id)).toBe(newP);
    expect((await fetch(publicImageUrl(newP)!)).status).toBe(200);
    expect(await objectExists(oldP)).toBe(false);
    await setPath("managerA", product.id, null);
  });

  it("cozinha/caixa/garçom não removem; gerente de B não remove o de A; anon não remove", async () => {
    const path = track(buildProductImagePath(A().id, "image/png"));
    expect((await upload("managerA", path, png)).error).toBeNull();
    for (const who of ["cashierA", "kitchenA", "waiterA", "ownerB", "managerB", "plain"] as const) {
      const rm = await as(who).storage.from(BUCKET).remove([path]);
      expect(rm.data ?? [], who).toHaveLength(0);
    }
    const rmAnon = await anon().storage.from(BUCKET).remove([path]);
    expect(rmAnon.data ?? []).toHaveLength(0);
    expect(await objectExists(path)).toBe(true);
    expect((await as("managerA").storage.from(BUCKET).remove([path])).error).toBeNull();
    expect(await objectExists(path)).toBe(false);
  });

  it("limpeza: nenhum objeto de teste fica no bucket", async () => {
    if (objects.length) await admin().storage.from(BUCKET).remove(objects);
    for (const name of objects) expect(await objectExists(name), name).toBe(false);
    objects.length = 0;
  });
});

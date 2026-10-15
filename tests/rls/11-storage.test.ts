/**
 * Storage (bucket público 'restaurant-public'): escrita só no path do próprio restaurante e com a
 * permissão da pasta (products -> menu.manage, logo -> restaurant.settings.manage); leitura pública
 * da URL funciona; o bucket não pode ser listado anonimamente; tipos/tamanho restritos.
 */
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../scripts/lib/env";
import { admin, anon, as, world } from "../helpers/clients";
import { expectOk } from "../helpers/expect";
import { uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const BUCKET = "restaurant-public";

// PNG 1x1 válido
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const created: string[] = [];
const track = (name: string) => {
  created.push(name);
  return name;
};
afterAll(async () => {
  if (created.length) await admin().storage.from(BUCKET).remove(created);
});

const put = (who: Parameters<typeof as>[0] | "anon", name: string, opts: { type?: string; body?: Buffer | Blob; upsert?: boolean } = {}) => {
  const client = who === "anon" ? anon() : as(who);
  return client.storage.from(BUCKET).upload(name, opts.body ?? PNG, { contentType: opts.type ?? "image/png", upsert: opts.upsert ?? false });
};
const productPath = (rid: string) => `restaurants/${rid}/products/zz-${uniq()}.png`;
const logoPath = (rid: string) => `restaurants/${rid}/logo/zz-${uniq()}.png`;
const exists = async (name: string) => {
  const dir = name.split("/").slice(0, -1).join("/");
  const file = name.split("/").pop()!;
  const { data } = await admin().storage.from(BUCKET).list(dir, { search: file });
  return (data ?? []).some((o) => o.name === file);
};

describe("upload válido do próprio restaurante + leitura pública", () => {
  it("owner e manager de A (menu.manage) enviam imagem de produto; a URL pública abre sem login", async () => {
    for (const who of ["ownerA", "managerA"] as const) {
      const name = track(productPath(A().id));
      const up = await put(who, name);
      expect(up.error, up.error?.message).toBeNull();
      expect(await exists(name)).toBe(true);

      const { data } = anon().storage.from(BUCKET).getPublicUrl(name);
      const res = await fetch(data.publicUrl); // sem Authorization
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/image\/png/);
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    }
  });

  it("logo: dono e gerente (restaurant.settings.manage) enviam; a leitura também é pública", async () => {
    for (const who of ["ownerA", "managerA"] as const) {
      const name = track(logoPath(A().id));
      const up = await put(who, name);
      expect(up.error, up.error?.message).toBeNull();
      const res = await fetch(anon().storage.from(BUCKET).getPublicUrl(name).data.publicUrl);
      expect(res.status).toBe(200);
    }
  });

  it("o dono pode substituir (upsert) e apagar seu próprio arquivo", async () => {
    const name = track(productPath(A().id));
    expect((await put("ownerA", name)).error).toBeNull();
    expect((await put("ownerA", name, { upsert: true })).error).toBeNull();
    const rm = await as("ownerA").storage.from(BUCKET).remove([name]);
    expect(rm.error).toBeNull();
    expect(rm.data).toHaveLength(1);
    expect(await exists(name)).toBe(false);
  });
});

describe("papéis sem permissão não gravam imagens", () => {
  for (const who of ["kitchenA", "cashierA", "waiterA"] as const) {
    it(`${who}: upload em products/ e logo/ de A é negado e nada é criado`, async () => {
      for (const name of [productPath(A().id), logoPath(A().id)]) {
        const up = await put(who, name);
        expect(up.error, `${who} gravou ${name}`).not.toBeNull();
        expect(await exists(name)).toBe(false);
      }
    });
  }

  it("nem remover nem substituir o que já existe (cozinha/caixa/garçom)", async () => {
    const name = track(productPath(A().id));
    expect((await put("managerA", name)).error).toBeNull();
    for (const who of ["kitchenA", "cashierA", "waiterA"] as const) {
      const rm = await as(who).storage.from(BUCKET).remove([name]);
      expect(rm.data ?? []).toHaveLength(0);
      const over = await put(who, name, { upsert: true });
      expect(over.error).not.toBeNull();
    }
    expect(await exists(name)).toBe(true);
  });
});

describe("isolamento entre restaurantes no Storage", () => {
  it("usuário de A não envia, substitui, apaga, move nem copia para restaurants/{B}/...", async () => {
    // arquivo legítimo de B, criado pelo service role
    const bName = track(productPath(B().id));
    const seed = await admin().storage.from(BUCKET).upload(bName, PNG, { contentType: "image/png" });
    expect(seed.error).toBeNull();

    for (const who of ["ownerA", "managerA"] as const) {
      // upload novo no path de B
      const forged = productPath(B().id);
      track(forged);
      expect((await put(who, forged)).error).not.toBeNull();
      expect(await exists(forged)).toBe(false);
      const forgedLogo = logoPath(B().id);
      track(forgedLogo);
      expect((await put(who, forgedLogo)).error).not.toBeNull();

      // sobrescrever o arquivo de B
      const over = await put(who, bName, { upsert: true, body: Buffer.concat([PNG, Buffer.from("x")]) });
      expect(over.error).not.toBeNull();

      // apagar o arquivo de B
      const rm = await as(who).storage.from(BUCKET).remove([bName]);
      expect(rm.data ?? []).toHaveLength(0);

      // listar a pasta de B (não há policy de SELECT para ele)
      const ls = await as(who).storage.from(BUCKET).list(`restaurants/${B().id}/products`);
      expect(ls.data ?? []).toHaveLength(0);
    }
    // o arquivo de B segue idêntico
    expect(await exists(bName)).toBe(true);
    const dl = await admin().storage.from(BUCKET).download(bName);
    expect(Buffer.from(await dl.data!.arrayBuffer()).equals(PNG)).toBe(true);

    // mover/copiar entre tenants
    const aName = track(productPath(A().id));
    expect((await put("managerA", aName)).error).toBeNull();
    const moveTo = track(productPath(B().id));
    const mv = await as("managerA").storage.from(BUCKET).move(aName, moveTo);
    expect(mv.error).not.toBeNull();
    const cpTo = track(productPath(B().id));
    const cp = await as("managerA").storage.from(BUCKET).copy(aName, cpTo);
    expect(cp.error).not.toBeNull();
    const cpIn = track(productPath(A().id));
    const cpFromB = await as("managerA").storage.from(BUCKET).copy(bName, cpIn);
    expect(cpFromB.error).not.toBeNull();
    expect(await exists(moveTo)).toBe(false);
    expect(await exists(cpTo)).toBe(false);
    expect(await exists(cpIn)).toBe(false);
    expect(await exists(aName)).toBe(true);
  });

  it("e o inverso: usuário de B não escreve no path de A", async () => {
    const name = track(productPath(A().id));
    expect((await put("ownerB", name)).error).not.toBeNull();
    expect((await put("managerB", name)).error).not.toBeNull();
    expect(await exists(name)).toBe(false);
  });

  it("paths fora do layout obrigatório são negados (prefixo, uuid inválido, pasta desconhecida, raiz)", async () => {
    const bad = [
      `evil/zz-${uniq()}.png`,
      `zz-${uniq()}.png`,
      `restaurants/zz-${uniq()}.png`,
      `restaurants/not-a-uuid/products/zz-${uniq()}.png`,
      `restaurants/${A().id}/zz-${uniq()}.png`,
      `restaurants/${A().id}/other/zz-${uniq()}.png`,
      `restaurants/${A().id.toUpperCase()}/private/zz-${uniq()}.png`,
      `RESTAURANTS/${A().id}/products/zz-${uniq()}.png`,
    ];
    for (const name of bad) {
      track(name);
      const up = await put("managerA", name);
      expect(up.error, `path inesperadamente aceito: ${name}`).not.toBeNull();
      expect(await exists(name)).toBe(false);
    }
  });

  it("tentativa de path traversal para a pasta de B não grava dentro de restaurants/{B}", async () => {
    const tricky = `restaurants/${A().id}/products/../../${B().id}/products/zz-${uniq()}.png`;
    track(tricky);
    const up = await put("managerA", tricky);
    const leaf = tricky.split("/").pop()!;
    const listB = await admin().storage.from(BUCKET).list(`restaurants/${B().id}/products`, { search: leaf });
    expect((listB.data ?? []).filter((o) => o.name === leaf), `traversal gravou em B (upload error: ${up.error?.message})`).toHaveLength(0);
  });

  it("bucket inexistente / outro bucket: sem escrita", async () => {
    const r = await as("ownerA").storage.from("outro-bucket").upload(`restaurants/${A().id}/products/zz-${uniq()}.png`, PNG, { contentType: "image/png" });
    expect(r.error).not.toBeNull();
  });
});

describe("administração de buckets", () => {
  it("nenhum cliente cria/altera/esvazia/apaga buckets (inclui o restaurant-public)", async () => {
    for (const who of ["ownerA", "managerA", "superadmin"] as const) {
      const c = as(who).storage;
      expect((await c.createBucket(`zz-bucket-${uniq()}`, { public: true })).error, `${who} criou bucket`).not.toBeNull();
      expect((await c.updateBucket(BUCKET, { public: false })).error, `${who} alterou o bucket`).not.toBeNull();
      expect((await c.emptyBucket(BUCKET)).error, `${who} esvaziou o bucket`).not.toBeNull();
      expect((await c.deleteBucket(BUCKET)).error, `${who} apagou o bucket`).not.toBeNull();
    }
    const b = await admin().storage.getBucket(BUCKET);
    expect(b.data).toMatchObject({ public: true, file_size_limit: 5242880 });
  });
});

describe("anônimo", () => {
  it("lê a URL pública, mas não envia, apaga, substitui nem lista o bucket", async () => {
    const name = track(productPath(A().id));
    expect((await put("managerA", name)).error).toBeNull();

    expect((await put("anon", productPath(A().id))).error).not.toBeNull();
    expect((await put("anon", name, { upsert: true })).error).not.toBeNull();
    const rm = await anon().storage.from(BUCKET).remove([name]);
    expect(rm.data ?? []).toHaveLength(0);
    const ls = await anon().storage.from(BUCKET).list(`restaurants/${A().id}/products`);
    expect(ls.data ?? []).toHaveLength(0);
    const root = await anon().storage.from(BUCKET).list("restaurants");
    expect(root.data ?? []).toHaveLength(0);
    expect(await exists(name)).toBe(true);

    const pub = await fetch(anon().storage.from(BUCKET).getPublicUrl(name).data.publicUrl);
    expect(pub.status).toBe(200);
  });

  it("objeto inexistente na URL pública => 404; anon não gera URL assinada", async () => {
    const env = loadEnv();
    const missing = await fetch(`${env.url}/storage/v1/object/public/${BUCKET}/restaurants/${A().id}/products/nao-existe-${uniq()}.png`);
    expect([400, 404]).toContain(missing.status);
    const name = track(productPath(A().id));
    expect((await put("managerA", name)).error).toBeNull();
    const sign = await anon().storage.from(BUCKET).createSignedUrl(name, 60);
    expect(sign.error).not.toBeNull();
  });
});

describe("tipo e tamanho", () => {
  it("SVG/HTML/script são rejeitados (apenas jpeg/png/webp/avif)", async () => {
    for (const [type, body] of [
      ["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
      ["text/html", Buffer.from("<script>alert(1)</script>")],
      ["application/javascript", Buffer.from("alert(1)")],
      ["application/octet-stream", Buffer.from("MZ")],
    ] as const) {
      const name = track(`restaurants/${A().id}/products/zz-${uniq()}.${type.split("/")[1].replace("+xml", "")}`);
      const up = await put("managerA", name, { type, body });
      expect(up.error, `tipo ${type} aceito`).not.toBeNull();
      expect(await exists(name)).toBe(false);
    }
  });

  it("arquivo acima de 5 MB é rejeitado", async () => {
    const name = track(productPath(A().id));
    const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 0);
    const up = await put("managerA", name, { body: big });
    expect(up.error).not.toBeNull();
    expect(await exists(name)).toBe(false);
  });

  it("jpeg e webp válidos são aceitos", async () => {
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
    ] as const) {
      const name = track(`restaurants/${A().id}/products/zz-${uniq()}.${ext}`);
      const up = await put("ownerA", name, { type });
      expect(up.error, up.error?.message).toBeNull();
    }
  });
});

describe("suspensão corta a escrita no Storage", () => {
  it("restaurante suspenso: nem o dono nem o gerente enviam imagens; ao reativar, voltam a enviar", async () => {
    try {
      expectOk(await admin().from("restaurants").update({ status: "suspended" }).eq("id", A().id));
      const name = track(productPath(A().id));
      expect((await put("ownerA", name)).error).not.toBeNull();
      expect((await put("managerA", name)).error).not.toBeNull();
      expect(await exists(name)).toBe(false);
    } finally {
      await admin().from("restaurants").update({ status: "active" }).eq("id", A().id);
    }
    const ok = track(productPath(A().id));
    expect((await put("ownerA", ok)).error).toBeNull();
  });
});

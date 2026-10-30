import { describe, expect, it } from "vitest";
import { PERMISSION_LABELS, ROLE_LABELS } from "@/lib/auth/permissions";
import { PERMISSIONS } from "@/lib/auth/types";
import { PAGE_SIZE, SEARCH_MAX, customerDetailSchema, customerListSchema, customersQuery, cursorSchema, decodeCursor, encodeCursor, parseCustomerFilters } from "@/modules/customers/schemas";
import { AUDIT_CATEGORIES, describeAudit, endOfDayIso, formatDate, formatDateTime, prefixForCategory, safeMetadataEntries, startOfDayIso } from "@/modules/team/audit";
import { auditFiltersSchema, fieldErrorsOf, inviteSchema, membershipIdSchema, permissionSchema, roleSchema } from "@/modules/team/schemas";
import { ASSIGNABLE_ROLES } from "@/modules/team/types";
import {
  MAX_INTERVALS_PER_DAY,
  emptyWeek,
  isOvernight,
  localDateIn,
  sameWeek,
  toMinutes,
  trimSeconds,
  validateWeek,
  weekFromRows,
  weekdayOf,
  type WeekHours,
} from "@/modules/restaurant-settings/hours";
import { exceptionSchema, parseNeighborhoods, rulesSchema, weekSchema, zoneSchema } from "@/modules/restaurant-settings/schemas";
import { TIMEZONES, isValidTimezone, timezoneLabel } from "@/modules/restaurant-profile/timezones";
import { buildLogoPath, isOwnLogoPath } from "@/modules/restaurant-profile/logo";
import { establishmentSchema } from "@/modules/restaurant-profile/schemas";

const RID = "7db1eed0-6e5c-46dc-8eaf-a984b87a2b1b";
const UUID = "a971dd7b-6eee-5ded-95d8-129db13f83c8";
const enc = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

describe("customers/schemas: cursor base64url e filtros", () => {
  const c = { t: "2026-04-01T00:00:00.000000Z", id: "00000000-0000-4000-8000-000000000001" };

  it("ida e volta; é base64url (sem +, / ou =)", () => {
    const raw = encodeCursor(c);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(c);
  });

  it("adulterado ou hostil => null (nunca lança)", () => {
    const bad: (string | undefined)[] = [
      undefined,
      "",
      "x".repeat(401),
      "%%%",
      "!!!!",
      enc("não json"),
      enc("[]"),
      enc([]),
      enc([c.t, c.id]),
      enc(null),
      enc(5),
      enc("abc"),
      enc({}),
      enc({ t: c.t }),
      enc({ id: c.id }),
      enc({ ...c, extra: 1 }),
      enc({ t: c.t, id: "nao-e-uuid" }),
      enc({ t: c.t, id: c.id + "0" }),
      enc({ t: 5, id: c.id }),
      enc({ t: null, id: c.id }),
      enc({ t: "", id: c.id }),
      enc({ t: "x".repeat(65), id: c.id }),
      enc({ t: c.t, id: { v: c.id } }),
      enc('{"t":"a","id":"b"'),
    ];
    for (const b of bad) expect(() => decodeCursor(b), String(b).slice(0, 30)).not.toThrow();
    for (const b of bad) expect(decodeCursor(b), String(b).slice(0, 30)).toBeNull();
    // __proto__ não polui nem passa
    expect(decodeCursor(enc('{"__proto__":{"x":1},"t":"a","id":"b"}'))).toBeNull();
    expect(cursorSchema.safeParse({ ...c, t: "x".repeat(64) }).success).toBe(true);
  });

  it("parseCustomerFilters: remove controles, limita a 100, usa o 1º valor, cursor inválido vira null", () => {
    expect(parseCustomerFilters({})).toEqual({ q: "", cursor: null });
    expect(parseCustomerFilters({ q: "  Ana\n\t\u0000Silva  " }).q).toBe("Ana Silva");
    expect(parseCustomerFilters({ q: "a".repeat(500) }).q).toHaveLength(SEARCH_MAX);
    expect(parseCustomerFilters({ q: ["x", "y"] }).q).toBe("x");
    expect(parseCustomerFilters({ q: "%_\\" }).q).toBe("%_\\");
    expect(parseCustomerFilters({ cursor: "lixo" }).cursor).toBeNull();
    expect(parseCustomerFilters({ cursor: encodeCursor(c) }).cursor).toEqual(c);
    expect(PAGE_SIZE).toBe(25);
  });

  it("customersQuery e schemas das RPCs", () => {
    expect(customersQuery("")).toBe("");
    expect(new URLSearchParams(customersQuery("a b", c)).get("q")).toBe("a b");
    expect(decodeCursor(new URLSearchParams(customersQuery("", c)).get("cursor")!)).toEqual(c);
    expect(customerListSchema.parse({ rows: [] }).next_cursor).toBeNull();
    expect(customerListSchema.safeParse({ rows: [], next_cursor: { t: "x" } }).success).toBe(false);
    expect(customerListSchema.safeParse({ rows: [{ id: "1" }] }).success).toBe(false);
    expect(customerDetailSchema.safeParse({}).success).toBe(false);
  });
});

describe("team/schemas", () => {
  it("convite: e-mail normalizado (trim + minúsculas) e validado; ninguém convida como dono", () => {
    expect(inviteSchema.parse({ email: "  Pessoa@Empresa.COM ", role: "waiter" })).toEqual({ email: "pessoa@empresa.com", role: "waiter" });
    for (const email of ["", "a@b", "a b@c.com", "@c.com", "a@@c.com", "a".repeat(250) + "@c.com", "pessoa"]) {
      expect(inviteSchema.safeParse({ email, role: "waiter" }).success, email).toBe(false);
    }
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
    expect(inviteSchema.safeParse({ email: "a@b.co", role: "owner" }).success).toBe(false);
    expect(roleSchema.safeParse("admin").success).toBe(false);
    expect(roleSchema.safeParse("constructor").success).toBe(false);
  });

  it("permissões, ids e filtros de auditoria", () => {
    for (const k of PERMISSIONS) expect(permissionSchema.safeParse(k).success).toBe(true);
    expect(permissionSchema.safeParse("root").success).toBe(false);
    expect(membershipIdSchema.safeParse("x").success).toBe(false);
    expect(membershipIdSchema.safeParse(UUID).success).toBe(true);
    expect(auditFiltersSchema.safeParse({ category: "team", from: "2026-03-01", to: "" }).success).toBe(true);
    for (const from of ["2026-3-1", "ontem", "2026-03-01T00:00:00Z"]) expect(auditFiltersSchema.safeParse({ category: "", from, to: "" }).success).toBe(false);
    expect(auditFiltersSchema.safeParse({ category: "x".repeat(41), from: "", to: "" }).success).toBe(false);
    const r = inviteSchema.safeParse({ email: "x", role: "y" });
    if (r.success) throw new Error("deveria falhar");
    expect(Object.keys(fieldErrorsOf(r.error)).sort()).toEqual(["email", "role"]);
  });
});

describe("team/audit: texto PT-BR por ação e metadados seguros", () => {
  it("descreve ações conhecidas com nomes de função/permissão traduzidos", () => {
    expect(describeAudit("member.invited", { email: "a@b.co", role: "waiter" })).toEqual({ text: `Convidou a@b.co como ${ROLE_LABELS.waiter}`, known: true });
    expect(describeAudit("member.role_changed", { from: "waiter", to: "manager" }).text).toBe(`Alterou a função de ${ROLE_LABELS.waiter} para ${ROLE_LABELS.manager}`);
    expect(describeAudit("member.permission_changed", { permission: "reports.view", granted: true, role: "cashier" }).text).toBe(
      `Concedeu a permissão "${PERMISSION_LABELS["reports.view"]}" (${ROLE_LABELS.cashier})`,
    );
    expect(describeAudit("member.permission_changed", { permission: "reports.view", granted: false, role: "cashier" }).text).toMatch(/^Removeu/);
    expect(describeAudit("customer.viewed", {})).toEqual({ text: "Consultou os dados de um cliente", known: true });
    expect(describeAudit("tab.closed_unpaid", {}).text).toBe("Fechou uma comanda sem pagamento");
    expect(describeAudit("table.qr_rotated", {}).known).toBe(true);
  });

  it("metadados faltando/hostis não quebram: fallbacks seguros", () => {
    expect(describeAudit("member.invited", {}).text).toBe(`Convidou uma pessoa como função desconhecida`);
    expect(describeAudit("member.role_changed", { from: 5, to: {} }).text).toContain("função desconhecida");
    expect(describeAudit("member.permission_changed", { permission: "root", granted: "yes" }).text).toContain("uma permissão");
    expect(describeAudit("member.invited", { email: "x".repeat(500), role: "constructor" }).text.length).toBeLessThan(260);
    expect(describeAudit("member.invited", { email: "   ", role: "waiter" }).text).toContain("uma pessoa");
  });

  it("ação desconhecida ou herdada de Object.prototype => texto genérico, known=false", () => {
    for (const a of ["", "nope.action", "constructor", "toString", "__proto__", "hasOwnProperty", "member.invited ", "MEMBER.INVITED"]) {
      expect(describeAudit(a, {}), a).toEqual({ text: "Atividade registrada no sistema", known: false });
    }
  });

  it("safeMetadataEntries remove chaves sensíveis (inclusive em português), trunca e limita a 12", () => {
    const e = safeMetadataEntries({
      ok: "x",
      password: "p",
      senha: "s",
      qr_token: "t",
      apiKey: "k",
      "x-api-key": "k",
      Authorization: "a",
      cookie: "c",
      jwt: "j",
      cvv: "123",
      otp: "1",
      hash: "h",
      numero: 5,
      flag: true,
      nulo: null,
      obj: { a: 1 },
      longo: "y".repeat(300),
    });
    const keys = e.map((x) => x.key);
    expect(keys).toEqual(["ok", "numero", "flag", "obj", "longo"]);
    expect(e.find((x) => x.key === "obj")!.value).toBe("(dados adicionais)");
    expect(e.find((x) => x.key === "longo")!.value).toHaveLength(120);
    expect(e.find((x) => x.key === "numero")!.value).toBe("5");
    const many = safeMetadataEntries(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])));
    expect(many).toHaveLength(12);
    expect(safeMetadataEntries({ ["a".repeat(100)]: 1 })[0].key).toHaveLength(40);
  });

  it("categorias, prefixos e janelas de data no fuso do painel (-03:00)", () => {
    expect(prefixForCategory("team")).toBe("member.");
    expect(prefixForCategory("")).toBeNull();
    expect(prefixForCategory("constructor")).toBeNull();
    expect(prefixForCategory("nope")).toBeNull();
    expect(AUDIT_CATEGORIES.every((c) => c.prefix === null || c.prefix.length <= 64)).toBe(true);
    expect(startOfDayIso("2026-03-10")).toBe("2026-03-10T00:00:00.000-03:00");
    expect(endOfDayIso("2026-03-10")).toBe("2026-03-10T23:59:59.999-03:00");
    expect(startOfDayIso("")).toBeNull();
    expect(formatDateTime("2026-03-10T02:30:00Z")).toMatch(/09/);
    expect(formatDateTime("lixo")).toBe("");
    expect(formatDate(null)).toBe("");
  });
});

describe("restaurant-settings/hours", () => {
  const day = (...i: [string, string][]) => i.map(([opens, closes]) => ({ opens, closes }));
  const week = (patch: Record<number, [string, string][]>): WeekHours => {
    const w = emptyWeek();
    for (const [d, list] of Object.entries(patch)) w[Number(d)] = day(...list);
    return w;
  };

  it("grade válida, vazia e faixas coladas passam; virada de dia é detectada", () => {
    expect(validateWeek(emptyWeek())).toBeNull();
    expect(validateWeek(week({ 1: [["09:00", "12:00"], ["12:00", "18:00"]] }))).toBeNull();
    expect(validateWeek(week({ 5: [["18:00", "02:00"]], 6: [["09:00", "17:00"]] }))).toBeNull();
    expect(isOvernight({ opens: "18:00", closes: "02:00" })).toBe(true);
    expect(isOvernight({ opens: "09:00", closes: "10:00" })).toBe(false);
  });

  it("sobreposição no mesmo dia, entre dias (transbordo da virada) e sábado -> domingo", () => {
    expect(validateWeek(week({ 1: [["09:00", "12:00"], ["11:59", "13:00"]] }))?.message).toMatch(/se sobrepõem/);
    expect(validateWeek(week({ 1: [["09:00", "12:00"], ["09:00", "12:00"]] }))).not.toBeNull();
    // segunda 22:00–02:00 invade terça 01:00–03:00
    const spill = validateWeek(week({ 1: [["22:00", "02:00"]], 2: [["01:00", "03:00"]] }));
    expect(spill).toMatchObject({ weekday: 2 });
    expect(spill!.message).toMatch(/se sobrepõe ao de/);
    expect(validateWeek(week({ 1: [["22:00", "02:00"]], 2: [["02:00", "03:00"]] }))).toBeNull(); // colado
    // sábado 23:00–03:00 invade domingo 01:00–02:00
    expect(validateWeek(week({ 6: [["23:00", "03:00"]], 0: [["01:00", "02:00"]] }))).not.toBeNull();
    expect(validateWeek(week({ 6: [["23:00", "03:00"]], 0: [["03:00", "04:00"]] }))).toBeNull();
    // virada x virada
    expect(validateWeek(week({ 3: [["20:00", "04:00"], ["21:00", "23:00"]] }))).not.toBeNull();
  });

  it("limites: máx. de intervalos por dia, igual abre/fecha, horário malformado", () => {
    expect(MAX_INTERVALS_PER_DAY).toBe(4);
    const five = week({ 1: [["00:00", "01:00"], ["02:00", "03:00"], ["04:00", "05:00"], ["06:00", "07:00"], ["08:00", "09:00"]] });
    expect(validateWeek(five)?.message).toMatch(/no máximo 4/);
    expect(validateWeek(week({ 1: [["00:00", "01:00"], ["02:00", "03:00"], ["04:00", "05:00"], ["06:00", "07:00"]] }))).toBeNull();
    expect(validateWeek(week({ 1: [["10:00", "10:00"]] }))?.message).toMatch(/não podem ser iguais/);
    for (const bad of [["24:00", "01:00"], ["9:00", "10:00"], ["09:60", "10:00"], ["", "10:00"], ["09:00:00", "10:00"], ["aa:bb", "10:00"]] as [string, string][]) {
      expect(validateWeek(week({ 2: [bad] })), bad.join("-")).not.toBeNull();
    }
  });

  it("conversões: weekFromRows ordena, trimSeconds, sameWeek, weekdayOf, localDateIn", () => {
    const w = weekFromRows([
      { weekday: 1, opens_at: "13:00:00", closes_at: "18:00:00" },
      { weekday: 1, opens_at: "09:00:00", closes_at: "12:00:00" },
      { weekday: 9, opens_at: "09:00:00", closes_at: "12:00:00" },
    ]);
    expect(w[1]).toEqual([{ opens: "09:00", closes: "12:00" }, { opens: "13:00", closes: "18:00" }]);
    expect(w).toHaveLength(7);
    expect(trimSeconds("09:30:00")).toBe("09:30");
    expect(toMinutes("01:30")).toBe(90);
    expect(sameWeek(w, structuredClone(w))).toBe(true);
    expect(sameWeek(w, emptyWeek())).toBe(false);
    expect(weekdayOf("2026-03-10")).toBe(2);
    expect(weekdayOf("2026-03-08")).toBe(0);
    expect(localDateIn("Asia/Tokyo", new Date("2026-03-10T20:00:00Z"))).toBe("2026-03-11");
    expect(localDateIn("Mars/Olympus", new Date("2026-03-10T02:00:00Z"))).toBe("2026-03-09");
  });
});

describe("restaurant-settings/schemas", () => {
  it("weekSchema: exatamente 7 dias, usa validateWeek; ignora dias extras", () => {
    expect(weekSchema.safeParse(emptyWeek()).success).toBe(true);
    expect(weekSchema.safeParse([[], []]).success).toBe(false);
    const w = emptyWeek();
    w[1] = [{ opens: "09:00", closes: "12:00" }, { opens: "11:00", closes: "13:00" }];
    const r = weekSchema.safeParse(w);
    expect(r.success).toBe(false);
    w[1] = [{ opens: "9:00", closes: "12:00" }];
    expect(weekSchema.safeParse(w).success).toBe(false);
  });

  it("exceção: fechado ignora horários; aberto exige horários diferentes; data impossível recusada; descrição vazia vira null", () => {
    expect(exceptionSchema.parse({ onDate: "2026-12-25", isClosed: true, opensAt: "10:00", closesAt: "12:00", description: "  " })).toEqual({
      id: undefined,
      onDate: "2026-12-25",
      isClosed: true,
      opensAt: null,
      closesAt: null,
      description: null,
    });
    expect(exceptionSchema.safeParse({ onDate: "2026-12-25", isClosed: false, opensAt: "10:00", closesAt: "12:00" }).success).toBe(true);
    expect(exceptionSchema.safeParse({ onDate: "2026-12-25", isClosed: false, opensAt: "10:00", closesAt: "10:00" }).success).toBe(false);
    expect(exceptionSchema.safeParse({ onDate: "2026-12-25", isClosed: false }).success).toBe(false);
    for (const onDate of ["2026-02-30", "2026-13-01", "25/12/2026", "", "2026-12-25T00:00"]) expect(exceptionSchema.safeParse({ onDate, isClosed: true }).success, onDate).toBe(false);
    expect(exceptionSchema.safeParse({ onDate: "2026-12-25", isClosed: true, description: "x".repeat(201) }).success).toBe(false);
  });

  it("zona: dinheiro em reais -> centavos com teto de R$ 1.000 na taxa; ETA 1..1440; bairros únicos/limitados", () => {
    const ok = zoneSchema.parse({ name: "  Centro ", fee: "5,50", minOrder: "15", estimatedMinutes: "40", neighborhoods: "Centro\nbela vista; Centro,  Bela   Vista", isActive: true });
    expect(ok).toMatchObject({ name: "Centro", fee: 550, minOrder: 1500, estimatedMinutes: 40, neighborhoods: ["Centro", "bela vista"] });
    expect(zoneSchema.parse({ name: "x", isActive: false })).toMatchObject({ fee: 0, minOrder: 0, estimatedMinutes: null, neighborhoods: [] });
    const bad = (patch: Record<string, unknown>) => zoneSchema.safeParse({ name: "x", isActive: true, ...patch }).success;
    expect(bad({ fee: "1000,00" })).toBe(true);
    expect(bad({ fee: "1000,01" })).toBe(false);
    expect(bad({ minOrder: "100000,00" })).toBe(true);
    expect(bad({ minOrder: "100000,01" })).toBe(false);
    expect(bad({ estimatedMinutes: "1440" })).toBe(true);
    for (const e of ["0", "1441", "-5", "1e3", "abc", "12345"]) expect(bad({ estimatedMinutes: e }), e).toBe(false);
    expect(bad({ fee: "-5" })).toBe(false);
    expect(bad({ fee: "abc" })).toBe(false);
    expect(bad({ name: "   " })).toBe(false);
    expect(zoneSchema.safeParse({ name: "x".repeat(121), isActive: true }).success).toBe(false);
    expect(bad({ neighborhoods: Array.from({ length: 101 }, (_, i) => `B${i}`).join("\n") })).toBe(false);
    expect(bad({ neighborhoods: Array.from({ length: 100 }, (_, i) => `B${i}`).join("\n") })).toBe(true);
    expect(bad({ neighborhoods: "y".repeat(81) })).toBe(false);
    expect(parseNeighborhoods(" ,;\n ")).toEqual([]);
  });

  it("regras: ao menos uma modalidade (ordem canônica), preparo 1..600, mínimo até R$ 100.000", () => {
    const base = { fulfillmentTypes: ["PICKUP", "DELIVERY"], prepMinutes: "30", minOrder: "0", pickupInstructions: "", singleTabPerTable: true };
    const r = rulesSchema.parse(base);
    expect(r.fulfillmentTypes).toEqual(["DELIVERY", "PICKUP"]);
    expect(r.pickupInstructions).toBeNull();
    expect(rulesSchema.safeParse({ ...base, fulfillmentTypes: [] }).success).toBe(false);
    expect(rulesSchema.safeParse({ ...base, fulfillmentTypes: ["DRONE"] }).success).toBe(false);
    for (const prep of ["0", "601", "-1", "1.5", "abc", ""]) expect(rulesSchema.safeParse({ ...base, prepMinutes: prep }).success, prep).toBe(false);
    expect(rulesSchema.safeParse({ ...base, prepMinutes: "600" }).success).toBe(true);
    expect(rulesSchema.safeParse({ ...base, minOrder: "100000,01" }).success).toBe(false);
    expect(rulesSchema.safeParse({ ...base, pickupInstructions: "x".repeat(301) }).success).toBe(false);
    expect(rulesSchema.safeParse({ ...base, pickupInstructions: "x".repeat(300) }).success).toBe(true);
  });
});

describe("restaurant-profile: fusos, logo e schema do estabelecimento", () => {
  it("TIMEZONES: todos reconhecidos pelo Intl, sem repetição; rótulos", () => {
    const values = TIMEZONES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(isValidTimezone(v), v).toBe(true);
    expect(timezoneLabel("America/Sao_Paulo")).toMatch(/Brasília/);
    expect(timezoneLabel("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("isValidTimezone rejeita lixo, vazio e > 64 caracteres", () => {
    for (const bad of ["", "   ", "Mars/Olympus", "x".repeat(65), "'; drop table x; --", "America//Sao_Paulo"]) expect(isValidTimezone(bad), bad).toBe(false);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("F-42: isValidTimezone aceita o que o banco recusa (Intl ignora caixa: 'america/sao_paulo'; o CHECK/trigger usa pg_timezone_names, sensível a caixa)", () => {
    // O app aceita, a action tenta gravar e o banco responde INVALID_TIMEZONE (23514). Correção: comparar com a lista canônica
    // (Intl.supportedValuesOf('timeZone')) ou exigir igualdade com Intl.DateTimeFormat(...).resolvedOptions().timeZone.
    expect(isValidTimezone("america/sao_paulo")).toBe(false);
    expect(isValidTimezone("ASIA/TOKYO")).toBe(false);
  });

  it("buildLogoPath: restaurants/{id}/logo/{uuid}.ext e aceito por isOwnLogoPath", () => {
    const p = buildLogoPath(RID, "image/webp");
    expect(p).toMatch(new RegExp(`^restaurants/${RID}/logo/[0-9a-f-]{36}\\.webp$`));
    expect(isOwnLogoPath(p, RID)).toBe(true);
    expect(buildLogoPath(RID, "image/png").endsWith(".png")).toBe(true);
    expect(buildLogoPath(RID, "text/html").endsWith(".jpg")).toBe(true); // mime desconhecido => jpg (o upload valida o tipo antes)
    expect(buildLogoPath(RID, "image/png")).not.toBe(buildLogoPath(RID, "image/png"));
  });

  it("isOwnLogoPath rejeita traversal, outro restaurante, pasta errada, extensão e URLs", () => {
    const ok = `restaurants/${RID}/logo/${UUID}.png`;
    expect(isOwnLogoPath(ok, RID)).toBe(true);
    const other = "00000000-0000-4000-8000-0000000000b1";
    for (const bad of [
      `restaurants/${other}/logo/${UUID}.png`,
      `restaurants/${RID}/products/${UUID}.png`,
      `restaurants/${RID}/logo/../../x.png`,
      `restaurants/${RID}/logo/${UUID}.svg`,
      `restaurants/${RID}/logo/${UUID}.png/extra`,
      `restaurants/${RID}/logo/${UUID}.png\n`,
      `/restaurants/${RID}/logo/${UUID}.png`,
      `https://evil.test/restaurants/${RID}/logo/${UUID}.png`,
      `restaurants/${RID}/logo/not-a-uuid.png`,
      `restaurants/${RID}//logo/${UUID}.png`,
      `restaurants/${RID}/logo/${UUID}.png?x=1`,
      "",
    ]) {
      expect(isOwnLogoPath(bad, RID), bad).toBe(false);
    }
  });

  it("F-49: isOwnLogoPath usa a flag /i e aceita RESTAURANTS/... e UUID em maiúsculas; o CHECK do banco (restaurants_logo_path_scope) recusa (mesma classe do F-20)", () => {
    expect(isOwnLogoPath(`RESTAURANTS/${RID}/logo/${UUID}.png`, RID)).toBe(false);
    expect(isOwnLogoPath(`restaurants/${RID.toUpperCase()}/logo/${UUID}.png`, RID)).toBe(false);
    expect(isOwnLogoPath(`restaurants/${RID}/logo/${UUID.toUpperCase()}.PNG`, RID)).toBe(false);
  });

  it("F-49b: restaurantId com metacaracteres é interpolado no RegExp sem escapar ('.' casa qualquer caractere)", () => {
    const fake = RID.replace(/-/g, ".");
    expect(isOwnLogoPath(`restaurants/${RID}/logo/${UUID}.png`, fake)).toBe(false);
    expect(isOwnLogoPath(`restaurants/${RID}/logo/${UUID}.png`, ".*")).toBe(false);
  });

  it("establishmentSchema: nome 2..120 normalizado, fuso válido, logoPath <= 300", () => {
    const base = { name: "  La   Pastelaria ", timezone: "America/Sao_Paulo", logoPath: null, removeLogo: false };
    expect(establishmentSchema.parse(base).name).toBe("La Pastelaria");
    expect(establishmentSchema.safeParse({ ...base, name: "A" }).success).toBe(false);
    expect(establishmentSchema.safeParse({ ...base, name: "x".repeat(121) }).success).toBe(false);
    expect(establishmentSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(establishmentSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(establishmentSchema.safeParse({ ...base, logoPath: "x".repeat(301) }).success).toBe(false);
    expect(establishmentSchema.safeParse({ ...base, logoPath: 5 }).success).toBe(false);
  });
});

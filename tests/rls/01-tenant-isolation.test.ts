/**
 * Isolamento entre tenants: usuários do restaurante A (todos os papéis) nunca leem nem escrevem
 * dados privados do restaurante B (e vice-versa), pelo caminho real PostgREST/RPC com JWT de usuário.
 * Toda negação é confirmada lendo o estado real com service role (dado inalterado).
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AccountKey } from "../fixtures/accounts";
import { admin, as, world } from "../helpers/clients";
import { expectDenied, expectNoRows, expectNotApplied, expectOk, rows } from "../helpers/expect";
import { Cleanup, makeOrder, orderRow, uniq } from "../helpers/factory";

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;

const A_USERS: AccountKey[] = ["ownerA", "managerA", "cashierA", "kitchenA", "waiterA", "waiter2A"];
const B_USERS: AccountKey[] = ["ownerB", "managerB", "cashierB", "kitchenB", "waiterB"];

/** Tabelas com restaurant_id cujo conteúdo é PRIVADO (nenhum dado de B pode aparecer para A). */
const PRIVATE_TABLES = [
  "orders",
  "order_items",
  "order_item_modifiers",
  "order_status_history",
  "customers",
  "customer_addresses",
  "payments",
  "tabs",
  "tab_status_history",
  "restaurant_tables",
  "print_jobs",
  "restaurant_memberships",
  "membership_permission_overrides",
  "audit_logs",
  "subscriptions",
  "support_sessions",
  "support_tickets",
];

describe("leitura: nenhuma linha privada do outro tenant, em nenhuma tabela, para nenhum papel", () => {
  for (const [users, other, label] of [
    [A_USERS, B, "A -> B"],
    [B_USERS, A, "B -> A"],
  ] as const) {
    describe(label, () => {
      for (const who of users) {
        it(`${who}: select irrestrito e filtrado por restaurant_id do outro tenant devolvem 0 linhas`, async () => {
          const rid = other().id;
          for (const table of PRIVATE_TABLES) {
            const filtered = await as(who).from(table).select("restaurant_id").eq("restaurant_id", rid);
            expectNoRows(filtered);
            // Sem filtro: o RLS tem de remover qualquer linha do outro tenant sozinho.
            const unfiltered = await as(who).from(table).select("restaurant_id").limit(1000);
            if (!unfiltered.error) {
              const leaked = rows(unfiltered).filter((r) => r.restaurant_id === rid);
              expect(leaked, `${table} vazou linhas de ${rid} para ${who}`).toHaveLength(0);
            }
          }
        });
      }
    });
  }

  it("ids conhecidos de B (pedidos, cliente, comanda, mesa, pagamento) continuam invisíveis para toda a equipe de A", async () => {
    const b = B();
    for (const who of A_USERS) {
      expectNoRows(await as(who).from("orders").select("id").in("id", b.orderIds));
      expectNoRows(await as(who).from("customers").select("id").eq("id", b.customerId));
      expectNoRows(await as(who).from("tabs").select("id").eq("id", b.tabId));
      expectNoRows(await as(who).from("restaurant_tables").select("id").in("id", b.tableIds));
      expectNoRows(await as(who).from("payments").select("id").eq("id", b.paymentId));
    }
  });

  it("o restaurante B (linha em restaurants) é invisível para A, inclusive por embed a partir de dado público", async () => {
    expectNoRows(await as("ownerA").from("restaurants").select("id,name,status").eq("id", B().id));
    const embed = await as("ownerA").from("products").select("id,restaurant_id,restaurants(id,name,status)").eq("restaurant_id", B().id).eq("is_active", true);
    expectOk(embed);
    expect(rows(embed).length).toBeGreaterThan(0); // cardápio de B é público por desenho
    for (const p of rows(embed)) expect(p.restaurants).toBeNull(); // mas a linha do restaurante não vem
  });

  it("profiles: colegas do mesmo restaurante são legíveis; pessoas de B não", async () => {
    const colleagues = await as("waiterA").from("profiles").select("id");
    expectOk(colleagues);
    const ids = new Set(rows(colleagues).map((r) => r.id));
    expect(ids.has(world().users.ownerA.id)).toBe(true);
    for (const k of B_USERS) expect(ids.has(world().users[k].id), `perfil de ${k} vazou`).toBe(false);
    expect(ids.has(world().users.superadmin.id)).toBe(false);
    expectNoRows(await as("waiterA").from("profiles").select("id").eq("id", world().users.ownerB.id));
  });
});

describe("RPCs/funções de autorização não vazam nem concedem acesso ao outro tenant", () => {
  it("is_member / has_permission / my_permissions de B, vistos por A, são negativos", async () => {
    for (const who of A_USERS) {
      const member = await as(who).rpc("is_member", { rid: B().id });
      expect(member.error).toBeNull();
      expect(member.data).toBe(false);
      const perm = await as(who).rpc("has_permission", { rid: B().id, perm: "orders.view" });
      expect(perm.data).toBe(false);
      const mine = await as(who).rpc("my_permissions", { rid: B().id });
      expect(mine.data).toEqual([]);
    }
  });

  it("my_restaurants lista somente o restaurante do próprio usuário", async () => {
    const res = await as("managerA").rpc("my_restaurants");
    expectOk(res);
    expect(rows(res).map((r) => r.restaurant_id)).toEqual([A().id]);
  });

  it("RPCs de equipe/suporte apontando para B com sessão de A são negadas e não alteram nada", async () => {
    const membershipB = world().memberships.waiterB!;
    const before = await admin().from("restaurant_memberships").select("role,status").eq("id", membershipB).single();

    expectDenied(await as("ownerA").rpc("invite_member", { p_restaurant: B().id, p_email: `zz-${uniq()}@example.test`, p_role: "waiter" }), /forbidden/);
    expectDenied(await as("ownerA").rpc("change_member_role", { p_membership: membershipB, p_role: "manager" }), /forbidden/);
    expectDenied(await as("ownerA").rpc("revoke_member", { p_membership: membershipB }), /forbidden/);
    expectDenied(await as("ownerA").rpc("set_member_permission", { p_membership: membershipB, p_permission: "orders.accept", p_granted: true }), /forbidden/);
    expectDenied(await as("ownerA").rpc("open_support_session", { p_restaurant: B().id, p_reason: "tentativa indevida de acesso" }), /forbidden/);

    const after = await admin().from("restaurant_memberships").select("role,status").eq("id", membershipB).single();
    expect(after.data).toEqual(before.data);
    const ov = await admin().from("membership_permission_overrides").select("*").eq("membership_id", membershipB);
    expect(rows(ov)).toHaveLength(0);
    const inv = await admin().from("restaurant_memberships").select("id").eq("restaurant_id", B().id).like("invited_email", "zz-%");
    expect(rows(inv)).toHaveLength(0);
  });
});

/**
 * Escrita cross-tenant: managerA e ownerA TÊM direitos de gestão no próprio restaurante
 * (menu.manage, tables.manage, settings.manage); logo a única barreira para B é o tenant.
 */
interface WriteCase {
  table: string;
  /** id da linha de B usada nos testes de update/delete */
  rowId: () => string;
  column: string;
  patch: unknown;
  insert: (rid: string) => Record<string, unknown>;
  hasDelete?: boolean;
  hasInsert?: boolean;
}

const writeCases: WriteCase[] = [
  { table: "menu_categories", rowId: () => B().categoryId, column: "name", patch: "HACKED", insert: (rid) => ({ restaurant_id: rid, name: "zz-evil" }) },
  { table: "products", rowId: () => B().productId, column: "price_cents", patch: 1, insert: (rid) => ({ restaurant_id: rid, name: "zz-evil", price_cents: 1 }) },
  { table: "modifier_groups", rowId: () => B().modifierGroupId, column: "name", patch: "HACKED", insert: (rid) => ({ restaurant_id: rid, name: "zz-evil" }) },
  { table: "modifiers", rowId: () => B().modifierId, column: "price_delta_cents", patch: 0, insert: (rid) => ({ restaurant_id: rid, group_id: B().modifierGroupId, name: "zz-evil" }) },
  { table: "restaurant_tables", rowId: () => B().tableIds[1], column: "name", patch: "HACKED", insert: (rid) => ({ restaurant_id: rid, name: "zz-evil" }) },
  { table: "business_hours", rowId: () => B().businessHourId, column: "opens_at", patch: "03:33:00", insert: (rid) => ({ restaurant_id: rid, weekday: 1, opens_at: "03:33", closes_at: "04:00" }) },
  { table: "delivery_zones", rowId: () => B().deliveryZoneId, column: "fee_cents", patch: 0, insert: (rid) => ({ restaurant_id: rid, name: "zz-evil" }) },
  { table: "customers", rowId: () => B().customerId, column: "name", patch: "HACKED", insert: (rid) => ({ restaurant_id: rid, name: "zz-evil" }) },
];

describe("escrita cross-tenant: gestores de A não alteram nada de B", () => {
  for (const who of ["managerA", "ownerA"] as const) {
    for (const c of writeCases) {
      it(`${who} · ${c.table}: insert/update/delete em B negados e dado de B intacto`, async () => {
        const before = await admin().from(c.table).select("*").eq("id", c.rowId()).single();
        expect(before.error).toBeNull();

        // INSERT com restaurant_id de B
        const ins = await as(who).from(c.table).insert(c.insert(B().id)).select("id");
        expectDenied(ins);

        // UPDATE da linha de B (id conhecido)
        const upd = await as(who).from(c.table).update({ [c.column]: c.patch }).eq("id", c.rowId()).select("id");
        expectNotApplied(upd);

        // UPDATE em massa filtrando pelo restaurante de B
        const mass = await as(who).from(c.table).update({ [c.column]: c.patch }).eq("restaurant_id", B().id).select("id");
        expectNotApplied(mass);

        // DELETE
        const del = await as(who).from(c.table).delete().eq("id", c.rowId()).select("id");
        expectNotApplied(del);

        const after = await admin().from(c.table).select("*").eq("id", c.rowId()).single();
        expect(after.error).toBeNull();
        expect(after.data).toEqual(before.data);
      });
    }
  }

  it("restaurant_settings e business_hour_exceptions de B: update/insert/delete negados", async () => {
    const settingsBefore = await admin().from("restaurant_settings").select("*").eq("restaurant_id", B().id).single();
    const exBefore = await admin().from("business_hour_exceptions").select("*").eq("restaurant_id", B().id).single();
    for (const who of ["managerA", "ownerA"] as const) {
      expectNotApplied(await as(who).from("restaurant_settings").update({ accepts_orders: false, prep_time_minutes: 1 }).eq("restaurant_id", B().id).select("restaurant_id"));
      expectDenied(await as(who).from("restaurant_settings").insert({ restaurant_id: B().id }).select("restaurant_id"));
      expectNotApplied(await as(who).from("business_hour_exceptions").update({ description: "HACKED" }).eq("restaurant_id", B().id).select("id"));
      expectNotApplied(await as(who).from("business_hour_exceptions").delete().eq("restaurant_id", B().id).select("id"));
      expectDenied(await as(who).from("business_hour_exceptions").insert({ restaurant_id: B().id, on_date: "2031-01-01" }).select("id"));
    }
    expect((await admin().from("restaurant_settings").select("*").eq("restaurant_id", B().id).single()).data).toEqual(settingsBefore.data);
    expect((await admin().from("business_hour_exceptions").select("*").eq("restaurant_id", B().id).single()).data).toEqual(exBefore.data);
  });

  it("não é possível 'mover' uma linha de A para B trocando restaurant_id (WITH CHECK / GRANT)", async () => {
    const res = await as("managerA").from("products").update({ restaurant_id: B().id }).eq("id", A().productId).select("id");
    expectDenied(res);
    const row = await admin().from("products").select("restaurant_id").eq("id", A().productId).single();
    expect(row.data?.restaurant_id).toBe(A().id);

    const resTable = await as("managerA").from("restaurant_tables").update({ restaurant_id: B().id }).eq("id", A().tableIds[1]).select("id");
    expectDenied(resTable);
    expect((await admin().from("restaurant_tables").select("restaurant_id").eq("id", A().tableIds[1]).single()).data?.restaurant_id).toBe(A().id);
  });

  it("FKs compostas impedem referenciar linhas de B a partir de A (mesmo com permissão em A)", async () => {
    const cleanup = new Cleanup();
    try {
      // produto de A apontando para categoria de B
      const p = await as("managerA").from("products").insert({ restaurant_id: A().id, name: `zz-fk-${uniq()}`, price_cents: 1, category_id: B().categoryId }).select("id");
      expect(p.error, "produto de A não pode usar categoria de B").not.toBeNull();
      expect(p.error!.code).toBe("23503");

      // modificador de A em grupo de B
      const m = await as("managerA").from("modifiers").insert({ restaurant_id: A().id, group_id: B().modifierGroupId, name: "zz-fk" }).select("id");
      expect(m.error?.code).toBe("23503");

      // vínculo produto de A <-> grupo de B
      const l = await as("managerA").from("product_modifier_groups").insert({ restaurant_id: A().id, product_id: A().productId, group_id: B().modifierGroupId }).select("product_id");
      expect(l.error?.code).toBe("23503");

      // pedido de impressão de A para pedido de B: o INSERT direto do cliente não existe mais (mig. 0116, F-08) ...
      const row = { restaurant_id: A().id, document_type: "KITCHEN_TICKET", order_id: B().orderIds[0], requested_by: world().users.managerA.id, printer_target: "zz-x" };
      const pj = await as("managerA").from("print_jobs").insert(row).select("id");
      expect(pj.error?.code).toBe("42501");
      // ... a RPC não enxerga o pedido de B ...
      const rpc = await as("managerA").rpc("request_print", { p_order: B().orderIds[0], p_document_type: "KITCHEN_TICKET" });
      expect(rpc.error?.message).toMatch(/^ORDER_NOT_FOUND/);
      // ... e a FK composta continua barrando até o service role
      const svc = await admin().from("print_jobs").insert(row).select("id");
      expect(svc.error?.code).toBe("23503");

      const stray = await admin().from("print_jobs").select("id").like("printer_target", "zz-%");
      expect(rows(stray)).toHaveLength(0);
    } finally {
      await cleanup.run();
    }
  });
});

describe("pedidos, pagamentos, comandas e mesas de B não são tocados por operadores de A", () => {
  const cleanup = new Cleanup();
  afterAll(() => cleanup.run());

  it("cashierA/managerA não aceitam, recusam, cancelam nem mudam status de pedido de B", async () => {
    const order = await makeOrder(cleanup, B().id, { status: "RECEIVED" });
    for (const who of ["cashierA", "managerA", "kitchenA"] as const) {
      for (const patch of [{ status: "CONFIRMED" }, { status: "REJECTED", status_reason: "x" }, { status: "CANCELLED", status_reason: "x" }]) {
        const res = await as(who).from("orders").update(patch).eq("id", order.id).select("id");
        expectNotApplied(res);
      }
    }
    expect((await orderRow(order.id)).status).toBe("RECEIVED");
  });

  it("A não consegue criar pedido, pagamento, item de pedido nem registrar histórico em B (sem policy/GRANT)", async () => {
    const insOrder = await as("managerA").from("orders").insert({ restaurant_id: B().id, fulfillment_type: "PICKUP", subtotal_cents: 1, total_cents: 1 }).select("id");
    expectDenied(insOrder);
    const insPay = await as("managerA").from("payments").insert({ restaurant_id: B().id, order_id: B().orderIds[0], method: "CASH", amount_cents: 1, status: "PAID", paid_at: new Date().toISOString() }).select("id");
    expectDenied(insPay);
    const insItem = await as("managerA").from("order_items").insert({ restaurant_id: B().id, order_id: B().orderIds[0], product_name: "x", unit_price_cents: 1, quantity: 1, line_total_cents: 1 }).select("id");
    expectDenied(insItem);
    const hist = await as("managerA").from("order_status_history").insert({ restaurant_id: B().id, order_id: B().orderIds[0], to_status: "COMPLETED" }).select("id");
    expectDenied(hist);
    const strayPay = await admin().from("payments").select("id").eq("restaurant_id", B().id).eq("amount_cents", 1);
    expect(rows(strayPay)).toHaveLength(0);
  });

  it("comandas e mesas de B: abrir/fechar/alterar com sessão de A é negado", async () => {
    const tabBefore = await admin().from("tabs").select("*").eq("id", B().tabId).single();
    const tableBefore = await admin().from("restaurant_tables").select("*").eq("id", B().tableIds[2]).single();

    const open = await as("cashierA")
      .from("tabs")
      .insert({ restaurant_id: B().id, table_id: B().tableIds[2], status: "OPEN", total_cents: 0, opened_by: world().users.cashierA.id, label: "zz-evil" })
      .select("id");
    expectDenied(open);
    expectNotApplied(await as("cashierA").from("tabs").update({ status: "CLOSED" }).eq("id", B().tabId).select("id"));
    expectNotApplied(await as("waiterA").from("restaurant_tables").update({ status: "OCCUPIED" }).eq("id", B().tableIds[2]).select("id"));

    expect((await admin().from("tabs").select("*").eq("id", B().tabId).single()).data).toEqual(tabBefore.data);
    expect((await admin().from("restaurant_tables").select("*").eq("id", B().tableIds[2]).single()).data).toEqual(tableBefore.data);
    expect(rows(await admin().from("tabs").select("id").eq("restaurant_id", B().id).eq("label", "zz-evil"))).toHaveLength(0);
  });

  it("clientes de B: nem leitura nem inserção/alteração por A; sem DELETE para ninguém", async () => {
    const before = await admin().from("customers").select("*").eq("id", B().customerId).single();
    expectNotApplied(await as("managerA").from("customers").update({ name: "HACKED", phone: "11000000000" }).eq("id", B().customerId).select("id"));
    expectNotApplied(await as("managerA").from("customer_addresses").delete().eq("restaurant_id", B().id).select("id"));
    // delete de customers não tem GRANT
    expectDenied(await as("managerB").from("customers").delete().eq("id", B().customerId).select("id"));
    expect((await admin().from("customers").select("*").eq("id", B().customerId).single()).data).toEqual(before.data);
  });
});

describe("controle positivo: os mesmos atores FAZEM no próprio restaurante o que não podem fazer em B", () => {
  const cleanup = new Cleanup();
  afterAll(() => cleanup.run());

  it("managerA/ownerA inserem, alteram e apagam cardápio/mesas/horários/zonas de A", async () => {
    for (const who of ["managerA", "ownerA"] as const) {
      const prod = await as(who).from("products").insert({ restaurant_id: A().id, name: `zz-ok-${uniq()}`, price_cents: 100 }).select("id").single();
      expectOk(prod);
      cleanup.add(async () => void (await admin().from("products").delete().eq("id", prod.data!.id)));
      expectOk(await as(who).from("products").update({ price_cents: 200 }).eq("id", prod.data!.id));
      expect((await admin().from("products").select("price_cents").eq("id", prod.data!.id).single()).data?.price_cents).toBe(200);
      const del = await as(who).from("products").delete().eq("id", prod.data!.id).select("id");
      expectOk(del);
      expect(rows(del)).toHaveLength(1);

      const tbl = await as(who).from("restaurant_tables").insert({ restaurant_id: A().id, name: `zz-ok-${uniq()}` }).select("id").single();
      expectOk(tbl);
      cleanup.add(async () => void (await admin().from("restaurant_tables").delete().eq("id", tbl.data!.id)));

      const zone = await as(who).from("delivery_zones").insert({ restaurant_id: A().id, name: `zz-ok-${uniq()}` }).select("id").single();
      expectOk(zone);
      cleanup.add(async () => void (await admin().from("delivery_zones").delete().eq("id", zone.data!.id)));
    }
  });

  it("produto que já foi vendido não pode ser apagado fisicamente (nem pelo gerente do próprio restaurante); produto novo pode", async () => {
    const sold = await as("managerA").from("products").delete().eq("id", A().productId).select("id");
    expectNotApplied(sold);
    expect(rows(await admin().from("products").select("id").eq("id", A().productId))).toHaveLength(1);
    const fresh = await as("managerA").from("products").insert({ restaurant_id: A().id, name: `zz-del-${uniq()}`, price_cents: 1 }).select("id").single();
    expectOk(fresh);
    const del = await as("managerA").from("products").delete().eq("id", fresh.data!.id).select("id");
    expect(rows(del)).toHaveLength(1);
  });

  it("cashierA cria cliente em A (orders.create) e opera pedido de A", async () => {
    const cust = await as("cashierA").from("customers").insert({ restaurant_id: A().id, name: `zz-cli-${uniq()}` }).select("id").single();
    expectOk(cust);
    cleanup.add(async () => void (await admin().from("customers").delete().eq("id", cust.data!.id)));

    const order = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    const acc = await as("cashierA").from("orders").update({ status: "CONFIRMED" }).eq("id", order.id).select("id");
    expectOk(acc);
    expect(rows(acc)).toHaveLength(1);
    expect((await orderRow(order.id)).status).toBe("CONFIRMED");
  });
});

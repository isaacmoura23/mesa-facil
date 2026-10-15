/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Realtime (postgres_changes): o Realtime avalia o RLS de SELECT de cada assinante.
 * Um usuário de A inscrito em orders recebe os eventos de A e NUNCA os de B; anon não recebe dados;
 * papel sem orders.view/tabs.view não recebe o que não pode ler; filtro por restaurant_id alheio não fura o RLS.
 *
 * Estabilidade (sem sleeps cegos):
 *  - "SUBSCRIBED" não garante que o Realtime já esteja entregando mudanças; por isso cada teste faz um
 *    AQUECIMENTO: toca linhas-sonda dos tenants e só segue quando todo assinante que PODE ver a sonda a recebeu
 *    (o anon prova que está vivo pelo aviso 401). Todo assinante que deve ficar sem eventos compartilha o mesmo
 *    canal com uma tabela que ele pode ler, então "estar vivo" vale para ele também.
 *  - Para provar um "não recebeu", usamos barreira de ordem: os eventos do outro tenant são commitados ANTES
 *    da sentinela do próprio tenant; quando a sentinela chega, qualquer evento anterior já teria chegado
 *    (o WAL é entregue em ordem).
 */
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admin, realtimeAs, world } from "../helpers/clients";
import { Cleanup, makeOrder, makeTab, makeTable, waitFor } from "../helpers/factory";

// O Realtime LOCAL reinicia o tenant a cada ~5 min ("Rebalancing ... {:shutdown, :rebalancing}" no log do contêiner
// supabase_realtime_*): canais caem e eventos em voo se perdem. Quando isso acontece no meio de um teste, ele falha
// rápido (listener "down") e é repetido do zero (dados novos, canais novos). Não é problema do banco/RLS.
vi.setConfig({ testTimeout: 150_000 });

const A = () => world().restaurants.a;
const B = () => world().restaurants.b;
const cleanup = new Cleanup();

interface Ev {
  table: string;
  eventType: string;
  id?: string;
  restaurant_id?: string;
  status?: string;
  errors?: unknown;
}
interface Listener {
  events: Ev[];
  channel: RealtimeChannel;
  down: boolean;
}
const channels: Array<{ client: SupabaseClient; channel: RealtimeChannel }> = [];

afterAll(async () => {
  for (const { client, channel } of channels) await client.removeChannel(channel).catch(() => undefined);
  await cleanup.run();
});

async function listen(client: SupabaseClient, tables: string[], filter?: string): Promise<Listener> {
  const events: Ev[] = [];
  const channel = client.channel(`rt-${Math.random().toString(36).slice(2)}`);
  for (const table of tables) {
    channel.on("postgres_changes" as never, { event: "*", schema: "public", table, ...(filter ? { filter } : {}) } as never, (payload: any) => {
      const row = payload.new && Object.keys(payload.new).length ? payload.new : payload.old && Object.keys(payload.old).length ? payload.old : {};
      events.push({ table, eventType: payload.eventType, id: row.id, restaurant_id: row.restaurant_id, status: row.status, errors: payload.errors ?? undefined });
    });
  }
  const listener: Listener = { events, channel, down: false };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Realtime não assinou ${tables.join(",")} em 20s`)), 20_000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        listener.down = true; // tenant reiniciado/canal caiu depois de assinar
        clearTimeout(timer);
        reject(new Error(`Realtime ${status}: ${err?.message ?? ""}`));
      }
    });
  });
  channels.push({ client, channel });
  activeListeners.push(listener);
  return listener;
}

let activeListeners: Listener[] = [];
beforeEach(() => {
  activeListeners = [];
});
/** waitFor que aborta na hora se algum canal caiu (reinício do Realtime) em vez de esperar o prazo todo. */
async function until(cond: () => boolean, what: string, timeoutMs = 20_000) {
  return waitFor(
    async () => {
      if (activeListeners.some((l) => l.down)) throw new Error(`Realtime reiniciou durante o teste (${what}); será repetido`);
      return cond();
    },
    { timeoutMs, what },
  );
}

const saw = (l: Listener, id: string, table?: string) => l.events.some((e) => e.id === id && (!table || e.table === table));
const count = (l: Listener, table: string) => l.events.filter((e) => e.table === table).length;
const bump = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** Toca as sondas até todos os "vivos" receberem algo novo na tabela indicada. */
async function warmUp(alive: Array<{ l: Listener; table: string }>, touch: (round: number) => Promise<unknown>, timeoutMs = 60_000) {
  const baseline = alive.map(({ l, table }) => count(l, table));
  const deadline = Date.now() + timeoutMs;
  for (let round = 1; ; round++) {
    await touch(round);
    const settled = await until(() => alive.every(({ l, table }, i) => count(l, table) > baseline[i]), "aquecimento", 2_500).then(
      () => true,
      (e: Error) => {
        if (/reiniciou/.test(e.message)) throw e;
        return false;
      },
    );
    if (settled) return;
    if (Date.now() > deadline) throw new Error("Realtime não ficou ativo a tempo (aquecimento)");
  }
}

/** Anon não pode ver linhas: no máximo um aviso "401" sem dados (ver FINDINGS F-09). */
function expectNoRowData(l: Listener, what: string) {
  for (const e of l.events) {
    expect(e.id, `anon recebeu id de ${what}`).toBeUndefined();
    expect(e.restaurant_id, `anon recebeu restaurant_id de ${what}`).toBeUndefined();
    expect(e.status, `anon recebeu status de ${what}`).toBeUndefined();
  }
}

describe("Realtime respeita o RLS por assinante", { retry: 3 }, () => {
  it("orders: A recebe INSERT/UPDATE dos pedidos de A e nunca os de B (e vice-versa); anon não recebe dados", async () => {
    const probeA = await makeOrder(cleanup, A().id);
    const probeB = await makeOrder(cleanup, B().id);
    const [la, lb, lanon] = [await listen(realtimeAs("ownerA"), ["orders"]), await listen(realtimeAs("ownerB"), ["orders"]), await listen(realtimeAs("anon"), ["orders"])];
    await warmUp(
      [
        { l: la, table: "orders" },
        { l: lb, table: "orders" },
        { l: lanon, table: "orders" },
      ],
      async (n) => {
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeA.id);
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeB.id);
      },
    );

    // B primeiro (commit anterior), depois A: a sentinela de A fecha a janela de observação
    const orderB = await makeOrder(cleanup, B().id, { status: "RECEIVED" });
    const orderA = await makeOrder(cleanup, A().id, { status: "RECEIVED" });
    await until(() => saw(la, orderA.id) && saw(lb, orderB.id), "INSERTs chegarem aos donos");

    // updates também (REPLICA IDENTITY FULL)
    expect((await admin().from("orders").update({ status: "CONFIRMED" }).eq("id", orderB.id)).error).toBeNull();
    expect((await admin().from("orders").update({ status: "CONFIRMED" }).eq("id", orderA.id)).error).toBeNull();
    await until(() => la.events.some((e) => e.id === orderA.id && e.eventType === "UPDATE") && lb.events.some((e) => e.id === orderB.id && e.eventType === "UPDATE"), "UPDATEs chegarem");

    expect(saw(la, orderB.id), "A recebeu evento de pedido de B").toBe(false);
    expect(saw(lb, orderA.id), "B recebeu evento de pedido de A").toBe(false);
    expect(la.events.every((e) => e.restaurant_id === A().id)).toBe(true);
    expect(lb.events.every((e) => e.restaurant_id === B().id)).toBe(true);
    expect(lanon.events.length, "o anon deveria estar vivo (aviso 401)").toBeGreaterThan(0);
    expectNoRowData(lanon, "pedidos");
  });

  it("orders: o evento chega a quem tem orders.view (cozinha, garçom) e não aos de outro tenant", async () => {
    const probeA = await makeOrder(cleanup, A().id);
    const probeB = await makeOrder(cleanup, B().id);
    const [lk, lw, lkb] = [await listen(realtimeAs("kitchenA"), ["orders"]), await listen(realtimeAs("waiterA"), ["orders"]), await listen(realtimeAs("kitchenB"), ["orders"])];
    await warmUp(
      [
        { l: lk, table: "orders" },
        { l: lw, table: "orders" },
        { l: lkb, table: "orders" },
      ],
      async (n) => {
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeA.id);
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeB.id);
      },
    );
    const orderB = await makeOrder(cleanup, B().id);
    const orderA = await makeOrder(cleanup, A().id);
    await until(() => saw(lk, orderA.id) && saw(lw, orderA.id) && saw(lkb, orderB.id), "INSERTs chegarem à cozinha/garçom");
    expect(saw(lk, orderB.id) || saw(lw, orderB.id)).toBe(false);
    expect(saw(lkb, orderA.id)).toBe(false);
  });

  it("filtro com restaurant_id de outro tenant não fura o RLS", async () => {
    const probeA = await makeOrder(cleanup, A().id);
    const forged = await listen(realtimeAs("ownerA"), ["orders"], `restaurant_id=eq.${B().id}`);
    const sentinel = await listen(realtimeAs("ownerA"), ["orders"], `restaurant_id=eq.${A().id}`);
    await warmUp([{ l: sentinel, table: "orders" }], async (n) => {
      await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeA.id);
    });
    const orderB = await makeOrder(cleanup, B().id);
    const orderA = await makeOrder(cleanup, A().id);
    await until(() => saw(sentinel, orderA.id), "sentinela de A");
    expect(saw(forged, orderB.id)).toBe(false);
    expect(forged.events).toHaveLength(0);
  });

  it("tabs: garçom de A recebe as comandas de A; cozinha (sem tabs.view) não recebe; B não vaza", async () => {
    const tA = await makeTable(cleanup, A().id);
    const tB = await makeTable(cleanup, B().id);
    const probeTabA = await makeTab(cleanup, A().id, { tableId: tA.id, openedBy: world().users.cashierA.id });
    const probeTabB = await makeTab(cleanup, B().id, { tableId: tB.id, openedBy: world().users.cashierB.id });
    const probeOrderA = await makeOrder(cleanup, A().id);
    const [lw, lk, lb] = [
      await listen(realtimeAs("waiterA"), ["tabs"]),
      await listen(realtimeAs("kitchenA"), ["tabs", "orders"]), // "orders" prova que o canal da cozinha está vivo
      await listen(realtimeAs("waiterB"), ["tabs"]),
    ];
    await warmUp(
      [
        { l: lw, table: "tabs" },
        { l: lb, table: "tabs" },
        { l: lk, table: "orders" },
      ],
      async (n) => {
        await admin().from("tabs").update({ label: `zz-probe-${n}` }).eq("id", probeTabA.id);
        await admin().from("tabs").update({ label: `zz-probe-${n}` }).eq("id", probeTabB.id);
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeOrderA.id);
      },
    );
    const tableB = await makeTable(cleanup, B().id);
    const tableA = await makeTable(cleanup, A().id);
    const tabB = await makeTab(cleanup, B().id, { tableId: tableB.id, openedBy: world().users.cashierB.id });
    const tabA = await makeTab(cleanup, A().id, { tableId: tableA.id, openedBy: world().users.cashierA.id });
    await until(() => saw(lw, tabA.id) && saw(lb, tabB.id), "comandas chegarem aos garçons");
    expect(saw(lw, tabB.id)).toBe(false);
    expect(saw(lb, tabA.id)).toBe(false);
    expect(count(lk, "tabs"), "cozinha recebeu eventos de comandas").toBe(0);
  });

  it("restaurant_tables: apenas quem tem tables.view do restaurante recebe", async () => {
    const probeA = await makeTable(cleanup, A().id);
    const probeB = await makeTable(cleanup, B().id);
    const probeOrderA = await makeOrder(cleanup, A().id);
    const [lw, lk, lanon] = [
      await listen(realtimeAs("waiterA"), ["restaurant_tables"]),
      await listen(realtimeAs("kitchenA"), ["restaurant_tables", "orders"]),
      await listen(realtimeAs("anon"), ["restaurant_tables"]),
    ];
    await warmUp(
      [
        { l: lw, table: "restaurant_tables" },
        { l: lk, table: "orders" },
        { l: lanon, table: "restaurant_tables" },
      ],
      async (n) => {
        await admin().from("restaurant_tables").update({ area: `zz-${n}` }).eq("id", probeA.id);
        await admin().from("restaurant_tables").update({ area: `zz-${n}` }).eq("id", probeB.id);
        await admin().from("orders").update({ estimated_ready_at: bump(n) }).eq("id", probeOrderA.id);
      },
    );
    const tableB = await makeTable(cleanup, B().id);
    const tableA = await makeTable(cleanup, A().id);
    await until(() => saw(lw, tableA.id), "mesa de A chegar ao garçom");
    expect(saw(lw, tableB.id)).toBe(false);
    expect(count(lk, "restaurant_tables"), "cozinha recebeu eventos de mesas").toBe(0);
    expectNoRowData(lanon, "mesas");
  });
});

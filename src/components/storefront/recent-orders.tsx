"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { RECENT_ORDERS_KEY, readRecentOrders } from "@/modules/storefront/order-checkout";
import { formatDateTime } from "@/modules/storefront/order-status";

function subscribe(listener: () => void): () => void {
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

/** Texto bruto do localStorage (primitivo estável para o useSyncExternalStore). */
function getRaw(): string {
  try {
    return window.localStorage.getItem(RECENT_ORDERS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** "Meus pedidos recentes" deste navegador (até 5, só deste restaurante). */
export function RecentOrders({ slug }: { slug: string }) {
  const raw = useSyncExternalStore(subscribe, getRaw, () => "");
  const orders = useMemo(
    () => (raw ? readRecentOrders().filter((o) => o.slug === slug) : []),
    [raw, slug],
  );
  if (orders.length === 0) return null;

  return (
    <section aria-labelledby="pedidos-recentes" className="mb-6 rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 id="pedidos-recentes" className="flex items-center gap-2 text-sm font-semibold text-fg">
        <ReceiptText aria-hidden="true" className="size-4 text-muted" />
        Meus pedidos recentes
      </h2>
      <ul className="mt-2 divide-y divide-line">
        {orders.map((order) => (
          <li key={order.publicCode}>
            <Link
              href={`/r/${encodeURIComponent(order.slug)}/pedido/${encodeURIComponent(order.publicCode)}`}
              className="flex min-h-11 items-center justify-between gap-3 rounded-control py-2 text-sm hover:text-accent"
            >
              <span className="font-medium text-fg">
                {order.orderNumber !== null ? `Pedido nº ${order.orderNumber}` : "Pedido"}
              </span>
              <span className="text-muted tabular-nums">{formatDateTime(order.at, null)}</span>
              <span className="font-medium text-accent">Acompanhar</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

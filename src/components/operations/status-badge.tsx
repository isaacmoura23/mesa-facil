import { Bike, ShoppingBag, UtensilsCrossed } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import {
  FULFILLMENT_LABELS,
  STATUS_LABELS,
  type FulfillmentType,
  type OrderStatus,
} from "@/modules/operations/types";

export const STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  RECEIVED: "accent",
  CONFIRMED: "info",
  PREPARING: "warning",
  READY: "accent",
  OUT_FOR_DELIVERY: "info",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  REJECTED: "danger",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const FULFILLMENT_ICONS = {
  DELIVERY: Bike,
  PICKUP: ShoppingBag,
  DINE_IN: UtensilsCrossed,
} as const;

export function FulfillmentBadge({ type, label }: { type: FulfillmentType; label?: string | null }) {
  const Icon = FULFILLMENT_ICONS[type];
  return (
    <Badge tone="neutral" className="gap-1.5 text-sm">
      <Icon aria-hidden="true" className="size-3.5" />
      {FULFILLMENT_LABELS[type]}
      {label ? ` ${label}` : ""}
    </Badge>
  );
}

import type { AccountKey, RestaurantKey } from "./accounts";

export interface RestaurantSamples {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  productId: string;
  hiddenProductId: string;
  modifierGroupId: string;
  modifierId: string;
  /** Mesas cadastradas pelo seed (nunca mutadas pelos testes). */
  tableIds: string[];
  tabTableId: string;
  tabId: string;
  customerId: string;
  /** Pedidos do seed: [0] RECEIVED, [1] CONFIRMED (DELIVERY), [2] PREPARING (DINE_IN), [3] COMPLETED (pago). */
  orderIds: string[];
  paymentId: string;
  businessHourId: string;
  deliveryZoneId: string;
}

export interface World {
  url: string;
  users: Record<AccountKey, { id: string; email: string }>;
  /** id do vínculo (restaurant_memberships) das contas com restaurante. */
  memberships: Partial<Record<AccountKey, string>>;
  restaurants: Record<RestaurantKey, RestaurantSamples>;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}

export type SessionMap = Record<AccountKey, SessionTokens>;

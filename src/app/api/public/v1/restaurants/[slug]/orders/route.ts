import { getPublicApi } from "@/modules/public-api/server";

type Context = { params: Promise<{ slug: string }> };

/** POST /api/public/v1/restaurants/{slug}/orders (cria o pedido; idempotente). */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  return getPublicApi().createOrder(request, slug);
}

/** Preflight CORS (origem validada por restaurante). */
export async function OPTIONS(request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  return getPublicApi().ordersPreflight(request, slug);
}

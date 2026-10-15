import { getPublicApi } from "@/modules/public-api/server";

type Context = { params: Promise<{ slug: string; publicCode: string }> };

/** GET /api/public/v1/restaurants/{slug}/orders/{publicCode} (acompanhamento, no-store). */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { slug, publicCode } = await params;
  return getPublicApi().trackOrder(request, slug, publicCode);
}

/** Preflight CORS (origem validada por restaurante). */
export async function OPTIONS(request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  return getPublicApi().trackPreflight(request, slug);
}

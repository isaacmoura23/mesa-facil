import { getPublicApi } from "@/modules/public-api/server";

type Context = { params: Promise<{ slug: string }> };

/** GET /api/public/v1/restaurants/{slug}/menu */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  return getPublicApi().menu(request, slug);
}

/** Preflight CORS (origem validada por restaurante). */
export async function OPTIONS(request: Request, { params }: Context): Promise<Response> {
  const { slug } = await params;
  return getPublicApi().menuPreflight(request, slug);
}

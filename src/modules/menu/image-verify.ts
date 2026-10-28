import "server-only";
import { PUBLIC_BUCKET } from "@/lib/storage";
import type { AppSupabaseClient } from "@/lib/supabase/types";
import { bytesMatchPath, SNIFF_BYTES } from "./image-bytes";
import { MAX_IMAGE_BYTES } from "./image";

/**
 * Confere, NO SERVIDOR, os bytes reais do arquivo que o navegador enviou ao Storage (F-17). Se não for PNG, JPEG,
 * WebP ou AVIF compatível com a extensão do caminho (ex.: HTML ou SVG disfarçado de PNG), o arquivo é APAGADO
 * do bucket e a ação recusa o caminho. Devolve a mensagem de erro (PT-BR) ou `null` se está tudo certo.
 */
export async function verifyImageBytes(
  supabase: AppSupabaseClient,
  path: string,
  noun: "imagem" | "logo",
): Promise<string | null> {
  const { data, error } = await supabase.storage.from(PUBLIC_BUCKET).download(path);
  if (error || !data) return `Não foi possível conferir ${noun === "logo" ? "a logo" : "a imagem"} enviada.`;

  let head: Uint8Array;
  try {
    if (data.size > MAX_IMAGE_BYTES) throw new Error("grande demais");
    head = new Uint8Array(await data.slice(0, SNIFF_BYTES).arrayBuffer());
  } catch {
    await supabase.storage.from(PUBLIC_BUCKET).remove([path]);
    return `${noun === "logo" ? "A logo enviada" : "A imagem enviada"} não atende aos requisitos (JPG, PNG, WebP ou AVIF, até 5 MB).`;
  }

  if (!bytesMatchPath(head, path)) {
    await supabase.storage.from(PUBLIC_BUCKET).remove([path]);
    return `O arquivo enviado não é uma ${noun === "logo" ? "logo" : "imagem"} válida (JPG, PNG, WebP ou AVIF). Escolha outro arquivo.`;
  }
  return null;
}

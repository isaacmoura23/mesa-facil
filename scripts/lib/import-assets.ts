/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Imagens da importação: SOMENTE arquivos locais das pastas irmãs (leitura; nada é modificado lá).
 * Envia ao bucket `restaurant-public` com a service role, respeitando 5 MB e MIME jpeg/png/webp/avif.
 * Não converte nada: o que não couber é pulado e listado.
 * Caminho determinístico (uuid derivado do conteúdo) => reenvio idempotente (upsert no mesmo objeto).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "restaurant-public";
export const MAX_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, { mime: string; ext: string }> = {
  ".jpg": { mime: "image/jpeg", ext: "jpg" },
  ".jpeg": { mime: "image/jpeg", ext: "jpg" },
  ".png": { mime: "image/png", ext: "png" },
  ".webp": { mime: "image/webp", ext: "webp" },
  ".avif": { mime: "image/avif", ext: "avif" },
};

export interface SkippedAsset {
  file: string;
  reason: string;
}

export interface PreparedAsset {
  file: string;
  buffer: Buffer;
  mime: string;
  ext: string;
  sha256: string;
}

/** Confere a assinatura do arquivo (não confia só na extensão). */
function sniff(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(buf.toString("ascii", 8, 12))) return "image/avif";
  return null;
}

/** Lê e valida um arquivo relativo a srcRoot. Retorna o asset ou o motivo do descarte. */
export function prepareAsset(srcRoot: string, relFile: string): PreparedAsset | SkippedAsset {
  const abs = path.resolve(srcRoot, relFile);
  // Defesa contra caminhos que escapam da raiz das pastas irmãs.
  if (!abs.startsWith(path.resolve(srcRoot) + path.sep)) return { file: relFile, reason: "caminho fora da raiz das pastas-fonte" };
  if (!existsSync(abs)) return { file: relFile, reason: "arquivo não encontrado" };
  const st = statSync(abs);
  if (!st.isFile()) return { file: relFile, reason: "não é arquivo" };
  if (st.size > MAX_BYTES) return { file: relFile, reason: `maior que 5 MB (${(st.size / 1048576).toFixed(1)} MB)` };
  const kind = MIME_BY_EXT[path.extname(abs).toLowerCase()];
  if (!kind) return { file: relFile, reason: `extensão não permitida (${path.extname(abs) || "sem extensão"})` };
  const buffer = readFileSync(abs);
  const sniffed = sniff(buffer);
  if (sniffed !== kind.mime) return { file: relFile, reason: `conteúdo (${sniffed ?? "desconhecido"}) não confere com a extensão` };
  return { file: relFile, buffer, mime: kind.mime, ext: kind.ext, sha256: createHash("sha256").update(buffer).digest("hex") };
}

export const isSkipped = (x: PreparedAsset | SkippedAsset): x is SkippedAsset => "reason" in x;

/** uuid (estilo v5) determinístico a partir de uma semente. */
export function deterministicUuid(seed: string): string {
  const h = createHash("sha1").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function objectPath(restaurantId: string, kind: "products" | "logo", asset: PreparedAsset): string {
  return `restaurants/${restaurantId}/${kind}/${deterministicUuid(`${restaurantId}:${kind}:${asset.sha256}`)}.${asset.ext}`;
}

/** Envia (upsert). Devolve o path gravado em image_path/logo_path. */
export async function uploadAsset(admin: SupabaseClient, restaurantId: string, kind: "products" | "logo", asset: PreparedAsset): Promise<string> {
  const p = objectPath(restaurantId, kind, asset);
  const { error } = await admin.storage.from(BUCKET).upload(p, asset.buffer, { contentType: asset.mime, upsert: true, cacheControl: "31536000" });
  if (error) throw new Error(`[assets] upload ${p}: ${error.message}`);
  return p;
}

/** Remove todos os objetos sob restaurants/{id}/ (usado por --reset). */
export async function removeRestaurantFolder(admin: SupabaseClient, restaurantId: string): Promise<number> {
  let removed = 0;
  for (const kind of ["products", "logo"] as const) {
    const folder = `restaurants/${restaurantId}/${kind}`;
    const names = await listFolder(admin, folder);
    if (names.length) {
      const { error } = await admin.storage.from(BUCKET).remove(names.map((n) => `${folder}/${n}`));
      if (error) throw new Error(`[assets] remove ${folder}: ${error.message}`);
      removed += names.length;
    }
  }
  return removed;
}

export async function listFolder(admin: SupabaseClient, folder: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await admin.storage.from(BUCKET).list(folder, { limit: 100, offset });
    if (error) throw new Error(`[assets] list ${folder}: ${error.message}`);
    const files = (data ?? []).filter((o: any) => o.id !== null && o.name !== ".emptyFolderPlaceholder");
    out.push(...files.map((o: any) => o.name as string));
    if ((data ?? []).length < 100) break;
  }
  return out;
}

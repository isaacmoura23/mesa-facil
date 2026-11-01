/**
 * Detecção do tipo REAL de imagem pelos primeiros bytes ("magic bytes", F-17). O Content-Type declarado no
 * upload é só uma dica do cliente: HTML/SVG/JS enviados como `image/png` passariam pelo bucket. Módulo puro.
 */

export type DetectedImageType = "image/jpeg" | "image/png" | "image/webp" | "image/avif";

/** Quantos bytes iniciais bastam para identificar os quatro formatos. */
export const SNIFF_BYTES = 64;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function detectImageType(bytes: Uint8Array): DetectedImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 16 && ascii(bytes, 4, 8) === "ftyp") {
    // Caixa ftyp: marca principal em 8..12 e marcas compatíveis a partir de 16 (até o tamanho da caixa).
    const boxSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    const end = Math.min(bytes.length, boxSize > 16 ? boxSize : 32);
    const major = ascii(bytes, 8, 12);
    if (major === "avif" || major === "avis") return "image/avif";
    for (let i = 16; i + 4 <= end; i += 4) {
      const brand = ascii(bytes, i, i + 4);
      if (brand === "avif" || brand === "avis") return "image/avif";
    }
  }
  return null;
}

const EXTENSION_TYPES: Readonly<Record<string, DetectedImageType>> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
};

/** Tipo que a extensão do caminho promete (minúscula, como o CHECK do banco exige), ou null. */
export function expectedTypeFromPath(path: string): DetectedImageType | null {
  const ext = /[.]([a-z0-9]+)$/.exec(path)?.[1];
  return ext && Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : null;
}

/** Os bytes iniciais são mesmo do formato prometido pela extensão do caminho? */
export function bytesMatchPath(bytes: Uint8Array, path: string): boolean {
  const expected = expectedTypeFromPath(path);
  return expected !== null && detectImageType(bytes) === expected;
}

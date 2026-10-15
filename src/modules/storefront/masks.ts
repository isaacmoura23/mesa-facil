/** Máscaras e validações de campos brasileiros (somente formatação; sem dependências). */

export const onlyDigits = (value: string): string => value.replace(/\D/g, "");

/** (11) 91234-5678 ou (11) 1234-5678, aplicado enquanto digita. */
export function maskPhone(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (d.length <= 6) return `(${ddd}) ${rest}`;
  if (d.length <= 10) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
}

/** Telefone BR: DDD 11-99 e 8 dígitos (fixo) ou 9 dígitos começando em 9 (celular). */
export function isValidBrPhone(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length !== 10 && d.length !== 11) return false;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return false;
  if (d.length === 11) return d[2] === "9";
  return /[2-5]/.test(d[2]);
}

/** 00000-000 */
export function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

export function isValidCep(value: string): boolean {
  return onlyDigits(value).length === 8;
}

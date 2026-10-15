import { clsx, type ClassValue } from "clsx";

/** Junta classes condicionais (wrapper fino sobre clsx). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

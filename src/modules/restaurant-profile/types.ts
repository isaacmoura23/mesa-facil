import { z } from "zod";

export type { ActionResult } from "@/modules/menu/types";

export const contactRowSchema = z.object({
  whatsapp: z.string().nullable(),
  phone: z.string().nullable(),
  address_text: z.string().nullable(),
  storefront_url: z.string().nullable(),
});
export type ContactRow = z.infer<typeof contactRowSchema>;

export const originsSchema = z.array(z.string());

/**
 * `contact`/`origins` são `null` quando a leitura falhou: a tela mostra o erro e
 * NÃO oferece edição (salvar por cima de uma leitura que falhou apagaria dados).
 */
export type RestaurantProfileData = {
  contact: ContactRow | null;
  origins: string[] | null;
  establishment: EstablishmentRow | null;
};

export const establishmentRowSchema = z.object({
  name: z.string(),
  logo_path: z.string().nullable(),
  timezone: z.string(),
});
export type EstablishmentRow = z.infer<typeof establishmentRowSchema>;

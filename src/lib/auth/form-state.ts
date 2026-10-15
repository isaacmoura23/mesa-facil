/** Estado devolvido pelas Server Actions de formulário (serializável). */
export type FormState = {
  status: "idle" | "error" | "success";
  message?: string;
  /** Primeira mensagem de erro por campo. */
  fieldErrors?: Record<string, string>;
  /** Valores a repopular (nunca inclui senhas). */
  values?: Record<string, string>;
};

export const initialFormState: FormState = { status: "idle" };

/** Fusos IANA oferecidos no painel: os do Brasil primeiro, depois os mais comuns. */
export type TimezoneOption = { value: string; label: string; group: "Brasil" | "Outros" };

export const TIMEZONES: readonly TimezoneOption[] = [
  { value: "America/Sao_Paulo", label: "Brasília (São Paulo, Rio, Belo Horizonte)", group: "Brasil" },
  { value: "America/Bahia", label: "Bahia (Salvador)", group: "Brasil" },
  { value: "America/Fortaleza", label: "Nordeste (Fortaleza, Recife, Natal)", group: "Brasil" },
  { value: "America/Belem", label: "Belém (Pará, Amapá)", group: "Brasil" },
  { value: "America/Maceio", label: "Maceió", group: "Brasil" },
  { value: "America/Campo_Grande", label: "Campo Grande (Mato Grosso do Sul)", group: "Brasil" },
  { value: "America/Cuiaba", label: "Cuiabá (Mato Grosso)", group: "Brasil" },
  { value: "America/Manaus", label: "Manaus (Amazonas)", group: "Brasil" },
  { value: "America/Porto_Velho", label: "Porto Velho (Rondônia)", group: "Brasil" },
  { value: "America/Boa_Vista", label: "Boa Vista (Roraima)", group: "Brasil" },
  { value: "America/Rio_Branco", label: "Rio Branco (Acre)", group: "Brasil" },
  { value: "America/Noronha", label: "Fernando de Noronha", group: "Brasil" },
  { value: "America/Argentina/Buenos_Aires", label: "Buenos Aires", group: "Outros" },
  { value: "America/Montevideo", label: "Montevidéu", group: "Outros" },
  { value: "America/Asuncion", label: "Assunção", group: "Outros" },
  { value: "America/Santiago", label: "Santiago", group: "Outros" },
  { value: "America/Bogota", label: "Bogotá", group: "Outros" },
  { value: "America/New_York", label: "Nova York", group: "Outros" },
  { value: "America/Chicago", label: "Chicago", group: "Outros" },
  { value: "America/Los_Angeles", label: "Los Angeles", group: "Outros" },
  { value: "Europe/Lisbon", label: "Lisboa", group: "Outros" },
  { value: "Europe/London", label: "Londres", group: "Outros" },
  { value: "Europe/Madrid", label: "Madri", group: "Outros" },
  { value: "UTC", label: "UTC", group: "Outros" },
];

/** O fuso é um identificador IANA que o ambiente reconhece? */
export function isValidTimezone(value: string): boolean {
  if (value.trim() === "" || value.length > 64) return false;
  try {
    // O Intl ignora a caixa ("america/sao_paulo" passa) e o banco compara com pg_timezone_names, que não ignora (F-42):
    // exige o nome exatamente como o ambiente o conhece.
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    const supported = Intl.supportedValuesOf("timeZone");
    if (resolved === value || supported.includes(value)) return true;
    // Só difere na caixa do nome canônico (ou de um nome conhecido): o banco recusaria.
    const lower = value.toLowerCase();
    if (resolved.toLowerCase() === lower || supported.some((name) => name.toLowerCase() === lower)) return false;
    return true; // apelido IANA com a grafia exata (ex.: America/Argentina/Buenos_Aires)
  } catch {
    return false;
  }
}

export function timezoneLabel(value: string): string {
  return TIMEZONES.find((option) => option.value === value)?.label ?? value;
}

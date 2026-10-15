import { z } from "zod";

/**
 * Preferências do alerta sonoro, guardadas em localStorage (por navegador).
 * Toda leitura/escrita é protegida: o storage pode estar bloqueado.
 */

export const ALERT_SOUNDS = ["sino", "campainha", "bipe"] as const;
export type AlertSoundKind = (typeof ALERT_SOUNDS)[number];

export const ALERT_SOUND_LABELS: Record<AlertSoundKind, string> = {
  sino: "Sino",
  campainha: "Campainha",
  bipe: "Bipe triplo",
};

/** 0 = tocar uma vez só. */
export const REPEAT_OPTIONS = [0, 10, 20, 30, 60] as const;

const prefsSchema = z.object({
  enabled: z.boolean().default(true),
  volume: z.number().min(0).max(1).default(0.7),
  sound: z.enum(ALERT_SOUNDS).default("sino"),
  repeatSeconds: z
    .number()
    .refine((value) => (REPEAT_OPTIONS as readonly number[]).includes(value))
    .default(20),
});
export type AlertPrefs = z.infer<typeof prefsSchema>;

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  enabled: true,
  volume: 0.7,
  sound: "sino",
  repeatSeconds: 20,
};

const STORAGE_KEY = "mesa-facil.ops.alert.v1";

let current: AlertPrefs | null = null;
const listeners = new Set<() => void>();

function load(): AlertPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = prefsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // storage indisponível ou JSON inválido: usa o padrão
  }
  return DEFAULT_ALERT_PREFS;
}

export function getAlertPrefsSnapshot(): AlertPrefs {
  if (current === null) current = load();
  return current;
}

export function getAlertPrefsServerSnapshot(): AlertPrefs {
  return DEFAULT_ALERT_PREFS;
}

export function subscribeAlertPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      current = load();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function updateAlertPrefs(patch: Partial<AlertPrefs>): void {
  const parsed = prefsSchema.safeParse({ ...getAlertPrefsSnapshot(), ...patch });
  if (!parsed.success) return;
  current = parsed.data;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    // sem persistência: a preferência vale só nesta sessão
  }
  for (const listener of listeners) listener();
}

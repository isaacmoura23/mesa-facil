"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  NAV_BADGE_STATUS,
  type NavBadgeKey,
} from "@/modules/operations/nav-badges";

type Counts = Partial<Record<NavBadgeKey, number>>;

const NavBadgesContext = createContext<Counts>({});

/** Contagem atual do selo (undefined enquanto não carregou ou sem selo neste ambiente). */
export function useNavBadgeCount(
  key: NavBadgeKey | undefined,
): number | undefined {
  const counts = useContext(NavBadgesContext);
  return key ? counts[key] : undefined;
}

const SAFETY_REFRESH_MS = 60_000;
const DEBOUNCE_MS = 400;

type NavBadgesProviderProps = {
  /** Resolvido no servidor pelo guard; nunca derivado do slug no cliente. */
  restaurantId: string;
  /** Só os selos que este usuário pode ver (vem do menu já filtrado por permissão). */
  keys: readonly NavBadgeKey[];
  children: ReactNode;
};

/**
 * Mantém as contagens dos selos da barra lateral. Lê só a contagem (sem baixar pedidos),
 * relê a cada mudança em `orders` (tempo real, com pequena espera para juntar eventos),
 * ao voltar para a aba e a cada 60 s. Se falhar, mantém o último número.
 */
export function NavBadgesProvider({
  restaurantId,
  keys,
  children,
}: NavBadgesProviderProps) {
  const [counts, setCounts] = useState<Counts>({});
  const keysSignature = keys.join("|");
  const keysRef = useRef(keys);
  useEffect(() => {
    keysRef.current = keys;
  });

  useEffect(() => {
    if (keysSignature === "") return;
    const supabase = createClient();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const wanted = keysRef.current;
      try {
        const results = await Promise.all(
          wanted.map(async (key) => {
            const { count, error } = await supabase
              .from("orders")
              .select("id", { count: "exact", head: true })
              .eq("restaurant_id", restaurantId)
              .eq("status", NAV_BADGE_STATUS[key]);
            if (error) throw new Error(error.message);
            return [key, count ?? 0] as const;
          }),
        );
        if (!cancelled) setCounts(Object.fromEntries(results) as Counts);
      } catch (cause) {
        console.warn(
          "selos: falha ao contar pedidos",
          cause instanceof Error ? cause.message : cause,
        );
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), DEBOUNCE_MS);
    };

    void load();
    const interval = setInterval(() => void load(), SAFETY_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    const channel = supabase.channel(`nav-badges:${restaurantId}`);
    void (async () => {
      try {
        await supabase.auth.getSession();
        await supabase.realtime.setAuth();
      } catch {
        // Sem tempo real, a releitura periódica continua valendo.
      }
      if (cancelled) return;
      channel
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "orders",
            filter: `restaurant_id=eq.${restaurantId}`,
          },
          schedule,
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [restaurantId, keysSignature]);

  const value = useMemo(() => counts, [counts]);
  return (
    <NavBadgesContext.Provider value={value}>
      {children}
    </NavBadgesContext.Provider>
  );
}

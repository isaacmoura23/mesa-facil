"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

const KEY = "mf-theme";
const EVENT = "mf-theme-change";

/** Tema atual: a escolha salva ou, sem escolha, o do aparelho. */
function currentTheme(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener(EVENT, onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    media.removeEventListener("change", onChange);
  };
}

/** Alterna claro/escuro e lembra a escolha neste aparelho. No servidor não mostra estado (evita divergir do cliente). */
export function ThemeToggle() {
  const theme = useSyncExternalStore<Theme | null>(subscribe, currentTheme, () => null);

  function toggle() {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* sem armazenamento: vale só nesta visita */
    }
    window.dispatchEvent(new Event(EVENT));
  }

  const dark = theme === "dark";
  const Icon = dark ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={theme === null ? undefined : dark}
      aria-label={dark ? "Mudar para o tema claro" : "Mudar para o tema escuro"}
      className="grid size-11 shrink-0 place-items-center rounded-control text-muted transition-colors hover:bg-accent-soft hover:text-accent-soft-fg"
    >
      {theme === null ? null : <Icon aria-hidden="true" className="size-[1.125rem]" />}
    </button>
  );
}

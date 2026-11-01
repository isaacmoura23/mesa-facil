"use client";

import { useEffect, useRef } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render(
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme?: "auto";
      language?: string;
    },
  ): string;
  reset(id: string): void;
  remove(id: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi | null> | null = null;

/** Carrega o script oficial da Cloudflare uma única vez (e só quando existe site key). */
function loadTurnstile(): Promise<TurnstileApi | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile ?? null);
    script.onerror = () => {
      scriptPromise = null;
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** `true` quando as chaves do Turnstile estão configuradas neste build. */
export const TURNSTILE_ENABLED = SITE_KEY !== "";

type TurnstileWidgetProps = {
  /** Recebe o token (ou `null` quando expira/falha). */
  onToken?: (token: string | null) => void;
  /** Mude este valor para pedir um desafio novo (token é de uso único). */
  resetKey?: unknown;
  className?: string;
};

/**
 * Widget do Turnstile. Sem site key não renderiza nada nem baixa script algum. Dentro de um <form>
 * o Cloudflare também injeta o campo oculto `cf-turnstile-response` (usado pelas Server Actions de formulário).
 */
export function TurnstileWidget({ onToken, resetKey, className }: TurnstileWidgetProps) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);

  useEffect(() => {
    onTokenRef.current = onToken;
  });

  useEffect(() => {
    if (!SITE_KEY || !container.current) return;
    const element = container.current;
    let cancelled = false;
    void loadTurnstile().then((api) => {
      if (cancelled || !api) return;
      widgetId.current = api.render(element, {
        sitekey: SITE_KEY,
        callback: (token) => onTokenRef.current?.(token),
        "expired-callback": () => onTokenRef.current?.(null),
        "error-callback": () => onTokenRef.current?.(null),
        language: "pt-br",
      } as Parameters<TurnstileApi["render"]>[1]);
    });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, []);

  useEffect(() => {
    if (widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
      onTokenRef.current?.(null);
    }
  }, [resetKey]);

  if (!SITE_KEY) return null;
  return <div ref={container} className={className} />;
}

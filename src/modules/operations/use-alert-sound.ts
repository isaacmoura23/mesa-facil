"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getAlertPrefsServerSnapshot,
  getAlertPrefsSnapshot,
  subscribeAlertPrefs,
  updateAlertPrefs,
  type AlertPrefs,
} from "./alert-prefs";
import {
  playAlertSound,
  unlockAudio,
  watchAudioState,
} from "./sound-engine";

/**
 * Alerta de novos pedidos: som (WebAudio), repetição até o pedido ser visto
 * ou aceito e contador para o título da aba.
 *
 * `waitingIds` = ids dos pedidos que ainda estão RECEIVED. Um alerta só vale
 * enquanto o pedido continua aguardando (se outro aparelho aceitar, ele some).
 */
export function useAlertSound(waitingIds: ReadonlySet<string>) {
  const prefs = useSyncExternalStore(
    subscribeAlertPrefs,
    getAlertPrefsSnapshot,
    getAlertPrefsServerSnapshot,
  );
  const [unlocked, setUnlocked] = useState(false);
  const [alertIds, setAlertIds] = useState<ReadonlySet<string>>(new Set());
  const prefsRef = useRef<AlertPrefs>(prefs);

  useEffect(() => {
    prefsRef.current = prefs;
  });

  // Estado do contexto de áudio + desbloqueio no primeiro gesto em qualquer ponto da tela.
  useEffect(() => {
    const stop = watchAudioState(setUnlocked);
    const onGesture = () => {
      void unlockAudio();
    };
    document.addEventListener("pointerdown", onGesture, { once: true });
    document.addEventListener("keydown", onGesture, { once: true });
    return () => {
      stop();
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
    };
  }, []);

  const pendingCount = [...alertIds].filter((id) => waitingIds.has(id)).length;

  // Repetição enquanto houver pedido novo não visto.
  useEffect(() => {
    if (!prefs.enabled || !unlocked || pendingCount === 0 || prefs.repeatSeconds === 0) return;
    const timer = setInterval(
      () => playAlertSound(prefs.sound, prefs.volume),
      prefs.repeatSeconds * 1000,
    );
    return () => clearInterval(timer);
  }, [prefs.enabled, prefs.sound, prefs.volume, prefs.repeatSeconds, unlocked, pendingCount]);

  /** Registra um pedido novo (chegou depois da carga inicial) e toca uma vez. */
  const notify = useCallback((id: string) => {
    setAlertIds((current) => new Set(current).add(id));
    const { enabled, sound, volume } = prefsRef.current;
    if (enabled) playAlertSound(sound, volume);
  }, []);

  /** O pedido foi visto/aceito/recusado: para de repetir por ele. */
  const dismiss = useCallback((id: string) => {
    setAlertIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);

  const dismissAll = useCallback(() => setAlertIds(new Set()), []);

  const unlock = useCallback(async () => {
    const ok = await unlockAudio();
    if (ok) playAlertSound(prefsRef.current.sound, prefsRef.current.volume);
    return ok;
  }, []);

  const preview = useCallback(() => {
    playAlertSound(prefsRef.current.sound, prefsRef.current.volume);
  }, []);

  return {
    prefs,
    setPrefs: updateAlertPrefs,
    unlocked,
    unlock,
    preview,
    notify,
    dismiss,
    dismissAll,
    alertIds,
    pendingCount,
  };
}

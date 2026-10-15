"use client";

import { useId } from "react";
import { BellRing, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputStyles } from "@/components/ui/input";
import {
  ALERT_SOUNDS,
  ALERT_SOUND_LABELS,
  REPEAT_OPTIONS,
  type AlertPrefs,
  type AlertSoundKind,
} from "@/modules/operations/alert-prefs";

type SoundControlsProps = {
  prefs: AlertPrefs;
  unlocked: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (patch: Partial<AlertPrefs>) => void;
  onUnlock: () => void;
  onPreview: () => void;
};

/** Botão "Som" da barra + painel de configuração. */
export function SoundControls({
  prefs,
  unlocked,
  open,
  onToggleOpen,
  onChange,
  onUnlock,
  onPreview,
}: SoundControlsProps) {
  const panelId = useId();
  const volumeId = useId();
  const soundId = useId();
  const repeatId = useId();
  const needsUnlock = prefs.enabled && !unlocked;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {needsUnlock ? (
        <Button variant="primary" size="md" onClick={onUnlock}>
          <BellRing aria-hidden="true" className="size-4" />
          Ativar som
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="md"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggleOpen}
      >
        {prefs.enabled ? (
          <Volume2 aria-hidden="true" className="size-4" />
        ) : (
          <VolumeX aria-hidden="true" className="size-4" />
        )}
        Som {prefs.enabled ? "ligado" : "desligado"}
      </Button>

      <div
        id={panelId}
        hidden={!open}
        className="w-full rounded-card border border-line bg-surface p-4 shadow-card"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex items-center gap-3 text-sm font-medium text-fg">
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(event) => onChange({ enabled: event.target.checked })}
              className="size-5 accent-[var(--accent)]"
            />
            Tocar alerta de novo pedido
          </label>

          <div className="flex flex-col gap-2">
            <label htmlFor={volumeId} className="text-sm font-medium text-fg">
              Volume: {Math.round(prefs.volume * 100)}%
            </label>
            <input
              id={volumeId}
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(prefs.volume * 100)}
              onChange={(event) => onChange({ volume: Number(event.target.value) / 100 })}
              className="h-11 w-full accent-[var(--accent)]"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={soundId} className="text-sm font-medium text-fg">
              Som
            </label>
            <select
              id={soundId}
              value={prefs.sound}
              onChange={(event) => onChange({ sound: event.target.value as AlertSoundKind })}
              className={inputStyles()}
            >
              {ALERT_SOUNDS.map((sound) => (
                <option key={sound} value={sound}>
                  {ALERT_SOUND_LABELS[sound]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor={repeatId} className="text-sm font-medium text-fg">
              Repetir até ver o pedido
            </label>
            <select
              id={repeatId}
              value={prefs.repeatSeconds}
              onChange={(event) => onChange({ repeatSeconds: Number(event.target.value) })}
              className={inputStyles()}
            >
              {REPEAT_OPTIONS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0 ? "Não repetir" : `A cada ${seconds} s`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="secondary" onClick={unlocked ? onPreview : onUnlock}>
            {unlocked ? "Testar som" : "Ativar e testar som"}
          </Button>
          <p className="text-sm text-muted">
            {unlocked
              ? "Som liberado neste navegador."
              : "O navegador só libera o som depois de um toque. Toque em Ativar som uma vez."}{" "}
            As preferências ficam salvas neste aparelho.
          </p>
        </div>
      </div>
    </div>
  );
}

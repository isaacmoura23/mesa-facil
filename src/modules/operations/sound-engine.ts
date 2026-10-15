import type { AlertSoundKind } from "./alert-prefs";

/**
 * Sons gerados com WebAudio (osciladores). Nenhum arquivo de áudio de terceiros.
 * O navegador só libera o áudio após um gesto do usuário: `unlockAudio()` deve
 * ser chamado a partir de um clique/toque.
 */

let context: AudioContext | null = null;

type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (context) return context;
  const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

export function audioSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.AudioContext ?? (window as AudioWindow).webkitAudioContext);
}

export function audioRunning(): boolean {
  return context?.state === "running";
}

/** Observa mudanças de estado do contexto (suspended/running). */
export function watchAudioState(onChange: (running: boolean) => void): () => void {
  const ctx = getContext();
  if (!ctx) return () => {};
  const handler = () => onChange(ctx.state === "running");
  ctx.addEventListener("statechange", handler);
  handler();
  return () => ctx.removeEventListener("statechange", handler);
}

/** Retoma o contexto; só funciona dentro de um gesto do usuário. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) return false;
  try {
    if (ctx.state !== "running") await ctx.resume();
  } catch {
    return false;
  }
  return ctx.state === "running";
}

type Tone = { freq: number; start: number; dur: number; type: OscillatorType; gain: number };

const PATTERNS: Record<AlertSoundKind, Tone[]> = {
  sino: [
    { freq: 880, start: 0, dur: 1.1, type: "sine", gain: 0.9 },
    { freq: 1760, start: 0, dur: 0.8, type: "sine", gain: 0.35 },
    { freq: 1320, start: 0.28, dur: 1.2, type: "sine", gain: 0.7 },
  ],
  campainha: [
    { freq: 784, start: 0, dur: 0.38, type: "triangle", gain: 0.9 },
    { freq: 587, start: 0.42, dur: 0.6, type: "triangle", gain: 0.9 },
  ],
  bipe: [
    { freq: 1000, start: 0, dur: 0.14, type: "square", gain: 0.35 },
    { freq: 1000, start: 0.22, dur: 0.14, type: "square", gain: 0.35 },
    { freq: 1000, start: 0.44, dur: 0.14, type: "square", gain: 0.35 },
  ],
};

/** Toca o som. Retorna `false` quando o áudio ainda não foi liberado. */
export function playAlertSound(kind: AlertSoundKind, volume: number): boolean {
  const ctx = getContext();
  if (!ctx || ctx.state !== "running") return false;
  const master = ctx.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume));
  master.connect(ctx.destination);

  const now = ctx.currentTime + 0.02;
  for (const tone of PATTERNS[kind]) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    const begin = now + tone.start;
    env.gain.setValueAtTime(0.0001, begin);
    env.gain.exponentialRampToValueAtTime(tone.gain, begin + 0.015);
    env.gain.exponentialRampToValueAtTime(0.0001, begin + tone.dur);
    osc.connect(env).connect(master);
    osc.start(begin);
    osc.stop(begin + tone.dur + 0.05);
  }
  return true;
}

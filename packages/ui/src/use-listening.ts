"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { planHlsListening, type ListeningMode, type ListeningPlan } from "./listening";

export interface ListeningPreferences {
  mode: ListeningMode;
  /** Compress and lift speech, the way podcast apps even out quiet and loud voices. */
  voiceBoost: boolean;
  /** Fold both channels into each ear, for one earbud or a lopsided mix. */
  mono: boolean;
}

const STORAGE_KEY = "phantom.listening";
const DEFAULTS: ListeningPreferences = { mode: "video", voiceBoost: false, mono: false };
const listeners = new Set<() => void>();
let cached: ListeningPreferences | null = null;

function read(): ListeningPreferences {
  if (cached) return cached;
  let next = DEFAULTS;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ListeningPreferences> | null;
    if (saved && typeof saved === "object") next = {
      mode: saved.mode === "audio" ? "audio" : "video",
      voiceBoost: saved.voiceBoost === true,
      mono: saved.mono === true,
    };
  } catch {
    // Blocked storage only costs the remembered choice.
  }
  cached = next;
  return next;
}

function write(change: Partial<ListeningPreferences>) {
  cached = { ...read(), ...change };
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached)); } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const serverSnapshot = () => DEFAULTS;

/**
 * The viewer's listening choices, remembered in this browser and shared by every player on the page.
 * `available` says whether this source can be listened to at all; `listening` is the mode actually in effect.
 */
export function useListening(available = true) {
  const preferences = useSyncExternalStore(subscribe, read, serverSnapshot);
  const setMode = useCallback((mode: ListeningMode) => write({ mode }), []);
  const setVoiceBoost = useCallback((voiceBoost: boolean) => write({ voiceBoost }), []);
  const setMono = useCallback((mono: boolean) => write({ mono }), []);
  return {
    ...preferences,
    listening: available && preferences.mode === "audio",
    setMode,
    setVoiceBoost,
    setMono,
  };
}

export type Listening = ReturnType<typeof useListening>;

type PlanState =
  | { status: "idle" | "loading"; plan: null }
  | { status: "ready"; plan: ListeningPlan }
  | { status: "failed"; plan: null };

/**
 * Read an HLS master playlist and choose what to play while listening. Only fetched while `enabled`, so video
 * viewers never pay for it. `retry` reads the master again, for when the chosen stream's address has expired.
 */
export function useHlsListeningPlan(masterUrl: string | null, enabled: boolean, options: { language?: string } = {}) {
  const { language } = options;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PlanState & { key: string }>({ key: "", status: "idle", plan: null });
  const key = enabled && masterUrl ? `${masterUrl}\n${language ?? ""}\n${attempt}` : "";

  useEffect(() => {
    if (!key || !masterUrl) return;
    const controller = new AbortController();
    const url = new URL(masterUrl, window.location.href).href;
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.text() : Promise.reject(new Error(String(response.status))))
      .then(text => setState({ key, status: "ready", plan: planHlsListening(text, url, { language }) }))
      .catch(() => { if (!controller.signal.aborted) setState({ key, status: "failed", plan: null }); });
    return () => controller.abort();
  }, [key, masterUrl, language]);

  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const current: PlanState = !key ? { status: "idle", plan: null } : state.key === key ? state : { status: "loading", plan: null };
  return { ...current, retry };
}

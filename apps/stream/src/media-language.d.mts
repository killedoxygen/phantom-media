import type { StreamCandidate } from "../lib/types";

export declare const UNVERIFIED_AUDIO_LANGUAGE: "und";
export declare const COMMON_AUDIO_LANGUAGES: readonly string[];
export declare function normalizeAudioLanguage(value: unknown): string;
export declare function audioLanguageName(value: unknown): string;
export declare function hlsAudioLanguages(manifest: string): string[];
export declare function dashAudioLanguages(manifest: string): string[];
export declare function candidateAudioLanguages(
  candidate: StreamCandidate,
  manifest?: string,
): string[];
export declare function matchesAudioLanguage(
  candidate: StreamCandidate,
  preferred: string,
  manifest?: string,
): boolean;
export declare function listeningAudioFits(
  plan: { rendition?: { language?: string; name?: string } } | null | undefined,
  requestedLanguage: string,
): boolean;

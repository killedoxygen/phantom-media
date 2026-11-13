import { languageName, normalizeLanguage } from "./subtitles.mjs";

export const UNVERIFIED_AUDIO_LANGUAGE = "und";

const LANGUAGE_ALIASES = Object.freeze({
  und: "und",
  unknown: "und",
  unverified: "und",
  original: "und",
  default: "und",
  eng: "en",
  english: "en",
  spa: "es",
  spanish: "es",
  español: "es",
  fra: "fr",
  fre: "fr",
  french: "fr",
  français: "fr",
  deu: "de",
  ger: "de",
  german: "de",
  deutsch: "de",
  ita: "it",
  italian: "it",
  italiano: "it",
  por: "pt",
  portuguese: "pt",
  português: "pt",
  hin: "hi",
  hindi: "hi",
  ben: "bn",
  bengali: "bn",
  tam: "ta",
  tamil: "ta",
  tel: "te",
  telugu: "te",
  mar: "mr",
  marathi: "mr",
  pan: "pa",
  pun: "pa",
  punjabi: "pa",
  urd: "ur",
  urdu: "ur",
  ara: "ar",
  arabic: "ar",
  jpn: "ja",
  japanese: "ja",
  kor: "ko",
  korean: "ko",
  zho: "zh",
  chi: "zh",
  chinese: "zh",
  mandarin: "zh",
  rus: "ru",
  russian: "ru",
  ukr: "uk",
  ukrainian: "uk",
  tur: "tr",
  turkish: "tr",
  pol: "pl",
  polish: "pl",
  nld: "nl",
  dut: "nl",
  dutch: "nl",
  ind: "id",
  indonesian: "id",
  tha: "th",
  thai: "th",
  vie: "vi",
  vietnamese: "vi",
});

export const COMMON_AUDIO_LANGUAGES = Object.freeze([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "hi",
  "bn",
  "ta",
  "te",
  "mr",
  "pa",
  "ur",
  "ar",
  "ja",
  "ko",
  "zh",
  "ru",
  "uk",
  "tr",
  "pl",
  "nl",
  "id",
  "th",
  "vi",
]);

export function normalizeAudioLanguage(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "und";
  const direct = LANGUAGE_ALIASES[raw];
  if (direct) return direct;
  const base = raw.split(/[-_]/)[0];
  return LANGUAGE_ALIASES[base] ?? normalizeLanguage(base);
}

export function audioLanguageName(value) {
  const language = normalizeAudioLanguage(value);
  return language === UNVERIFIED_AUDIO_LANGUAGE
    ? "Unverified"
    : languageName(language);
}

function attributeList(value) {
  const attributes = {};
  for (const match of String(value).matchAll(
    /([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/gi,
  )) {
    attributes[match[1].toUpperCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function addLanguage(target, value) {
  const language = normalizeAudioLanguage(value);
  if (language !== "und") target.add(language);
}

export function hlsAudioLanguages(manifest) {
  const languages = new Set();
  for (const line of String(manifest).split(/\r?\n/)) {
    if (!line.trimStart().toUpperCase().startsWith("#EXT-X-MEDIA:")) continue;
    const attributes = attributeList(line.slice(line.indexOf(":") + 1));
    if (attributes.TYPE?.toUpperCase() !== "AUDIO") continue;
    addLanguage(languages, attributes.LANGUAGE);
    if (languages.size === 0 || !attributes.LANGUAGE) {
      addLanguage(languages, attributes.NAME);
    }
  }
  return [...languages];
}

export function dashAudioLanguages(manifest) {
  const languages = new Set();
  const source = String(manifest);
  for (const match of source.matchAll(
    /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet\s*>/gi,
  )) {
    const attributes = attributeList(match[1]);
    const body = match[2];
    const audio =
      attributes.CONTENTTYPE?.toLowerCase() === "audio" ||
      attributes.MIMETYPE?.toLowerCase().startsWith("audio/") ||
      /<(?:Representation|ContentComponent)\b[^>]*(?:contentType|mimeType)\s*=\s*["']audio(?:\/[^"']*)?["']/i.test(
        body,
      );
    if (!audio) continue;
    addLanguage(languages, attributes.LANG);
    for (const child of body.matchAll(
      /<(?:Representation|ContentComponent)\b([^>]*)>/gi,
    )) {
      addLanguage(languages, attributeList(child[1]).LANG);
    }
  }
  return [...languages];
}

export function candidateAudioLanguages(candidate, manifest = "") {
  const languages = new Set();
  for (const track of Array.isArray(candidate?.audioTracks)
    ? candidate.audioTracks
    : []) {
    addLanguage(
      languages,
      track?.language ?? track?.lang ?? track?.label ?? track?.name,
    );
  }
  for (const value of Array.isArray(candidate?.audioLanguages)
    ? candidate.audioLanguages
    : []) {
    addLanguage(languages, value);
  }
  addLanguage(languages, candidate?.language ?? candidate?.lang);

  const detected =
    candidate?.type === "hls"
      ? hlsAudioLanguages(manifest)
      : candidate?.type === "dash"
        ? dashAudioLanguages(manifest)
        : [];
  for (const language of detected) languages.add(language);
  return [...languages];
}

export function matchesAudioLanguage(candidate, preferred, manifest = "") {
  const language = normalizeAudioLanguage(preferred);
  const available = candidateAudioLanguages(candidate, manifest);
  return language === UNVERIFIED_AUDIO_LANGUAGE
    ? available.length === 0
    : available.includes(language);
}

/**
 * Whether an audio-only listening stream carries the language the viewer asked for.
 * An audio-only variant carries the same muxed sound as the picture variants beside it, so it fits whatever they
 * were verified to carry. An audio rendition must say it is that language, by tag or by name.
 */
export function listeningAudioFits(plan, requestedLanguage) {
  if (!plan?.rendition) return true;
  const wanted = normalizeAudioLanguage(requestedLanguage);
  if (wanted === UNVERIFIED_AUDIO_LANGUAGE) return true;
  const { language, name } = plan.rendition;
  return (
    (language !== undefined && normalizeAudioLanguage(language) === wanted) ||
    (name !== undefined && normalizeAudioLanguage(name) === wanted)
  );
}

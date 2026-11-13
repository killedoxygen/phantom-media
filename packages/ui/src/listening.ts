/**
 * Listening mode: playing a source as audio, the way a podcast app would, so the picture costs no data.
 *
 * Nothing here knows about a platform. A player hands over what it plays (an HLS master playlist, or a list of
 * files) and gets back the cheapest thing that still carries the sound. HLS semantics follow RFC 8216 §4.3.4.
 */

export type ListeningMode = "video" | "audio";

export type ListeningPlan =
  /**
   * A stream that carries only sound: an audio-only variant, or an audio rendition played on its own.
   * `rendition` is set for the latter, so a player can check its language against the one the viewer asked for.
   */
  | { kind: "audio"; url: string; bandwidth?: number; videoBandwidth?: number; rendition?: { language?: string; name?: string } }
  /** No audio-only stream exists, so the smallest picture plays behind the listening view. */
  | { kind: "reduced"; url: string; bandwidth?: number; videoBandwidth?: number }
  /** The source cannot be thinned. The full source plays behind the listening view. */
  | { kind: "unavailable" };

const VIDEO_CODECS = /^(avc[1-4]|hvc1|hev1|dvh1|dvhe|dva1|dvav|vp0?8|vp09|vp9|av01|mp4v|theora)\b/i;

/** Read an HLS attribute list, keeping commas inside quoted values. */
export function parseHlsAttributes(list: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const [, name, raw] of list.matchAll(pattern)) {
    attributes[name] = raw.startsWith("\"") ? raw.slice(1, -1) : raw;
  }
  return attributes;
}

function codecList(value?: string) {
  return (value ?? "").split(",").map(token => token.trim()).filter(Boolean);
}

/** True only on positive evidence: codecs are declared and none of them carries a picture. */
export function isAudioOnlyCodecs(value?: string) {
  const codecs = codecList(value);
  return codecs.length > 0 && !codecs.some(codec => VIDEO_CODECS.test(codec));
}

function absolute(uri: string, base: string) {
  try { return new URL(uri, base).href; } catch { return null; }
}

function positive(value?: string) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

interface Variant { url: string; bandwidth?: number; audioOnly: boolean; audioGroup?: string }
interface Rendition { url: string; group?: string; language?: string; name?: string; default: boolean; autoselect: boolean }

function readMaster(text: string, base: string) {
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  let pending: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseHlsAttributes(line.slice("#EXT-X-STREAM-INF:".length));
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseHlsAttributes(line.slice("#EXT-X-MEDIA:".length));
      const url = attributes.TYPE === "AUDIO" && attributes.URI ? absolute(attributes.URI, base) : null;
      if (url) renditions.push({
        url, group: attributes["GROUP-ID"], language: attributes.LANGUAGE?.toLowerCase(), name: attributes.NAME,
        default: attributes.DEFAULT === "YES", autoselect: attributes.AUTOSELECT === "YES",
      });
    } else if (!line.startsWith("#") && pending) {
      const url = absolute(line, base);
      if (url) variants.push({
        url,
        bandwidth: positive(pending["AVERAGE-BANDWIDTH"]) ?? positive(pending.BANDWIDTH),
        audioOnly: isAudioOnlyCodecs(pending.CODECS),
        audioGroup: pending.AUDIO,
      });
      pending = null;
    }
  }
  return { variants, renditions };
}

function primaryLanguage(value?: string) {
  return value?.toLowerCase().split("-")[0];
}

/**
 * The cheapest stream in an HLS master that still carries the sound.
 *
 * Preference: an audio-only variant (highest bitrate, since audio is cheap either way), then an audio rendition
 * from the groups the variants use (the preferred language, then the default), then the smallest variant.
 * A media playlist has nothing to choose between, so it is unavailable.
 */
export function planHlsListening(master: string, masterUrl: string, options: { language?: string } = {}): ListeningPlan {
  if (!/^#EXTM3U/.test(master.trimStart())) return { kind: "unavailable" };
  const { variants, renditions } = readMaster(master, masterUrl);
  const video = variants.filter(variant => !variant.audioOnly);
  const videoBandwidth = video.reduce<number | undefined>((best, variant) =>
    variant.bandwidth !== undefined && (best === undefined || variant.bandwidth > best) ? variant.bandwidth : best, undefined);

  const audioVariants = variants.filter(variant => variant.audioOnly);
  if (audioVariants.length) {
    const best = audioVariants.reduce((top, variant) => (variant.bandwidth ?? 0) > (top.bandwidth ?? 0) ? variant : top);
    return { kind: "audio", url: best.url, bandwidth: best.bandwidth, videoBandwidth };
  }

  const groups = new Set(variants.map(variant => variant.audioGroup).filter(Boolean));
  const usable = renditions.filter(rendition => !groups.size || (rendition.group && groups.has(rendition.group)));
  if (usable.length) {
    const language = primaryLanguage(options.language);
    const chosen = (language && usable.find(rendition => primaryLanguage(rendition.language) === language)) ||
      usable.find(rendition => rendition.default) || usable.find(rendition => rendition.autoselect) || usable[0];
    return {
      kind: "audio", url: chosen.url, videoBandwidth,
      rendition: { ...(chosen.language ? { language: chosen.language } : {}), ...(chosen.name ? { name: chosen.name } : {}) },
    };
  }

  if (video.length > 1) {
    const smallest = video.reduce((low, variant) =>
      (variant.bandwidth ?? Infinity) < (low.bandwidth ?? Infinity) ? variant : low);
    if (smallest.bandwidth !== undefined && smallest.bandwidth !== videoBandwidth) {
      return { kind: "reduced", url: smallest.url, bandwidth: smallest.bandwidth, videoBandwidth };
    }
  }
  return { kind: "unavailable" };
}

/**
 * For players whose engine already knows the bitrate ladder (DASH representations, or HLS levels once parsed):
 * listening caps playback to the cheapest rung of `url`, when that saves anything.
 */
export function planLowestRung(url: string, bitrates: readonly number[]): ListeningPlan {
  const known = bitrates.filter(rate => Number.isFinite(rate) && rate > 0);
  if (known.length < 2) return { kind: "unavailable" };
  const bandwidth = Math.min(...known);
  const videoBandwidth = Math.max(...known);
  return bandwidth < videoBandwidth ? { kind: "reduced", url, bandwidth, videoBandwidth } : { kind: "unavailable" };
}

/**
 * For sources offered as whole files: the smallest one, since a file cannot drop its picture.
 * `size` returns the file's bitrate or picture height; files without one are only chosen when nothing has one.
 */
export function pickListeningFile<T>(files: readonly T[], size: (file: T) => number | undefined): T | undefined {
  let chosen: T | undefined;
  let chosenSize = Infinity;
  for (const file of files) {
    const value = size(file);
    const comparable = value !== undefined && Number.isFinite(value) && value > 0 ? value : Infinity;
    if (chosen === undefined || comparable < chosenSize) {
      chosen = file;
      chosenSize = comparable;
    }
  }
  return chosen;
}

function formatRate(bitsPerSecond: number) {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond >= 10_000_000 ? 0 : 1)} Mb/s`
    : `${Math.max(1, Math.round(bitsPerSecond / 1_000))} kb/s`;
}

/** The plan in a sentence, for the settings sheet. */
export function describeListeningPlan(plan: ListeningPlan | null | undefined): string {
  if (!plan || plan.kind === "unavailable") {
    return "Hides the picture and keeps playing the sound. This source has no lighter stream, so it uses the same data.";
  }
  const saving = plan.bandwidth && plan.videoBandwidth && plan.videoBandwidth > plan.bandwidth
    ? ` About ${formatRate(plan.bandwidth)} instead of ${formatRate(plan.videoBandwidth)}, ${Math.round((1 - plan.bandwidth / plan.videoBandwidth) * 100)}% less.`
    : "";
  return plan.kind === "audio"
    ? `Plays only the sound, like a podcast, and stops downloading the picture.${saving}`
    : `This source has no audio-only stream, so the smallest picture plays behind the cover.${saving}`;
}

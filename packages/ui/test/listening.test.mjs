import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeListeningPlan, isAudioOnlyCodecs, parseHlsAttributes, pickListeningFile, planHlsListening, planLowestRung,
} from "../src/listening.ts";

const base = "https://media.example/live/master.m3u8";

test("attribute lists keep commas inside quoted values", () => {
  assert.deepEqual(parseHlsAttributes('BANDWIDTH=160000,CODECS="mp4a.40.2,ac-3",VIDEO="audio_only"'),
    { BANDWIDTH: "160000", CODECS: "mp4a.40.2,ac-3", VIDEO: "audio_only" });
});

test("audio-only needs positive evidence: declared codecs, none of them video", () => {
  assert.equal(isAudioOnlyCodecs("mp4a.40.2"), true);
  assert.equal(isAudioOnlyCodecs("opus,ec-3"), true);
  assert.equal(isAudioOnlyCodecs("avc1.64002A,mp4a.40.2"), false);
  assert.equal(isAudioOnlyCodecs("hvc1.1.6.L93.B0,mp4a.40.2"), false);
  assert.equal(isAudioOnlyCodecs("av01.0.08M.08"), false);
  assert.equal(isAudioOnlyCodecs(""), false);
  assert.equal(isAudioOnlyCodecs(undefined), false);
});

test("an audio-only variant is chosen over every picture, with the saving against the best picture", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000',
    "/api/live/media.m3u8?url=chunked",
    '#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=284x160,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="160p30"',
    "/api/live/media.m3u8?url=160p",
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"',
    "/api/live/media.m3u8?url=audio_only",
  ].join("\n");
  const plan = planHlsListening(master, base);
  assert.deepEqual(plan, { kind: "audio", url: "https://media.example/api/live/media.m3u8?url=audio_only", bandwidth: 160000, videoBandwidth: 8000000 });
  assert.match(describeListeningPlan(plan), /160 kb\/s instead of 8\.0 Mb\/s, 98% less/);
});

test("an alternate audio rendition plays on its own, in the preferred language", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="es",NAME="Español",DEFAULT=YES,AUTOSELECT=YES,URI="audio/es.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en-US",NAME="English",AUTOSELECT=YES,URI="audio/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="unused",LANGUAGE="fr",URI="audio/fr.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"',
    "video/1080.m3u8",
  ].join("\n");
  assert.deepEqual(planHlsListening(master, base, { language: "en" }), {
    kind: "audio", url: "https://media.example/live/audio/en.m3u8", videoBandwidth: 5000000,
    rendition: { language: "en-us", name: "English" },
  });
  assert.equal(planHlsListening(master, base).url, "https://media.example/live/audio/es.m3u8");
  assert.equal(planHlsListening(master, base, { language: "fr" }).url, "https://media.example/live/audio/es.m3u8");
});

test("regional audio preferences use an exact match before another variant of the language", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="es",DEFAULT=YES,URI="audio/es.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en-US",URI="audio/us.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en-GB",URI="audio/gb.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="unused",LANGUAGE="en-AU",URI="audio/au.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"',
    "video/1080.m3u8",
  ].join("\n");
  const audioUrl = language => planHlsListening(master, base, { language }).url;

  assert.equal(audioUrl("en-GB"), "https://media.example/live/audio/gb.m3u8");
  assert.equal(audioUrl("EN-gb"), "https://media.example/live/audio/gb.m3u8");
  assert.equal(audioUrl("en-AU"), "https://media.example/live/audio/us.m3u8");
  assert.equal(audioUrl("en"), "https://media.example/live/audio/us.m3u8");
  assert.equal(audioUrl("fr-CA"), "https://media.example/live/audio/es.m3u8");
});

test("without audio of its own, the smallest picture plays", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2"', "720.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,AVERAGE-BANDWIDTH=350000,CODECS="avc1.42c015,mp4a.40.2"', "240.m3u8",
  ].join("\n");
  assert.deepEqual(planHlsListening(master, base), { kind: "reduced", url: "https://media.example/live/240.m3u8", bandwidth: 350000, videoBandwidth: 3000000 });
});

test("a single picture, a media playlist or something else cannot be thinned", () => {
  assert.deepEqual(planHlsListening('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nonly.m3u8', base), { kind: "unavailable" });
  assert.deepEqual(planHlsListening("#EXTM3U\n#EXTINF:2,\nsegment.ts", base), { kind: "unavailable" });
  assert.deepEqual(planHlsListening("<html>", base), { kind: "unavailable" });
  assert.match(describeListeningPlan({ kind: "unavailable" }), /same data/);
});

test("ambiguous variants without codecs are never mistaken for audio", () => {
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nb.m3u8";
  assert.equal(planHlsListening(master, base).kind, "reduced");
});

test("files: the smallest one with a known size", () => {
  const files = [{ key: "1080" }, { key: "source" }, { key: "360" }, { key: "720" }];
  assert.equal(pickListeningFile(files, file => Number.parseInt(file.key, 10) || undefined)?.key, "360");
  assert.equal(pickListeningFile([{ key: "a" }], () => undefined)?.key, "a");
  assert.equal(pickListeningFile([], () => 1), undefined);
});

test("an engine's own ladder: the cheapest rung, only when it saves something", () => {
  assert.deepEqual(planLowestRung("m.mpd", [4_000_000, 600_000, 1_500_000]), { kind: "reduced", url: "m.mpd", bandwidth: 600_000, videoBandwidth: 4_000_000 });
  assert.deepEqual(planLowestRung("m.mpd", [2_000_000, 0]), { kind: "unavailable" });
  assert.deepEqual(planLowestRung("m.mpd", [900, 900]), { kind: "unavailable" });
});

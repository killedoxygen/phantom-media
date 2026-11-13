import assert from "node:assert/strict";
import test from "node:test";
import { listeningAudioFits } from "../src/media-language.mjs";

test("an audio-only variant fits whatever language the picture carried", () => {
  assert.equal(listeningAudioFits({ kind: "audio", url: "a.m3u8" }, "en"), true);
});

test("an audio rendition must name the requested language", () => {
  const plan = (rendition) => ({ kind: "audio", url: "a.m3u8", rendition });
  assert.equal(listeningAudioFits(plan({ language: "en-us" }), "en"), true);
  assert.equal(listeningAudioFits(plan({ name: "English" }), "en"), true);
  assert.equal(listeningAudioFits(plan({ language: "es", name: "Español" }), "en"), false);
  assert.equal(listeningAudioFits(plan({}), "en"), false);
});

test("without a requested language, any rendition fits", () => {
  assert.equal(listeningAudioFits({ kind: "audio", url: "a", rendition: { language: "fr" } }, "und"), true);
});

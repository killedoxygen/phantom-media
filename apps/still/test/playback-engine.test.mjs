import assert from "node:assert/strict";
import { test } from "node:test";
import { canProcessAudio, prefersNativeHls } from "../lib/media/engine.ts";

const iphone = { mediaSource: false, managedMediaSource: true, nativeHls: true };

test("iPhone recordings play through Safari's own HLS", () => {
  assert.equal(prefersNativeHls(iphone, false), true);
});

test("live keeps hls.js on iPhone", () => {
  assert.equal(prefersNativeHls(iphone, true), false);
});

test("browsers with the classic MediaSource keep hls.js", () => {
  assert.equal(prefersNativeHls({ mediaSource: true, managedMediaSource: true, nativeHls: true }, false), false);
  assert.equal(prefersNativeHls({ mediaSource: true, managedMediaSource: false, nativeHls: true }, false), false);
});

test("a ManagedMediaSource without native HLS keeps hls.js", () => {
  assert.equal(prefersNativeHls({ mediaSource: false, managedMediaSource: true, nativeHls: false }, false), false);
});

test("listening to live on iPhone uses Safari's own HLS, so the screen can lock", () => {
  assert.equal(prefersNativeHls(iphone, true, true), true);
  assert.equal(prefersNativeHls({ mediaSource: true, managedMediaSource: true, nativeHls: true }, true, true), false);
});

test("audio processing needs readable media and a platform that keeps Web Audio running", () => {
  const desktop = { mediaSource: true, managedMediaSource: false, nativeHls: false };
  assert.equal(canProcessAudio(desktop, "hls.js", "hls"), true);
  assert.equal(canProcessAudio(desktop, "native", "file"), true);
  assert.equal(canProcessAudio(desktop, "native", "hls"), false);
  assert.equal(canProcessAudio({ ...iphone, mobileWebKit: true }, "hls.js", "hls"), false);
  assert.equal(canProcessAudio({ ...iphone, mobileWebKit: true }, "native", "file"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { prefersNativeHls } from "../lib/media/engine.ts";

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

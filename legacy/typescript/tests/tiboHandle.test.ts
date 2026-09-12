import assert from "node:assert/strict";
import test from "node:test";

import { getTiboDisplayLabel, getTiboHandle } from "../lib/radar/tiboHandle";

test("extracts the safe handle from an X status URL before saved metadata", () => {
  assert.equal(
    getTiboHandle(
      "https://x.com/thsottiaux/status/2086189414292865249",
      "Tibo (@tibo_maker)",
    ),
    "thsottiaux",
  );
});

test("accepts Twitter status URLs and falls back safely", () => {
  assert.equal(
    getTiboDisplayLabel("https://twitter.com/thsottiaux/status/123"),
    "Tibo (@thsottiaux)",
  );
  assert.equal(
    getTiboDisplayLabel("https://example.com/posts/123", "Tibo (@saved_handle)"),
    "Tibo (@saved_handle)",
  );
  assert.equal(getTiboDisplayLabel(null), "Tibo (@thsottiaux)");
});

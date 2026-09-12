import assert from "node:assert/strict";
import test from "node:test";

import { getRadarViewModel, getLocalRadarData } from "../lib/radar";
import { hasOfficialNoticeForLog } from "../lib/logProbability";

test("log probability marks a dynamic official notice as official", () => {
  const now = Date.now();
  const data = getLocalRadarData({
    activeTiboSignals: [
      {
        tweet_id: "route-reset",
        signal_type: "reset_executed",
        confidence: 0.98,
        tweet_created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
      {
        tweet_id: "route-notice",
        signal_type: "official_notice",
        text: "A dynamic official reset notice",
        confidence: 0.96,
        tweet_created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        expires_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        verification_status: "auto_unverified",
      },
    ],
  });

  const viewModel = getRadarViewModel(data, "ja");

  assert.equal(viewModel.activeWindow.active, true);
  assert.equal(viewModel.activeWindow.kind, "official");
  assert.equal(hasOfficialNoticeForLog(viewModel), true);
});

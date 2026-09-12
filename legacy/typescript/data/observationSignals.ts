export type LocalObservationSignal = {
  id: string;
  observedAt: string;
  expectedAt?: string;
  expectedEndAt?: string;
  type: "official_notice" | "official_incident_hint" | "probability_boost" | "status_incident" | "community_report" | "limit_anomaly";
  status: "active" | "resolved" | "expired";
  expiresAt?: string;
  resolvedAt?: string;
  boostValue?: number;
  boostValue24h?: number;
  boostValue48h?: number;
  boostDecayHours?: number;
  boostReason?: string;
  title: string;
  source: string;
  sourceLabel: string;
  skipAutoHistoryMerge?: boolean;
  keywords?: Array<string>;
};

export const LOCAL_OBSERVATION_SIGNALS: Array<LocalObservationSignal> = [
  {
    id: "official-tibo-signs-resets-teaser-2026-07-31",
    observedAt: "2026-07-31T04:53:19.170Z",
    type: "probability_boost",
    status: "resolved",
    resolvedAt: "2026-08-01T03:32:00.000Z",
    expiresAt: "2026-08-01T23:59:59.000Z",
    boostValue24h: 0.10,
    boostValue48h: 0.10,
    boostDecayHours: 48,
    boostReason: "Tibo氏の「There will be signs... Resets」匂わせ投稿",
    title: "Tibo氏の「There will be signs... Resets」匂わせ投稿",
    source: "https://x.com/thsottiaux/status/2083053369351090254",
    sourceLabel: "Tibo氏（OpenAI Codex開発責任者）のXポストより",
  },
  {
    id: "official-tibo-recharge-tomorrow-hint-2026-07-28",
    observedAt: "2026-07-27T19:00:00.000Z",
    type: "probability_boost",
    status: "resolved",
    resolvedAt: "2026-07-29T13:09:00.000Z",
    expiresAt: "2026-07-30T04:00:00.000Z",
    boostValue24h: 0.230,
    boostValue48h: 0.55,
    boostDecayHours: 48,
    boostReason: "Tibo氏の「明日また会いましょう」匂わせ投稿",
    title: "Tibo氏の「明日また会いましょう」匂わせ投稿",
    source: "https://x.com/thsottiaux/status/1987541298716945904",
    sourceLabel: "Tibo氏（OpenAI Codex開発責任者）のXポストより",
  },
];

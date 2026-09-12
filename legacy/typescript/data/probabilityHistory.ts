export type ProbabilityHistoryItem = {
  id: string;
  recordedAt: string;
  probability12h?: number;
  probability24h: number;
  probability48h: number;
  probability72h?: number;
  expectation: "低" | "中" | "高" | "超高" | "不明";
  displayedProbability24h: string;
  displayedProbability48h: string;
  reason: string;
  note?: string;
};

export const LOCAL_PROBABILITY_HISTORY: Array<ProbabilityHistoryItem> = [
  {
    id: "probability-2026-06-18-0700-jst",
    recordedAt: "2026-06-18T07:00:00+09:00",
    probability24h: 0.02,
    probability48h: 0.02,
    expectation: "低",
    displayedProbability24h: "2%",
    displayedProbability48h: "2%",
    reason:
      "6/18 07:00 JSTのリセット実施後。直近のリセット直後で、activeな公式予告や障害・容量到達シグナルはありません。",
    note:
      "サイト画面には表示しない内部記録。今後、表示中の確率を時系列で比較するために残します。",
  },
];

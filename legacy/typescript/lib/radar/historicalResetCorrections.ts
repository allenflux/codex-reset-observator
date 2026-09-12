export const ASTRA_BANKED_HISTORY_EVENT_KEY = "banked-reset-2095651088502591861";
export const ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY = `${ASTRA_BANKED_HISTORY_EVENT_KEY}-observation-20260904T234601897Z`;
export const ASTRA_BANKED_HISTORY_SOURCE_TWEET_ID = "2095651088502591861";

type HistoricalResetTitleTranslationKey =
  | "astraBankedHistoryTitle"
  | "astraBankedHistorySecondTitle";

type HistoricalResetCorrection = {
  correctionId: "astra-banked-history";
  scopeCorrectionEventKeys: readonly string[];
  presentationEventKeys: readonly string[];
  sourceTweetId: string;
  presentation: {
    defaultTitleTranslationKey: HistoricalResetTitleTranslationKey;
    titleTranslationKeysByEventKey: ReadonlyArray<{
      eventKey: string;
      translationKey: HistoricalResetTitleTranslationKey;
    }>;
    reasonType: "ご祝儀リセット";
    noteTranslationKey: "astraBankedHistoryNote";
  };
};

/**
 * Historical corrections are keyed by known event/source identity, never by
 * post text. Scope correction intentionally has narrower matching than
 * presentation correction because the two have different contracts.
 */
export const HISTORICAL_RESET_CORRECTIONS: readonly HistoricalResetCorrection[] = [
  {
    correctionId: "astra-banked-history",
    scopeCorrectionEventKeys: [
      ASTRA_BANKED_HISTORY_EVENT_KEY,
      ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY,
    ],
    // The second key selects its title after provenance has matched; it was
    // not a standalone presentation matcher in the legacy implementation.
    presentationEventKeys: [ASTRA_BANKED_HISTORY_EVENT_KEY],
    sourceTweetId: ASTRA_BANKED_HISTORY_SOURCE_TWEET_ID,
    presentation: {
      defaultTitleTranslationKey: "astraBankedHistoryTitle",
      titleTranslationKeysByEventKey: [
        {
          eventKey: ASTRA_BANKED_HISTORY_EVENT_KEY,
          translationKey: "astraBankedHistoryTitle",
        },
        {
          eventKey: ASTRA_BANKED_SECOND_HISTORY_EVENT_KEY,
          translationKey: "astraBankedHistorySecondTitle",
        },
      ],
      reasonType: "ご祝儀リセット",
      noteTranslationKey: "astraBankedHistoryNote",
    },
  },
];

export type HistoricalResetPresentationLookup = {
  recordKind?: string | null;
  eventKey?: string | null;
  officialNoticeTweetId?: string | null;
  sourceTweetIds?: ReadonlyArray<string | null | undefined> | null;
};

export type HistoricalResetPresentationCorrection = {
  correctionId: string;
  sourceTweetId: string;
  titleTranslationKey: HistoricalResetTitleTranslationKey;
  reasonType: "ご祝儀リセット";
  noteTranslationKey: "astraBankedHistoryNote";
};

export function hasHistoricalResetScopeCorrection(eventKey: string | null | undefined) {
  return typeof eventKey === "string" && HISTORICAL_RESET_CORRECTIONS.some((correction) =>
    correction.scopeCorrectionEventKeys.includes(eventKey),
  );
}

export function getHistoricalResetPresentationCorrection(
  input: HistoricalResetPresentationLookup,
): HistoricalResetPresentationCorrection | null {
  if (input.recordKind !== "banked_distribution") return null;

  const officialNoticeTweetId = input.officialNoticeTweetId?.trim();
  const correction = HISTORICAL_RESET_CORRECTIONS.find((candidate) =>
    (input.eventKey !== null && input.eventKey !== undefined &&
      candidate.presentationEventKeys.includes(input.eventKey)) ||
    officialNoticeTweetId === candidate.sourceTweetId ||
    (input.sourceTweetIds?.includes(candidate.sourceTweetId) ?? false),
  );
  if (!correction) return null;

  const exactTitle = input.eventKey !== null && input.eventKey !== undefined
    ? correction.presentation.titleTranslationKeysByEventKey.find((entry) => entry.eventKey === input.eventKey)
    : undefined;

  return {
    correctionId: correction.correctionId,
    sourceTweetId: correction.sourceTweetId,
    titleTranslationKey: exactTitle?.translationKey ?? correction.presentation.defaultTitleTranslationKey,
    reasonType: correction.presentation.reasonType,
    noteTranslationKey: correction.presentation.noteTranslationKey,
  };
}

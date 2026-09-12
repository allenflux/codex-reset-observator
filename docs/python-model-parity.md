# Python domain migration and model evidence

The Python service keeps the completed reset history, three-language public snapshot,
regular seven-day forecast, social-post signal classes, recovery observations, and
random-reset probability baseline. The additional neural network is implemented in
`observatory/neural.py`; it is a separately versioned model and does not overwrite
historical predictions from the TypeScript system.

## Numerical baseline

`observatory/probability.py` ports the active September 11, 2026 corrective rollback
baseline, not the earlier B-family selective-calibration model. Its explicit identity
is `python-hazard-odds-calibrated-v1` because the migration supports a smaller set of
historical identity and override policies than the original application.

The following numerical rules are retained:

- Broad completed random events include forced resets and broad banked credit
  distributions. Regular, reference, conditional/narrow-scope, pending, excluded,
  invalid-time and future records do not train the random hazard. Distinct
  authoritative Banked grant IDs remain separate even when they share one
  persistent announcement post.
- Twenty-four-hour elapsed-age bins have a tail beginning at seven days. An open
  interval contributes censored exposure without an event. The global prior is
  one event per ten exposure days; bin shrinkage uses twenty equivalent exposure
  days. Daily baseline probability is bounded to 0.01–0.35.
- Recency weighting uses exponential half-life decay on completed intervals and
  weight one for the current censored interval. The H30 baseline is available via
  `calculate_raw(..., half_life_days=30)`.
- Teaser, severity-weighted status, official hint/update, community and anomaly
  odds multipliers retain the original coefficients and combined caps (5/6).
  Regular proximity and recent reset counts do not raise random-event odds.
- Calibration origins are Japanese midnights, beginning after five completed
  intervals. Each horizon uses only rows with complete follow-up at the current
  origin. The normal intercept prior has standard deviation 0.5, minimum sample
  count ten, and the same bounded Newton solver as the TypeScript code.
- Future status updates are projected to conservative investigating state;
  current aggregate environmental counts are omitted from historical fits.
  Execution estimates require all availability timestamps to precede the origin.
- Horizon coherence and derived 12-hour / 72-hour probabilities follow the public
  TypeScript presentation. Public calculations use ten-minute UTC buckets.
- Official notices require confidence at least 0.95, a future explicit expiry,
  non-reply status and no rejection. Resolved timing windows restrict boosts to
  overlapping horizons. An untimed accepted notice retains the 0.90/0.96 override.

## Executed parity checks

The fixture `tests_python/fixtures/domain_golden.json` was generated from the existing
TypeScript implementation at `2026-09-12T00:00:00Z` and `2026-08-22T00:00:00Z`, using
its checked-in 30-row reset history, no dynamic radar payload and no local signals.
Python agrees within `1e-12` on both calibrated probabilities, raw probabilities,
intercepts, sample counts, positive counts, and H30 bin hazards. Weighted exposure
agrees within `1e-10` hours.

For example, at September 12 midnight UTC, the TypeScript calibrated 24-hour result
is `0.21591356914704388`; Python produces `0.21591356914704396`. This validates the
ported mathematics on these controlled fixtures, not every historical live input.
The original generated output is retained in
`reports/python-migration/typescript-golden.json` for audit.

Other domain tests cover pending/future/conditional exclusion, post identity
deduplication, weekly anchors, calibration minimum samples, censored exposure,
future-status leakage, classifier safety, notice timing, observed-recovery privacy,
unsafe links and validated monitor estimates.

## Data, schedules and public projection

`load_data()` treats the complete online structured history as authoritative when
it is valid, with the old local seed as an offline fallback. The online timestamp
wins when an event was corrected; local-only retired records are not reintroduced. Existing Japanese and
English title translations remain available; the online Chinese text is retained
for Chinese. Online source metadata is preserved internally. Raw social text is
classified by deterministic rules; the Python runtime does not call an LLM for
extraction or classification.

A weekly forecast anchors to the latest completed regular or broad forced reset.
A banked credit distribution alone does not move that anchor. Missing observed
weekly completions are not inserted as factual history just because time passed.
Public fields preserve approximate timestamps where the source declares them.

The snapshot is assembled with explicit fields, rather than serializing repository
rows. API credentials, classification audit details, usage percentages, account
plans and recovery IDs are excluded. A fresh strong unexpected recovery is shown
as unconfirmed for up to 90 minutes unless a consumed estimate already represents it.

## Boundaries of the migration

The original A/B/C shadow experiments, every historical model-adoption selector,
manual persistent/terminated notice registry, composite-post secondary expansion,
X edit-chain logical identities, AI-generated names and advanced notice-window
reconciliation are not reproduced as equivalent Python models. Existing exported
historical records remain available. The rule classifier retains the major safety
patterns; semantic teaser strength is conservatively `weak` for a rule match and
is not represented as an AI judgement.

The original post-calibration strong timed teaser floor is not applied by this
baseline. The separately fitted neural model uses event timestamps only, and is
published with its own out-of-time evaluation and experimental status. Neither
baseline parity fixtures nor a neural fit establish reliable future accuracy.

## 当前主预测

Python 网站使用自己的实验性神经网络输出主界面 24／48 小时概率，`primaryForecast` 标明模型和实验状态；`statisticalBaseline` 保留统计结果用于比较。神经网络未提供的 12／72 小时概率返回 null，模型不可用时回退到统计模型。以上与原站统计数值的兼容验证是不同范围；帖子文本和上游 LLM 标签目前不进入神经网络。

import type {
  HistoryNoticeType,
  Locale,
  LocalizedString,
  ResetCycleType,
  ResetMethodType,
  ResetReasonType,
  ResetScopeType,
} from "./types";
import { SITE_NAME } from "../siteMetadata";

export const UI_TRANSLATIONS: Record<string, Record<Locale, string>> = {
  title: {
    ja: SITE_NAME,
    en: SITE_NAME,
    zh: SITE_NAME,
  },
  siteStatus: {
    ja: "サイトの状態",
    en: "Update status",
    zh: "更新状态",
  },
  manualReviewAvailable: {
    ja: "🟢 手動確認対応中",
    en: "🟢 Manual review active",
    zh: "🟢 人工确认进行中",
  },
  manualReviewDelayed: {
    ja: "🌙 手動確認が遅れる場合があります",
    en: "🌙 Manual review may be delayed",
    zh: "🌙 人工确认可能会延迟",
  },
  lastCheckedLabel: {
    ja: "最終更新時刻",
    en: "Last updated",
    zh: "上次更新",
  },
  degradedDataWarning: {
    ja: "一部のライブ情報源を取得できていないため、見積もりが不完全な可能性があります。",
    en: "Some live sources are unavailable, so this estimate may be incomplete.",
    zh: "部分实时数据源暂不可用，因此当前估算可能不完整。",
  },
  dataUnavailable: {
    ja: "ライブデータも保存済みデータも取得できません。確率表示を一時停止しています。",
    en: "Live and cached data are unavailable. Probability values are temporarily hidden.",
    zh: "实时数据和缓存数据均不可用，概率数值已暂时隐藏。",
  },
  lastSuccessfulRefresh: {
    ja: "最終更新",
    en: "Last updated",
    zh: "最后更新",
  },
  unknownProbability: { ja: "不明", en: "Unknown", zh: "未知" },
  noticePostedAt: { ja: "予告投稿時刻", en: "Notice posted", zh: "预告发布时间" },
  subTitle: {
    ja: "Codex制限解除・使用量リセット情報",
    en: "Codex reset notices, history, and probability",
    zh: "Codex 使用限制重置信息",
  },
  description: {
    ja: "Codexのリセット予測、最新情報、過去の履歴をまとめて確認できます。",
    en: "Check Codex reset forecasts, official updates, and recent reset history in one place.",
    zh: "集中查看 Codex 的重置预测、最新信息和近期重置记录。",
  },
  officialNotice: {
    ja: "公式リセット予告",
    en: "Reset-related notice",
    zh: "重置相关预告",
  },
  noNotice: {
    ja: "公式リセット予告はありません",
    en: "No reset-related notice",
    zh: "暂无官方重置预告",
  },
  activeNoticeLabel: {
    ja: "予告あり",
    en: "Notice available",
    zh: "已有预告",
  },
  bankedNoticeLabel: {
    ja: "BANKEDリセット（任意リセット権）の配布が予告されています。",
    en: "A BANKED Reset distribution has been announced.",
    zh: "已发布 BANKED 重置发放预告。",
  },
  ongoingBankedNoticeLabel: {
    ja: "BANKEDリセット配布案内",
    en: "BANKED Reset Distribution Notice",
    zh: "BANKED 重置发放说明",
  },
  ongoingBankedNoticeContext: {
    ja: "継続中のBANKED配布方針",
    en: "Ongoing BANKED distribution policy",
    zh: "持续中的 BANKED 发放政策",
  },
  ongoingBankedNoticeSummary: {
    ja: "GPT-6 Astraにまだアクセスできない有料ChatGPTユーザーには、BANKEDリセットが毎日配布される方針が案内されています。",
    en: "A policy has been announced to distribute BANKED Resets every day to paid ChatGPT users who still do not have access to GPT-6 Astra.",
    zh: "已公布一项政策：每天向仍无法访问 GPT-6 Astra 的付费 ChatGPT 用户发放 BANKED 重置。",
  },
  bankedNoticeAdvice: {
    ja: "任意のタイミングで使用できるため、無理にCodexの使用量を使い切る必要はありません。",
    en: "Because it can be used at any time, you do not need to use up your Codex quota.",
    zh: "由于可以在任意时间使用，无需为了重置而用完 Codex 的使用额度。",
  },
  noNoticeLabel: {
    ja: "予告なし",
    en: "No notice",
    zh: "无预告",
  },
  officialNoticeStatus: {
    ja: "公式リセット予告",
    en: "Official reset notice",
    zh: "官方重置预告",
  },
  noOfficialNotice: {
    ja: "なし",
    en: "None",
    zh: "无",
  },
  codexIncidentStatus: {
    ja: "Codex関連障害",
    en: "Codex incidents",
    zh: "Codex 相关故障",
  },
  noCodexIncident: {
    ja: "なし",
    en: "None",
    zh: "无",
  },
  activeCodexIncident: {
    ja: "あり",
    en: "Active",
    zh: "有",
  },
  recoveredCodexIncident: {
    ja: "復旧直後",
    en: "Recently recovered",
    zh: "刚刚恢复",
  },
  outlookOfficialNotice: {
    ja: "公式のリセット予告が確認されています。予告内容を踏まえ、リセットの見込みが高まっています。",
    en: "An official reset notice has been confirmed. Considering the notice, the outlook for a reset is higher.",
    zh: "已确认有官方重置预告。结合预告内容，重置的可能性有所上升。",
  },
  outlookOfficialNoticeWithin24: {
    ja: "公式のリセット予告が24時間以内の予定に入っています。",
    en: "The official reset notice falls within the next 24 hours.",
    zh: "官方重置预告的时间落在未来 24 小时内。",
  },
  outlookOfficialNoticeWithin48: {
    ja: "公式のリセット予告があり、48時間以内の見込みを押し上げています。",
    en: "An official reset notice is active and raises the outlook within 48 hours.",
    zh: "已有官方重置预告，正在提高未来 48 小时内的预期。",
  },
  outlookOfficialNoticeOutsideForecast: {
    ja: "公式のリセット予告はありますが、まだ24時間・48時間の予測範囲外です。",
    en: "An official reset notice is active, but it is outside the next 24- and 48-hour forecast windows.",
    zh: "已有官方重置预告，但目前仍在未来 24 小时和 48 小时预测范围之外。",
  },
  outlookMajorModelRelease: {
    ja: "GPT-6 Astraのリリース直後のため、通常よりリセット確率を高めに予測しています。",
    en: "Because GPT-6 Astra was just released, we are forecasting a higher reset probability than usual.",
    zh: "由于 GPT-6 Astra 刚刚发布，我们预测重置概率将高于平时。",
  },
  outlookStrongTeaser: {
    ja: "リセットを示唆する投稿が確認されています。通常時よりリセットの見込みが高まっています。",
    en: "A post suggesting a reset has been confirmed. The outlook is higher than usual.",
    zh: "已确认有暗示重置的帖子，重置的可能性高于平时。",
  },
  outlookStrongTimedTeaser: {
    ja: "Tiboがリセットを強く示唆しています。示唆された時間帯は{start}〜{end}で、通常よりリセットの可能性が高まっています。",
    en: "Tibo is strongly hinting at a reset. The hinted window is {start}–{end}, so the chance of a reset is higher than usual.",
    zh: "Tibo 正在强烈暗示可能会重置。暗示的时间窗口为{start}至{end}，因此重置的可能性高于平时。",
  },
  outlookStrongTimedTeaserGrace: {
    ja: "Tiboが示唆した時間帯（{start}〜{end}）は過ぎましたが、直後のためリセットの可能性はまだ通常より高めです。",
    en: "The window Tibo hinted at ({start}–{end}) has passed, but it ended recently, so the chance of a reset is still higher than usual.",
    zh: "Tibo 暗示的时间窗口（{start}至{end}）已经结束，但由于刚刚结束，重置的可能性目前仍高于平时。",
  },
  outlookActiveIncident: {
    ja: "Codex関連の障害が確認されています。復旧対応などに伴うリセットの可能性も含めて注視しています。",
    en: "A Codex-related incident has been confirmed. We are watching for a possible reset connected with recovery work.",
    zh: "已确认有 Codex 相关故障，我们也在关注是否会因恢复处理等情况而发生重置。",
  },
  outlookWeakTeaser: {
    ja: "弱いリセット匂わせ投稿があります。",
    en: "A weak reset hint is present.",
    zh: "目前有一条较弱的重置暗示。",
  },
  outlookWeakTimedTeaser: {
    ja: "Tiboがリセットの可能性をほのめかしています。示唆された時間帯は{start}〜{end}で、リセットの見込みがやや高まっています。",
    en: "Tibo may be hinting at a reset. The hinted window is {start}–{end}, so the chance of a reset is slightly higher than usual.",
    zh: "Tibo 可能在暗示会有重置。暗示的时间窗口为{start}至{end}，因此重置的可能性略高于平时。",
  },
  outlookWeakTimedTeaserGrace: {
    ja: "Tiboがほのめかした時間帯（{start}〜{end}）は過ぎましたが、直後のためリセットの見込みはまだ少し高めです。",
    en: "The window Tibo hinted at ({start}–{end}) has passed, but it ended recently, so the chance of a reset is still slightly higher than usual.",
    zh: "Tibo 暗示的时间窗口（{start}至{end}）已经结束，但由于刚刚结束，重置的可能性目前仍略高于平时。",
  },
  outlookUsageAnomaly: {
    ja: "利用上限まわりの異常が確認されており、リセットの可能性がやや高まっています。",
    en: "Usage-limit anomalies have been observed, so the possibility of a reset is somewhat higher.",
    zh: "已发现使用上限相关异常，重置的可能性略有上升。",
  },
  outlookLowCooldown: {
    ja: "前回のランダムリセットから{elapsed}しか経過しておらず、過去の発生傾向でもリセット直後は起きにくいため、現在の見込みは低めです。",
    en: "It has only been {elapsed} since the last random reset, and resets have historically been less common immediately after a reset, so the current outlook is low.",
    zh: "距离上次随机重置仅过去{elapsed}，根据过去的发生趋势，重置后不久通常较少发生重置，因此目前的可能性较低。",
  },
  outlookLowCooldownSubminute: {
    ja: "前回のランダムリセットからまだ1分も経過しておらず、過去の発生傾向でもリセット直後は起きにくいため、現在の見込みは低めです。",
    en: "Less than a minute has passed since the last random reset, and resets have historically been less common immediately after a reset, so the current outlook is low.",
    zh: "距离上次随机重置还不到1分钟，根据过去的发生趋势，重置后不久通常较少发生重置，因此目前的可能性较低。",
  },
  outlookLowHistorical: {
    ja: "前回のランダムリセットから{elapsed}が経過していますが、過去の発生傾向では今後24〜48時間のリセット発生率が低いため、現在の見込みは低めです。",
    en: "It has been {elapsed} since the last random reset, but historical reset rates over the next 24–48 hours are low, so the current outlook is low.",
    zh: "距离上次随机重置已过去{elapsed}，但根据过去的发生趋势，未来24至48小时内的重置发生率较低，因此目前的可能性较低。",
  },
  outlookModerateApproaching: {
    ja: "前回のランダムリセットから{elapsed}が経過し、今後24〜48時間が過去にリセットの起きやすかった時間帯に近づいているため、現在の見込みは中程度です。",
    en: "It has been {elapsed} since the last random reset, and the next 24–48 hours approach periods when resets have historically been more likely, so the current outlook is moderate.",
    zh: "距离上次随机重置已过去{elapsed}，未来24至48小时将逐渐接近过去较容易发生重置的时段，因此目前的可能性处于中等水平。",
  },
  outlookHighOverlap: {
    ja: "前回のランダムリセットから{elapsed}が経過し、今後24〜48時間が過去にリセットの起きやすかった時間帯と重なるため、現在の見込みは高めです。",
    en: "It has been {elapsed} since the last random reset, and the next 24–48 hours overlap periods when resets have historically been more likely, so the current outlook is high.",
    zh: "距离上次随机重置已过去{elapsed}，未来24至48小时与过去较容易发生重置的时段重叠，因此目前的可能性较高。",
  },
  outlookVeryHighOverlap: {
    ja: "前回のランダムリセットから{elapsed}が経過し、今後24〜48時間が過去に特にリセットの起きやすかった時間帯と重なるため、現在の見込みは非常に高いです。",
    en: "It has been {elapsed} since the last random reset, and the next 24–48 hours overlap periods when resets have historically been especially likely, so the current outlook is very high.",
    zh: "距离上次随机重置已过去{elapsed}，未来24至48小时与过去特别容易发生重置的时段重叠，因此目前的可能性非常高。",
  },
  outlookGenericLow: {
    ja: "前回のランダムリセットから{elapsed}が経過しており、現在の予測ではリセットの見込みは低めです。",
    en: "It has been {elapsed} since the last random reset, and the current forecast puts the outlook for a reset at low.",
    zh: "距离上次随机重置已过去{elapsed}，根据当前预测，重置的可能性较低。",
  },
  outlookGenericMedium: {
    ja: "前回のランダムリセットから{elapsed}が経過しており、現在の予測ではリセットの見込みは中程度です。",
    en: "It has been {elapsed} since the last random reset, and the current forecast puts the outlook for a reset at moderate.",
    zh: "距离上次随机重置已过去{elapsed}，根据当前预测，重置的可能性处于中等水平。",
  },
  outlookGenericHigh: {
    ja: "前回のランダムリセットから{elapsed}が経過しており、現在の予測ではリセットの見込みは高めです。",
    en: "It has been {elapsed} since the last random reset, and the current forecast puts the outlook for a reset at high.",
    zh: "距离上次随机重置已过去{elapsed}，根据当前预测，重置的可能性较高。",
  },
  outlookGenericVeryHigh: {
    ja: "前回のランダムリセットから{elapsed}が経過しており、現在の予測ではリセットの見込みは非常に高いです。",
    en: "It has been {elapsed} since the last random reset, and the current forecast puts the outlook for a reset at very high.",
    zh: "距离上次随机重置已过去{elapsed}，根据当前预测，重置的可能性非常高。",
  },
  outlookNoElapsedLow: {
    ja: "現在の予測では、リセットの見込みは低めです。",
    en: "The current forecast puts the outlook for a reset at low.",
    zh: "根据当前预测，重置的可能性较低。",
  },
  outlookNoElapsedMedium: {
    ja: "現在の予測では、リセットの見込みは中程度です。",
    en: "The current forecast puts the outlook for a reset at moderate.",
    zh: "根据当前预测，重置的可能性处于中等水平。",
  },
  outlookNoElapsedHigh: {
    ja: "現在の予測では、リセットの見込みは高めです。",
    en: "The current forecast puts the outlook for a reset at high.",
    zh: "根据当前预测，重置的可能性较高。",
  },
  outlookNoElapsedVeryHigh: {
    ja: "現在の予測では、リセットの見込みは非常に高いです。",
    en: "The current forecast puts the outlook for a reset at very high.",
    zh: "根据当前预测，重置的可能性非常高。",
  },
  outlookLowUnder24h: {
    ja: "前回のリセットから時間がたっておらず、最近のリセットも少ないため、リセットの見込みは低めです。",
    en: "Not much time has passed since the last reset, and recent resets have been less frequent, so the chance of another reset is low.",
    zh: "距离上次重置还没过多久，近期重置也较少，因此再次重置的可能性较低。",
  },
  outlookLow24To72h: {
    ja: "前回のリセットから少し時間がたっていますが、最近のリセットが少ないため、リセットの見込みは低めです。",
    en: "Some time has passed since the last reset, but recent resets have been less frequent, so the chance of another reset is low.",
    zh: "距离上次重置已经过了一段时间，但近期重置较少，因此再次重置的可能性较低。",
  },
  outlookLow72hPlus: {
    ja: "前回のリセットから時間はたっていますが、最近のリセットが少ないため、リセットの見込みはやや低めです。",
    en: "More time has passed since the last reset, but recent resets have been less frequent, so the chance of a reset is still somewhat low.",
    zh: "距离上次重置已经过了较长时间，但近期重置较少，因此重置可能性仍略低。",
  },
  outlookNormalUnder24h: {
    ja: "前回のリセットから時間がたっていないため、短期のリセット見込みは低めです。",
    en: "Not much time has passed since the last reset, so the short-term chance of another reset is low.",
    zh: "距离上次重置还没过多久，因此短期内再次重置的可能性较低。",
  },
  outlookNormal24To72h: {
    ja: "前回のリセットから少し時間がたっており、リセットの見込みは中程度です。",
    en: "Some time has passed since the last reset, and the current reset outlook is moderate.",
    zh: "距离上次重置已经过了一段时间，目前的重置可能性处于中等水平。",
  },
  outlookNormal72hPlus: {
    ja: "前回のリセットから時間がたっているため、リセットの見込みは高まりつつあります。",
    en: "More time has passed since the last reset, so a reset is becoming more likely.",
    zh: "距离上次重置已经过了较长时间，因此重置的可能性正在上升。",
  },
  outlookHighUnder24h: {
    ja: "最近はリセットが多いものの、前回のリセットから時間がたっていないため、リセットの見込みは中程度です。",
    en: "Resets have been frequent recently, but not much time has passed since the last reset, so the current reset outlook is moderate.",
    zh: "近期重置较多，但距离上次重置还没过多久，因此目前的重置可能性处于中等水平。",
  },
  outlookHigh24To72h: {
    ja: "最近はリセットが多く、前回のリセットからも少し時間がたっているため、リセットの見込みは高めです。",
    en: "Resets have been frequent recently, and some time has passed since the last reset, so the likelihood of a reset is high.",
    zh: "近期重置较多，距离上次重置也已经过了一段时间，因此重置的可能性较高。",
  },
  outlookHigh72hPlus: {
    ja: "最近はリセットが多く、前回のリセットからも時間がたっているため、リセットの見込みは高めです。",
    en: "Resets have been frequent recently, and more time has passed since the last reset, so the likelihood of a reset is high.",
    zh: "近期重置较多，距离上次重置也已经过了较长时间，因此重置的可能性较高。",
  },
  outlookFallbackNoMajorChange: {
    ja: "現在、大きな変化は確認されていません。",
    en: "No major changes are currently apparent.",
    zh: "目前未发现明显变化。",
  },
  outlookUnavailable: {
    ja: "現在の見込みを確認できません。",
    en: "The current outlook is unavailable.",
    zh: "当前预期暂不可用。",
  },
  elapsedSinceResetShort: {
    ja: "前回のリセットから",
    en: "Since last reset",
    zh: "距上次重置",
  },
  elapsedSinceRandomResetShort: {
    ja: "前回のランダムリセットから",
    en: "Since the last random reset",
    zh: "距上次随机重置",
  },
  resetTeaserStatus: {
    ja: "リセット匂わせ投稿",
    en: "Reset teaser",
    zh: "重置暗示帖",
  },
  noResetTeaser: {
    ja: "なし",
    en: "None",
    zh: "无",
  },
  activeResetTeaser: {
    ja: "あり",
    en: "Present",
    zh: "有",
  },
  weakResetTeaser: {
    ja: "あり（弱）",
    en: "Present (weak)",
    zh: "有（较弱）",
  },
  checkAction: {
    ja: "要確認",
    en: "Pending confirmation",
    zh: "尚待确认",
  },
  scheduledResetTime: {
    ja: "リセット予定",
    en: "Planned reset",
    zh: "重置安排",
  },
  scheduledResetDeadlinePrefix: {
    ja: "",
    en: "by ",
    zh: "",
  },
  scheduledResetDeadlineSuffix: {
    ja: "まで",
    en: "",
    zh: "前",
  },
  tiboNoticeLocalTime: {
    ja: "Tibo氏の予告日時をお使いの地域の時間に変換して表示しています",
    en: "Tibo's notice date and time are shown in your local time.",
    zh: "Tibo 的预告日期和时间会转换为您所在地区的本地时间显示。",
  },
  source: {
    ja: "ソース",
    en: "Source",
    zh: "来源",
  },
  currentStatus: {
    ja: "現在の状況",
    en: "Current status",
    zh: "当前状况",
  },
  observedRecoveryTitle: {
    ja: "利用枠の回復を観測",
    en: "Usage recovery observed",
    zh: "已观测到使用额度恢复",
  },
  observedRecoveryBody: {
    ja: "監視中のCodexアカウントで利用枠の回復を観測しました。Tiboによる全体リセットの完了発表を確認中です。",
    en: "Usage recovery was observed on the monitored Codex account. We are checking for Tibo's announcement of a global reset.",
    zh: "在监测中的 Codex 账户上观测到使用额度恢复。正在确认 Tibo 是否发布全体重置完成的公告。",
  },
  observedRecoveryChecking: {
    ja: "確認中",
    en: "Checking",
    zh: "确认中",
  },
  noticeBackedRecoveryTitle: {
    ja: "全体リセット完了",
    en: "Global reset completed",
    zh: "全局重置已完成",
  },
  noticeBackedRecoveryBody: {
    ja: "監視中のCodexアカウントで利用枠の回復を確認しました。事前のTibo氏による公式予告と一致するため、全体リセット完了として記録しました。",
    en: "A quota recovery was observed on the monitored Codex account. Because it matches Tibo's prior official notice, it has been recorded as a completed global reset.",
    zh: "监控中的 Codex 账户已观测到额度恢复。由于与 Tibo 事先发布的官方预告一致，已记录为全局重置完成。",
  },
  scheduledResetPlan: {
    ja: "予定",
    en: "Planned",
    zh: "计划",
  },
  scheduledResetTimeUnknown: {
    ja: "時刻未定",
    en: "time not specified",
    zh: "时间未定",
  },
  scheduledResetLocalRange: {
    ja: "閲覧者の現地時刻換算",
    en: "In the viewer's local time",
    zh: "按查看者当地时间换算",
  },
  overdueNoticePendingText: {
    ja: "予定時刻を過ぎています。リセットを確認中です。",
    en: "The expected time has passed. Waiting for reset confirmation.",
    zh: "预计时间已过，正在等待重置确认。",
  },
  randomReset: {
    ja: "ランダムリセット",
    en: "Random reset",
    zh: "随机重置",
  },
  expectationLabel: {
    ja: "期待度",
    en: "Likelihood",
    zh: "可能性",
  },
  within24h: {
    ja: "24時間以内",
    en: "Within 24h",
    zh: "24小时内",
  },
  within12h: {
    ja: "12時間以内",
    en: "Within 12 hours",
    zh: "12小时内",
  },
  within48h: {
    ja: "48時間以内",
    en: "Within 48h",
    zh: "48小时内",
  },
  within72h: {
    ja: "72時間以内",
    en: "Within 72 hours",
    zh: "72小时内",
  },
  disclaimer: {
    ja: "※非公式の予測です。実際の実施時期は公式情報をご確認ください。",
    en: "This is an unofficial forecast. Check official sources for confirmed reset timing.",
    zh: "本预测并非官方信息，实际重置时间请以官方消息为准。",
  },
  forecastOutlook: {
    ja: "現在の見込み",
    en: "Current outlook",
    zh: "当前判断",
  },
  manualOutlookFlashBadge: {
    ja: "速報",
    en: "Flash",
    zh: "快讯",
  },
  manualOutlookNoticeBadge: {
    ja: "注意",
    en: "Notice",
    zh: "注意",
  },
  manualOutlookInfoBadge: {
    ja: "お知らせ",
    en: "Info",
    zh: "通知",
  },
  manualOutlookStandardForecast: {
    ja: "通常の算出見込み",
    en: "Standard forecast",
    zh: "通常预测",
  },
  viewAllHistoryLink: {
    ja: "さらにリセット履歴を見る →",
    en: "View all reset history →",
    zh: "查看更多重置历史 →",
  },
  timeRangeSeparator: {
    ja: " ～ ",
    en: " to ",
    zh: " 至 ",
  },
  latestReset: {
    ja: "最新のリセット",
    en: "Latest reset",
    zh: "最新重置",
  },
  tiboLatestActivity: {
    ja: "Tiboの最新投稿",
    en: "Latest Tibo post",
    zh: "Tibo 最新帖子",
  },
  tiboRelatedActivity: {
    ja: "関連するTibo投稿",
    en: "Related Tibo post",
    zh: "相关的 Tibo 帖子",
  },
  tiboObservedClassification: {
    ja: "観測分類",
    en: "Observed classification",
    zh: "观测分类",
  },
  tiboReplyToPost: {
    ja: "返信先の投稿",
    en: "Replying to",
    zh: "回复的帖子",
  },
  tiboReply: {
    ja: "Tiboの返信",
    en: "Tibo's reply",
    zh: "Tibo 的回复",
  },
  tiboPostDate: {
    ja: "投稿時刻",
    en: "Posted",
    zh: "发布时间",
  },
  tiboViewPost: {
    ja: "投稿を見る",
    en: "View post",
    zh: "查看帖子",
  },
  tiboNoPostText: {
    ja: "投稿本文は取得できませんでした。",
    en: "Post text is unavailable.",
    zh: "无法获取帖子正文。",
  },
  tiboClassificationOfficialNotice: {
    ja: "リセット予告",
    en: "Reset notice",
    zh: "重置预告",
  },
  tiboClassificationResetExecuted: {
    ja: "リセット実施",
    en: "Reset executed",
    zh: "已执行重置",
  },
  tiboClassificationTeaser: {
    ja: "リセット示唆",
    en: "Reset hint",
    zh: "重置提示",
  },
  tiboClassificationStrongTeaser: {
    ja: "リセット匂わせ",
    en: "Reset hint",
    zh: "重置暗示",
  },
  tiboClassificationWeakTeaser: {
    ja: "弱いリセット匂わせ",
    en: "Weak reset hint",
    zh: "较弱的重置暗示",
  },
  tiboClassificationIrrelevant: {
    ja: "リセットとは無関係",
    en: "Unrelated to resets",
    zh: "与重置无关",
  },
  nextRegularResetReference: {
    ja: "次回定期リセット参考日",
    en: "Next regular reset reference",
    zh: "下次定期重置参考日期",
  },
  regularResetReferenceDateTime: {
    ja: "参考日時",
    en: "Reference date and time",
    zh: "参考日期和时间",
  },
  regularResetRemainingTime: {
    ja: "残り時間",
    en: "Time remaining",
    zh: "剩余时间",
  },
  regularResetReferenceNote: {
    ja: "実際のリセット日時は、ユーザーごとの利用状況により異なる場合があります。",
    en: "The actual reset time may vary by user depending on usage.",
    zh: "实际重置时间可能因用户的使用情况而异。",
  },
  regularResetTimingNote: {
    ja: "定期リセットのタイミングはユーザーによって異なる場合があります。",
    en: "The timing of regular resets may vary by user.",
    zh: "定期重置的时间可能因用户而异。",
  },
  scope: {
    ja: "対象プラン",
    en: "Scope",
    zh: "适用套餐",
  },
  detectionTime: {
    ja: "予告",
    en: "Notice",
    zh: "预告",
  },
  resetTime: {
    ja: "リセット実施時刻",
    en: "Reset time",
    zh: "重置执行时间",
  },
  windowLength: {
    ja: "予告から実施まで",
    en: "Time from notice to reset",
    zh: "从预告到执行",
  },
  historyCycleType: {
    ja: "分類",
    en: "Category",
    zh: "分类",
  },
  historyReasonType: {
    ja: "理由",
    en: "Reason",
    zh: "原因",
  },
  historyResetMethod: {
    ja: "リセット方法",
    en: "Reset method",
    zh: "重置方式",
  },
  historyScope: {
    ja: "対象",
    en: "Eligibility",
    zh: "适用对象",
  },
  astraBankedHistoryTitle: {
    ja: "GPT-6 Astraリリース記念BANKEDリセット配布",
    en: "GPT-6 Astra Launch BANKED Reset Distribution",
    zh: "GPT-6 Astra 发布纪念 BANKED 重置发放",
  },
  astraBankedHistorySecondTitle: {
    ja: "GPT-6 Astraリリース記念リセット（2回目）",
    en: "GPT-6 Astra Launch Celebration Reset (2nd)",
    zh: "GPT-6 Astra 发布庆祝重置（第2次）",
  },
  astraBankedHistoryNote: {
    ja: "GPT-6 Astraの提供開始にあわせ、BANKEDリセットが配布されました。配布は一斉ではなく、順次行われる場合があります。",
    en: "To mark the GPT-6 Astra launch, a BANKED Reset was distributed. Distribution may take place progressively rather than all at once.",
    zh: "配合 GPT-6 Astra 发布，已发放 BANKED 重置。发放可能会分批进行，而不是一次性全部到账。",
  },
  historyNoticeToExecution: {
    ja: "告知から実施まで",
    en: "Time from notice to reset",
    zh: "从预告到执行",
  },
  historyNoticeType: {
    ja: "リセット告知",
    en: "Reset Notice",
    zh: "重置预告",
  },
  historyNoticeAnnouncementValue: {
    ja: "告知あり",
    en: "Announcement",
    zh: "有告知",
  },
  historyNoticeTeaserValue: {
    ja: "匂わせあり",
    en: "Teaser hint",
    zh: "有预告提示",
  },
  historyAnnouncementTime: {
    ja: "告知",
    en: "Announcement",
    zh: "告知",
  },
  historyNote: {
    ja: "補足",
    en: "Note",
    zh: "补充",
  },
  recentResetEvents: {
    ja: "直近のリセット履歴",
    en: "Recent reset events",
    zh: "最近的重置历史",
  },
  resetHistory: {
    ja: "リセット履歴",
    en: "Reset history",
    zh: "重置历史",
  },
  sourceOriginalPost: {
    ja: "元投稿",
    en: "Original post",
    zh: "原帖",
  },
  sourceProfile: {
    ja: "投稿者プロフィール",
    en: "Source profile",
    zh: "发布者主页",
  },
  sourceOfficialStatus: {
    ja: "OpenAI Status",
    en: "OpenAI Status",
    zh: "OpenAI Status",
  },
  sourceNotRecorded: {
    ja: "出典未記録",
    en: "Source not recorded",
    zh: "未记录来源",
  },
  noHistory: {
    ja: "直近履歴は取得できていません。",
    en: "No reset history is available.",
    zh: "未能获取最近的重置历史。",
  },
  lastUpdated: {
    ja: "最終更新時刻",
    en: "Last updated",
    zh: "最后更新时间",
  },
  dataFetched: {
    ja: "データ取得時刻",
    en: "Data fetched",
    zh: "数据获取时间",
  },
  reason: {
    ja: "理由",
    en: "Reason",
    zh: "原因",
  },
  about: {
    ja: "About",
    en: "About",
    zh: "关于",
  },
  faq: {
    ja: "FAQ",
    en: "FAQ",
    zh: "常见问题",
  },
  history: {
    ja: "History",
    en: "History",
    zh: "历史",
  },
  githubDevelopmentLink: {
    ja: "GitHubで開発を見る",
    en: "View development on GitHub",
    zh: "在 GitHub 查看开发",
  },
  githubDevelopmentAriaLabel: {
    ja: "GitHubでCodexリセット観測所の開発状況を見る",
    en: "View Codex Reset Observatory development on GitHub",
    zh: "在 GitHub 查看 Codex 重置观测站的开发情况",
  },
  aboutDeveloper: {
    ja: "Codex Reset Observatoryは個人開発・運用されています。実装や更新履歴はGitHubで公開しています。",
    en: "Codex Reset Observatory is independently developed and operated. Its implementation and development history are available on GitHub.",
    zh: "Codex Reset Observatory 由个人独立开发和运营。实现代码和开发记录可在 GitHub 查看。",
  },
  languageName: {
    ja: "日本語",
    en: "English",
    zh: "简体中文",
  },
};

/**
 * Standard history terms that must be present in DYNAMIC_TRANSLATIONS.
 * If any standard term is missing from DYNAMIC_TRANSLATIONS, tsc will raise a type error.
 */
export type StandardHistoryTerm =
  | ResetCycleType
  | ResetReasonType
  | HistoryNoticeType
  | ResetMethodType
  | ResetScopeType;

export const DYNAMIC_TRANSLATIONS = {
  "Codex信頼性障害補償リセット": {
    ja: "Codex信頼性障害補償リセット",
    en: "Codex reliability compensation reset",
    zh: "Codex 可靠性事故补偿重置",
  },
  "過去24時間以内に発生したCodexの信頼性に影響する3件の障害への補償として、全有料プランの利用制限がリセットされました。": {
    ja: "過去24時間以内に発生したCodexの信頼性に影響する3件の障害への補償として、全有料プランの利用制限がリセットされました。",
    en: "As compensation for three incidents affecting Codex reliability in the past 24 hours, usage limits for all paid plans were reset.",
    zh: "为补偿过去 24 小时内发生的 3 起影响 Codex 可靠性的故障，所有付费套餐的使用限制已重置。",
  },
  "Codexアクティブユーザー数500万人達成を記念し、全有料ChatGPT/Codexユーザーの利用回数が強制リセットされました。": {
    ja: "Codexアクティブユーザー数500万人達成を記念し、全有料ChatGPT/Codexユーザーの利用回数が強制リセットされました。",
    en: "To celebrate reaching 5 million active Codex users, usage counts for all paid ChatGPT/Codex users were forcibly reset.",
    zh: "为庆祝 Codex 活跃用户数达到 500 万，所有付费 ChatGPT/Codex 用户的使用次数已被强制重置。",
  },
  "Codex長セッション圧縮のキャッシュヒット率低下による過剰消費バグが修正され、全有料ユーザーのリセットが実施されました。": {
    ja: "Codex長セッション圧縮のキャッシュヒット率低下による過剰消費バグが修正され、全有料ユーザーのリセットが実施されました。",
    en: "After a bug causing excessive consumption due to lower cache-hit rates in Codex long-session compression was fixed, all paid users' limits were reset.",
    zh: "修复 Codex 长会话压缩缓存命中率下降导致的过度消耗漏洞后，所有付费用户的使用限制均已重置。",
  },
  "Sam Altman氏のツイート1いいね達成に伴い、Tibo氏によって即座にCodex利用上限がリセットされました。": {
    ja: "Sam Altman氏のツイート1いいね達成に伴い、Tibo氏によって即座にCodex利用上限がリセットされました。",
    en: "After Sam Altman's tweet reached one like, Tibo immediately reset the Codex usage limit.",
    zh: "Sam Altman 的推文获得 1 个赞后，Tibo 立即重置了 Codex 使用限制。",
  },
  "GPT-5.5モデルの能力一時退化不具合が解消されたことに伴い、全有料プランの利用回数が強制リセットされました。": {
    ja: "GPT-5.5モデルの能力一時退化不具合が解消されたことに伴い、全有料プランの利用回数が強制リセットされました。",
    en: "Following the resolution of a temporary GPT-5.5 performance-degradation issue, usage counts for all paid plans were forcibly reset.",
    zh: "随着 GPT-5.5 模型暂时性能力退化问题得到解决，所有付费套餐的使用次数已被强制重置。",
  },
  "500万人アクティブユーザー記念リセット": {
    ja: "500万人アクティブユーザー記念リセット",
    en: "5M active users milestone celebration reset",
    zh: "500 万活跃用户庆祝重置",
  },
  "長セッション圧縮過剰消費補償リセット": {
    ja: "長セッション圧縮過剰消費補償リセット",
    en: "Long-session compression over-consumption compensation reset",
    zh: "长会话压缩过度消耗补偿重置",
  },
  "過剰消費のお詫びリセット": {
    ja: "過剰消費のお詫びリセット",
    en: "Excessive consumption compensation reset",
    zh: "过度消耗补偿重置",
  },
  "5時間制限復活に伴うリセット": {
    ja: "5時間制限復活に伴うリセット",
    en: "5-hour limit restoration reset",
    zh: "恢复5小时限制附带重置",
  },
  "Samいいね約束リセット": {
    ja: "Samいいね約束リセット",
    en: "Sam's promised like milestone reset",
    zh: "Sam 点赞承诺重置",
  },
  "GPT-5.5能力退化補償リセット": {
    ja: "GPT-5.5能力退化補償リセット",
    en: "GPT-5.5 performance degradation compensation reset",
    zh: "GPT-5.5 性能退化补偿重置",
  },

  "Tibo氏の「There will be signs... Resets」匂わせ投稿": {
    ja: "Tibo氏の「There will be signs... Resets」匂わせ投稿",
    en: "Tibo's teaser post stating 'There will be signs... Resets'",
    zh: "Tibo 关于‘There will be signs... Resets’的暗示动态",
  },
  "Tibo氏の「明日また会いましょう」匂わせ投稿": {
    ja: "Tibo氏の「明日また会いましょう」匂わせ投稿",
    en: "Tibo's teaser post stating 'See you tomorrow'",
    zh: "Tibo 关于‘明天见’的暗示动态",
  },
  "Tibo氏によるご祝儀リセット": {
    ja: "Tibo氏によるご祝儀リセット",
    en: "Tibo celebration reset",
    zh: "Tibo 庆祝重置",
  },
  "Tibo氏による詫びリセット": {
    ja: "Tibo氏による詫びリセット",
    en: "Tibo compensation reset",
    zh: "Tibo 补偿重置",
  },
  "Tibo氏による定期リセット": {
    ja: "Tibo氏による定期リセット",
    en: "Tibo regular reset",
    zh: "Tibo 定期重置",
  },
  "Tibo氏による利用上限リセット": {
    ja: "Tibo氏による利用上限リセット",
    en: "Tibo usage limits reset",
    zh: "Tibo 使用限制重置",
  },
  "Tibo氏がCodexとChatGPT Workの利用上限リセット完了を発表しました。": {
    ja: "Tibo氏がCodexとChatGPT Workの利用上限リセット完了を発表しました。",
    en: "Tibo announced that usage limits for Codex and ChatGPT Work were reset.",
    zh: "Tibo 宣布 Codex 和 ChatGPT Work 的使用限制已重置。",
  },
  "Tibo氏がCodexの利用上限リセット完了を発表しました。": {
    ja: "Tibo氏がCodexの利用上限リセット完了を発表しました。",
    en: "Tibo announced that Codex usage limits were reset.",
    zh: "Tibo 宣布 Codex 的使用限制已重置。",
  },
  "Tibo氏がChatGPT Workの利用上限リセット完了を発表しました。": {
    ja: "Tibo氏がChatGPT Workの利用上限リセット完了を発表しました。",
    en: "Tibo announced that ChatGPT Work usage limits were reset.",
    zh: "Tibo 宣布 ChatGPT Work 的使用限制已重置。",
  },
  "Tibo氏の公式Xで告知あり": {
    ja: "Tibo氏の公式Xで告知あり",
    en: "Announced on Tibo's official X",
    zh: "在 Tibo 官方 X 上发布预告",
  },
  "900万人アクティブユーザー記念の可能性": {
    ja: "900万人アクティブユーザー記念の可能性",
    en: "a possible celebration reset for reaching 9 million active users",
    zh: "可能庆祝达到 900 万活跃用户而重置",
  },
  "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。": {
    ja: "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。",
    en: "Tibo suggested an additional reset (or limit relaxation) of usage limits to celebrate reaching 9M active users.",
    zh: "Tibo 暗示，为庆祝活跃用户达到 900 万，Codex 的使用限制可能会再次重置或放宽。",
  },
  "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。7月16日朝〜17日朝にかけての実施が予想されます。": {
    ja: "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。7月16日朝〜17日朝にかけての実施が予想されます。",
    en: "Tibo suggested an additional reset (or limit relaxation) of usage limits to celebrate reaching 9M active users. Expected execution is between the morning of July 16 and the morning of July 17 JST.",
    zh: "Tibo 暗示，为庆祝活跃用户达到 900 万，Codex 的使用限制可能会再次重置或放宽。预计将于 7 月 16 日早上至 17 日早上执行。",
  },
  "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。正確な実施時刻は未告知のため、広めの予想レンジを設定しています。": {
    ja: "Tibo氏が900万人アクティブユーザー到達に伴う利用制限の追加リセット（または制限緩和）を示唆しました。正確な実施時刻は未告知のため、広めの予想レンジを設定しています。",
    en: "Tibo suggested an additional reset (or limit relaxation) of usage limits to celebrate reaching 9M active users. Since the exact execution time is unannounced, a wide expected range has been set.",
    zh: "Tibo 暗示，为庆祝活跃用户达到 900 万，Codex 的使用限制可能会再次重置或放宽。由于尚未公布具体执行时间，因此本页面设置了较宽的预计时间范围。请优先查看原帖中的详细信息。",
  },
  "1時間11分": {
    ja: "1時間11分",
    en: "1 hour 11 minutes",
    zh: "1 小时 11 分钟",
  },
  "Tibo氏が、過剰な利用制限消費問題の補償として、全プランのCodex利用制限を数時間以内にリセットすると発表しました。": {
    ja: "Tibo氏が、過剰な利用制限消費問題の補償として、全プランのCodex利用制限を数時間以内にリセットすると発表しました。",
    en: "Tibo announced that Codex usage limits across all plans will be reset within a few hours to compensate for an issue causing excessive usage consumption.",
    zh: "Tibo 宣布将在数小时内重置所有计划的 Codex 使用限制，以补偿导致使用额度过度消耗的问题。",
  },
  // Titles / Reset Types
  "500万人達成記念リセット": {
    ja: "500万人達成記念リセット",
    en: "5M user milestone reset",
    zh: "500 万用户庆祝重置",
  },
  "500 万用户庆祝重置": {
    ja: "500万人達成記念リセット",
    en: "5M user milestone reset",
    zh: "500 万用户庆祝重置",
  },
  "5M users celebration reset": {
    ja: "500万人達成記念リセット",
    en: "5M user milestone reset",
    zh: "500 万用户庆祝重置",
  },
  "Codex障害対応の利用上限リセット": {
    ja: "Codex障害対応の利用上限リセット",
    en: "Codex reliability compensation reset",
    zh: "Codex 可靠性事故补偿重置",
  },
  "Codex 可靠性事故补偿重置": {
    ja: "Codex障害対応の利用上限リセット",
    en: "Codex reliability compensation reset",
    zh: "Codex 可靠性事故补偿重置",
  },
  "Codex reliability compensation reset": {
    ja: "Codex障害対応の利用上限リセット",
    en: "Codex reliability compensation reset",
    zh: "Codex 可靠性事故补偿重置",
  },
  "Codex利用上限リセット": {
    ja: "Codex利用上限リセット",
    en: "Codex usage-limit reset",
    zh: "Codex使用限制重置",
  },
  "Codex usage-limit reset": {
    ja: "Codex利用上限リセット",
    en: "Codex usage-limit reset",
    zh: "Codex使用限制重置",
  },
  "GPT-5.5性能低下への補償リセット": {
    ja: "GPT-5.5性能低下への補償リセット",
    en: "GPT-5.5 degradation compensation reset",
    zh: "GPT-5.5 能力退化补偿重置",
  },
  "GPT-5.5 能力退化补偿重置": {
    ja: "GPT-5.5性能低下への補償リセット",
    en: "GPT-5.5 degradation compensation reset",
    zh: "GPT-5.5 能力退化补偿重置",
  },
  "GPT-5.5 degradation compensation reset": {
    ja: "GPT-5.5性能低下への補償リセット",
    en: "GPT-5.5 degradation compensation reset",
    zh: "GPT-5.5 能力退化补偿重置",
  },
  "長時間セッション圧縮の消費異常に対する補償リセット": {
    ja: "長時間セッション圧縮の消費異常に対する補償リセット",
    en: "Long-session compression usage anomaly compensation reset",
    zh: "长会话压缩耗额异常补偿重置",
  },
  "长会话压缩耗额异常补偿重置": {
    ja: "長時間セッション圧縮の消費異常に対する補償リセット",
    en: "Long-session compression usage anomaly compensation reset",
    zh: "长会话压缩耗额异常补偿重置",
  },
  "Long-session compression usage anomaly compensation reset": {
    ja: "長時間セッション圧縮の消費異常に対する補償リセット",
    en: "Long-session compression usage anomaly compensation reset",
    zh: "长会话压缩耗额异常补偿重置",
  },
  "Sam氏の投稿をきっかけにしたレート制限リセット": {
    ja: "Sam氏の投稿をきっかけにしたレート制限リセット",
    en: "Rate-limit reset triggered by Sam's post",
    zh: "Sam 点赞承诺速率限制重置",
  },
  "Sam 点赞承诺速率限制重置": {
    ja: "Sam氏の投稿をきっかけにしたレート制限リセット",
    en: "Rate-limit reset triggered by Sam's post",
    zh: "Sam 点赞承诺速率限制重置",
  },
  "Rate-limit reset triggered by Sam's post": {
    ja: "Sam氏の投稿をきっかけにしたレート制限リセット",
    en: "Rate-limit reset triggered by Sam's post",
    zh: "Sam 点赞承诺速率限制重置",
  },
  "周度庆祝付费计划重置": {
    ja: "週次の節目を祝う有料プランリセット",
    en: "Weekly celebration paid plan reset",
    zh: "周度庆祝付费套餐重置",
  },
  "400 万活跃用户里程碑重置": {
    ja: "400万アクティブユーザー達成記念リセット",
    en: "4M active users milestone reset",
    zh: "400 万活跃用户里程碑重置",
  },
  "局部故障补偿重置": {
    ja: "一部障害への補償リセット",
    en: "Partial incident compensation reset",
    zh: "局部故障补偿重置",
  },
  "一周年纪念重置": {
    ja: "1周年記念リセット",
    en: "1st anniversary reset",
    zh: "一周年纪念重置",
  },
  "300 万周活用户与新计划重置": {
    ja: "300万週間アクティブユーザーと新プランに伴うリセット",
    en: "3M weekly active users and new plan reset",
    zh: "300 万周活用户与新计划重置",
  },

  // Scopes
  "全有料プラン": {
    ja: "全有料プラン",
    en: "All paid plans",
    zh: "所有付费套餐",
  },
  "一部ユーザー": {
    ja: "一部ユーザー",
    en: "Some users",
    zh: "部分用户",
  },
  "Some users": {
    ja: "一部ユーザー",
    en: "Some users",
    zh: "部分用户",
  },
  "部分用户": {
    ja: "一部ユーザー",
    en: "Some users",
    zh: "部分用户",
  },
  "任意リセット未使用アカウント": {
    ja: "任意リセット未使用アカウント",
    en: "Accounts without a Banked Reset",
    zh: "未使用任意重置的账户",
  },
  "全プラン": {
    ja: "全プラン",
    en: "All plans",
    zh: "所有计划",
  },
  "全ユーザー": {
    ja: "全ユーザー",
    en: "All users",
    zh: "所有用户",
  },
  "所有付费计划": {
    ja: "全有料プラン",
    en: "All paid plans",
    zh: "所有付费套餐",
  },
  "All paid plans": {
    ja: "全有料プラン",
    en: "All paid plans",
    zh: "所有付费套餐",
  },
  "All plans": {
    ja: "全プラン",
    en: "All plans",
    zh: "所有计划",
  },
  "Codexユーザー": {
    ja: "Codexユーザー",
    en: "Codex users",
    zh: "Codex 用户",
  },
  "Codex 用户": {
    ja: "Codexユーザー",
    en: "Codex users",
    zh: "Codex 用户",
  },
  "Codex users": {
    ja: "Codexユーザー",
    en: "Codex users",
    zh: "Codex 用户",
  },
  "既存の$200 Proユーザー": {
    ja: "既存の$200 Proユーザー",
    en: "Existing $200 Pro users",
    zh: "现有 $200 Pro 用户",
  },
  "现有 $200 Pro 用户": {
    ja: "既存の$200 Proユーザー",
    en: "Existing $200 Pro users",
    zh: "现有 $200 Pro 用户",
  },

  // Window Humans
  "定期実施": {
    ja: "定期実施",
    en: "Weekly cycle",
    zh: "定期执行",
  },
  "即時リセット": {
    ja: "即時リセット",
    en: "Immediate reset",
    zh: "即时重置",
  },
  "无窗": {
    ja: "即時リセット",
    en: "Immediate reset",
    zh: "无时间窗",
  },
  "9時間25分": {
    ja: "9時間25分",
    en: "9 hours 25 minutes",
    zh: "9小时25分",
  },
  "9小时25分": {
    ja: "9時間25分",
    en: "9 hours 25 minutes",
    zh: "9小时25分",
  },
  "19時間53分": {
    ja: "19時間53分",
    en: "19 hours 53 minutes",
    zh: "19小时53分",
  },
  "19小时53分": {
    ja: "19時間53分",
    en: "19 hours 53 minutes",
    zh: "19小时53分",
  },
  "8分": {
    ja: "8分",
    en: "8 minutes",
    zh: "8分钟",
  },
  "8分钟": {
    ja: "8分",
    en: "8 minutes",
    zh: "8分钟",
  },
  "17時間20分": {
    ja: "17時間20分",
    en: "17 hours 20 minutes",
    zh: "17小时20分",
  },
  "17小时20分": {
    ja: "17時間20分",
    en: "17 hours 20 minutes",
    zh: "17小时20分",
  },

  // Statuses
  "配布": {
    ja: "配布",
    en: "Distributed",
    zh: "发放",
  },
  "検知": {
    ja: "検知",
    en: "Detected",
    zh: "检测到",
  },
  "実施": {
    ja: "実施",
    en: "Reset",
    zh: "执行",
  },
  "実施予定": {
    ja: "実施予定",
    en: "Planned reset",
    zh: "计划执行",
  },
  "終了": {
    ja: "終了",
    en: "Closed",
    zh: "结束",
  },
  "リセット実施": {
    ja: "リセット実施",
    en: "Reset completed",
    zh: "重置执行",
  },
  "予告検知": {
    ja: "予告検知",
    en: "Notice detected",
    zh: "检测到预告",
  },
  "予告中": {
    ja: "予告中",
    en: "Notice active",
    zh: "预告中",
  },
  "定期リセット": {
    ja: "定期リセット",
    en: "Weekly reset",
    zh: "定期重置",
  },
  "定期更新": {
    ja: "定期更新",
    en: "Regular update",
    zh: "定期更新",
  },
  "週間リセット参考日時": {
    ja: "週間リセット参考日時",
    en: "Weekly reset reference time",
    zh: "每周重置参考时间",
  },
  "参考日時": {
    ja: "参考日時",
    en: "Reference time",
    zh: "参考时间",
  },
  "参考情報": {
    ja: "参考情報",
    en: "Reference information",
    zh: "参考信息",
  },
  "共通参考日時": {
    ja: "共通参考日時",
    en: "Shared reference time",
    zh: "公共参考时间",
  },
  "詫びリセット": {
    ja: "詫びリセット",
    en: "Compensation reset",
    zh: "故障补偿重置",
  },
  "ご祝儀リセット": {
    ja: "ご祝儀リセット",
    en: "Celebration reset",
    zh: "庆祝重置",
  },
  "予告付き臨時リセット": {
    ja: "予告付き臨時リセット",
    en: "Announced temporary reset",
    zh: "带预告的临时重置",
  },
  "コミュニティ予測": {
    ja: "コミュニティ予測",
    en: "Community signal",
    zh: "社区预测",
  },
  "その他": {
    ja: "その他",
    en: "Other",
    zh: "其他",
  },
  "ランダムリセット": {
    ja: "ランダムリセット",
    en: "Random reset",
    zh: "随机重置",
  },
  "個人別リセット": {
    ja: "個人別リセット",
    en: "Account-specific reset",
    zh: "账号特定重置",
  },
  "通常更新": {
    ja: "通常更新",
    en: "Regular refresh",
    zh: "常规更新",
  },
  "通常更新 / 詫びリセット": {
    ja: "通常更新 / 詫びリセット",
    en: "Regular refresh / Compensation reset",
    zh: "常规更新 / 故障补偿重置",
  },
  "強制リセット": {
    ja: "強制リセット",
    en: "Hard Reset",
    zh: "强制重置",
  },
  "利用上限更新": {
    ja: "利用上限更新",
    en: "Usage-limit refresh",
    zh: "使用限制更新",
  },
  "任意リセット権配布": {
    ja: "任意リセット権配布",
    en: "Banked Reset distribution",
    zh: "BANKED 重置发放",
  },
  "不明": {
    ja: "不明",
    en: "Unknown",
    zh: "未知",
  },
  "即時実行": {
    ja: "即時実行",
    en: "Immediate execution",
    zh: "即时执行",
  },
  "数時間以内": {
    ja: "数時間以内",
    en: "Within a few hours",
    zh: "数小时内",
  },
  "26分": {
    ja: "26分",
    en: "26 minutes",
    zh: "26分钟",
  },
  "40分": {
    ja: "40分",
    en: "40 minutes",
    zh: "40分钟",
  },

  // Summaries
  "定期リセットが予定時刻に実施されました。": {
    ja: "定期リセットが予定時刻に実施されました。",
    en: "The regular reset was completed at the scheduled time.",
    zh: "定期重置已在预定时间完成。",
  },
  "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。": {
    ja: "通常の1週間サイクルのタイミングで、Codexの利用上限リセットが実施されました。",
    en: "Codex usage limits were reset on the usual weekly-cycle timing.",
    zh: "在常规的 1 周循环时间点，执行了 Codex 使用限制重置。",
  },
  "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。": {
    ja: "前回のリセット後にCodex / Workを初めて使用した時点から、1週間後に定期リセットが行われます。任意リセットを使用した場合も、任意リセット後の初使用から1週間後となるため、この表示時刻とはずれる場合があります。",
    en: "A regular reset occurs one week after you first use Codex or Work following the previous reset. If you use a Banked Reset, the next weekly timing is likewise counted from your first use after that reset, so it may differ from the time shown here.",
    zh: "定期重置会在您上次重置后首次使用 Codex 或 Work 的一周后进行。使用手动重置后也一样，会从该重置后的首次使用时间起算一周，因此实际时间可能与此处显示的时间不同。",
  },
  "1週間サイクルの定期リセットが実施されました。": {
    ja: "1週間サイクルの定期リセットが実施されました。",
    en: "A weekly-cycle reset was completed.",
    zh: "已执行 1 周循环的定期重置。",
  },
  "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。": {
    ja: "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 8 million active users. *Because the reset is being applied sequentially, there may be a delay of several minutes to hours before it takes effect on your account.",
    zh: "为庆祝活跃用户数达到800万，ChatGPT Work和Codex整体的使用限制已强制重置。※由于重置是顺序应用的，您的账号可能会出现几十分钟到数小时的延迟。",
  },
  "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされる予定です。06:00 JST 頃の実施が見込まれています。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。": {
    ja: "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされる予定です。06:00 JST 頃の実施が見込まれています。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。",
    en: "Usage limits for ChatGPT Work and Codex are scheduled to be reset to celebrate reaching 8 million active users, around 06:00 JST. *Because the reset is applied sequentially, there may be a delay of several minutes to hours before it takes effect on your account.",
    zh: "为庆祝活跃用户数达到800万，ChatGPT Work和Codex整体的使用限制预计将于JST 06:00左右强制重置。※由于重置是顺序应用的，您的账号可能会出现几十分钟到数小时的延迟。",
  },
  "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が06:00 JST頃に強制リセットされる予定です。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。": {
    ja: "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が06:00 JST頃に強制リセットされる予定です。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。",
    en: "Usage limits for ChatGPT Work and Codex are scheduled to be reset around 06:00 JST to celebrate reaching 8 million active users. *Because the reset is applied sequentially, there may be a delay of several minutes to hours before it takes effect on your account.",
    zh: "为庆祝活跃用户数达到800万，ChatGPT Work和Codex整体的使用限制预计将于JST 06:00左右强制重置。※由于重置是顺序应用的，您的账号可能会出现几十分钟到数小时的延迟。",
  },
  "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リresetされました。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。": {
    ja: "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。※発表から順次適用されているため、アカウントへの反映に数十分から数時間程度の遅延が発生する場合があります。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 8 million active users. *Because the reset is being applied sequentially, there may be a delay of several minutes to hours before it takes effect on your account.",
    zh: "为庆祝活跃用户数达到800万，ChatGPT Work和Codex整体的使用限制已强制重置。※由于重置是顺序应用的，您的账号可能会出现几十分钟到数小时的延迟。",
  },
  "Tibo氏の「明日またChatGPTとCodexの楽しい出来事で会いましょう」匂わせ投稿": {
    ja: "Tibo氏の「明日またChatGPTとCodexの楽しい出来事で会いましょう」匂わせ投稿",
    en: "Tibo's post hinting 'See you back tomorrow for more ChatGPT and Codex fun'",
    zh: "Tibo 发帖暗示“明天见，享受更多 ChatGPT 和 Codex 的乐趣”",
  },
  "Tibo氏が「See you back tomorrow for more ChatGPT and Codex fun」と投稿（明日以降の追加発表・リセットを示唆）": {
    ja: "Tibo氏が「See you back tomorrow for more ChatGPT and Codex fun」と投稿（明日以降の追加発表・リセットを示唆）",
    en: "Tibo posted 'See you back tomorrow for more ChatGPT and Codex fun' (hinting at upcoming announcements/resets)",
    zh: "Tibo 发帖称“See you back tomorrow for more ChatGPT and Codex fun”（暗示明天起的追加发布/重置）",
  },
  "ChatGPT Work急速採用記念リセット": {
    ja: "ChatGPT Work急速採用記念リセット",
    en: "ChatGPT Work Rapid Adoption Celebration Reset",
    zh: "ChatGPT Work 快速采用庆祝重置",
  },
  "ChatGPT Workの急速な普及とチームの努力を祝し、CodexとChatGPT Work全体の利用上限が強制リセットされました。": {
    ja: "ChatGPT Workの急速な普及とチームの努力を祝し、CodexとChatGPT Work全体の利用上限が強制リセットされました。",
    en: "Usage limits for Codex and ChatGPT Work were forcibly reset to celebrate the rapid adoption of ChatGPT Work and team efforts.",
    zh: "为庆祝 ChatGPT Work 的快速普及和团队付出的努力，Codex 与 ChatGPT Work 整体的使用限制已强制重置。",
  },
  "大規模障害に伴う詫びリセット": {
    ja: "大規模障害に伴う詫びリセット",
    en: "Outage Compensation Reset",
    zh: "大规模故障补偿重置",
  },
  "世界規模で発生したシステム障害の復旧に伴い、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "世界規模で発生したシステム障害の復旧に伴い、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were forcibly reset following full recovery from a global system outage.",
    zh: "为弥补全球范围发生的系统故障，ChatGPT Work 和 Codex 的使用限制已在服务恢复后强制重置。",
  },
  "Tibo氏が「Tomorrow is feeling codexy」と投稿（Codex関連の更新・リセットを示唆）": {
    ja: "Tibo氏が「Tomorrow is feeling codexy」と投稿（Codex関連の更新・リセットを示唆）",
    en: "Tibo posted 'Tomorrow is feeling codexy' (hinting at upcoming Codex updates/reset)",
    zh: "Tibo 发帖称“Tomorrow is feeling codexy”（暗示即将来临的 Codex 更新/重置）",
  },
  "Tibo氏の「Tomorrow is feeling codexy」匂わせ投稿": {
    ja: "Tibo氏の「Tomorrow is feeling codexy」匂わせ投稿",
    en: "Tibo's 'Tomorrow is feeling codexy' teaser post",
    zh: "Tibo 的“Tomorrow is feeling codexy”预告贴",
  },
  "1000万人アクティブユーザー記念リセット": {
    ja: "1000万人アクティブユーザー記念リセット",
    en: "10M Active Users Celebration Reset",
    zh: "1000万活跃用户庆祝重置",
  },
  "アクティブユーザー数1000万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "アクティブユーザー数1000万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 10 million active users.",
    zh: "为庆祝活跃用户数达到 1000 万，ChatGPT Work 和 Codex 的使用限制已被强制重置。",
  },
  "2000万人アクティブユーザー突破記念リセット": {
    ja: "2000万人アクティブユーザー突破記念リセット",
    en: "20 Million Active Users Milestone Reset",
    zh: "活跃用户突破2000万纪念重置",
  },
  "2500万人アクティブユーザー突破記念リセット": {
    ja: "2500万人アクティブユーザー突破記念リセット",
    en: "25 Million Active Users Milestone Reset",
    zh: "活跃用户突破2500万纪念重置",
  },
  "Codex利用制限改善対応リセット": {
    ja: "Codex利用制限改善対応リセット",
    en: "Codex Usage Limit Improvement Reset",
    zh: "Codex 使用限制改进重置",
  },
  "任意リセット権の配布が確認されました。": {
    ja: "任意リセット権の配布が確認されました。",
    en: "A BANKED Reset distribution was observed.",
    zh: "已观测到 BANKED 重置发放。",
  },
  "1500万人アクティブユーザー突破記念リセット": {
    ja: "1500万人アクティブユーザー突破記念リセット",
    en: "15 Million Active Users Milestone Reset",
    zh: "活跃用户突破1500万纪念重置",
  },
  "Tiboの君を絶対に諦めないリセット": {
    ja: "Tiboの君を絶対に諦めないリセット",
    en: "Tibo's Never Gonna Give You Up Reset",
    zh: "Tibo 绝不放弃你重置",
  },
  "君を絶対に諦めないリセット": {
    ja: "君を絶対に諦めないリセット",
    en: "Never Gonna Give You Up Reset",
    zh: "绝不放弃你重置",
  },
  "Tibo氏より公式予告が行われ、各アカウントへ順次リセットが行われました。": {
    ja: "Tibo氏より公式予告が行われ、各アカウントへ順次リセットが行われました。",
    en: "Following an official notice from Tibo, resets were rolled out sequentially across accounts.",
    zh: "在 Tibo 发布官方预告后，各账号陆续完成了重置。",
  },
  "Tibo氏による『Never Gonna Give You Up』（君を絶対に諦めない）予告に基づき、CodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。": {
    ja: "Tibo氏による『Never Gonna Give You Up』（君を絶対に諦めない）予告に基づき、CodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。",
    en: "Following the 'Never Gonna Give You Up' teaser notice, usage limits for Codex and ChatGPT Work were forcibly reset for all users.",
    zh: "根据“绝不放弃你”（Never Gonna Give You Up）预告，Codex 和 ChatGPT Work 的使用额度对全体用户执行了强制重置。",
  },
  "公式予告リセット（順次適用中）": {
    ja: "公式予告リセット（順次適用中）",
    en: "Official Notice Reset (Rolling Out)",
    zh: "官方预告重置（分批应用中）",
  },
  "Astra Blenderモデリング支援記念リセット": {
    ja: "Astra Blenderモデリング支援記念リセット",
    en: "Astra Blender Modeling Support Reset",
    zh: "Astra Blender 建模支持纪念重置",
  },
  "Tibo氏よりBlenderでの3Dモデリング等でAstraを使い切ったユーザー向けに、週初めの作業再開を支援する全体リセットが実施されました。一部アカウントで順次反映中と見られます。": {
    ja: "Tibo氏よりBlenderでの3Dモデリング等でAstraを使い切ったユーザー向けに、週初めの作業再開を支援する全体リセットが実施されました。一部アカウントで順次反映中と見られます。",
    en: "A global usage limit reset was completed to support users who exhausted Astra quotas on 3D modeling in Blender, kicking off the work week. Sequential rollout appears to be underway.",
    zh: "Tibo 宣布为在 Blender 3D 建模中消耗完 Astra 额度的用户执行了全局使用限制重置，以支持新工作周的开启。目前部分账号正在顺次生效中。",
  },
  "公式予告の予定時刻前後に一部ユーザーで利用上限リセットが確認されました。アカウントにより未反映の報告もあり、現在順次ロールアウト中と見られます。": {
    ja: "公式予告の予定時刻前後に一部ユーザーで利用上限リセットが確認されました。アカウントにより未反映の報告もあり、現在順次ロールアウト中と見られます。",
    en: "Usage limit resets were observed for some users around the scheduled notice time. Some accounts report no reset yet, suggesting a progressive rollout is underway.",
    zh: "在官方预告时间前后，部分用户的使用额度已完成重置。亦有部分账号反馈尚未重置，目前可能正在分批推送中。",
  },
  "一部のユーザーで利用枠の回復が確認されていますが、未反映のアカウントも報告されており、順次ロールアウト中または調査中と見られます。": {
    ja: "一部のユーザーで利用枠の回復が確認されていますが、未反映のアカウントも報告されており、順次ロールアウト中または調査中と見られます。",
    en: "Usage quota recovery has been observed for some users, but unreset accounts have also been reported. A progressive rollout or investigation may be underway.",
    zh: "部分用户已确认使用额度恢复，但仍有部分账号反馈未重置，目前可能正在分批应用或调查中。",
  },
  "全有料プラン（順次適用中）": {
    ja: "全有料プラン（順次適用中）",
    en: "All paid plans (Rolling out)",
    zh: "所有付费方案（分批应用中）",
  },
  "58分": {
    ja: "58分",
    en: "58 minutes",
    zh: "58 分钟",
  },
  "23分": {
    ja: "23分",
    en: "23 minutes",
    zh: "23 分钟",
  },
  "5時間58分": {
    ja: "5時間58分",
    en: "5 hours 58 minutes",
    zh: "5 小时 58 分钟",
  },
  "6時間5分": {
    ja: "6時間5分",
    en: "6 hours 5 minutes",
    zh: "6 小时 5 分钟",
  },
  "Codexのアクティブユーザー数1500万人突破を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "Codexのアクティブユーザー数1500万人突破を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "To celebrate Codex surpassing 15 million active users, usage limits for ChatGPT Work and Codex were forcibly reset.",
    zh: "为纪念 Codex 活跃用户数突破 1500 万，ChatGPT Work 和 Codex 的使用额度进行了强制重置。",
  },
  "Codexの利用枠がリセットされました。": {
    ja: "Codexの利用枠がリセットされました。",
    en: "Codex usage limits have been reset.",
    zh: "Codex 使用额度已重置。",
  },
  "週末の過剰消費トラブルに伴い、Codex全体の利用枠がお詫びとしてリセットされました。": {
    ja: "週末の過剰消費トラブルに伴い、Codex全体の利用枠がお詫びとしてリセットされました。",
    en: "Codex usage limits were reset as compensation for the weekend's excessive consumption issue.",
    zh: "针对周末过度消耗问题，Codex 整体使用额度已作为补偿进行重置。",
  },
  "Plusプランにおける5時間ごとの利用制限復活に伴い、Codex全体の利用枠がお詫びとしてリセットされました。": {
    ja: "Plusプランにおける5時間ごとの利用制限復活に伴い、Codex全体の利用枠がお詫びとしてリセットされました。",
    en: "Codex usage limits were reset as compensation accompanying the restoration of the 5-hour limit for Plus plans.",
    zh: "随着 Plus 计划恢复每 5 小时使用限制，Codex 整体使用额度已作为补偿进行重置。",
  },
  "Codexの週間利用枠がリセットされたことを確認しました。": {
    ja: "Codexの週間利用枠がリセットされたことを確認しました。",
    en: "Codex weekly usage limits were confirmed to have been reset.",
    zh: "已确认 Codex 每周使用额度已重置。",
  },
  "16分": {
    ja: "16分",
    en: "16 minutes",
    zh: "16 分钟",
  },
  "900万人アクティブユーザー記念リセット": {
    ja: "900万人アクティブユーザー記念リセット",
    en: "9 million active users celebration reset",
    zh: "900万活跃用户庆祝重置",
  },
  "アクティブユーザー数900万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "アクティブユーザー数900万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 9 million active users.",
    zh: "为庆祝活跃用户数达到 900 万，ChatGPT Work 和 Codex 的使用限制已被强制重置。",
  },
  "0分": {
    ja: "0分",
    en: "0 min",
    zh: "0 分",
  },
  "3時間": {
    ja: "3時間",
    en: "3 hours",
    zh: "3 小时",
  },
  "定期": {
    ja: "定期",
    en: "Scheduled",
    zh: "定期",
  },
  "800万人アクティブユーザー記念リセット": {
    ja: "800万人アクティブユーザー記念リセット",
    en: "8 million active users celebration reset",
    zh: "800万活跃用户庆祝重置",
  },
  "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "アクティブユーザー数800万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 8 million active users.",
    zh: "为庆祝活跃用户数达到800万，ChatGPT Work 和 Codex 的使用限制已被强制重置。",
  },
  "800万人アクティブユーザー記念": {
    ja: "800万人アクティブユーザー記念",
    en: "8 million active users celebration",
    zh: "800万活跃用户庆祝",
  },
  "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数800万人突破を記念してCodex利用上限を再びリセットしたと発表しました。": {
    ja: "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数800万人突破を記念してCodex利用上限を再びリセットしたと発表しました。",
    en: "Tibo (OpenAI Codex developer) announced that Codex usage limits were reset again to celebrate reaching 8 million active users.",
    zh: "Tibo（OpenAI Codex开发者）宣布为庆祝活跃用户数突破800万，已再次重置Codex使用限制。",
  },
  "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数800万人突破を記念してCodex利用上限をリセットすると発表しました。06:00 JST頃の実施が見込まれます。": {
    ja: "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数800万人突破を記念してCodex利用上限をリセットすると発表しました。06:00 JST頃の実施が見込まれます。",
    en: "Tibo (OpenAI Codex developer) announced that Codex usage limits will be reset to celebrate reaching 8 million active users, expected around 06:00 JST.",
    zh: "Tibo（OpenAI Codex开发者）宣布为庆祝活跃用户数突破800万，将重置Codex使用限制，预计JST 06:00左右实施。",
  },
  "800万人アクティブユーザー記念の可能性": {
    ja: "800万人アクティブユーザー記念の可能性",
    en: "potential 8M active users celebration",
    zh: "可能庆祝800万活跃用户",
  },
  "700万人アクティブユーザー記念任意リセット配布": {
    ja: "700万人アクティブユーザー記念任意リセット配布",
    en: "7 Million Active Users Celebration Banked Reset Distribution",
    zh: "700万活跃用户庆祝手动重置发放",
  },
  "20時間40分": {
    ja: "20時間40分",
    en: "20 hours 40 minutes",
    zh: "20小时40分钟",
  },
  "700万人アクティブユーザー記念": {
    ja: "700万人アクティブユーザー記念",
    en: "7 Million Active Users Celebration",
    zh: "700万活跃用户庆祝",
  },
  "Web/モバイル機能不具合補償任意リセット": {
    ja: "Web/モバイル機能不具合補償任意リセット",
    en: "Web/Mobile Feature Bug Compensation Banked Reset",
    zh: "网页/移动端功能异常补偿手动重置",
  },
  "不具合対象ユーザー（約50万人）": {
    ja: "不具合対象ユーザー（約50万人）",
    en: "Affected users (approx. 500k)",
    zh: "异常受影响用户（约 50 万人）",
  },
  "アクティブユーザー数700万人到達を記念し、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。": {
    ja: "アクティブユーザー数700万人到達を記念し、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。",
    en: "One Banked Reset was granted to all paid users (Codex Go/Plus/Pro) to celebrate reaching 7 million active users.",
    zh: "为庆祝活跃用户数达到700万，已向所有付费用户（Codex Go/Plus/Pro）发放了 1 次手动重置。",
  },
  "Web/モバイルからの任意リセット機能リリース時に、ボタンを押しても適用されなかった一部ユーザー（約50万人）に対して任意リセット（マニュアルリセット）1回分が補償配布されました。": {
    ja: "Web/モバイルからの任意リセット機能リリース時に、ボタンを押しても適用されなかった一部ユーザー（約50万人）に対して任意リセット（マニュアルリセット）1回分が補償配布されました。",
    en: "One Banked Reset was granted as compensation to approximately 500,000 affected users whose reset did not apply after they pressed the button during the web/mobile feature rollout.",
    zh: "由于网页/移动端手动重置功能发布时，部分用户（约 50 万人）点击重置按钮后未生效，已向所有受影响的付费用户补发 1 次手动重置机会。",
  },
  "影響時間帯に任意リセット権を使用したユーザーへ、補償として任意リセット権が再配布されました。": {
    ja: "影響時間帯に任意リセット権を使用したユーザーへ、補償として任意リセット権が再配布されました。",
    en: "Banked Resets were redistributed as compensation to users who used a Banked Reset during the affected time window.",
    zh: "作为补偿，已向在受影响时段内使用过手动重置的用户重新发放了手动重置。",
  },
  "ChatGPT WorkおよびCodexにおいて、任意リセット権（banked reset）を使用した際に正常に適用されない問題が発生しました。影響を受けた時間帯に任意リセット権を使用したユーザーに対して、お詫びメールの送付とともに、補償として任意リセット権が1回分再配布されました。": {
    ja: "ChatGPT WorkおよびCodexにおいて、任意リセット権（banked reset）を使用した際に正常に適用されない問題が発生しました。影響を受けた時間帯に任意リセット権を使用したユーザーに対して、お詫びメールの送付とともに、補償として任意リセット権が1回分再配布されました。",
    en: "An issue occurred where some Banked Resets did not fully apply when used in ChatGPT Work and Codex. Users who used one during the affected time window are receiving an apology email along with a replacement Banked Reset.",
    zh: "ChatGPT Work 和 Codex 出现部分手动重置（banked reset）使用后未完全生效的问题。在受影响时段内使用过手动重置的用户将收到一封致歉邮件以及补发的手动重置机会。",
  },
  "任意リセット不具合補償リセット": {
    ja: "任意リセット不具合補償リセット",
    en: "Banked Reset Issue Compensation Reset",
    zh: "手动重置故障补偿重置",
  },
  "任意リセット不具合お詫びリセット": {
    ja: "任意リセット不具合お詫びリセット",
    en: "Banked Reset Issue Apology Reset",
    zh: "手动重置故障致歉重置",
  },
  "Tibo氏（OpenAI Codex開発者）が、明日アクティブユーザー数700万人突破を記念して全有料ユーザーに任意リセット枠（banked reset）1回分を付与すると発表しました。": {
    ja: "Tibo氏（OpenAI Codex開発者）が、明日アクティブユーザー数700万人突破を記念して全有料ユーザーに任意リセット枠（banked reset）1回分を付与すると発表しました。",
    en: "Tibo (OpenAI Codex developer) announced that a Banked Reset would be granted to all paid users tomorrow to celebrate reaching 7 million active users.",
    zh: "Tibo（OpenAI Codex开发者）宣布，明天将为庆祝活跃用户数突破700万，向所有付费用户发放 1 次手动重置机会（banked reset）。",
  },
  "即時": {
    ja: "即時",
    en: "Immediate",
    zh: "立即",
  },
  "600万人アクティブユーザー記念リセット": {
    ja: "600万人アクティブユーザー記念リセット",
    en: "6 million active users celebration reset",
    zh: "600万活跃用户庆祝重置",
  },

  "Luna 10万スレッド到達・効率改善記念リセット": {
    ja: "Luna 10万スレッド到達・効率改善記念リセット",
    en: "Luna 100k Threads & Efficiency Milestone Reset",
    zh: "Luna 10万线程与效率改进庆祝重置",
  },
  "Tibo氏より今週の利用効率改善を記念し、週末に10万件のLunaスレッドを実行できるようCodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。": {
    ja: "Tibo氏より今週の利用効率改善を記念し、週末に10万件のLunaスレッドを実行できるようCodexおよびChatGPT Workの利用上限が全ユーザー強制リセットされました。",
    en: "Tibo announced a forced reset for all Codex and ChatGPT Work users to celebrate a week of efficiency gains and enable 100,000 Luna threads over the weekend.",
    zh: "Tibo 宣布由于本周效率提升，全员重置 Codex 与 ChatGPT Work 用量上限，方便周末运行 10 万个 Luna 线程。",
  },
  "アクティブユーザー数600万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。": {
    ja: "アクティブユーザー数600万人到達を記念し、ChatGPT WorkとCodex全体の利用上限が強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset to celebrate reaching 6 million active users.",
    zh: "为庆祝活跃用户数达到600万，ChatGPT Work 和 Codex 的使用限制已被强制重置。",
  },
  "600万人アクティブユーザー記念": {
    ja: "600万人アクティブユーザー記念",
    en: "6 million active users celebration",
    zh: "600万活跃用户庆祝",
  },
  "30分": {
    ja: "30分",
    en: "30 minutes",
    zh: "30分钟",
  },
  "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数600万人突破を記念して1時間以内にCodex利用上限をリセットすると発表しました。": {
    ja: "Tibo氏（OpenAI Codex開発者）が、アクティブユーザー数600万人突破を記念して1時間以内にCodex利用上限をリセットすると発表しました。",
    en: "Tibo (OpenAI Codex developer) announced that Codex usage limits would be reset within an hour to celebrate reaching 6 million active users.",
    zh: "Tibo（OpenAI Codex开发者）宣布为庆祝活跃用户数突破600万，将在1小时内重置Codex使用限制。",
  },
  "Tibo 表示过去 24 小时内有三次影响 Codex 可靠性的小事故，并已为所有付费计划重置 Codex 使用限制。": {
    ja: "過去24時間にCodexの信頼性へ影響する小規模な障害が3件発生したとして、Tibo氏が全有料プランのCodex利用上限をリセットしたと発表しました。",
    en: "Tibo announced that Codex usage limits across all paid plans have been reset due to three minor incidents affecting reliability over the past 24 hours.",
    zh: "Tibo 表示过去 24 小时内有三次影响 Codex 可靠性的小事故，并已为所有付费套餐重置 Codex 使用限制。",
  },
  "Tibo 将这次重置解释为庆祝 Codex 达到 500 万用户；随后确认所有付费 ChatGPT 订阅的周额度和 5 小时额度都已恢复到 100%。": {
    ja: "Codexの500万人達成を祝うリセットとして説明され、その後、有料ChatGPTプランの利用上限が回復したことが確認されました。",
    en: "Tibo framed this reset as a celebration of Codex reaching 5M users; usage limits for paid ChatGPT subscriptions were restored.",
    zh: "Tibo 将这次重置解释为庆祝 Codex 达到 500 万用户；随后确认所有付费 ChatGPT 订阅的使用额度已恢复。",
  },
  "Tibo 表示 Codex 长会话压缩的 cache hit rate 受回滚优化影响，导致限制消耗更快；修复后已为所有账号重置使用限制。": {
    ja: "長時間セッション圧縮のキャッシュヒット率が低下して利用上限の消費が速くなっていた問題について、修正後に全アカウントの利用制限がリセットされました。",
    en: "Tibo said that the cache hit rate for Codex long-session compression was affected by rollback optimization, causing limits to consume faster; after the fix, usage limits were reset for all accounts.",
    zh: "Tibo 表示 Codex 长会话压缩的 cache hit rate 受回滚优化影响，导致限制消耗更快；修复后已为所有账号重置使用限制。",
  },
  "Sam 发文称推文获 1 个赞后 Tibo 会重置 Codex 速率限制，随后社区在数分钟内反馈重置完成。": {
    ja: "Sam氏の投稿をきっかけに、数分後にはコミュニティからリセット完了の反応が出ました。",
    en: "Sam posted that Tibo would reset the Codex rate limit if the tweet got 1 like, and the community reported completion within minutes.",
    zh: "Sam 发文称推文获 1 个赞后 Tibo 会重置 Codex 速率限制，随后社区在数分钟内反馈重置完成。",
  },
  "Tibo 表示两个 GPT-5.5 能力退化问题已修复后，付费计划的使用限制完成重置。": {
    ja: "GPT-5.5の性能低下に関する2件の問題が修正された後、有料プランの利用制限がリセットされました。",
    en: "Tibo stated that after two GPT-5.5 degradation issues were fixed, usage limits for paid plans were reset.",
    zh: "Tibo 表示两个 GPT-5.5 能力退化问题已修复后，付费计划的使用限制完成重置。",
  },
  "2026/06/25 07:01 JST に、全有料プランのCodex利用上限リセットが予定されています。": {
    ja: "2026/06/25 07:01 JST に、全有料プランのCodex利用上限リセットが予定されています。",
    en: "A Codex usage-limit reset for all paid plans is scheduled for Jun 25, 2026 at 7:01 AM JST.",
    zh: "预计于 2026/06/25 07:01 JST 对所有付费套餐重置 Codex 使用限制。",
  },
  "Tibo氏が、全プランのCodexレート制限を24時間以内にリセットすると発表しました。": {
    ja: "Tibo氏が、全プランのCodexレート制限を24時間以内にリセットすると発表しました。",
    en: "Tibo announced that Codex rate limits across all plans will be reset within 24 hours.",
    zh: "Tibo 宣布将在 24 小时内重置所有计划的 Codex 速率限制。",
  },
  "Tibo氏が、全プランのCodexレート制限を24時間以内にリセットすると発表しました。 予告内容を優先して最新状況を確認してください。": {
    ja: "Tibo氏が、全プランのCodexレート制限を24時間以内にリセットすると発表しました。 予告内容を優先して最新状況を確認してください。",
    en: "Tibo announced that Codex rate limits across all plans will be reset within 24 hours. Please check Codex for the latest status.",
    zh: "Tibo 宣布将在 24 小时内重置所有计划的 Codex 速率限制。请优先确认预告内容以获取最新状况。",
  },
  "2026/06/25 07:01 JST に、全有料プランのCodex利用上限リセットが予定されています。 予告内容を優先して最新状況を確認してください。": {
    ja: "2026/06/25 07:01 JST に、全有料プランのCodex利用上限リセットが予定されています。 予告内容を優先して最新状況を確認してください。",
    en: "A Codex usage-limit reset for all paid plans is scheduled for Jun 25, 2026 at 7:01 AM JST. Please check Codex for the latest notice.",
    zh: "预计于 2026/06/25 07:01 JST 对所有付费计划重置 Codex 使用限制。请优先确认预告内容以获取最新状况。",
  },
  "Tibo氏が、一部のユーザーでモデル容量到達エラーが多発していると投稿しました。": {
    ja: "Tibo氏が、一部のユーザーでモデル容量到達エラーが多発していると投稿しました。",
    en: "Tibo posted that some users are experiencing model capacity error spikes.",
    zh: "Tibo 发文称部分用户频繁遇到模型容量达到上限的错误。",
  },
  "Tibo氏が、Codexの一部ユーザーでモデル容量到達エラーが多発していると投稿しました。": {
    ja: "Tibo氏が、Codexの一部ユーザーでモデル容量到達エラーが多発していると投稿しました。",
    en: "Tibo posted that some users are experiencing Codex model capacity error spikes.",
    zh: "Tibo 发文称部分 Codex 用户频繁遇到模型容量达到上限的错误。",
  },
  "Codexに表示あり": {
    ja: "Codexに表示あり",
    en: "Shown in Codex",
    zh: "显示在 Codex",
  },
  "概要は取得できていません。": {
    ja: "概要は取得できていません。",
    en: "No summary is available.",
    zh: "未能获取概要信息。",
  },
  "通常の1週間サイクルのタイミングで、有料プランのCodex利用上限リセットが実施されました。ただし、任意リセットを使用したアカウントは対象外となります。": {
    ja: "通常の1週間サイクルのタイミングで、有料プランのCodex利用上限リセットが実施されました。ただし、任意リセットを使用したアカウントは対象外となります。",
    en: "A regular Codex usage limit reset was executed as part of the weekly cycle. However, accounts that have used a Banked Reset are excluded.",
    zh: "作为常规的1周循环，付费套餐的Codex使用限制已重置。但使用过手动重置的账号除外。",
  },
  "GPT-5.6リリース記念": {
    ja: "GPT-5.6リリース記念",
    en: "the recent GPT-5.6 launch celebrations",
    zh: "GPT-5.6 发布庆祝活动",
  },
  "GPT-5.6リリース記念ランダムリセット警戒期間に伴う確率底上げブースト (+20%)": {
    ja: "GPT-5.6リリース記念ランダムリセット警戒期間に伴う確率底上げブースト (+20%)",
    en: "GPT-5.6 launch celebration boost (+20% probability boost during random reset alert period)",
    zh: "GPT-5.6 发布庆祝随机重置警戒期概率提升 (+20%)",
  },
  "システムによる確率調整": {
    ja: "システムによる確率調整",
    en: "System probability adjustment",
    zh: "系统概率调整",
  },
  "OpenAI Codex開発者のTibo氏が「リセットは今日の午後（米国太平洋時間）に来る」と発言しました。": {
    ja: "OpenAI Codex開発者のTibo氏が「リセットは今日の午後（米国太平洋時間）に来る」と発言しました。",
    en: "Tibo, an OpenAI Codex developer, stated that 'reset is coming this afternoon (US Pacific time).'",
    zh: "OpenAI Codex开发者Tibo表示「今天下午（美国太平洋时间）会有重置」。",
  },
  "Tibo氏（OpenAI Codex開発者）のXポストより": {
    ja: "Tibo氏（OpenAI Codex開発者）のXポストより",
    en: "From Tibo's X post (OpenAI Codex developer)",
    zh: "Tibo（OpenAI Codex 开发者）发布的 X 帖子",
  },
  "Tibo氏（OpenAI Codex開発者）がGPT-5.6 Solローンチを記念し、ChatGPT WorkとCodex全体で2回目のレート制限リセットを24時間以内に実施すると発表。": {
    ja: "Tibo氏（OpenAI Codex開発者）がGPT-5.6 Solローンチを記念し、ChatGPT WorkとCodex全体で2回目のレート制限リセットを24時間以内に実施すると発表。",
    en: "Tibo (OpenAI Codex developer) announced a 2nd rate limit reset across ChatGPT Work and Codex within 24 hours to celebrate the GPT-5.6 Sol launch.",
    zh: "Tibo（OpenAI Codex开发者）宣布为庆祝GPT-5.6 Sol发布，将在24小时内对ChatGPT Work 和 Codex 全体执行第2次速率限制重置。",
  },
  "Tibo氏（OpenAI Codex開発者）が、GPT-5.6 Solローンチ記念の3回目のレート制限リセットを本日後半に実施すると発表しました。": {
    ja: "Tibo氏（OpenAI Codex開発者）が、GPT-5.6 Solローンチ記念の3回目のレート制限リセットを本日後半に実施すると発表しました。",
    en: "Tibo (OpenAI Codex developer) announced a third rate limit reset later today (US Pacific time) to celebrate the GPT-5.6 Sol launch.",
    zh: "Tibo（OpenAI Codex开发者）宣布将于今天晚些时候（美国太平洋时间）执行第3次速率限制重置，以庆祝GPT-5.6 Sol发布。",
  },
  "GPT-5.6 Solリリース記念リセット（4回目）": {
    ja: "GPT-5.6 Solリリース記念リセット（4回目）",
    en: "GPT-5.6 Sol launch celebration reset (fourth)",
    zh: "GPT-5.6 Sol 发布庆祝重置（第4次）",
  },
  "GPT-5.6 Solの追加調査・改善に伴い、ChatGPT WorkとCodex全体の利用上限が4回目に強制リセットされました。": {
    ja: "GPT-5.6 Solの追加調査・改善に伴い、ChatGPT WorkとCodex全体の利用上限が4回目に強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset for a fourth time following additional investigations and improvements to GPT-5.6 Sol.",
    zh: "随着对 GPT-5.6 Sol 的进一步调查与改进，ChatGPT Work 和 Codex 的使用限制已第4次被强制重置。",
  },
  "GPT-5.6 Solリリース記念リセット（3回目）": {
    ja: "GPT-5.6 Solリリース記念リセット（3回目）",
    en: "GPT-5.6 Sol launch celebration reset (third)",
    zh: "GPT-5.6 Sol 发布庆祝重置（第3次）",
  },
  "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が3回目に強制リセットされました。": {
    ja: "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が3回目に強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset for a third time to celebrate the GPT-5.6 Sol launch.",
    zh: "为庆祝GPT-5.6 Sol发布，ChatGPT Work 和 Codex 的使用限制已第3次被强制重置。",
  },
  "15時間": {
    ja: "15時間",
    en: "15 hours",
    zh: "15小时",
  },
  "GPT-5.6 Solリリース記念リセット（2回目）": {
    ja: "GPT-5.6 Solリリース記念リセット（2回目）",
    en: "GPT-5.6 Sol launch celebration reset (second)",
    zh: "GPT-5.6 Sol 发布庆祝重置（第2次）",
  },
  "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が2回目に強制リセットされました。": {
    ja: "GPT-5.6 Solのリリース記念として、ChatGPT WorkとCodex全体の利用上限が2回目に強制リセットされました。",
    en: "Usage limits for ChatGPT Work and Codex were reset for a second time to celebrate the GPT-5.6 Sol launch.",
    zh: "为庆祝GPT-5.6 Sol发布，ChatGPT Work 和 Codex 的使用限制已第2次被强制重置。",
  },
  "12時間56分": {
    ja: "12時間56分",
    en: "12 hours 56 minutes",
    zh: "12小时56分钟",
  },
  "GPT-5.6リリース記念リセット": {
    ja: "GPT-5.6リリース記念リセット",
    en: "GPT-5.6 launch celebration reset",
    zh: "GPT-5.6 发布庆祝重置",
  },
  "GPT-5.6のリリース記念として、全有料プランのCodex利用上限が強制的にリセットされました。": {
    ja: "GPT-5.6のリリース記念として、全有料プランのCodex利用上限が強制的にリセットされました。",
    en: "Codex usage limits for all paid plans were reset to celebrate the GPT-5.6 launch.",
    zh: "为庆祝GPT-5.6发布，所有付费套餐的Codex使用限制已被强制重置。",
  },
  "約3時間": {
    ja: "約3時間",
    en: "About 3 hours",
    zh: "约3小时",
  },
  "任意リセット1回分": {
    ja: "任意リセット1回分",
    en: "1 Banked Reset granted",
    zh: "手动重置 1 次",
  },
  "1回分・期限1か月以内": {
    ja: "1回分・期限1か月以内",
    en: "1 Banked Reset; valid within 1 month",
    zh: "1 次手动重置・1 个月内有效",
  },
  "対象アカウント": {
    ja: "対象アカウント",
    en: "Eligible accounts",
    zh: "目标账号",
  },
  "モデル能力退化および過剰な制限消費不具合に対する補償として、任意リセット1回分が配布されました。": {
    ja: "モデル能力退化および過剰な制限消費不具合に対する補償として、任意リセット1回分が配布されました。",
    en: "One Banked Reset was distributed as compensation for model degradation and excessive limit consumption issues.",
    zh: "因模型能力退化及额度过度消耗问题，已发放 1 次手动重置作为补偿。",
  },
  "Codexの信頼性に影響する不具合の補償として、任意リセット1回分が配布されました。": {
    ja: "Codexの信頼性に影響する不具合の補償として、任意リセット1回分が配布されました。",
    en: "One Banked Reset was distributed as compensation for issues affecting Codex reliability.",
    zh: "因影响 Codex 可靠性的故障，已发放 1 次手动重置作为补偿。",
  },
  "個人の利用制限の更新として、任意リセットが配布されました。": {
    ja: "個人の利用制限の更新として、任意リセットが配布されました。",
    en: "A Banked Reset was distributed as an individual usage-limit refresh.",
    zh: "已发放手动重置，用于个人使用额度更新。",
  },
  "能力退化・過剰消費補償任意リセット": {
    ja: "能力退化・過剰消費補償任意リセット",
    en: "Model Degradation & Excessive Consumption Compensation Reset",
    zh: "模型退化及额度过度消耗补偿手动重置",
  },
  "モデルの能力退化および過剰な利用制限消費不具合に対する補償として、全有料プランに任意リセット（マニュアルリセット）1回分が配布されました。": {
    ja: "モデルの能力退化および過剰な利用制限消費不具合に対する補償として、全有料プランに任意リセット（マニュアルリセット）1回分が配布されました。",
    en: "One Banked Reset was distributed to all paid plans as compensation for model degradation and excessive usage consumption issues.",
    zh: "因模型能力退化及额度过度消耗问题，已对所有付费套餐发放 1 次手动重置作为补偿。",
  },
  "Codex信頼性障害補償任意リセット": {
    ja: "Codex信頼性障害補償任意リセット",
    en: "Codex Reliability Incident Compensation Reset",
    zh: "Codex 可靠性故障补偿手动重置",
  },
  "Codexの信頼性に影響する不具合の補償として、全アカウントに対して任意リセット（マニュアルリセット）1回分が配布されました。": {
    ja: "Codexの信頼性に影響する不具合の補償として、全アカウントに対して任意リセット（マニュアルリセット）1回分が配布されました。",
    en: "One Banked Reset was distributed to all accounts as compensation for issues affecting Codex reliability.",
    zh: "因影响 Codex 可靠性的故障，已对所有账号发放 1 次手动重置作为补偿。",
  },
  "過剰消費バグ調査・強制補償リセット": {
    ja: "過剰消費バグ調査・強制補償リセット",
    en: "Forced Compensation Reset (Excessive Consumption Investigation)",
    zh: "过度消耗漏洞调查强制补偿重置",
  },
  "一部のユーザーでCodexの使用制限が過剰に消費される不具合が発生したため、その調査に伴い全ユーザーの利用制限が強制的にリセット（クリア）されました。": {
    ja: "一部のユーザーでCodexの使用制限が過剰に消費される不具合が発生したため、その調査に伴い全ユーザーの利用制限が強制的にリセット（クリア）されました。",
    en: "Due to an issue causing excessive usage limit consumption for some users, everyone's Codex limits were forcibly reset (cleared) during the investigation.",
    zh: "因部分用户出现 Codex 使用额度过度消耗的问题，在调查期间已强制重置（清空）所有用户的限制额度。",
  },
  "Tibo氏が、Codexの過剰な利用制限消費問題の調査に伴い、全員の利用制限を強制リセットしたと発表しました。": {
    ja: "Tibo氏が、Codexの過剰な利用制限消費問題の調査に伴い、全員の利用制限を強制リセットしたと発表しました。",
    en: "Tibo announced that they forcibly reset everyone's Codex limits as they investigate an issue causing excessive usage consumption.",
    zh: "Tibo 宣布由于正在调查导致使用量过度消耗的问题，已强制重置所有人的 Codex 额度限制。",
  },
  "Tibo氏が、過剰消費問題の調査が終了した後、追加の手動リセット（任意リセット枠）を全員に配布すると発表しました。": {
    ja: "Tibo氏が、過剰消費問題の調査が終了した後、追加の手動リセット（任意リセット枠）を全員に配布すると発表しました。",
    en: "Tibo announced that more Banked Resets will be provided to everyone after the excessive consumption investigation is complete.",
    zh: "Tibo 宣布在过度消耗问题的调查结束后，将对所有人发放额外的手动重置机会。",
  },
  "Tibo氏が、1時間以内に全員のCodex利用制限を再度フルリセットすると発表しました。": {
    ja: "Tibo氏が、1時間以内に全員のCodex利用制限を再度フルリセットすると発表しました。",
    en: "Tibo announced that everyone's Codex limits will be fully reset again within the next hour.",
    zh: "Tibo 宣布将在 1 小时内再次完全重置所有人的 Codex 额度限制。",
  },
  "Tibo氏が、今後24時間以内に全有料プランへ任意リセット枠をさらに1回分追加配布すると発表しました。": {
    ja: "Tibo氏が、今後24時間以内に全有料プランへ任意リセット枠をさらに1回分追加配布すると発表しました。",
    en: "Tibo announced that one additional Banked Reset will be distributed to all paid plans within the next 24 hours.",
    zh: "Tibo 宣布将在未来 24 小时内向所有付费套餐追加发放 1 次手动重置机会。",
  },
  "OpenAI関係者がAI Engineerイベントで Codex reset button の実演を示唆し、Tibo氏も “It's happening” と反応しています。": {
    ja: "OpenAI関係者がAI Engineerイベントで Codex reset button の実演を示唆し、Tibo氏も “It's happening” と反応しています。",
    en: "An OpenAI member hinted at a Codex reset button demo at the AI Engineer event, and Tibo also reacted with “It’s happening.”",
    zh: "OpenAI成员暗示将在AI Engineer活动中演示Codex重置按钮，Tibo也对此回应称 “It's happening”。",
  },
  "Romain Huet氏 & Tibo氏の公式Xにて言及あり": {
    ja: "Romain Huet氏 & Tibo氏の公式Xにて言及あり",
    en: "Mentioned on Romain Huet's & Tibo's official X",
    zh: "Romain Huet 与 Tibo 的官方 X 提及",
  },
  "臨時リセット": {
    ja: "臨時リセット",
    en: "Temporary Reset",
    zh: "临时重置",
  },
  "Tibo氏が1時間以内の再フルリセットを告知し、利用制限の過剰消費問題への補償対応として全有料プランのCodex利用制限が強制リセットされました。": {
    ja: "Tibo氏が1時間以内の再フルリセットを告知し、利用制限の過剰消費問題への補償対応として全有料プランのCodex利用制限が強制リセットされました。",
    en: "Tibo announced that a full reset would take place within an hour. Codex limits were then reset for all users as compensation for an excessive-usage issue.",
    zh: "Tibo 宣布将在 1 小时内再次完全重置，并且所有人的 Codex 额度限制已作为过度消耗问题的补偿被强制重置。",
  },
  "任意リセット配布": {
    ja: "任意リセット配布",
    en: "Banked Reset Distributed",
    zh: "手动重置已发放",
  },
  "仕様変更": {
    ja: "仕様変更",
    en: "Specification change",
    zh: "规格变更",
  },
  "定期リセットが強制リセットから任意リセット1回分の配布に変更されました。": {
    ja: "定期リセットが強制リセットから任意リセット1回分の配布に変更されました。",
    en: "The regular reset has been changed from a Hard Reset to a distribution of one Banked Reset.",
    zh: "定期重置已从强制重置更改为发放 1 次手动重置。",
  },
  "Codex reset button 配布 (AIE World's Fair 記念)": {
    ja: "Codex reset button 配布 (AIE World's Fair 記念)",
    en: "Codex Reset Button (AIE World's Fair)",
    zh: "Codex 重置按钮（AIE World's Fair 纪念）",
  },
  "AI Engineer World's Fair のデモにおいて Codex reset button が押され、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。": {
    ja: "AI Engineer World's Fair のデモにおいて Codex reset button が押され、全有料ユーザー（Codex Go/Plus/Pro）に対して任意リセット（マニュアルリセット）1回分が配布されました。",
    en: "During the AI Engineer World's Fair demo, the Codex reset button was pressed, granting one Banked Reset to all paid users (Codex Go/Plus/Pro).",
    zh: "在 AI Engineer World's Fair 的演示中，Codex 重置按钮被按下，向所有付费用户（Codex Go/Plus/Pro）发放了 1 次手动重置机会。",
  },
  "キャンペーン": {
    ja: "キャンペーン",
    en: "Campaign",
    zh: "活动",
  },
  "1時間": {
    ja: "1時間",
    en: "1 hour",
    zh: "1小时",
  },
  "告知": {
    ja: "告知",
    en: "Notice",
    zh: "通知",
  },
  "実行": {
    ja: "実行",
    en: "Executed",
    zh: "执行",
  },
  "任意リセットを使っていないアカウント": {
    ja: "任意リセットを使っていないアカウント",
    en: "Accounts that have not used a Banked Reset",
    zh: "未使用手动重置的账号",
  },
  "出典のない共通参考日時です。実際の全体リセット実施を確認した記録ではありません。": {
    ja: "出典のない共通参考日時です。実際の全体リセット実施を確認した記録ではありません。",
    en: "This is a shared reference time without a recorded source, not a confirmed global reset.",
    zh: "这是没有记录来源的公共参考时间，并非已确认的全局重置。",
  },
  "任意リセット権の配布は確認できますが、全体への強制リセット実施はこの記録では確認できないため、共通参考日時として扱います。": {
    ja: "任意リセット権の配布は確認できますが、全体への強制リセット実施はこの記録では確認できないため、共通参考日時として扱います。",
    en: "A Banked Reset distribution is recorded, but this entry does not confirm a forced global reset, so it is treated as a shared reference time.",
    zh: "可以确认发放了手动重置，但该记录无法确认全局强制重置，因此按公共参考时间处理。",
  },
  "定期的な強制リセットではなく、任意リセット権が1回分配布されました。使用後の利用枠や次回日時はユーザーごとに異なる場合があります。": {
    ja: "定期的な強制リセットではなく、任意リセット権が1回分配布されました。使用後の利用枠や次回日時はユーザーごとに異なる場合があります。",
    en: "This was not a regular forced reset. One Banked Reset was distributed, and the resulting usage window or next date may differ by account.",
    zh: "这不是定期强制重置，而是发放了 1 次手动重置；使用后的额度周期和下次日期可能因账号而异。",
  },
  "任意リセットを使用すると、対象の利用上限が更新されます。その後の7日間枠や表示されるリセット日時は、アカウントの利用状況によって、このサイトの共通参考日時と異なる場合があります。": {
    ja: "任意リセットを使用すると、対象の利用上限が更新されます。その後の7日間枠や表示されるリセット日時は、アカウントの利用状況によって異なる場合があります。",
    en: "Using a Banked Reset refreshes the applicable usage limit. The resulting usage window and reset date may differ by account.",
    zh: "使用手动重置后，适用的使用上限会被刷新。之后的使用周期以及账号中显示的重置日期可能因账号而异。",
  },
  "予告": {
    ja: "予告",
    en: "Notice",
    zh: "预告",
  },
  "予告内容": {
    ja: "予告内容",
    en: "Notice details",
    zh: "预告详情",
  },
  "GPT-5.6 Sol利用効率改善リセット": {
    ja: "GPT-5.6 Sol利用効率改善リセット",
    en: "GPT-5.6 Sol Efficiency Improvement Reset",
    zh: "GPT-5.6 Sol 效率提升重置",
  },
  "Tibo氏よりGPT-5.6 Solモデルの消費効率改善（利用持続力約18%向上）の発表とともに、全ChatGPT WorkおよびCodexユーザーの利用上限が即時強制リセットされました。": {
    ja: "Tibo氏よりGPT-5.6 Solモデルの消費効率改善（利用持続力約18%向上）の発表とともに、全ChatGPT WorkおよびCodexユーザーの利用上限が即時強制リセットされました。",
    en: "Following the announcement by Tibo regarding efficiency improvements for the GPT-5.6 Sol model (~18% longer usage duration), rate limits for all ChatGPT Work and Codex users were forcibly reset immediately.",
    zh: "随着 Tibo 宣布 GPT-5.6 Sol 模型的消耗效率提升（使用时长延长约 18%），所有 ChatGPT Work 和 Codex 用户的用量上限已立即被强制重置。",
  },
  "直近7日間でリセットが3回発生しており、リセット頻度が高まっているため予測確率を上昇補正しています。": {
    ja: "直近7日間でリセットが3回発生しており、リセット頻度が高まっているため予測確率を上昇補正しています。",
    en: "Reset probability has been upwardly adjusted due to an increased frequency of 3 resets in the past 7 days.",
    zh: "由于过去 7 天内已发生 3 次重置且重置频率上升，预测概率已向上调整。",
  },
  "直近7日間でリセットが4回以上発生しており、連続リセットウェーブ（ラッシュ期）に入っているため予測確率を大幅に上昇補正しています。": {
    ja: "直近7日間でリセットが4回発生しており、連続リセットウェーブ（ラッシュ期）に入っているため予測確率を大幅に上昇補正しています。",
    en: "Reset probability has been significantly boosted due to a high-density reset wave (4+ resets in the past 7 days).",
    zh: "由于过去 7 天内已发生 4 次以上重置进入高频重置波（密集期），预测概率已大幅向上调整。",
  },
  "公式予告あり": {
    ja: "公式予告あり",
    en: "Official notice",
    zh: "有官方预告",
  },
  "公式告知あり": {
    ja: "公式告知あり",
    en: "Official notice",
    zh: "有官方预告",
  },
  "告知投稿あり": {
    ja: "告知投稿あり",
    en: "Official notice",
    zh: "有官方预告",
  },
  "匂わせ投稿あり": {
    ja: "匂わせ投稿あり",
    en: "Teaser hint",
    zh: "有预告提示",
  },
  "予告あり": {
    ja: "予告あり",
    en: "Notice available",
    zh: "有预告",
  },
  "予告なし": {
    ja: "予告なし",
    en: "No notice",
    zh: "无预告",
  },
  "なし": {
    ja: "なし",
    en: "None",
    zh: "无预告",
  },
} satisfies Record<StandardHistoryTerm, Record<Locale, string>> & Record<string, Record<Locale, string>>;

export function translateUI(key: string, locale: Locale): string {
  return UI_TRANSLATIONS[key]?.[locale] ?? key;
}

export function translateDynamic(value: string | undefined, locale: Locale): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim().normalize("NFC");

  // DYNAMIC_TRANSLATIONS のキーもNFC正規化した辞書を作成して検索する（NFD/NFC差異対策）
  const normalizedDict: Record<string, Record<Locale, string>> = {};
  for (const [key, mapping] of Object.entries(DYNAMIC_TRANSLATIONS)) {
    normalizedDict[key.normalize("NFC")] = mapping;
  }

  const directMatch = normalizedDict[trimmed]?.[locale];
  if (directMatch) {
    return directMatch;
  }

  // 日・時間・分パターンの自動解析・翻訳（例: "35時間20分", "1日5時間", "2日" などを辞書登録なしで全自動変換）
  const durationMatch = trimmed.match(/^(?:(\d+)日)?(?:(\d+)時間)?(?:(\d+)分)?$/);
  if (
    durationMatch &&
    (durationMatch[1] !== undefined ||
      durationMatch[2] !== undefined ||
      durationMatch[3] !== undefined)
  ) {
    const days = durationMatch[1] ? parseInt(durationMatch[1], 10) : 0;
    const hours = durationMatch[2] ? parseInt(durationMatch[2], 10) : 0;
    const minutes = durationMatch[3] ? parseInt(durationMatch[3], 10) : 0;

    if (days > 0 || hours > 0 || minutes > 0) {
      if (locale === "en") {
        const parts: Array<string> = [];
        if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
        if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
        if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
        return parts.join(" ");
      }
      if (locale === "zh") {
        const parts: Array<string> = [];
        if (days > 0) parts.push(`${days} 天`);
        if (hours > 0) parts.push(`${hours} 小时`);
        if (minutes > 0) parts.push(`${minutes} 分钟`);
        return parts.join(" ");
      }
      const parts: Array<string> = [];
      if (days > 0) parts.push(`${days}日`);
      if (hours > 0) parts.push(`${hours}時間`);
      if (minutes > 0) parts.push(`${minutes}分`);
      return parts.join("");
    }
  }

  // Fallback for partial/contains matching or dynamic strings
  let result = trimmed;
  const sortedEntries = Object.entries(normalizedDict).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [key, mapping] of sortedEntries) {
    if (key.length > 3 && result.includes(key)) {
      result = result.replaceAll(key, mapping[locale]);
    }
  }

  return result;
}

const TIBO_POST_TRANSLATIONS: Array<{
  sourcePrefix: string;
  ja: string;
  zh: string;
}> = [
  {
    sourcePrefix:
      "You can just ask Codex with GPT-5.6 Sol the wildest things and it will just do it.",
    ja: "GPT-5.6 Sol搭載のCodexなら、どんな無茶なことでも頼めます。何週間もかかりそうな作業でも、5分間話すだけで進めてくれます。冷蔵庫から何か取ってきたり、犬を撫でたりして戻ってくると…",
    zh: "使用 GPT-5.6 Sol 的 Codex，你可以让它完成各种疯狂的事情。只需和它连续交流5分钟，那些看起来需要几周才能完成的工作也能推进；你去冰箱拿点东西、摸摸狗，再回来时，它已经……",
  },
];

export function translateTiboPostText(
  value: string | undefined,
  locale: Locale,
): string {
  if (!value) return "";

  const normalized = value.replace(/\r\n?/g, "\n").trim().normalize("NFC");
  const compact = normalized.replace(/\s+/g, " ");
  const dynamicallyTranslated = translateDynamic(compact, locale);
  if (dynamicallyTranslated !== compact) {
    return dynamicallyTranslated;
  }

  if (locale === "en") return normalized;

  const knownPost = TIBO_POST_TRANSLATIONS.find(({ sourcePrefix }) =>
    compact.startsWith(sourcePrefix),
  );
  return knownPost?.[locale] ?? normalized;
}

export function translateExpectation(value: string, locale: Locale): string {
  const dictionary: Record<string, Record<Locale, string>> = {
    低: { ja: "低", en: "Low", zh: "低" },
    中: { ja: "中", en: "Medium", zh: "中" },
    高: { ja: "高", en: "High", zh: "高" },
    超高: { ja: "極めて高", en: "Very High", zh: "极高" },
    極めて高: { ja: "極めて高", en: "Very High", zh: "极高" },
    不明: { ja: "不明", en: "Unknown", zh: "未知" },
  };

  return dictionary[value]?.[locale] ?? value;
}

export function resolveLocalizedText(
  value: LocalizedString | null | undefined,
  locale: Locale,
): string {
  if (!value) return "";
  if (typeof value === "object" && value !== null) {
    const direct = value[locale]?.trim();
    if (direct) return direct;
    if (value.ja?.trim()) {
      return translateDynamic(value.ja.trim(), locale);
    }
    return "";
  }
  return translateDynamic(value, locale);
}

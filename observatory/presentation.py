"""Localized, defensive presentation of the public radar snapshot.

The website consumes the same public-v1 projection as API clients.  It never
serializes the ingestion records or their private classification metadata.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean, median
from typing import Any
from urllib.parse import urlsplit

SITE_URL = "http://localhost:9090"
SITE_AUTHOR = "allen flux"
REPOSITORY_URL = "https://github.com/allenflux/codex-reset-observator"
VISIBLE_RECORD_KINDS = {"confirmed_global", "banked_distribution", "reference", "regular_completed"}

COPY: dict[str, dict[str, Any]] = {
    "en": {
        "site_name": "Codex Reset Observatory",
        "tagline": "An independent view of Codex usage resets",
        "home": "Overview",
        "history": "History",
        "about": "About",
        "faq": "FAQ",
        "skip": "Skip to content",
        "language": "Language",
        "navigation": "Main navigation",
        "title_home": "Know where the next reset stands.",
        "title_history": "The reset record.",
        "title_about": "About the observatory.",
        "title_faq": "Frequently asked questions.",
        "description": "Track Codex reset history, official notices, and estimates for the next 24 and 48 hours.",
        "eyebrow_home": "CODEX USAGE · RESET OUTLOOK",
        "eyebrow_history": "THE OBSERVATION ARCHIVE",
        "eyebrow_about": "HOW THIS OBSERVATORY WORKS",
        "eyebrow_faq": "A GUIDE TO RESETS",
        "subtitle_history": "Global resets, Banked Reset distributions, and regular resets, newest first.",
        "subtitle_about": "An unofficial reference for reset history, notices, and observable signals.",
        "subtitle_faq": "Understanding timing, usage limits, and what the forecast can tell you.",
        "updated": "Source updated",
        "checked": "Checked",
        "refresh": "Refresh",
        "refreshing": "Refreshing…",
        "refresh_failed": "Could not refresh. The last available snapshot is still shown.",
        "stale": "Saved data",
        "healthy": "Sources connected",
        "offline": "Live sources are unavailable or delayed. This saved snapshot may be outdated; forecasts are estimates based on the available records.",
        "unknown": "Unknown",
        "status": "Codex service",
        "status_none": "No known active incident",
        "status_active": "Incident reported",
        "status_recovered": "Recovered",
        "status_unknown": "Status unavailable",
        "notice": "Official reset notice",
        "no_notice": "No active notice",
        "notice_active": "Notice detected",
        "no_notice_text": "No active official reset notice is present in this snapshot.",
        "forecast": "Random reset outlook",
        "forecast_note": "Statistical estimates, not an official schedule. Account eligibility may vary.",
        "neural_primary": "Neural network forecast",
        "neural_primary_note": "Our locally trained neural network estimates reset probabilities from historical event timing. It does not analyze post text. The model is experimental and has not been prospectively validated.",
        "within_24": "Within 24h",
        "within_48": "Within 48h",
        "method": "How this is estimated",
        "last_reset": "Latest recorded reset",
        "next_regular": "Next regular reset",
        "regular_note": "A schedule estimate. Your account's actual usage window may differ.",
        "latest_random": "Last random reset",
        "scheduled": "Expected time",
        "deadline": "Window ends",
        "scope": "Scope",
        "kind": "Record type",
        "reason": "Reason",
        "method_label": "Reset method",
        "notice_type": "Notice",
        "notice_gap": "Notice to execution",
        "source": "View source",
        "history_heading": "Recent reset events",
        "all_history": "View all history",
        "empty_history": "No reset records are available yet.",
        "record_confirmed_global": "Global reset",
        "record_banked_distribution": "Banked Reset distribution",
        "record_regular_completed": "Regular reset",
        "record_reference": "Reference record",
        "reference_note": "Reference record; not a confirmed global reset.",
        "heatmap": "When resets have happened",
        "heatmap_note": "Recorded random resets grouped by local hour. Past timing does not establish the next reset time.",
        "timezone": "Time zone",
        "utc": "UTC",
        "local": "Your time zone",
        "range": "Time range",
        "all_time": "All time",
        "last_month": "Last 30 days",
        "records": "records",
        "count": "Reset count",
        "intervals": "Time between random resets",
        "interval_note": "Intervals between consecutive events, grouped by elapsed days.",
        "median": "Median",
        "average": "Average",
        "shortest": "Shortest",
        "longest": "Longest",
        "no_intervals": "At least two recorded resets are needed to calculate intervals.",
        "days": "days",
        "hours": "hours",
        "latest_post": "Related Tibo post",
        "social_source": "Synced through the original site’s public API",
        "social_no_analysis": "Post text has not been semantically analyzed",
        "social_rule_notice": "Explicit reset announcement (local rules)",
        "announced": "Reset announced · awaiting execution",
        "announced_note": "A developer announcement takes priority over the historical forecast. It does not confirm that a reset has happened.",
        "notice_timing": "Timing in the original post",
        "notice_timezone_unknown": "The time has not been resolved reliably; no local countdown is shown.",
        "historical_forecast_note": "The neural probabilities below use historical timing only and do not incorporate this announcement. They are not the probability that the announcement will be fulfilled.",
        "no_post": "No public post is available in this snapshot.",
        "classification": "Observed classification",
        "posted": "Posted",
        "reply_context": "Reply context",
        "classification_official_notice": "Official notice",
        "classification_reset_executed": "Reset announced as completed",
        "classification_teaser": "Reset hint",
        "classification_irrelevant": "Unrelated to resets",
        "classification_strong": "Strong reset hint",
        "classification_weak": "Weak reset hint",
        "unofficial": "Independent and unofficial. Verify reset announcements and your account limits with OpenAI.",
        "developer": "Source code",
        "api": "Public API",
        "filter_history": "Filter records",
        "all_records": "All records",
        "search_history": "Search reset history",
        "no_matches": "No records match these filters.",
        "sources_heading": "Sources & methodology",
        "source_status": "OpenAI Status",
        "source_official": "Official Codex updates",
        "about_paragraphs": [
            "Codex Reset Observatory brings together reset history and official notices so you can compare the current situation with earlier events.",
            "The main forecast uses our locally trained neural network and historical reset timing. Post text is not a model input. The model is experimental and has not outperformed the baseline in the initial evaluation; it is not an official OpenAI probability or a promised reset.",
            "Global resets, Banked Reset distributions, regular resets, and reference records are kept distinct. Using a Banked Reset refreshes the applicable usage limit; the resulting window and reset date can differ by account.",
            "Read the original announcement for each event and check the usage limits shown in your account. A recorded event does not guarantee identical coverage for every plan.",
        ],
    },
    "ja": {
        "site_name": "Codexリセット観測所",
        "tagline": "Codexの利用上限リセットを観測する非公式サイト",
        "home": "概要",
        "history": "履歴",
        "about": "このサイトについて",
        "faq": "よくある質問",
        "skip": "本文へ移動",
        "language": "言語",
        "navigation": "メインナビゲーション",
        "title_home": "次のリセットを、観測する。",
        "title_history": "リセットの記録。",
        "title_about": "観測所について。",
        "title_faq": "よくある質問。",
        "description": "Codexのリセット履歴、公式予告、24時間・48時間以内のリセット予測を確認できます。",
        "eyebrow_home": "CODEX 利用上限 · リセット予測",
        "eyebrow_history": "これまでの観測記録",
        "eyebrow_about": "観測所のしくみ",
        "eyebrow_faq": "リセットの見方",
        "subtitle_history": "全体リセット・任意リセット権配布・定期リセットを、新しい順にまとめています。",
        "subtitle_about": "リセット履歴、公式予告、観測シグナルを整理する非公式の参考サイトです。",
        "subtitle_faq": "リセット時刻、利用上限、予測の意味についてまとめました。",
        "updated": "ソース更新",
        "checked": "確認時刻",
        "refresh": "更新",
        "refreshing": "更新中…",
        "refresh_failed": "更新できませんでした。最後に取得した情報を表示しています。",
        "stale": "保存データ",
        "healthy": "取得元に接続済み",
        "offline": "最新情報を取得できないか、取得が遅れています。保存済みの情報は古い可能性があり、予測は利用できる記録に基づく推定です。",
        "unknown": "不明",
        "status": "Codex 稼働状況",
        "status_none": "既知の障害なし",
        "status_active": "障害を確認",
        "status_recovered": "復旧済み",
        "status_unknown": "稼働状況不明",
        "notice": "公式リセット予告",
        "no_notice": "現在の予告なし",
        "notice_active": "予告を確認",
        "no_notice_text": "このデータでは、現在有効な公式リセット予告は確認されていません。",
        "forecast": "ランダムリセット期待度",
        "forecast_note": "統計に基づく推定です。公式の予定ではなく、アカウントによって適用範囲が異なります。",
        "neural_primary": "ニューラルネットワーク予測",
        "neural_primary_note": "ローカルで学習した独自のニューラルネットワークが、過去の発生時刻からリセット確率を推定します。投稿本文の意味解析は行いません。試験運用中で、将来データによる検証は未完了です。",
        "within_24": "24時間以内",
        "within_48": "48時間以内",
        "method": "予測の算出方法",
        "last_reset": "直近のリセット記録",
        "next_regular": "次回の定期リセット",
        "regular_note": "スケジュールからの推定です。アカウントの利用枠と異なる場合があります。",
        "latest_random": "前回のランダムリセット",
        "scheduled": "予定時刻",
        "deadline": "予定時間帯の終わり",
        "scope": "対象",
        "kind": "記録の種類",
        "reason": "理由",
        "method_label": "リセット方式",
        "notice_type": "予告",
        "notice_gap": "予告から実施まで",
        "source": "情報源を見る",
        "history_heading": "直近のリセット履歴",
        "all_history": "すべての履歴",
        "empty_history": "履歴データはまだありません。",
        "record_confirmed_global": "全体リセット",
        "record_banked_distribution": "任意リセット権配布",
        "record_regular_completed": "定期リセット",
        "record_reference": "参考記録",
        "reference_note": "参考記録です。全体リセットの確認記録ではありません。",
        "heatmap": "過去のランダムリセット時刻",
        "heatmap_note": "記録されたランダムリセットを現地時刻別に集計。過去の時刻は次回の実施時刻を保証しません。",
        "timezone": "タイムゾーン",
        "utc": "UTC",
        "local": "端末のタイムゾーン",
        "range": "集計期間",
        "all_time": "全期間",
        "last_month": "直近30日",
        "records": "件",
        "count": "リセット件数",
        "intervals": "過去のランダムリセット間隔",
        "interval_note": "連続するリセットの間隔を経過日数ごとに集計しています。",
        "median": "中央値",
        "average": "平均",
        "shortest": "最短",
        "longest": "最長",
        "no_intervals": "間隔の計算には2件以上のリセット記録が必要です。",
        "days": "日",
        "hours": "時間",
        "latest_post": "Tiboの関連投稿",
        "social_source": "元サイトの公開API経由で同期",
        "social_no_analysis": "投稿本文の意味解析は未実施",
        "social_rule_notice": "明確なリセット予告（ローカルルール）",
        "announced": "リセット予告あり・実施確認待ち",
        "announced_note": "開発者の予告を過去の履歴による予測より優先して表示します。実施済みという意味ではありません。",
        "notice_timing": "原文の時期表現",
        "notice_timezone_unknown": "時刻を確実に解決できないため、現地時刻のカウントダウンは表示しません。",
        "historical_forecast_note": "下のニューラル確率は過去のリセット時刻だけを使い、この予告を考慮していません。予告が実現する確率ではありません。",
        "no_post": "このデータでは公開投稿を取得できていません。",
        "classification": "観測上の分類",
        "posted": "投稿時刻",
        "reply_context": "返信先の内容",
        "classification_official_notice": "公式予告",
        "classification_reset_executed": "リセット完了の発表",
        "classification_teaser": "リセットの匂わせ",
        "classification_irrelevant": "リセットとは無関係",
        "classification_strong": "強いリセットの匂わせ",
        "classification_weak": "弱いリセットの匂わせ",
        "unofficial": "非公式の観測サイトです。リセットの発表とご自身の利用上限はOpenAIの情報をご確認ください。",
        "developer": "ソースコード",
        "api": "公開API",
        "filter_history": "記録の絞り込み",
        "all_records": "すべての記録",
        "search_history": "リセット履歴を検索",
        "no_matches": "条件に合う記録はありません。",
        "sources_heading": "情報源と予測方法",
        "source_status": "OpenAI 稼働状況",
        "source_official": "Codexの公式投稿",
        "about_paragraphs": [
            "Codexリセット観測所は、リセット履歴と公式予告をまとめ、現在の状況と過去の出来事を比較できるようにする非公式サイトです。",
            "主予測には、過去のリセット時刻でローカル学習したニューラルネットワークを使用します。投稿本文は入力に含みません。初期評価ではベースラインを上回っておらず、実験的な予測です。OpenAIの公式確率やリセット実施の保証ではありません。",
            "全体リセット、任意リセット権配布、定期リセット、参考記録を区別して掲載します。任意リセットを使うと対象の利用上限が更新されますが、その後の利用期間とリセット日時はアカウントにより異なります。",
            "各イベントの原文とアカウントの利用上限をご確認ください。履歴に記録されたイベントが、すべてのプランに同じように適用されるとは限りません。",
        ],
    },
    "zh": {
        "site_name": "Codex 重置观测站",
        "tagline": "独立观察 Codex 使用额度重置的非官方网站",
        "home": "概览",
        "history": "历史记录",
        "about": "关于本站",
        "faq": "常见问题",
        "skip": "跳转到正文",
        "language": "语言",
        "navigation": "主导航",
        "title_home": "观察下一次重置的可能。",
        "title_history": "每一次重置，都有记录。",
        "title_about": "关于重置观测站。",
        "title_faq": "关于重置，你可能想知道。",
        "description": "查看 Codex 最新重置时间、历史记录、官方预告，以及未来 24 小时和 48 小时内的重置预测。",
        "eyebrow_home": "CODEX 使用额度 · 重置预测",
        "eyebrow_history": "历史观测档案",
        "eyebrow_about": "了解观测站",
        "eyebrow_faq": "重置参考指南",
        "subtitle_history": "按时间倒序汇总全局重置、手动重置发放和定期重置记录。",
        "subtitle_about": "整理重置历史、官方预告和公开信号的非官方参考网站。",
        "subtitle_faq": "了解重置时间、使用额度，以及预测所能提供的参考。",
        "updated": "数据源更新",
        "checked": "检查时间",
        "refresh": "刷新",
        "refreshing": "刷新中…",
        "refresh_failed": "暂时无法刷新，仍显示最后一次获取的数据。",
        "stale": "已保存的数据",
        "healthy": "数据源已连接",
        "offline": "实时数据源暂时不可用或存在延迟。当前显示的已保存数据可能过时，预测是根据现有记录计算的估计值。",
        "unknown": "未知",
        "status": "Codex 服务状态",
        "status_none": "未发现正在发生的故障",
        "status_active": "已报告故障",
        "status_recovered": "已恢复",
        "status_unknown": "状态暂不可用",
        "notice": "官方重置预告",
        "no_notice": "暂无有效预告",
        "notice_active": "已发现预告",
        "no_notice_text": "当前数据中没有发现仍然有效的官方重置预告。",
        "forecast": "随机重置可能性",
        "forecast_note": "基于统计的参考预测，并非官方时间表；实际适用范围可能因账号而异。",
        "neural_primary": "神经网络预测",
        "neural_primary_note": "使用我们在本地训练的神经网络，根据历史事件时间估算重置概率。当前模型不分析帖文语义，仍处于实验阶段，尚未完成前瞻验证。",
        "within_24": "24 小时内",
        "within_48": "48 小时内",
        "method": "了解预测方法",
        "last_reset": "最近一次重置记录",
        "next_regular": "下一次定期重置",
        "regular_note": "根据周期估计的时间，可能与账号实际使用额度窗口不同。",
        "latest_random": "上次随机重置",
        "scheduled": "预计时间",
        "deadline": "预计窗口结束",
        "scope": "适用范围",
        "kind": "记录类型",
        "reason": "原因",
        "method_label": "重置方式",
        "notice_type": "预告类型",
        "notice_gap": "预告至执行间隔",
        "source": "查看来源",
        "history_heading": "近期重置记录",
        "all_history": "查看全部记录",
        "empty_history": "暂无重置历史记录。",
        "record_confirmed_global": "全局重置",
        "record_banked_distribution": "手动重置发放",
        "record_regular_completed": "定期重置",
        "record_reference": "参考记录",
        "reference_note": "仅为参考记录，未经确认为全局重置。",
        "heatmap": "历史随机重置时刻分布",
        "heatmap_note": "按本地时刻汇总已记录的随机重置；历史时刻不能确定下一次重置时间。",
        "timezone": "时区",
        "utc": "UTC",
        "local": "设备所在时区",
        "range": "统计周期",
        "all_time": "全部记录",
        "last_month": "最近 30 天",
        "records": "条记录",
        "count": "重置次数",
        "intervals": "历史随机重置间隔",
        "interval_note": "按经过的天数，汇总连续两次随机重置之间的间隔。",
        "median": "中位数",
        "average": "平均值",
        "shortest": "最短",
        "longest": "最长",
        "no_intervals": "需要至少两条重置记录才能计算间隔。",
        "days": "天",
        "hours": "小时",
        "latest_post": "Tibo 相关帖子",
        "social_source": "通过原站公开接口同步",
        "social_no_analysis": "未进行帖文语义分析",
        "social_rule_notice": "明确重置公告（本地规则识别）",
        "announced": "已公告重置 · 等待执行",
        "announced_note": "开发者已明确公告将进行重置，优先于历史概率展示。公告尚不代表重置已经发生。",
        "notice_timing": "原帖时间表达",
        "notice_timezone_unknown": "暂未可靠确定对应时刻，不转换为本地倒计时。",
        "historical_forecast_note": "下方神经网络概率仅依据历史重置时间，未考虑本条公告，不代表公告兑现的概率。",
        "no_post": "当前数据中暂无公开帖子。",
        "classification": "观测分类",
        "posted": "发布时间",
        "reply_context": "回复上下文",
        "classification_official_notice": "官方预告",
        "classification_reset_executed": "已宣布重置完成",
        "classification_teaser": "重置暗示",
        "classification_irrelevant": "与重置无关",
        "classification_strong": "较强重置暗示",
        "classification_weak": "较弱重置暗示",
        "unofficial": "本站为独立的非官方观测网站。请以 OpenAI 官方公告及账号中的使用额度为准。",
        "developer": "源代码",
        "api": "公开 API",
        "filter_history": "筛选记录",
        "all_records": "全部类型",
        "search_history": "搜索重置历史",
        "no_matches": "暂无符合筛选条件的记录。",
        "sources_heading": "信息来源与预测方法",
        "source_status": "OpenAI 服务状态",
        "source_official": "Codex 官方动态",
        "about_paragraphs": [
            "Codex 重置观测站汇集重置历史与官方预告，方便你将当前情况与过去的重置事件进行比较。",
            "主预测使用本地训练的神经网络，输入是历史重置时间特征，尚未使用帖子文本。模型仍处于实验阶段，初始评估尚未超过基线；预测并非 OpenAI 官方概率，也不保证会发生重置。",
            "本站区分全局重置、手动重置发放、定期重置和参考记录。使用手动重置后，适用的使用额度会被刷新；之后的使用周期和重置日期可能因账号而异。",
            "请查看每次事件对应的原始公告，并检查账号显示的使用额度。记录某次重置发生，并不意味着每个方案都会以同样的方式获得重置。",
        ],
    },
}

NEURAL_COPY: dict[str, dict[str, str]] = {
    "en": {
        "heading": "Neural model evaluation",
        "label": "HISTORICAL MODEL EXPERIMENT",
        "note": "Trained on recorded reset history. Event counts are limited and records may include retrospective corrections. Historical evaluation does not establish accuracy for future resets.",
        "trained": "Trained",
        "model": "Model",
        "evaluation": "Held-out Brier score (lower is better)",
        "neural": "Neural model",
        "baseline": "Baseline",
        "events": "Training events",
        "samples": "Evaluation samples",
        "active": "Model in use",
        "experimental": "Experimental; not prospectively validated",
    },
    "ja": {
        "heading": "ニューラルモデルの評価",
        "label": "履歴に基づくモデル実験",
        "note": "記録済みのリセット履歴で学習しています。イベント数が少なく、履歴には事後修正も含まれます。過去データの評価だけでは将来のリセットに対する精度は確認できません。",
        "trained": "学習日時",
        "model": "モデル",
        "evaluation": "未学習期間のBrierスコア（低いほど良い）",
        "neural": "ニューラルモデル",
        "baseline": "基準モデル",
        "events": "学習イベント数",
        "samples": "評価サンプル数",
        "active": "採用モデル",
        "experimental": "試験運用・将来データによる検証は未完了",
    },
    "zh": {
        "heading": "神经网络模型评估",
        "label": "基于历史数据的模型实验",
        "note": "使用已记录的重置历史训练。独立事件数量有限，历史记录也可能经过事后修正。历史评估结果不能证明模型对未来重置的预测准确率。",
        "trained": "训练时间",
        "model": "模型",
        "evaluation": "留出集 Brier 分数（越低越好）",
        "neural": "神经网络",
        "baseline": "基准模型",
        "events": "训练事件数",
        "samples": "评估样本数",
        "active": "当前采用的模型",
        "experimental": "实验模型，尚未完成前瞻验证",
    },
}


def safe_url(value: Any) -> str | None:
    """Only link absolute HTTP(S) URLs without embedded credentials or controls."""
    if not isinstance(value, str) or any(ord(char) < 33 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"https", "http"} or not parsed.hostname:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        _ = parsed.port
        return value
    except ValueError:
        return None


def get_site_origin(value: Any = SITE_URL, *, fallback: str = SITE_URL) -> str:
    """Keep configured metadata on an HTTP(S) origin, without paths or secrets."""
    if not safe_url(value) or "\\" in value:
        return fallback
    parsed = urlsplit(value)
    return f"{parsed.scheme.lower()}://{parsed.netloc}"


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return date.replace(tzinfo=UTC) if date.tzinfo is None else date.astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def localized(value: Any, locale: str) -> str:
    if isinstance(value, dict):
        value = value.get(locale) or value.get("en") or value.get("ja") or ""
    return (
        str(value) if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ""
    )


def date_display(value: Any, unknown: str) -> dict[str, str | None]:
    date = parse_time(value)
    return {
        "iso": date.isoformat() if date else None,
        "text": date.strftime("%Y-%m-%d %H:%M UTC") if date else unknown,
    }


def _percent(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if not 0 <= value <= 1:
        return None
    return math.floor(value * 100 + 0.5)


def _history_item(item: dict[str, Any], locale: str, copy: dict[str, Any]) -> dict[str, Any]:
    details = item.get("details") or {}
    fields = [
        ("kind", details.get("cycleType") or item.get("resetType")),
        ("reason", details.get("reasonType")),
        ("method_label", details.get("resetMethod")),
        ("scope", details.get("scope") or item.get("scope")),
        ("notice_type", details.get("noticeType")),
        ("notice_gap", details.get("noticeToExecution")),
    ]
    record_kind = item.get("recordKind", "reference")
    return {
        "title": localized(item.get("title"), locale) or copy["unknown"],
        "kind": record_kind,
        "kind_label": copy.get(f"record_{record_kind}", copy["unknown"]),
        "date": date_display(item.get("resetAt") or item.get("date"), copy["unknown"]),
        "summary": localized(details.get("note") or item.get("summary"), locale),
        "source": safe_url(item.get("source")),
        "fields": [
            (copy[key], localized(value, locale))
            for key, value in fields
            if localized(value, locale)
        ],
    }


def _heatmap(snapshot: dict[str, Any], copy: dict[str, Any]) -> dict[str, Any]:
    # Only use domain-qualified events: inferring eligibility from translated
    # history labels can accidentally include conditional or personal resets.
    raw_events = snapshot.get("randomResetEventTimes", [])
    now = parse_time(snapshot.get("checkedAt")) or datetime.now(UTC)
    events = sorted({date for value in raw_events if (date := parse_time(value)) and date <= now})
    counts = [0] * 24
    for date in events:
        counts[date.hour] += 1
    intervals = [
        (right - left).total_seconds() / 86400
        for left, right in zip(events, events[1:], strict=False)
    ]
    interval_counts = [0] * 11
    for days in intervals:
        interval_counts[min(int(days), 10)] += 1
    stats = [
        (copy[label], f"{value:.1f} {copy['days']}")
        for label, value in (
            [
                ("median", median(intervals)),
                ("average", mean(intervals)),
                ("shortest", min(intervals)),
                ("longest", max(intervals)),
            ]
            if intervals
            else []
        )
    ]
    return {
        "events": [date.isoformat() for date in events],
        "count": len(events),
        "bins": [
            {"hour": hour, "count": count, "height": round(100 * count / max(max(counts), 1), 1)}
            for hour, count in enumerate(counts)
        ],
        "interval_bins": [
            {
                "label": f"{index}–{index + 1}" if index < 10 else "10+",
                "count": count,
                "height": round(100 * count / max(max(interval_counts), 1), 1),
            }
            for index, count in enumerate(interval_counts)
        ],
        "stats": stats,
    }


def page_context(
    snapshot: dict[str, Any], locale: str = "zh", page: str = "home", site_url: str = SITE_URL
) -> dict[str, Any]:
    """Build the sole template contract for all twelve localized pages."""
    locale = locale if locale in COPY else "zh"
    page = page if page in {"home", "history", "about", "faq"} else "home"
    site_origin = get_site_origin(site_url)
    copy = COPY[locale]
    view = snapshot.get("viewModel") or {}
    health = snapshot.get("dataHealth") or {}
    active = view.get("activeWindow") or {}
    latest = view.get("latestWindow") or {}
    regular = view.get("regularResetForecast") or {}
    activity = snapshot.get("latestTiboActivity") or {}
    history = [
        _history_item(item, locale, copy)
        for item in view.get("recentHistory", [])
        if item.get("recordKind") in VISIBLE_RECORD_KINDS
    ]
    history.sort(key=lambda item: item["date"]["iso"] or "", reverse=True)
    base = f"/{locale}"
    routes = {
        name: f"{base}/{name}" if name != "home" else base or "/"
        for name in ("home", "history", "about", "faq")
    }
    suffix = "" if page == "home" else f"/{page}"
    languages = [
        {
            "code": code,
            "label": label,
            "url": f"/{code}" + suffix,
        }
        for code, label in (("zh", "简体中文"), ("en", "English"), ("ja", "日本語"))
    ]
    status = view.get("codexOperationalStatus", "unknown")
    if status not in {"none", "active", "recovered", "unknown"}:
        status = "unknown"
    classification = activity.get("classification", "unknown")
    if classification == "teaser" and activity.get("teaserStrength") in {"strong", "weak"}:
        classification = activity["teaserStrength"]
    faq_path = Path(__file__).parent / "templates" / "faq_content.json"
    faqs = json.loads(faq_path.read_text(encoding="utf-8"))[locale]
    context = {
        "locale": locale,
        "page": page,
        "t": copy,
        "primary_neural": (view.get("primaryForecast") or {}).get("kind") == "neural",
        "routes": routes,
        "languages": languages,
        "title": copy[f"title_{page}"],
        "eyebrow": copy[f"eyebrow_{page}"],
        "subtitle": copy["description"] if page == "home" else copy[f"subtitle_{page}"],
        "canonical": site_origin + routes[page],
        "site_url": site_origin,
        "site_author": SITE_AUTHOR,
        "repository_url": REPOSITORY_URL,
        "stale": health.get("stale", True) or health.get("overall") != "ok",
        "checked": date_display(snapshot.get("checkedAt"), copy["unknown"]),
        "updated": date_display(
            snapshot.get("updatedAt") or view.get("lastUpdated"), copy["unknown"]
        ),
        "status": status,
        "status_label": copy[f"status_{status}"],
        "notice": {
            "active": bool(active.get("active") and active.get("kind") == "official"),
            "label": localized(active.get("label"), locale),
            "summary": localized(active.get("summary"), locale) or copy["no_notice_text"],
            "date": date_display(active.get("expectedAt"), copy["unknown"]),
            "end": date_display(active.get("expectedEndAt"), copy["unknown"]),
            "source": safe_url(active.get("source")),
            "overdue": localized(active.get("overdueText"), locale),
            "excerpt": localized(active.get("announcementText"), locale),
            "timing": localized(active.get("timingText"), locale),
            "timing_unresolved": bool(active.get("timingUnresolved")),
        },
        "probabilities": [
            {
                "hours": hours,
                "label": copy[f"within_{hours}"],
                "value": _percent(view.get(f"probability{hours}h")),
            }
            for hours in (24, 48)
        ],
        "reasoning": localized(view.get("displayReasoningSummary"), locale),
        "latest": {
            "title": localized(latest.get("title"), locale) or copy["unknown"],
            "summary": localized(latest.get("summary"), locale),
            "date": date_display(latest.get("closedAt") or latest.get("openedAt"), copy["unknown"]),
            "source": safe_url(latest.get("source")),
        },
        "regular": {
            "date": date_display(regular.get("expectedAt"), copy["unknown"]),
            "remaining": localized(regular.get("remaining"), locale),
        },
        "last_random": date_display(snapshot.get("lastRandomResetAt"), copy["unknown"]),
        "history_items": history,
        "heatmap": _heatmap(snapshot, copy),
        "faqs": faqs,
        "activity": {
            "available": bool(activity),
            "mirrored": activity.get("sourceKind") == "upstream_public_snapshot",
            "reply_handles": [str(handle) for handle in activity.get("replyToHandles", [])],
            "text": localized(activity.get("text"), locale),
            "reply": localized(activity.get("replyContextText"), locale),
            "date": date_display(activity.get("createdAt"), copy["unknown"]),
            "source": safe_url(activity.get("sourceUrl")),
            "classification": (copy["social_rule_notice"]
                               if activity.get("classificationSource") == "explicit_text_rule"
                               else copy["social_no_analysis"]
                               if activity.get("sourceKind") == "upstream_public_snapshot"
                               else copy.get(f"classification_{classification}", copy["unknown"])),
        },
        "json_ld": {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": copy["site_name"],
            "url": site_origin,
            "description": copy["description"],
            "inLanguage": locale,
        },
    }
    neural = view.get("neuralForecast") or snapshot.get("neuralForecast")
    if isinstance(neural, dict):
        evaluation = neural.get("evaluation") or {}
        scores = []
        for key in ("neural", "baseline"):
            value = (evaluation.get(key) or {}).get("meanBrier")
            if (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
            ):
                scores.append((NEURAL_COPY[locale][key], f"{value:.4f}"))
        context["neural"] = {
            "t": NEURAL_COPY[locale],
            "model": localized(neural.get("modelVersion"), locale),
            "trained": date_display(neural.get("trainedAt"), copy["unknown"]),
            "eligible": bool(neural.get("eligibleForUse")),
            "scores": scores,
            "events": localized(evaluation.get("eventCount"), locale),
            "samples": localized(evaluation.get("testSampleCount"), locale),
            "probabilities": [
                {
                    "label": copy[f"within_{hours}"],
                    "value": _percent(neural.get(f"probability{hours}h")),
                }
                for hours in (24, 48)
            ],
        }
    if page == "faq":
        context["json_ld"] = {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": item["question"],
                    "acceptedAnswer": {"@type": "Answer", "text": item["answer"]},
                }
                for item in faqs
            ],
        }
    return context

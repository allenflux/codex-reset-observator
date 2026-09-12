import pytest

from observatory.classification import (
    classify_post,
    explicit_notice,
    is_global_reset_signal,
    legacy_classify_post,
    notice_cancelled,
)

ANNOUNCEMENT = "And of course, a reset is also landing by midnight today."
LONG_POST = (
    "Hello Astra users. We fixed problems mentioned yesterday.\n\n"
    "Skills for older models triggered too frequently. A context management experiment "
    "has been disabled, and we rolled out quality improvements.\n\n" + ANNOUNCEMENT
)


def test_real_announcement_survives_unrelated_history_and_model_rollout_context():
    notice = explicit_notice(LONG_POST)
    assert notice == {"excerpt": ANNOUNCEMENT, "timePhrase": "by midnight today"}
    assert legacy_classify_post(LONG_POST)["signal_type"] == "irrelevant"
    result = classify_post(LONG_POST)
    assert result["signal_type"] == "official_notice"
    assert result["confidence"] >= .95
    assert result["classification_source"] == "rules-python-v2"
    assert is_global_reset_signal({**result, "text": LONG_POST}) is False
    assert not {"expected_start_at", "expected_end_at", "temporal_timezone"} & result.keys()


@pytest.mark.parametrize(("text", "time_phrase"), [
    ("A reset will be rolled out before midnight today.", "before midnight today"),
    ("The reset is coming tomorrow.", "tomorrow"),
    ("We will reset usage limits tonight.", "tonight"),
    ("I am going to reset usage limits within two hours.", "within two hours"),
    ("We will do a reset at 11:30 pm PDT.", "at 11:30 pm PDT"),
    ("A reset is coming.", ""),
])
def test_explicit_notice_keeps_relative_timing_without_inventing_a_timezone(text, time_phrase):
    assert explicit_notice(text) == {"excerpt": text, "timePhrase": time_phrase}
    assert classify_post(text)["signal_type"] == "official_notice"


@pytest.mark.parametrize("text", [
    "A reset is not landing by midnight today.",
    "A reset might be landing by midnight today.",
    "A reset will not be rolled out before midnight today.",
    "If tests pass, a reset is landing by midnight today.",
    "A reset is landing by midnight today if tests pass.",
    "Imagine if a reset is landing by midnight today.",
    "A reset is landing by midnight today?",
    "A reset was landing by midnight yesterday.",
    "Last week a reset was planned for tonight.",
    "Yesterday we said a reset is landing by midnight today.",
    "A server reset is landing by midnight today.",
    "A reset is landing for the database by midnight today.",
    "Banked reset credits will be rolled out before midnight today.",
    "We will reset the server tonight.",
    "A reset is already complete.",
    "A reset is landing by midnight today, maybe.",
    '"A reset is landing by midnight today."',
    "“A reset is landing by midnight today.”",
    "‘A reset is landing by midnight today.’",
    "'A reset is landing by midnight today.'",
    "> A reset is landing by midnight today.",
    "`A reset is landing by midnight today.`",
    "```\nA reset is landing by midnight today.\n```",
    "Someone said: A reset is landing by midnight today.",
    "Someone said:\nA reset is landing by midnight today.",
])
def test_unsupported_negative_historical_and_quoted_text_is_not_explicit_notice(text):
    assert explicit_notice(text) is None


@pytest.mark.parametrize("withdrawal", [
    "The reset is canceled.", "We cancelled the reset.", "No reset tonight.",
    "We won't reset usage limits tonight.", "The reset has been postponed.",
    "Scratch that.", "Actually, it is canceled.", "Changed my mind.",
])
def test_later_withdrawal_clears_a_promise_within_the_same_post(withdrawal):
    assert explicit_notice(ANNOUNCEMENT + " " + withdrawal) is None


@pytest.mark.parametrize("text", [
    "The reset is canceled.", "We cancelled the reset.", "No reset tonight.",
    "We won't reset usage limits tonight.", "The reset has been postponed.",
    "The reset is not happening tonight.",
])
def test_explicit_withdrawal_can_suppress_an_earlier_post(text):
    assert notice_cancelled(text) is True


@pytest.mark.parametrize("text", [
    "The reset isn't canceled.", "The reset is not canceled.",
    "If we cancel the reset, we'll tell you.", "Was the reset canceled?",
    "Yesterday the reset was canceled.", "Someone said the reset was canceled.",
    '"No reset tonight."', "> No reset tonight.", "Cancel the server reset.",
    "We found no quality problems.", ANNOUNCEMENT,
])
def test_ambiguous_and_unrelated_text_does_not_withdraw_a_notice(text):
    assert notice_cancelled(text) is False


def test_positive_independent_clause_after_old_cancellation_can_announce_a_new_reset():
    assert explicit_notice("Yesterday we cancelled a reset.\n\n" + ANNOUNCEMENT) == {
        "excerpt": ANNOUNCEMENT, "timePhrase": "by midnight today"}


def test_new_affirmative_notice_after_reconsideration_overrides_same_post_withdrawal():
    text = "No reset tonight.\n\nActually, changed my mind. " + ANNOUNCEMENT
    assert explicit_notice(text) == {"excerpt": ANNOUNCEMENT, "timePhrase": "by midnight today"}
    assert notice_cancelled(text) is False


def test_pronoun_withdrawal_does_not_leave_a_legacy_notice_active():
    text = "We will reset usage limits tonight. Scratch that."
    assert explicit_notice(text) is None
    assert classify_post(text)["signal_type"] != "official_notice"


def test_reply_and_quote_flags_do_not_promote_the_new_rule_to_an_active_notice():
    assert classify_post(ANNOUNCEMENT, is_reply=True)["signal_type"] != "official_notice"
    assert classify_post(ANNOUNCEMENT, is_quote=True)["signal_type"] != "official_notice"


def test_legacy_reply_classification_is_preserved_for_separate_activity_eligibility_checks():
    text = "I will reset usage limits tomorrow."
    result = classify_post(text, is_reply=True)
    assert result["signal_type"] == "official_notice"
    assert result["is_reply"] is True
    assert result["classification_source"] == "rules-python-v1"


def test_legacy_rules_remain_available_for_validating_imported_v1_rows():
    result = legacy_classify_post("I will reset usage limits tomorrow.")
    assert result["signal_type"] == "official_notice"
    assert result["classification_source"] == "rules-python-v1"
    assert classify_post("I will reset usage limits tomorrow.")["classification_source"] == "rules-python-v2"

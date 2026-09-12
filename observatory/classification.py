"""Deterministic usage-reset classifier, ported from the TypeScript safety rules."""
from __future__ import annotations

import re

NON_USAGE_RESET_OBJECT_PATTERN = re.compile("(?:\\b(?:reset|resetting|restart|restarting|reboot|rebooting)\\s+(?:the|my|our|a|an)?\\s*(?:cache(?:s)?|server(?:s)?|benchmark(?:s)?|model(?:s)?(?:'s)?|conversation(?:s)?|chat(?:s)?|thread(?:s)?|sleep\\s+schedule|laptop(?:s)?|database(?:s)?|db|ui|interface|test\\s+(?:environment|suite)|app(?:s)?|application(?:s)?)\\b|\\b(?:cache(?:s)?|server(?:s)?|benchmark(?:s)?|model(?:s)?(?:'s)?|conversation(?:s)?|chat(?:s)?|thread(?:s)?|sleep\\s+schedule|laptop(?:s)?|database(?:s)?|db|ui|interface|test\\s+(?:environment|suite)|app(?:s)?|application(?:s)?)\\s+(?:reset|restart|reboot)\\b)", re.I)
USAGE_LIMIT_CONTEXT_PATTERN = re.compile("\\b(?:usage\\s+(?:limits?|allowances?)|rate\\s+limits?|quotas?|allowances?|capacity|paid\\s+users?|all\\s+users?|everyone(?:'s)?\\s+limits?|fresh\\s+limits?|topped\\s+up|codex\\s+(?:usage\\s+)?limits?|chatgpt\\s+work\\s+(?:usage\\s+)?limits?)\\b", re.I)
NON_USAGE_ACTIVATION_OBJECT_PATTERN = re.compile('\\b(?:context\\s+windows?|features?|models?(?:\\s+availability)?|api\\s+keys?|chatgpt\\s+accounts?|account\\s+support|rollouts?|deployments?|availability|products?|settings?|switch)\\b', re.I)
NON_USAGE_ACTIVATION_ACTION_PATTERN = re.compile('\\b(?:flipped\\s+the\\s+switch|turned\\s+(?:it|that|this|the)\\s+on|enabled|activated|now\\s+live|is\\s+live|are\\s+live|works?\\s+(?:through|for|with)|support(?:s|ed)?|rolled\\s+out|deployed|released|expanded|extended)\\b', re.I)
EXPLICIT_USAGE_LIMIT_RESET_PATTERN = re.compile("(?:\\b(?:usage\\s+limits?|rate\\s+limits?|quotas?|allowances?|fresh\\s+limits?|everyone(?:'s)?\\s+limits?)\\b[^.!?]{0,100}\\b(?:reset|refreshed|topped\\s+up|restored|replenished|landed|done|complete(?:d)?)\\b|\\b(?:reset|refreshed|topped\\s+up|restored|replenished|landed|done|complete(?:d)?)\\b[^.!?]{0,100}\\b(?:usage\\s+limits?|rate\\s+limits?|quotas?|allowances?|fresh\\s+limits?|everyone(?:'s)?\\s+limits?)\\b)", re.I)
PURE_HYPOTHETICAL_PATTERN = re.compile('\\b(?:what\\s+if|would\\s+be\\s+nice\\s+to|imagine\\s+if|i\\s+wish|if\\s+only)\\b|\\b(?:could|would)\\s+use\\s+(?:a\\s+)?reset\\b|\\bworld\\s+with\\s+unlimited\\s+resets?\\b', re.I)
INDEPENDENT_INTENT_AFTER_HYPOTHETICAL_PATTERN = re.compile('\\b(?:but|however|so)\\b[^.!?]{0,100}\\b(?:i|we)\\s+(?:will|might|may|could)\\b', re.I)
HISTORICAL_RESET_PATTERN = re.compile('\\b(?:yesterday|last\\s+(?:week|month|night|year)|(?:one|two|three|four|five|six|seven|ten|\\d+)\\s+days?\\s+ago|back\\s+in|earlier|old\\s+news|previously|remember\\s+when|was\\s+(?:completed|planned)|the\\s+reset\\s+button.*history)\\b', re.I)
UNRELATED_HISTORICAL_REFERENCE_PATTERN = re.compile('\\b(?:things?|issues?|problems?|fixes?|topics?)\\s+(?:mentioned|discussed|found|raised)\\s+(?:yesterday|last\\s+(?:week|month|night|year))\\b', re.I)
FUTURE_RESET_PATTERN = re.compile('\\b(?:will|going\\s+to|coming|tonight|tomorrow|later|soon|next|scheduled|planned|in\\s+(?:an?|one|two|half\\s+an?|\\d+)\\s+(?:minute|minutes|hour|hours|day|days))\\b', re.I)
CANCELLATION_PATTERN = re.compile('\\b(?:no|not|never|cancel(?:led|ed)?|canceled|not\\s+anymore|changed\\s+my\\s+mind|scratch\\s+that)\\b', re.I)
EXPLICIT_FUTURE_RESET_RESCHEDULE_PATTERN = re.compile('(?:\\b(?:reset|usage\\s+limits?|rate\\s+limits?|quotas?|allowances?)\\b[^.!?]{0,140}\\b(?:moved|postponed|delayed|rescheduled|pushed\\s+back|put\\s+off)\\b[^.!?]{0,100}\\b(?:tomorrow|later|next\\s+(?:day|week|month|year)|(?:on\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\\b|\\b(?:moved|postponed|delayed|rescheduled|pushed\\s+back|put\\s+off)\\b[^.!?]{0,100}\\b(?:reset|usage\\s+limits?|rate\\s+limits?|quotas?|allowances?)\\b[^.!?]{0,100}\\b(?:tomorrow|later|next\\s+(?:day|week|month|year)|(?:on\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\\b)', re.I)
CANCELLED_FUTURE_RESET_PATTERN = re.compile('(?:\\b(?:reset|usage\\s+limits?|rate\\s+limits?|quotas?|allowances?|celebration)\\b[^.!?]{0,140}\\b(?:cancel(?:led|ed)?|canceled|no\\s+longer|not\\s+happening|scrapped)\\b|\\b(?:cancel(?:led|ed)?|canceled|no\\s+longer|not\\s+happening|scrapped)\\b[^.!?]{0,140}\\b(?:reset|usage\\s+limits?|rate\\s+limits?|quotas?|allowances?|celebration)\\b)', re.I)
NEGATED_FUTURE_RESET_PATTERN = re.compile('\\b(?:no|not|never)\\s+(?:[^.!?]{0,40}\\b)?(?:reset|celebration)\\b[^.!?]{0,80}\\b(?:tomorrow|tonight|later|soon|next\\s+(?:day|week|month|year))\\b', re.I)
EXPLICIT_RESET_NEGATION_PATTERN = re.compile('\\b(?:no\\s+reset|(?:will|would|going\\s+to|can|could|should|do|does|did|am|is|are)\\s+not\\s+(?:going\\s+to\\s+|planning\\s+to\\s+)?(?:reset|restart|reboot)|(?:will|would|going\\s+to)\\s+not\\s+(?:happen|occur)|not\\s+(?:reset|happen|occur)\\b)', re.I)
RECENT_RESET_BUTTON_ACQUISITION_PATTERN = re.compile('\\b(?:i|we)\\s+(?:(?:was|were)\\s+)?(?:just\\s+)?(?:gifted|given|got|received|acquired)\\b[^.!?]{0,100}\\b(?:new\\s+)?reset\\s+button\\b', re.I)
RECENT_RESET_BUTTON_CUE_PATTERN = re.compile('\\b(?:just|today|recently|new)\\b', re.I)
HISTORICAL_RESET_BUTTON_ACQUISITION_PATTERN = re.compile('\\b(?:years?|months?|long)\\s+ago\\b|\\blast\\s+(?:year|month)\\b', re.I)
FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN = re.compile("\\b(?:i|we)(?:\\s+have|'ve)\\s+(?:now\\s+)?reset\\s+(?:(?:the|our|all)\\s+)?usage(?:\\s+(?:limits?|allowances?))?(?=\\s*(?:for|across|to|on|of|[.!?,;:]|$))", re.I)
CURRENT_USAGE_RESET_ANNOUNCEMENT_PATTERN = re.compile("\\b(?:i(?:\\s+am|'m)|we(?:\\s+are|'re))\\s+reset(?:t)?ing\\s+(?:(?:the|our|all)\\s+)?(?:usage(?:\\s+(?:limits?|allowances?))?|rate\\s+limits?|quotas?|allowances?)\\b", re.I)
EXPLICIT_FUTURE_USAGE_RESET_PATTERN = re.compile('(?:\\b(?:will|shall|going\\s+to|plan(?:ned)?\\s+to|planning\\s+to)\\b[^.!?]{0,120}\\b(?:reset|resetting)\\s+(?:(?:the|our|all)\\s+)?(?:usage(?:\\s+(?:limits?|allowances?))?|rate\\s+limits?|quotas?|allowances?)\\b|\\b(?:reset|resetting)\\s+(?:(?:the|our|all)\\s+)?(?:usage(?:\\s+(?:limits?|allowances?))?|rate\\s+limits?|quotas?|allowances?)\\b[^.!?]{0,120}\\b(?:tonight|tomorrow|later|soon|next\\s+(?:day|week|month|year)|in\\s+(?:an?|one|two|\\d+)\\s+(?:hour|hours|day|days))\\b)', re.I)
BANKED_RESET_TERM_PATTERN = re.compile('\\bbanked\\s+resets?\\b|\\breset\\s+credits?\\b|任意リセット権|リセット権', re.I)
DISTRIBUTION_TERM_PATTERN = re.compile('\\b(?:credit|grant|giv|gift|distribut|provide|deliver|issue|send)\\w*\\b|配布|付与|配る|プレゼント', re.I)
COMPENSATION_DISTRIBUTION_PATTERN = re.compile('\\b(?:get|gets|getting|receive|receives|receiving|be\\s+(?:given|sent|issued|delivered))\\b[\\s\\S]{0,60}\\b(?:another\\s+(?:one|banked\\s+resets?|reset(?:\\s+credits?)?|credits?)|(?:an?\\s+)?(?:additional|replacement)\\s+(?:banked\\s+)?(?:resets?|credits?))\\b', re.I)
NOTICE_CLAUSE_SEPARATOR = re.compile('[.!?。！？]+|\\bPS\\s*:\\s*', re.I)
FUTURE_BANKED_ACTION_PATTERN = re.compile('\\b(?:will|shall|(?:am|is|are)\\s+going\\s+to|gonna)\\s+(?:do|run|perform|execute|issue|grant|give|distribut|provide|deliver|send)\\w*\\b[\\s\\S]{0,100}\\b(?:banked\\s+resets?|reset\\s+credits?)\\b', re.I)
FUTURE_BANKED_AVAILABILITY_PATTERN = re.compile('\\b(?:banked\\s+resets?|reset\\s+credits?)\\b[\\s\\S]{0,80}\\b(?:will|shall|(?:is|are)\\s+going\\s+to|gonna)\\s+(?:land|arrive|be\\s+(?:there|available|ready)|be\\s+(?:issued|delivered|distributed|granted|provided))\\b', re.I)
BANKED_COMPLETION_PATTERN = re.compile('\\b(?:banked\\s+(?:resets?|credits?)|reset\\s+credits?)\\b[\\s\\S]{0,100}\\b(?:(?:has|have)\\s+(?:been\\s+)?(?:landed|arrived|distributed|credited|granted|issued|delivered|added)|(?:was|were)\\s+(?:distributed|credited|granted|issued|delivered|added)|(?:is|are)\\s+(?:now\\s+)?available)\\b', re.I)
GENERALIZED_PAID_CHATGPT_PLAN_SCOPE_PATTERN = re.compile("\\bfor\\s+(?:each|every)\\s+day\\s+you\\s+(?:do\\s+not|don't)\\s+have\\s+access\\s+to\\b[\\s\\S]{0,120}\\bon\\s+your\\s+paid\\s+chatgpt\\s+plan\\b", re.I)
PERSONAL_DIRECT_ADDRESS_PATTERN = re.compile('\\bI\\s+(?:(?:can|could|will|would)\\s+)?(?:(?:have|just)\\s+)?(?:give|gave|given|provide|provided|am\\s+giving)\\s+you\\b', re.I)
PERSONAL_BANKED_OPERATION_PATTERN = re.compile("\\b(?:i|you)\\b[\\s\\S]{0,80}\\b(?:use|used|using|spend|spent|consume|consumed|apply|applied|do|did|run|ran|perform|performed|execute|executed|give|gave|given|giving|provide|provided|grant|granted|issue|issued|deliver|delivered|distribute|distributed)\\b[\\s\\S]{0,80}\\b(?:banked\\s+resets?|reset\\s+credits?)\\b|\\b(?:here(?:'s|\\s+is)\\s+how\\s+to|how\\s+to)\\s+(?:use|do|run|perform|execute|spend|consume|apply)\\b[\\s\\S]{0,80}\\b(?:banked\\s+resets?|reset\\s+credits?)\\b|\\b(?:my|your|one\\s+of\\s+(?:my|your))\\s+(?:banked\\s+resets?|reset\\s+credits?)\\b[\\s\\S]{0,80}\\b(?:use|used|using|spend|spent|consume|consumed|apply|applied)\\b", re.I)
CONDITIONAL_AUDIENCE_CUE_PATTERN = re.compile("\\b(?:who|that|whom|whose|without|if|unless|only|excluding|except|don't|do\\s+not|doesn't|does\\s+not|not\\s+yet|with\\s+(?:no|out|limited|restricted|ineligible|eligible))\\b", re.I)
RECURRING_BANKED_POLICY_PATTERN = re.compile('\\b(?:for\\s+)?(?:every|each)\\s+(?:day|week|month)\\b|\\b(?:daily|weekly|monthly)\\b', re.I)
negativeOrPastPatterns = ['already reset everyone yesterday', 'reset was completed last week', 'no reset tonight', 'not going to reset', "don't think we should reset", 'dont think we should reset', 'no reset scheduled', "won't be a reset", 'wont be a reset', 'one day we created the reset button', 'created the reset button a long time ago', 'remember when we built the reset button', 'remember when we created the reset button', 'rest is history']
executedPatterns = ["i've reset usage limits", 'i have reset usage limits', "i've reset the usage limits", 'i reset usage limits for all paid users', 'reset usage limits', 'just reset', 'reset is complete', 'reset completed', 'limits have been reset', 'reset done', 'already reset', "reset everyone's limits", 'rate limits are reset', 'fresh limits for everyone', 'reset all paid users', 'reset for all users']
noticePatterns = ['reset in ', 'reset tonight', 'reset tomorrow', 'reset scheduled', 'full reset coming', 'reset at ', 'reset within ', 'will reset', 'going to reset', 'preparing a reset']
teaserBaseKeywords = ['reset button', 'working on reset', 'thinking about a reset', 'sol model caps']
futureIndicators = ['incoming', 'soon', 'should we', 'time to press', 'tonight', 'tomorrow', 'working on', 'next', 'later', 'there will be']
CURRENT_EXECUTION_PATTERNS = [re.compile('\\b(?:one\\s+|a\\s+)?reset\\s+now\\b', re.I), re.compile('\\b(?:reset|limits?|usage\\s+limits?)\\s+(?:is|are|was|were)\\s+(?:already\\s+)?(?:done|complete|completed|landed|reset|refreshed)\\b', re.I), re.compile('\\b(?:reset|usage\\s+limits?)\\s+(?:has|have|was|were|are)\\s+been\\s+(?:reset|completed|refreshed)\\b', re.I), re.compile('\\b(?:reset|usage\\s+limits?|rate\\s+limits?)\\s+(?:has|have)\\s+been\\s+(?:propagated|applied)\\s+to\\s+(?:accounts?|users?|everyone)\\b', re.I), re.compile('\\b(?:i|we)\\s+(?:have|has|just|already)\\s+reset\\b', re.I), re.compile('\\b(?:i|we)\\s+reset\\b[^.!?]{0,80}\\bnow\\b', re.I), re.compile('\\b(?:enjoy|go\\s+use)\\s+(?:a\\s+)?reset\\b', re.I), re.compile('\\bfresh\\s+limits\\b', re.I), re.compile('\\btopped\\s+up\\s+now\\b', re.I), re.compile('\\breset\\s+landed\\b', re.I), FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN]


def _current_execution(text: str) -> bool:
    if re.search(r"\b(?:i|we)(?:\s+(?:have|has|just|already)|'ve)(?:\s+now)?\s+reset\b[^.!?]{0,100}\b(?:yesterday|last\s+(?:week|month|night|year)|(?:one|two|three|four|five|six|seven|ten|\d+)\s+days?\s+ago)\b", text):
        return False
    historical = HISTORICAL_RESET_PATTERN.search(text) and not UNRELATED_HISTORICAL_REFERENCE_PATTERN.search(text)
    reconsidered = bool(re.search(r"\bchanged\s+my\s+mind\b[^\r\n]{0,80}\benjoy\b", text) and re.search(r"\breset\b", text)) or bool(
        re.search(r"\b(?:changed\s+my\s+mind|reconsidered)\b[^\r\n]{0,80}\b(?:done|complete|reset\s+now|reset\s+(?:everyone|limits?))\b", text)
        and not re.search(r"\b(?:not|no)\s+(?:reset|going\s+to\s+reset)\b", text)
    )
    if historical and not re.search(r"\b(?:now|today|just)\b", text) and not reconsidered and not re.search(r"\benjoy\s+(?:a\s+)?reset\b", text):
        return False
    return bool(CURRENT_USAGE_RESET_ANNOUNCEMENT_PATTERN.search(text) or any(pattern.search(text) for pattern in CURRENT_EXECUTION_PATTERNS) or reconsidered)


def classify_post(text: str, url: str = "", is_reply: bool | None = None, is_quote: bool | None = None, **kwargs: object) -> dict:
    """Classify English source text without an LLM; return persisted signal fields.

    Existing Gemini translations/classifications are preserved as input data but
    this runtime never invokes Gemini. Teaser strength is deliberately weak for
    rule-only matches because semantic strength has not been independently scored.
    """
    original = str(text)
    normalized = original.lower().replace("’", "'").replace("‘", "'")
    url = str(kwargs.get("tweet_url") or url)
    reply = is_reply if isinstance(is_reply, bool) else "/status/" in url and (original.startswith("@") or "reply" in normalized)
    quote = is_quote if isinstance(is_quote, bool) else "quote" in normalized
    candidate, confidence, reason = "irrelevant", .2, "No reset notice or execution patterns matched."
    negative = next((pattern for pattern in negativeOrPastPatterns if pattern in normalized), None)
    if negative:
        confidence, reason = .1, f"Negative, past, or retrospective pattern: {negative}"
    elif EXPLICIT_FUTURE_USAGE_RESET_PATTERN.search(normalized) and not CURRENT_USAGE_RESET_ANNOUNCEMENT_PATTERN.search(normalized):
        candidate, confidence, reason = "official_notice", .96, "Explicit future usage-limit reset announcement."
    elif FIRST_PERSON_USAGE_RESET_COMPLETION_PATTERN.search(normalized) or any(pattern in normalized for pattern in executedPatterns):
        candidate, confidence, reason = "reset_executed", .98, "Immediate usage-limit reset execution."
    elif any(pattern in normalized for pattern in noticePatterns):
        candidate, confidence, reason = "official_notice", .96, "Explicit future reset announcement."
    elif (RECENT_RESET_BUTTON_ACQUISITION_PATTERN.search(normalized) and RECENT_RESET_BUTTON_CUE_PATTERN.search(normalized) and not HISTORICAL_RESET_BUTTON_ACQUISITION_PATTERN.search(normalized)) or (any(pattern in normalized for pattern in teaserBaseKeywords) and any(pattern in normalized for pattern in futureIndicators)):
        candidate, confidence, reason = "teaser", .85, "Reset mechanism with an explicit future intention."

    current = _current_execution(normalized)
    future_banked = bool(FUTURE_BANKED_ACTION_PATTERN.search(normalized) or FUTURE_BANKED_AVAILABILITY_PATTERN.search(normalized))
    if BANKED_COMPLETION_PATTERN.search(normalized) and candidate != "irrelevant":
        candidate, reason = ("official_notice", "Future reset-credit distribution; completion is not a global usage reset.") if future_banked else ("irrelevant", "A reset-credit distribution is not a global usage reset.")
    elif NON_USAGE_RESET_OBJECT_PATTERN.search(normalized) and not USAGE_LIMIT_CONTEXT_PATTERN.search(normalized):
        candidate, reason = "irrelevant", "The reset affects an object other than usage limits."
    elif not current and not EXPLICIT_USAGE_LIMIT_RESET_PATTERN.search(normalized) and NON_USAGE_ACTIVATION_OBJECT_PATTERN.search(normalized) and NON_USAGE_ACTIVATION_ACTION_PATTERN.search(normalized):
        candidate, reason = "irrelevant", "Feature or model activation is not a usage-limit reset."
    elif PURE_HYPOTHETICAL_PATTERN.search(normalized) and not INDEPENDENT_INTENT_AFTER_HYPOTHETICAL_PATTERN.search(normalized):
        candidate, reason = "irrelevant", "A hypothetical statement or wish does not announce a reset."
    elif not current and (EXPLICIT_RESET_NEGATION_PATTERN.search(normalized) or CANCELLED_FUTURE_RESET_PATTERN.search(normalized) or NEGATED_FUTURE_RESET_PATTERN.search(normalized) or re.search(r"\b(?:won't|wont|don't|dont)\b.{0,35}\breset\b", normalized)):
        candidate, reason = "irrelevant", "The reset was denied or cancelled."
    elif current:
        candidate, reason = "reset_executed", "Current reset execution takes precedence."
        confidence = max(confidence, .98)
    elif EXPLICIT_FUTURE_RESET_RESCHEDULE_PATTERN.search(normalized) and candidate == "reset_executed":
        candidate, reason = "official_notice", "The reset was rescheduled to a future time."
    elif HISTORICAL_RESET_PATTERN.search(normalized) and candidate != "irrelevant":
        future, cancelled = FUTURE_RESET_PATTERN.search(normalized), CANCELLATION_PATTERN.search(normalized)
        if future and not cancelled and candidate == "reset_executed":
            candidate, reason = "official_notice", "A future notice follows a historical reset reference."
        elif not future or cancelled:
            candidate, reason = "irrelevant", "Historical or cancelled reset reference."
    return {"signal_type": candidate, "confidence": confidence, "classification_reason": reason,
            "classification_source": "rules-python-v1", "teaser_strength": "weak" if candidate == "teaser" else "none",
            "is_reply": reply, "is_quote": quote}


def is_global_reset_signal(signal: dict) -> bool:
    """Use one scope gate for adoption, history and recovery corroboration."""
    confidence = signal.get("confidence")
    if (signal.get("formal_adoption_allowed") is False
            or signal.get("signal_type") != "reset_executed" or not isinstance(confidence, (int, float))
            or confidence < .95 or signal.get("verification_status") == "rejected"
            or signal.get("is_reply") or signal.get("is_quote")):
        return False
    text = str(signal.get("text") or "").lower()
    broad = re.search(r"\b(?:everyone|all\s+(?:paid\s+)?users|global)\b|全(?:員|ユーザー|有料)", text)
    narrow = re.search(r"\b(?:your|my|single|specific|affected|individual)\s+(?:accounts?|users?|limits?|quota)\b|\b(?:only\s+for\s+you|for\s+your\s+account)\b", text)
    return bool(broad or not narrow)

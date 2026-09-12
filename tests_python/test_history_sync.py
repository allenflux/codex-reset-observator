import json
from datetime import UTC, datetime

import pytest

from observatory.history_sync import normalize_history, parse_history_page, write_import


def example():
    return {"key": "reset-1", "resetAt": "2026-09-01T12:00:00Z", "recordKind": "confirmed_global",
            "source": "https://x.com/thsottiaux/status/123", "details": {"cycleType": "随机重置", "scope": "所有付费套餐"}}


def page(rows):
    payload = 'a:["$","div",null,' + json.dumps({"items": rows}) + ']'
    return "<script>self.__next_f.push(" + json.dumps([1, payload]) + ")</script>"


def test_decode_complete_structured_list_without_executing_scripts(tmp_path):
    html = '<script>throw new Error("never run me")</script>' + page([example()])
    assert parse_history_page(html) == [example()]
    metadata = write_import(html, tmp_path, datetime(2026, 9, 12, tzinfo=UTC))
    assert metadata["recordCount"] == 1
    imported = json.loads((tmp_path / "online_history.json").read_text())[0]
    assert imported["details"]["cycleType"] == "ランダムリセット"
    assert imported["scope"] == "全有料プラン"


def test_changed_schema_and_duplicate_event_fail_closed():
    with pytest.raises(ValueError, match="schema_changed"):
        parse_history_page("<html>Not the expected page</html>")
    with pytest.raises(ValueError, match="duplicate"):
        normalize_history([example(), example()], datetime(2026, 9, 12, tzinfo=UTC))


def test_future_naive_dates_and_unsafe_links_are_rejected():
    for changed in [{"resetAt": "2030-01-01T00:00:00Z"}, {"resetAt": "2026-09-01T00:00:00"}, {"source": "javascript:alert(1)"}]:
        with pytest.raises(ValueError):
            normalize_history([example() | changed], datetime(2026, 9, 12, tzinfo=UTC))


def test_localized_pages_merge_only_display_text_by_event_key(tmp_path):
    zh = example() | {"title": "中文标题", "summary": "中文摘要"}
    zh["details"] = {**zh["details"], "note": "中文备注"}
    ja = example() | {"title": "日本語タイトル", "summary": "日本語要約", "resetAt": "2020-01-01T00:00:00Z",
                      "details": {"cycleType": "WRONG", "scope": "WRONG", "note": "日本語注記"}}
    extra = example() | {"key": "not-in-zh", "title": "Never add this event"}
    en = example() | {"title": "English title", "summary": "English summary"}
    metadata = write_import(page([zh]), tmp_path, datetime(2026, 9, 12, tzinfo=UTC),
                            localized_pages={"ja": page([extra, ja]), "en": page([en])})
    imported = json.loads((tmp_path / "online_history.json").read_text())
    assert len(imported) == 1
    record = imported[0]
    assert record["title"] == {"zh": "中文标题", "ja": "日本語タイトル", "en": "English title"}
    assert record["summary"]["en"] == "English summary"
    assert record["details"]["note"] == {"zh": "中文备注", "ja": "日本語注記"}
    assert record["details"]["cycleType"] == "ランダムリセット"
    assert record["scope"] == "全有料プラン"
    assert record["completed_at"] == zh["resetAt"]
    assert metadata["translations"]["ja"]["matchedRecords"] == 1
    assert metadata["translations"]["ja"]["recordCount"] == 2
    assert metadata["translations"]["en"]["sourceUrl"].endswith("/en/history")


def test_missing_or_invalid_translations_preserve_zh_history(tmp_path):
    zh = example() | {"title": "中文标题"}
    metadata = write_import(page([zh]), tmp_path, datetime(2026, 9, 12, tzinfo=UTC),
                            localized_pages={"ja": "<html>Unavailable</html>"})
    record = json.loads((tmp_path / "online_history.json").read_text())[0]
    assert record["title"] == "中文标题"
    assert metadata["translations"]["ja"]["status"] == "invalid_response"
    assert metadata["translations"]["en"]["status"] == "unavailable"


def test_sync_uses_zh_authority_and_best_effort_translations(tmp_path, monkeypatch):
    import httpx

    from observatory import history_sync

    requested = []

    def fake_fetch(url):
        requested.append(url)
        if url.endswith("/en/history"):
            raise httpx.ConnectError("unavailable")
        if url.endswith("/zh/history"):
            return page([example() | {"title": "中文标题"}])
        return page([example() | {"title": "日本語タイトル"}])

    monkeypatch.setattr(history_sync, "_fetch_page", fake_fetch)
    metadata = history_sync.sync_history(tmp_path)
    assert len(requested) == 3
    record = json.loads((tmp_path / "online_history.json").read_text())[0]
    assert record["title"] == {"zh": "中文标题", "ja": "日本語タイトル"}
    assert metadata["recordCount"] == 1
    assert metadata["translations"]["en"]["status"] == "unavailable"


def test_localized_display_details_do_not_change_semantic_fields(tmp_path):
    zh = example() | {"title": "BANKED 重置"}
    zh["details"] = {**zh["details"], "noticeType": "有告知", "noticeToExecution": "4 小时 23 分钟",
                     "resetMethod": "BANKED 重置发放"}
    ja = example() | {"details": {"scope": "全有料プラン", "noticeType": "告知あり",
                                 "noticeToExecution": "4時間23分", "resetMethod": "任意リセット権配布"}}
    en = example() | {"details": {"scope": "All paid plans", "noticeType": "Announcement",
                                 "noticeToExecution": "4 hours 23 minutes", "resetMethod": "Banked Reset distribution"}}
    write_import(page([zh]), tmp_path, datetime(2026, 9, 12, tzinfo=UTC),
                 localized_pages={"ja": page([ja]), "en": page([en])})
    record = json.loads((tmp_path / "online_history.json").read_text())[0]
    assert record["localizedDetails"]["ja"]["noticeToExecution"] == "4時間23分"
    assert record["localizedDetails"]["en"]["noticeToExecution"] == "4 hours 23 minutes"
    assert record["localizedDetails"]["en"]["noticeType"] == "Announcement"
    assert record["details"]["resetMethod"] == "BANKED 重置发放"
    assert record["details"]["scope"] == "全有料プラン"
    assert record["details"]["cycleType"] == "ランダムリセット"

from datetime import datetime, timedelta, timezone

from app.blocks import find_conflicts, normalize_proposal, overlaps, validate_block
from app.db import Store
from app.heuristic_parser import parse_schedule
from app.insights import heuristic_insights, summarize_week
from app.scheduler import run_scheduler_tick
from app.timeutil import local_parts

# Wednesday 2026-11-11, 10:00
CTX = {"today": "2026-11-11", "weekday": 3, "now_time": "10:00"}


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def test_touching_blocks_do_not_overlap():
    a = {"start": "2026-11-11T10:00:00Z", "end": "2026-11-11T11:00:00Z"}
    assert not overlaps(a, {"start": "2026-11-11T11:00:00Z", "end": "2026-11-11T12:00:00Z"})
    assert overlaps(a, {"start": "2026-11-11T10:30:00Z", "end": "2026-11-11T12:00:00Z"})


def test_find_conflicts_with_existing_and_within_batch():
    existing = [{"id": "x", "title": "Gym", "start": "2026-11-11T18:00:00Z", "end": "2026-11-11T19:00:00Z"}]
    candidates = [
        {"title": "A", "start": "2026-11-11T18:30:00Z", "end": "2026-11-11T20:00:00Z"},  # clashes with Gym
        {"title": "B", "start": "2026-11-11T20:00:00Z", "end": "2026-11-11T21:00:00Z"},  # ok
        {"title": "C", "start": "2026-11-11T20:30:00Z", "end": "2026-11-11T21:30:00Z"},  # clashes with B
    ]
    conflicts = find_conflicts(candidates, existing)
    assert [c["index"] for c in conflicts] == [0, 2]
    assert conflicts[0]["conflictsWith"]["title"] == "Gym"
    assert conflicts[1]["conflictsWith"]["title"] == "B"


def test_validate_block_rejects_bad_input_and_normalises_good_input():
    assert "Title" in validate_block({"title": "", "start": "x", "end": "y"})[1]
    assert "after" in validate_block({"title": "T", "start": "2026-11-11T10:00Z", "end": "2026-11-11T09:00Z"})[1]
    assert "24 hours" in validate_block({"title": "T", "start": "2026-11-11T10:00Z", "end": "2026-11-13T10:00Z"})[1]
    value, error = validate_block(
        {"title": " Study ", "category": "nope", "start": "2026-11-11T10:00Z", "end": "2026-11-11T12:00Z", "reminderMinutes": 999}
    )
    assert error is None
    assert value["title"] == "Study"
    assert value["category"] == "other"
    assert value["reminderMinutes"] == 120
    assert value["start"] == "2026-11-11T10:00:00.000Z"


def test_normalize_proposal_clamps_and_rejects():
    assert normalize_proposal({"startTime": "25:00", "endTime": "10:00", "daysOfWeek": [1]}, CTX["today"]) is None
    assert normalize_proposal({"startTime": "09:00", "endTime": "10:00", "daysOfWeek": []}, CTX["today"]) is None
    p = normalize_proposal(
        {"title": "X", "startTime": "09:00", "endTime": "10:00", "daysOfWeek": [5, 1, 1, 9], "repeatWeeks": 50}, CTX["today"]
    )
    assert p["daysOfWeek"] == [1, 5]
    assert p["repeatWeeks"] == 8
    assert p["startDate"] == CTX["today"]


def test_parser_multi_clause_overnight_sleep_and_weekday_study():
    proposals = parse_schedule("Sleep 10:30pm-6:30am every night and study 2-4pm on weekdays", CTX)["proposals"]
    assert len(proposals) == 2
    sleep, study = proposals
    assert sleep["category"] == "sleep"
    assert (sleep["startTime"], sleep["endTime"]) == ("22:30", "06:30")
    assert sleep["daysOfWeek"] == [0, 1, 2, 3, 4, 5, 6]
    assert sleep["repeatWeeks"] == 2
    assert study["category"] == "study"
    assert (study["startTime"], study["endTime"]) == ("14:00", "16:00")
    assert study["daysOfWeek"] == [1, 2, 3, 4, 5]


def test_parser_meridiem_inference_and_named_days():
    [p] = parse_schedule("deep work 9-11am Mon, Wed and Fri for 3 weeks, remind me 5 minutes before", CTX)["proposals"]
    assert p["category"] == "focus"
    assert (p["startTime"], p["endTime"]) == ("09:00", "11:00")
    assert p["daysOfWeek"] == [1, 3, 5]
    assert p["repeatWeeks"] == 3
    assert p["reminderMinutes"] == 5

    [n] = parse_schedule("quiet 10-6am", CTX)["proposals"]
    assert (n["startTime"], n["endTime"]) == ("22:00", "06:00")


def test_parser_tomorrow_and_default_window():
    [p] = parse_schedule("family dinner tomorrow 7-8:30pm", CTX)["proposals"]
    assert p["category"] == "family"
    assert p["startDate"] == "2026-11-12"
    assert p["daysOfWeek"] == [4]
    assert p["endTime"] == "20:30"

    res = parse_schedule("hello there", CTX)
    assert res["proposals"] == []
    assert res["clarification"]


def test_local_parts_respects_time_zones():
    p = local_parts("2026-11-11T23:30:00Z", "Asia/Kolkata")
    assert p["date"] == "2026-11-12"
    assert p["time"] == "05:00"
    assert p["weekday"] == "Thursday"


def test_insights_empty_week_and_sleep_improves_score():
    now = utc("2026-11-11T08:00:00Z")
    empty = heuristic_insights(summarize_week([], now=now, time_zone="UTC"))
    assert empty["score"] == 0
    assert empty["suggestions"][0]["proposal"]

    blocks = []
    for i in range(7):
        day = (now + timedelta(days=i)).date().isoformat()
        nxt = (now + timedelta(days=i + 1)).date().isoformat()
        blocks.append({"title": "Sleep", "category": "sleep", "start": f"{day}T22:30:00Z", "end": f"{nxt}T06:30:00Z"})
    summary = summarize_week(blocks, now=now, time_zone="UTC")
    assert summary["days"][0]["sleepHours"] == 8
    assert heuristic_insights(summary)["score"] > 60


def test_scheduler_sends_each_reminder_exactly_once():
    store = Store(":memory:")
    user = store.create_user({"name": "A", "email": "a@x.com", "passwordHash": "h", "preferences": {}})
    store.create_blocks(
        user["id"],
        [
            {"title": "Soon", "category": "focus", "start": "2026-11-11T10:08:00Z", "end": "2026-11-11T11:00:00Z", "reminderMinutes": 10},
            {"title": "Later", "category": "focus", "start": "2026-11-11T12:00:00Z", "end": "2026-11-11T13:00:00Z", "reminderMinutes": 10},
        ],
    )
    now = utc("2026-11-11T10:00:00Z")
    assert [f["type"] for f in run_scheduler_tick(store, now)] == ["reminder"]
    assert run_scheduler_tick(store, now) == []
    assert [f["type"] for f in run_scheduler_tick(store, utc("2026-11-11T10:08:30Z"))] == ["started"]


def test_store_persists_to_disk(tmp_path):
    path = tmp_path / "db.json"
    store = Store(path)
    user = store.create_user({"name": "B", "email": "B@X.com", "passwordHash": "h", "preferences": {}})
    reloaded = Store(path)
    assert reloaded.find_user_by_email("b@x.com")["id"] == user["id"]
    assert datetime.now(timezone.utc)  # sanity: tz-aware helpers importable

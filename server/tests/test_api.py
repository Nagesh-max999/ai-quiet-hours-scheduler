import pytest
from fastapi.testclient import TestClient

from app.db import Store
from app.server import create_app


@pytest.fixture(scope="module")
def client():
    mp = pytest.MonkeyPatch()
    mp.setenv("AI_DISABLED", "true")  # integration tests use the offline engine
    with TestClient(create_app(Store(":memory:"))) as c:
        yield c
    mp.undo()


@pytest.fixture(scope="module")
def token(client):
    reg = client.post("/api/auth/register", json={"name": "Sam", "email": "Sam@Example.com", "password": "password123", "timeZone": "UTC"})
    assert reg.status_code == 201
    return reg.json()["token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_health(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["ai"]["provider"] == "heuristic"


def test_auth_register_duplicate_login_me(client, token):
    me = client.get("/api/auth/me", headers=auth(token)).json()["user"]
    assert me["email"] == "sam@example.com"
    assert "passwordHash" not in me

    dup = client.post("/api/auth/register", json={"name": "S", "email": "sam@example.com", "password": "password123"})
    assert dup.status_code == 409
    assert dup.json()["error"]
    assert client.post("/api/auth/login", json={"email": "sam@example.com", "password": "wrong-password"}).status_code == 401

    login = client.post("/api/auth/login", json={"email": "sam@example.com", "password": "password123"})
    assert login.status_code == 200
    assert client.get("/api/auth/me", headers=auth(login.json()["token"])).json()["user"]["name"] == "Sam"
    assert client.get("/api/blocks", headers=auth("bad-token")).status_code == 401


def test_preferences(client, token):
    res = client.patch("/api/auth/preferences", headers=auth(token), json={"timeZone": "Asia/Kolkata", "defaultReminderMinutes": 15})
    assert res.status_code == 200
    assert res.json()["user"]["preferences"]["timeZone"] == "Asia/Kolkata"
    assert client.patch("/api/auth/preferences", headers=auth(token), json={"timeZone": "Mars/Base"}).status_code == 400
    assert client.patch("/api/auth/preferences", headers=auth(token), json={"defaultReminderMinutes": 500}).status_code == 400


def test_blocks_create_conflict_batch_update_delete_series(client, token):
    h = auth(token)
    one = client.post("/api/blocks", headers=h, json={"title": "Focus", "category": "focus", "start": "2030-01-07T09:00:00Z", "end": "2030-01-07T11:00:00Z"})
    assert one.status_code == 201
    block_id = one.json()["blocks"][0]["id"]

    clash = client.post("/api/blocks", headers=h, json={"title": "Clash", "start": "2030-01-07T10:00:00Z", "end": "2030-01-07T12:00:00Z"})
    assert clash.status_code == 409
    assert clash.json()["conflicts"][0]["conflictsWith"]["title"] == "Focus"

    batch = [
        {"title": "Study", "category": "study", "start": "2030-01-07T10:30:00Z", "end": "2030-01-07T11:30:00Z"},
        {"title": "Study", "category": "study", "start": "2030-01-08T10:30:00Z", "end": "2030-01-08T11:30:00Z"},
        {"title": "Study", "category": "study", "start": "2030-01-09T10:30:00Z", "end": "2030-01-09T11:30:00Z"},
    ]
    assert client.post("/api/blocks", headers=h, json={"blocks": batch}).status_code == 409
    partial = client.post("/api/blocks", headers=h, json={"blocks": batch, "skipConflicts": True})
    assert partial.status_code == 201
    assert len(partial.json()["blocks"]) == 2
    assert len(partial.json()["skipped"]) == 1
    series_first = partial.json()["blocks"][0]
    assert series_first["seriesId"]

    upd = client.put(f"/api/blocks/{block_id}", headers=h, json={"title": "Deep focus", "end": "2030-01-07T10:00:00Z"})
    assert upd.status_code == 200
    assert upd.json()["block"]["title"] == "Deep focus"

    ranged = client.get("/api/blocks", headers=h, params={"from": "2030-01-08T00:00:00Z", "to": "2030-01-09T00:00:00Z"})
    assert len(ranged.json()["blocks"]) == 1

    deleted = client.delete(f"/api/blocks/{series_first['id']}?series=1", headers=h)
    assert deleted.json()["removed"] == 2
    assert len(client.get("/api/blocks", headers=h).json()["blocks"]) == 1
    assert client.delete("/api/blocks/nope", headers=h).status_code == 404


def test_ai_parse_and_insights_offline(client, token):
    h = auth(token)
    parsed = client.post("/api/ai/parse", headers=h, json={"text": "sleep 11pm-7am every night", "timeZone": "UTC"})
    assert parsed.status_code == 200
    assert parsed.json()["source"] == "heuristic"
    assert parsed.json()["proposals"][0]["startTime"] == "23:00"

    insights = client.post("/api/ai/insights", headers=h, json={"timeZone": "UTC"})
    assert insights.status_code == 200
    assert isinstance(insights.json()["score"], int)
    assert isinstance(insights.json()["suggestions"], list)

    assert client.post("/api/ai/parse", headers=h, json={"text": ""}).status_code == 400


def test_ai_chat_history_proposals_and_validation(client, token):
    h = auth(token)
    plan = client.post(
        "/api/ai/chat",
        headers=h,
        json={
            "timeZone": "UTC",
            "messages": [
                {"role": "assistant", "content": "Hi! How can I help?"},  # leading assistant turn is dropped
                {"role": "user", "content": "Block study time 7-9pm on weekdays"},
            ],
        },
    )
    assert plan.status_code == 200
    assert plan.json()["source"] == "heuristic"
    assert plan.json()["proposals"][0]["startTime"] == "19:00"
    assert "Add to calendar" in plan.json()["reply"]

    sched = client.post("/api/ai/chat", headers=h, json={"messages": [{"role": "user", "content": "what's coming up this week?"}]})
    assert sched.status_code == 200
    assert sched.json()["proposals"] == []

    tips = client.post("/api/ai/chat", headers=h, json={"messages": [{"role": "user", "content": "any tips to improve my week?"}]})
    assert "score" in tips.json()["reply"].lower()

    assert client.post("/api/ai/chat", headers=h, json={"messages": [{"role": "assistant", "content": "hi"}]}).status_code == 400
    assert client.post("/api/ai/chat", headers=h, json={"messages": "nope"}).status_code == 400


def test_unknown_api_route_and_sse_auth(client):
    res = client.get("/api/does-not-exist")
    assert res.status_code == 404
    assert res.json() == {"error": "Not found"}
    assert client.get("/api/events?token=bad").status_code == 401

"""
Step 1 of the Otterotter pipeline.

Reads new messages from the Telegram group, asks Claude to extract events,
geocodes them, and pushes the candidates into Airtable with Status = Pending.

Live run (in GitHub Actions) needs these env vars:
  TG_API_ID, TG_API_HASH, TG_SESSION, TG_GROUP,
  ANTHROPIC_API_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID

Offline check:
  python pipeline/fetch_and_extract.py --dry-run
  (uses pipeline/fixtures/sample_messages.json + a mock geocoder, prints what
   it *would* send to Airtable, writes nothing to the network)
"""

import os
import sys
import json

import otter_common as oc

DRY = "--dry-run" in sys.argv

FIXTURES = os.path.join(oc.HERE, "fixtures", "sample_messages.json")
MOCK_GEO = {
    "bora bora, aarhus, denmark": (56.1518, 10.2069),
    "aarhus, denmark": (56.1629, 10.2039),
    "weld, stockholm, sweden": (59.3157, 18.0610),
    "stockholm, sweden": (59.3293, 18.0686),
    "berlin, germany": (52.5200, 13.4050),
    "freiburg, germany": (47.9990, 7.8421),
    "lisbon, portugal": (38.7223, -9.1393),
}


def get_messages_dry():
    data = oc.load_json(FIXTURES, {"messages": []})
    return data.get("messages", [])


# Which topic (forum thread) holds the curated event lists. Override with the
# TG_TOPIC secret if the title ever changes.
TOPIC_TITLE = os.environ.get("TG_TOPIC", "CI Festivals & Intensives List")


def _find_topic_id(client, entity, title):
    """Look up a forum topic by its title. Prints available titles to help if not found."""
    from telethon.tl.functions.channels import GetForumTopicsRequest
    try:
        res = client(GetForumTopicsRequest(
            channel=entity, offset_date=0, offset_id=0, offset_topic=0, limit=100))
        titles = [getattr(t, "title", "") for t in res.topics]
        print("  Forum topics found:", titles)
        for t in res.topics:
            if getattr(t, "title", "").strip().lower() == title.strip().lower():
                return t.id
    except Exception as e:
        print("  (not a forum / topic lookup failed:", e, ")")
    return None


def get_messages_live(state):
    """Read messages from the curated topic (preferred) or pinned messages.

    We re-read the whole set every run (these monthly lists get edited) and rely
    on content de-duplication, so we do NOT use an incremental message cursor here.
    """
    from telethon.sync import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl.types import InputMessagesFilterPinned

    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]
    session = os.environ["TG_SESSION"]
    group = os.environ["TG_GROUP"]

    out = []
    with TelegramClient(StringSession(session), api_id, api_hash) as client:
        entity = client.get_entity(group)
        msgs = []

        # 1) preferred: the named topic ("CI Festivals & Intensives List")
        topic_id = _find_topic_id(client, entity, TOPIC_TITLE)
        if topic_id:
            msgs = list(client.iter_messages(entity, reply_to=topic_id, limit=300))
            print("  Topic '%s' -> %d messages" % (TOPIC_TITLE, len(msgs)))

        # 2) fallback: pinned messages
        if not msgs:
            msgs = list(client.iter_messages(entity, filter=InputMessagesFilterPinned, limit=100))
            print("  Falling back to pinned messages ->", len(msgs))

        for msg in msgs:
            text = msg.message or ""
            if text.strip():
                out.append({
                    "id": msg.id,
                    "date": msg.date.date().isoformat() if msg.date else oc.today_iso(),
                    "text": text,
                })
    return out


def main():
    state = oc.load_json(oc.STATE_PATH, {"last_id": 0})
    cache = oc.load_json(oc.GEOCACHE_PATH, {})

    if DRY:
        print("DRY RUN — no network calls\n")
        messages = get_messages_dry()
        existing_keys = oc.existing_ids(oc.load_events())
        extractor = mock_extract
    else:
        oc.airtable_preflight()  # fail fast (~1s) if token/base/table are wrong
        messages = get_messages_live(state)
        existing_keys = oc.airtable_existing_event_keys() | oc.existing_ids(oc.load_events())
        from anthropic import Anthropic
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        extractor = lambda text, date: oc.extract_events_claude(text, date, client)

    print("Messages to process:", len(messages))
    print("Already known (skip):", len(existing_keys))

    candidates, seen = [], set()
    for m in messages:
        src = str(m["id"])
        events = extractor(m["text"], m.get("date", oc.today_iso()))
        for ev in events:
            oc.geocode_event(ev, cache, online=not DRY, mock_table=MOCK_GEO)
            key = oc.event_id(ev)
            if key in existing_keys or key in seen:
                continue  # already on the map, already in Airtable, or a repeat this run
            seen.add(key)
            candidates.append((ev, src))

    print("New candidate events:", len(candidates))
    for ev, src in candidates:
        loc = ", ".join(filter(None, [ev.get("city"), ev.get("country")]))
        print("  -", ev.get("start_date") or "??", "|", ev.get("title"),
              "|", loc, "| coords:", ev.get("lat"), ev.get("lng"))

    fields = [oc.candidate_to_airtable_fields(ev, src) for ev, src in candidates]

    if DRY:
        print("\nWould create", len(fields), "Airtable rows (Status=Pending). Sample:")
        if fields:
            print(json.dumps(fields[0], ensure_ascii=False, indent=2))
    else:
        created = oc.airtable_create(fields) if fields else 0
        print("Created", created, "Airtable rows.")
        oc.save_json(oc.STATE_PATH, state)
        oc.save_json(oc.GEOCACHE_PATH, cache)

    # In dry-run, still persist the geocode cache so repeat tests are fast.
    if DRY:
        oc.save_json(oc.GEOCACHE_PATH, cache)


# ---- mock extractor for dry-run: fixtures carry an 'expected' events list ----
def mock_extract(text, date):
    # the fixture stores pre-parsed events under each message; the real run uses Claude
    return _CURRENT_EXPECTED.get(text, [])


_CURRENT_EXPECTED = {}


def _load_mock_expectations():
    data = oc.load_json(FIXTURES, {"messages": []})
    for m in data.get("messages", []):
        _CURRENT_EXPECTED[m["text"]] = m.get("expected", [])


if DRY:
    _load_mock_expectations()

if __name__ == "__main__":
    main()

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


def get_messages_live(state):
    """Pull new messages from Telegram via Telethon (user session)."""
    from telethon.sync import TelegramClient
    from telethon.sessions import StringSession

    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]
    session = os.environ["TG_SESSION"]
    group = os.environ["TG_GROUP"]

    last_id = state.get("last_id", 0)
    out, max_id = [], last_id
    with TelegramClient(StringSession(session), api_id, api_hash) as client:
        for msg in client.iter_messages(group, min_id=last_id, limit=500):
            if msg.id > max_id:
                max_id = msg.id
            text = msg.message or ""
            if text.strip():
                out.append({
                    "id": msg.id,
                    "date": msg.date.date().isoformat() if msg.date else oc.today_iso(),
                    "text": text,
                })
    state["last_id"] = max_id
    return out


def main():
    state = oc.load_json(oc.STATE_PATH, {"last_id": 0})
    cache = oc.load_json(oc.GEOCACHE_PATH, {})

    if DRY:
        print("DRY RUN — no network calls\n")
        messages = get_messages_dry()
        existing_src = set()
        extractor = mock_extract
        client = None
    else:
        messages = get_messages_live(state)
        existing_src = oc.airtable_existing_source_ids()
        from anthropic import Anthropic
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        extractor = lambda text, date: oc.extract_events_claude(text, date, client)

    print("Messages to process:", len(messages))
    candidates = []
    for m in messages:
        src = str(m["id"])
        if src in existing_src:
            continue
        events = extractor(m["text"], m.get("date", oc.today_iso()))
        for ev in events:
            oc.geocode_event(ev, cache, online=not DRY, mock_table=MOCK_GEO)
            candidates.append((ev, src))

    print("Candidate events found:", len(candidates))
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

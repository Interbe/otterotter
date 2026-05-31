"""
Shared helpers for the Otterotter Telegram pipeline.

Nothing here talks to the network unless you call it. Everything is written so
the logic (slugs, dedupe, geocode cache, events.json merge) can be unit-tested
offline with --dry-run, while the live calls (Telegram, Claude, Airtable,
Nominatim) only fire when real credentials are present.
"""

import json
import os
import re
import time
import hashlib
import datetime as dt

# ---------------------------------------------------------------- paths / config
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

# In the live GitHub repo, events.json sits at data/events.json (repo root).
# Locally for testing we point at site/data/events.json via OTTER_EVENTS_PATH.
EVENTS_PATH = os.environ.get("OTTER_EVENTS_PATH", os.path.join(REPO, "data", "events.json"))
STATE_PATH = os.path.join(HERE, "state.json")
GEOCACHE_PATH = os.path.join(HERE, "geocode_cache.json")

VALID_TYPES = {"jam", "class", "workshop", "festival"}

ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")

AIRTABLE_TABLE = os.environ.get("AIRTABLE_TABLE", "Events")
AIRTABLE_BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "")
AIRTABLE_TOKEN = os.environ.get("AIRTABLE_TOKEN", "")

NOMINATIM_UA = "OtterotterEventsMap/1.0 (https://otterotter.org)"


# ---------------------------------------------------------------- small utilities
def today_iso():
    return dt.date.today().isoformat()


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def clean_date(s):
    """Return s if it's a real YYYY-MM-DD date, else None (guards against the model
    hallucinating impossible dates like 2026-09-31)."""
    if not s:
        return None
    s = str(s)[:10]
    try:
        dt.datetime.strptime(s, "%Y-%m-%d")
        return s
    except ValueError:
        return None


def slugify(*parts):
    base = "-".join(str(p) for p in parts if p)
    base = base.lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base[:60] or "event"


def event_id(ev):
    """Stable id from title + start date + city, plus a short hash for safety."""
    h = hashlib.sha1(
        (str(ev.get("title", "")) + str(ev.get("start_date", "")) +
         str(ev.get("city", ""))).encode("utf-8")
    ).hexdigest()[:6]
    return slugify(ev.get("title"), ev.get("start_date"), ev.get("city")) + "-" + h


# ---------------------------------------------------------------- events.json I/O
def load_events():
    data = load_json(EVENTS_PATH, {"events": []})
    if "events" not in data:
        data["events"] = []
    return data


def existing_ids(events_data):
    return {e.get("id") for e in events_data.get("events", [])}


def add_event(events_data, ev):
    """Append ev to events_data if its id isn't already present. Returns True if added."""
    if "id" not in ev or not ev["id"]:
        ev["id"] = event_id(ev)
    if ev["id"] in existing_ids(events_data):
        return False
    events_data["events"].append(ev)
    return True


# ---------------------------------------------------------------- geocoding
def geocode(query, cache, online=True, mock_table=None):
    """Return (lat, lng) for a place string, using a cache. Respects Nominatim's
    1 req/sec policy. In dry-run, uses mock_table instead of the network."""
    if not query:
        return None, None
    key = query.strip().lower()
    if key in cache:
        return cache[key].get("lat"), cache[key].get("lng")

    if not online:
        if mock_table and key in mock_table:
            lat, lng = mock_table[key]
            cache[key] = {"lat": lat, "lng": lng}
            return lat, lng
        return None, None

    import requests  # imported lazily so dry-run needs no requests
    try:
        time.sleep(1.1)  # be polite to the free Nominatim service
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 1},
            headers={"User-Agent": NOMINATIM_UA},
            timeout=20,
        )
        r.raise_for_status()
        hits = r.json()
        if hits:
            lat = float(hits[0]["lat"])
            lng = float(hits[0]["lon"])
            cache[key] = {"lat": lat, "lng": lng}
            return lat, lng
    except Exception as e:
        print("  geocode error for", query, "->", e)
    cache[key] = {"lat": None, "lng": None}
    return None, None


def geocode_event(ev, cache, online=True, mock_table=None):
    """Fill ev['lat']/['lng'] if missing, trying venue+city+country then city+country."""
    if ev.get("lat") is not None and ev.get("lng") is not None:
        return ev
    attempts = []
    if ev.get("venue"):
        attempts.append(", ".join(filter(None, [ev.get("venue"), ev.get("city"), ev.get("country")])))
    attempts.append(", ".join(filter(None, [ev.get("city"), ev.get("country")])))
    for q in attempts:
        lat, lng = geocode(q, cache, online=online, mock_table=mock_table)
        if lat is not None:
            ev["lat"], ev["lng"] = lat, lng
            return ev
    ev["lat"], ev["lng"] = None, None
    return ev


# ---------------------------------------------------------------- Claude extraction
EXTRACT_SYSTEM = """You extract structured event listings from informal messages \
posted in a contact-improvisation / eco-somatics community chat.

Return ONLY valid JSON: {"events": [ ... ]}. If the message is not announcing a \
concrete event (it's a discussion, a photo, a thank-you, a question, spam), return \
{"events": []}.

Each event object must have these keys (use null when unknown, never invent):
  title        short event name
  description  one short sentence, plain text, max ~140 characters
  type         one of: jam, class, workshop, festival (use "festival" for \
multi-day gatherings and retreats)
  start_date   "YYYY-MM-DD" (resolve relative dates like "this Saturday" using the \
message date provided), or null
  end_date     "YYYY-MM-DD" or null (same as start_date for single-day events)
  time         e.g. "19:00" or "all day" or null
  city         city name or null
  country      country name in English or null
  venue        venue name or null
  link         the event's URL if present, else null. Links often appear as \
markdown like [Festival Name](https://...) — put that URL here. Also accept plain \
URLs. Pick the link that belongs to each specific event.

Events may be anywhere in the world. Be conservative: if you are not reasonably \
sure something is a real, datable event, omit it."""


def extract_events_claude(message_text, message_date, client):
    """Call Claude to extract events from one message. Returns list (possibly empty)."""
    user = (
        "Message date: " + str(message_date) + "\n\n"
        "Message:\n\"\"\"\n" + message_text + "\n\"\"\""
    )
    resp = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=8000,  # monthly list posts can hold many events
        system=EXTRACT_SYSTEM,
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(getattr(b, "text", "") for b in resp.content).strip()
    return _parse_events_json(text)


def _parse_events_json(text):
    """Pull events out of a model response. Tolerates truncated output by
    salvaging every complete event object even if the surrounding array is cut off."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    # 1) clean parse
    try:
        data = json.loads(text)
        evs = data.get("events", []) if isinstance(data, dict) else \
            (data if isinstance(data, list) else [])
        return [e for e in evs if isinstance(e, dict) and _valid_candidate(e)]
    except json.JSONDecodeError:
        pass
    # 2) salvage: parse each complete {...} event object individually
    evs = []
    for sub in _salvage_objects(text):
        try:
            e = json.loads(sub)
        except json.JSONDecodeError:
            continue
        if isinstance(e, dict) and _valid_candidate(e):
            evs.append(e)
    return evs


def _salvage_objects(text):
    """Return every brace-balanced {...} substring that looks like an event
    (contains a "title" key and is not the outer {"events": ...} wrapper)."""
    out, seen, n = [], set(), len(text)
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        depth = 0
        for j in range(i, n):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    sub = text[i:j + 1]
                    if '"title"' in sub and '"events"' not in sub and sub not in seen:
                        seen.add(sub)
                        out.append(sub)
                    break
    return out


def _valid_candidate(e):
    if not e.get("title"):
        return False
    if e.get("type") and e["type"] not in VALID_TYPES:
        e["type"] = "jam"  # default to jam if model returns an odd type
    return True


# ---------------------------------------------------------------- Airtable
def _airtable_url():
    return "https://api.airtable.com/v0/{}/{}".format(
        AIRTABLE_BASE_ID, AIRTABLE_TABLE.replace(" ", "%20")
    )


def airtable_headers():
    return {"Authorization": "Bearer " + AIRTABLE_TOKEN, "Content-Type": "application/json"}


def airtable_existing_source_ids():
    """Return set of SourceMsg values already in Airtable (for dedupe)."""
    import requests
    out, offset = set(), None
    while True:
        params = {"fields[]": "SourceMsg", "pageSize": 100}
        if offset:
            params["offset"] = offset
        r = requests.get(_airtable_url(), headers=airtable_headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        for rec in data.get("records", []):
            v = rec.get("fields", {}).get("SourceMsg")
            if v:
                out.add(str(v))
        offset = data.get("offset")
        if not offset:
            break
    return out


def airtable_preflight():
    """Quick read to confirm token/base/table are reachable. Fails in ~1s if not."""
    import requests
    r = requests.get(_airtable_url(), headers=airtable_headers(),
                     params={"pageSize": 1}, timeout=20)
    if r.status_code >= 400:
        print("  Airtable preflight error:", r.status_code, r.text[:400])
    r.raise_for_status()


def airtable_existing_event_keys():
    """Return the set of event_id keys already in Airtable (any status), computed
    from Title + StartDate + City, so we can dedupe by content (not just message)."""
    import requests
    keys, offset = set(), None
    while True:
        params = {"fields[]": ["Title", "StartDate", "City"], "pageSize": 100}
        if offset:
            params["offset"] = offset
        r = requests.get(_airtable_url(), headers=airtable_headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        for rec in data.get("records", []):
            f = rec.get("fields", {})
            keys.add(event_id({
                "title": f.get("Title", ""),
                "start_date": f.get("StartDate", ""),
                "city": f.get("City", ""),
            }))
        offset = data.get("offset")
        if not offset:
            break
    return keys


def airtable_create(records):
    """records: list of field dicts. Creates them in batches of 10.
    typecast=True lets Airtable auto-match select options and coerce types,
    which avoids most 422 errors from small option name/case mismatches."""
    import requests

    def _post(field_dicts):
        return requests.post(
            _airtable_url(), headers=airtable_headers(),
            json={"records": [{"fields": f} for f in field_dicts], "typecast": True},
            timeout=30)

    created = 0
    for i in range(0, len(records), 10):
        chunk = records[i:i + 10]
        r = _post(chunk)
        if r.status_code < 400:
            created += len(r.json().get("records", []))
            continue
        # one bad row fails the whole batch — retry individually and skip offenders
        print("  batch failed (", r.status_code, ") — retrying rows individually")
        for f in chunk:
            r1 = _post([f])
            if r1.status_code < 400:
                created += 1
            else:
                print("  skipped row:", f.get("Title"), "->", r1.text[:160])
    return created


def airtable_list_status(status):
    """Return records (id + fields) whose Status equals the given value."""
    import requests
    out, offset = [], None
    formula = "{Status}='" + status + "'"
    while True:
        params = {"filterByFormula": formula, "pageSize": 100}
        if offset:
            params["offset"] = offset
        r = requests.get(_airtable_url(), headers=airtable_headers(), params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
    return out


def airtable_set_status(record_id, status):
    import requests
    r = requests.patch(
        _airtable_url() + "/" + record_id,
        headers=airtable_headers(),
        json={"fields": {"Status": status}},
        timeout=30,
    )
    r.raise_for_status()


# ---------------------------------------------------------------- mapping helpers
def candidate_to_airtable_fields(ev, source_msg):
    """Map an extracted/geocoded event dict to Airtable field names."""
    return {
        "Title": ev.get("title") or "",
        "Description": ev.get("description") or "",
        "Type": ev.get("type") or "jam",
        "StartDate": clean_date(ev.get("start_date")),
        "EndDate": clean_date(ev.get("end_date")) or clean_date(ev.get("start_date")),
        "Time": ev.get("time") or "",
        "City": ev.get("city") or "",
        "Country": ev.get("country") or "",
        "Venue": ev.get("venue") or "",
        "Lat": ev.get("lat"),
        "Lng": ev.get("lng"),
        "Link": ev.get("link") or "",
        "SourceMsg": str(source_msg),
        "Status": "Pending",
        "Added": today_iso(),
    }


def airtable_record_to_event(fields):
    """Map an approved Airtable row back to the events.json schema."""
    ev = {
        "title": fields.get("Title", ""),
        "description": fields.get("Description", ""),
        "type": fields.get("Type", "jam"),
        "start_date": clean_date(fields.get("StartDate")),
        "end_date": clean_date(fields.get("EndDate")) or clean_date(fields.get("StartDate")),
        "time": fields.get("Time", ""),
        "city": fields.get("City", ""),
        "country": fields.get("Country", ""),
        "venue": fields.get("Venue", ""),
        "lat": fields.get("Lat"),
        "lng": fields.get("Lng"),
        "link": fields.get("Link", ""),
        "source": "telegram",
        "featured": False,
        "added_date": today_iso(),
    }
    ev["id"] = event_id(ev)
    return ev

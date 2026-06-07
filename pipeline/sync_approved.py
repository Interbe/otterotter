"""
Step 2 of the Otterotter pipeline.

Reads Airtable rows you marked Status = Approved, merges them into
data/events.json, and flips them to Status = Published so they aren't added twice.

Also:
- applies manual location overrides (from the review tool) — these always win;
- publishes events with no reliable location (flagged on the site, not pinned);
- UPDATES events already on the map when their Airtable data changes (so location
  fixes and edits propagate);
- recovers any "Published" row that isn't actually on the map (mis-click safety).

Live run needs: AIRTABLE_TOKEN, AIRTABLE_BASE_ID

Offline check:  python pipeline/sync_approved.py --dry-run
"""

import os
import sys

import otter_common as oc

DRY = "--dry-run" in sys.argv
FIXTURES = os.path.join(oc.HERE, "fixtures", "sample_approved.json")

MUTABLE = ["title", "description", "type", "start_date", "end_date", "time",
           "city", "country", "venue", "lat", "lng", "link"]


def _build(rec, overrides):
    ev = oc.airtable_record_to_event(rec.get("fields", {}))
    oc.apply_override(ev, overrides)  # manual placement wins
    return ev


def _consider(ev, events_data, index, label):
    """Add a new event, or update an existing one in place. Returns a status word."""
    if not ev.get("start_date"):
        print("  ! skipping (no date):", ev.get("title"))
        return "skip"
    if oc.is_past(ev):
        return "skip"
    key = oc.dedupe_key(ev)
    if key in index:
        cur, changed = index[key], False
        for fld in MUTABLE:
            if cur.get(fld) != ev.get(fld):
                cur[fld] = ev.get(fld)
                changed = True
        if changed:
            print("  ~ updated:", ev.get("title"))
            return "updated"
        return "same"
    oc.add_event(events_data, ev)
    index[key] = ev
    loc = ev.get("city") or "(location to confirm)"
    print("  +", label, ":", ev.get("start_date"), "|", ev.get("title"), "|", loc)
    return "added"


def main():
    events_data = oc.load_events()

    # one-time housekeeping: drop the original seed/example events
    n0 = len(events_data["events"])
    events_data["events"] = [e for e in events_data["events"] if e.get("source") != "sample"]
    if len(events_data["events"]) != n0:
        print("Removed", n0 - len(events_data["events"]), "sample events")

    before = len(events_data["events"])
    overrides = oc.load_overrides()
    index = {oc.dedupe_key(e): e for e in events_data["events"]}

    if DRY:
        print("DRY RUN — no network, no permanent writes\n")
        approved = oc.load_json(FIXTURES, {"records": []}).get("records", [])
        published = []
    else:
        approved = oc.airtable_list_status("Approved")
        published = oc.airtable_list_status("Published")

    print("Manual overrides:", len(overrides), "| Approved rows:", len(approved))
    added = updated = recovered = 0
    publish_ids = []
    for rec in approved:
        r = _consider(_build(rec, overrides), events_data, index, "added")
        if r == "added":
            added += 1
        elif r == "updated":
            updated += 1
        publish_ids.append(rec.get("id"))

    if published:
        print("Re-checking", len(published), "already-Published rows…")
        for rec in published:
            r = _consider(_build(rec, overrides), events_data, index, "recovered")
            if r == "added":
                recovered += 1
            elif r == "updated":
                updated += 1

    unlocated = sum(1 for e in events_data["events"]
                    if e.get("lat") is None or e.get("lng") is None)
    print("\nEvents before:", before, "| added:", added, "| updated:", updated,
          "| recovered:", recovered, "| after:", len(events_data["events"]),
          "| unlocated (flagged, no pin):", unlocated)

    if DRY:
        print("\nResulting events.json would contain", len(events_data["events"]), "events.")
        return

    oc.save_json(oc.EVENTS_PATH, events_data)
    for rid in publish_ids:
        oc.airtable_set_status(rid, "Published")
    print("Wrote events.json; marked", len(publish_ids), "approved rows Published.")


if __name__ == "__main__":
    main()

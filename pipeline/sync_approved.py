"""
Step 2 of the Otterotter pipeline.

Reads Airtable rows you marked Status = Approved, merges them into
data/events.json, and flips them to Status = Published so they aren't added twice.

Safeguard: it also re-checks rows already marked Published and, if one isn't
actually on the map yet (e.g. you flipped it to Published by accident), it adds
it. So a mis-click can't lose an event.

Live run needs: AIRTABLE_TOKEN, AIRTABLE_BASE_ID

Offline check:
  python pipeline/sync_approved.py --dry-run
  (reads pipeline/fixtures/sample_approved.json, merges into a temp copy of
   events.json, prints the result, writes nothing permanent)
"""

import os
import sys

import otter_common as oc

DRY = "--dry-run" in sys.argv
FIXTURES = os.path.join(oc.HERE, "fixtures", "sample_approved.json")


def _consider(rec, events_data, existing_keys, label):
    """Add the event for an Airtable row to events_data if it's valid and not
    already present (by link/content key). Returns True if added."""
    ev = oc.airtable_record_to_event(rec.get("fields", {}))
    if not ev.get("start_date"):
        print("  ! skipping (no date):", ev.get("title"))
        return False
    if oc.is_past(ev):
        return False  # don't (re)publish events that have already happened
    if ev.get("lat") is None or ev.get("lng") is None:
        print("  ! skipping (no coordinates):", ev.get("title"))
        return False
    key = oc.dedupe_key(ev)
    if key in existing_keys:
        return False
    oc.add_event(events_data, ev)
    existing_keys.add(key)
    print("  +", label, ":", ev.get("start_date"), "|", ev.get("title"), "|", ev.get("city"))
    return True


def main():
    events_data = oc.load_events()

    # one-time housekeeping: drop the original seed/example events
    n0 = len(events_data["events"])
    events_data["events"] = [e for e in events_data["events"] if e.get("source") != "sample"]
    if len(events_data["events"]) != n0:
        print("Removed", n0 - len(events_data["events"]), "sample events")

    before = len(events_data["events"])
    existing_keys = oc.existing_dedupe_keys(events_data)

    if DRY:
        print("DRY RUN — no network, no permanent writes\n")
        approved = oc.load_json(FIXTURES, {"records": []}).get("records", [])
        published = []
    else:
        approved = oc.airtable_list_status("Approved")
        published = oc.airtable_list_status("Published")

    print("Approved rows to publish:", len(approved))
    added, publish_ids = 0, []
    for rec in approved:
        if _consider(rec, events_data, existing_keys, "added"):
            added += 1
        publish_ids.append(rec.get("id"))  # approved -> mark Published either way

    # safeguard: recover any "Published" row that isn't actually on the map
    recovered = 0
    if published:
        print("Re-checking", len(published), "already-Published rows…")
        for rec in published:
            if _consider(rec, events_data, existing_keys, "recovered"):
                recovered += 1

    print("\nEvents before:", before, "| added:", added, "| recovered:", recovered,
          "| after:", len(events_data["events"]))

    if DRY:
        print("\nResulting events.json would contain", len(events_data["events"]), "events.")
        return

    oc.save_json(oc.EVENTS_PATH, events_data)
    for rid in publish_ids:
        oc.airtable_set_status(rid, "Published")
    print("Wrote events.json; marked", len(publish_ids), "approved rows Published.")


if __name__ == "__main__":
    main()

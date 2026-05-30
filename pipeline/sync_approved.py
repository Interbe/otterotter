"""
Step 2 of the Otterotter pipeline.

Reads Airtable rows you marked Status = Approved, merges them into
data/events.json, and flips them to Status = Published so they aren't added twice.

Live run needs: AIRTABLE_TOKEN, AIRTABLE_BASE_ID

Offline check:
  python pipeline/sync_approved.py --dry-run
  (reads pipeline/fixtures/sample_approved.json, merges into a temp copy of
   events.json, prints the result, writes nothing permanent)
"""

import os
import sys
import json
import copy

import otter_common as oc

DRY = "--dry-run" in sys.argv
FIXTURES = os.path.join(oc.HERE, "fixtures", "sample_approved.json")


def main():
    events_data = oc.load_events()
    before = len(events_data["events"])

    if DRY:
        print("DRY RUN — no network, no permanent writes\n")
        rows = oc.load_json(FIXTURES, {"records": []}).get("records", [])
    else:
        rows = oc.airtable_list_status("Approved")

    print("Approved rows to publish:", len(rows))

    added = 0
    published_ids = []
    for rec in rows:
        fields = rec.get("fields", {})
        ev = oc.airtable_record_to_event(fields)
        if not ev.get("start_date"):
            print("  ! skipping (no date):", ev.get("title"))
            continue
        if ev.get("lat") is None or ev.get("lng") is None:
            print("  ! skipping (no coordinates):", ev.get("title"))
            continue
        if oc.add_event(events_data, ev):
            added += 1
            published_ids.append(rec.get("id"))
            print("  + added:", ev.get("start_date"), "|", ev.get("title"),
                  "|", ev.get("city"))
        else:
            published_ids.append(rec.get("id"))  # already present -> still mark published
            print("  = already on map:", ev.get("title"))

    print("\nEvents before:", before, "| added:", added, "| after:", len(events_data["events"]))

    if DRY:
        print("\nResulting events.json would contain", len(events_data["events"]), "events.")
        # show the newly added ones only
        return

    # live: write events.json and mark rows Published
    oc.save_json(oc.EVENTS_PATH, events_data)
    for rid in published_ids:
        oc.airtable_set_status(rid, "Published")
    print("Wrote events.json and marked", len(published_ids), "rows Published.")


if __name__ == "__main__":
    main()

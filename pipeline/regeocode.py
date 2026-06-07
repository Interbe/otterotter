"""
One-time location repair.

Re-resolves every Airtable row with the corrected geocoding rules (never country-
only) plus any manual overrides, and writes the new coordinates back — clearing
them where a trustworthy location can't be found. Those events then show up as
"location to be confirmed" so you can place them in the review tool.

Run it from the "repair-locations" workflow (Actions -> Run workflow), or locally:
  AIRTABLE_TOKEN=... AIRTABLE_BASE_ID=... python pipeline/regeocode.py
"""

import otter_common as oc


def main():
    oc.airtable_preflight()
    overrides = oc.load_overrides()
    print("Re-geocoding all Airtable rows (overrides:", len(overrides), ")…")
    changed = oc.airtable_regeocode(overrides)
    print("Updated coordinates on", changed, "rows.")


if __name__ == "__main__":
    main()

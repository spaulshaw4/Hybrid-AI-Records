"""Print archives the reconciler could not read, plus name-based folder guesses."""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "archive_reconciliation.json"), encoding="utf-8"))

for st in ("UNREADABLE", "EMPTY", "UNKNOWN_TAR"):
    rows = [r for r in data if r["status"] == st]
    print(f"\n===== {st}  ({len(rows)}, {sum(r['zip_bytes'] for r in rows)/1e9:.2f} GB) =====")
    for r in sorted(rows, key=lambda r: -r["zip_bytes"]):
        print(f"{r['zip_bytes']/1e9:9.3f} GB  {r['archive']}")
        if r.get("reason"):
            print(f"            reason: {r['reason']}")

print("\n===== NOT_EXTRACTED (largest) =====")
for r in sorted([r for r in data if r["status"] == "NOT_EXTRACTED"], key=lambda r: -r["zip_bytes"]):
    print(f"{r['zip_bytes']/1e9:9.3f} GB  {r['members']:6} members  {r['archive']}")

print("\n===== PARTIAL =====")
for r in sorted([r for r in data if r["status"] == "PARTIAL"], key=lambda r: -r["zip_bytes"]):
    loc = r["top_locations"][0][0] if r["top_locations"] else "?"
    print(f"{r['zip_bytes']/1e9:9.3f} GB  {r['found_fraction']:.2f} present  {r['archive']}\n            -> {loc}")

ext = [r for r in data if r["status"] == "EXTRACTED"]
print(f"\nEXTRACTED reclaimable: {sum(r['zip_bytes'] for r in ext)/1e9:.2f} GB across {len(ext)} archives")
print("\nEXTRACTED, where the contents live (top 25 by zip size):")
for r in sorted(ext, key=lambda r: -r["zip_bytes"])[:25]:
    loc = r["top_locations"][0][0] if r["top_locations"] else "?"
    print(f"{r['zip_bytes']/1e9:9.3f} GB  {r['archive']}\n            -> {loc}")

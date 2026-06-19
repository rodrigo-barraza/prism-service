import json
from collections import defaultdict

with open("scratch/findings.json") as f:
    findings = json.load(f)

# Group by category, file and severity
grouped = defaultdict(lambda: defaultdict(list))
for f in findings:
    grouped[f["category"]][f["file"]].append(f)

for cat, files in grouped.items():
    print(f"CATEGORY: {cat}")
    for file, items in files.items():
        criticals = [i for i in items if i["severity"] == "🔴"]
        warnings = [i for i in items if i["severity"] == "🟡"]
        infos = [i for i in items if i["severity"] == "🔵"]
        print(f"  File: {file} (🔴 {len(criticals)}, 🟡 {len(warnings)}, 🔵 {len(infos)})")
        if warnings:
            print("    Warnings:")
            for w in warnings[:5]:
                print(f"      Line {w.get('line_range')}: {w.get('description')} -> Fix: {w.get('fix')}")
            if len(warnings) > 5:
                print(f"      ... and {len(warnings)-5} more warnings")
        if criticals:
            print("    Criticals:")
            for c in criticals:
                print(f"      Line {c.get('line_range')}: {c.get('description')} -> Fix: {c.get('fix')}")
    print()

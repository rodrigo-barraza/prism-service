import json

with open("scratch/findings.json") as f:
    findings = json.load(f)

print("CRITICAL FINDINGS (🔴):")
criticals = [f for f in findings if f["severity"] == "🔴"]
for idx, f in enumerate(criticals):
    print(f"[{idx+1}] File: {f['file']}")
    print(f"    Line: {f.get('line')}")
    print(f"    Category: {f.get('category')}")
    print(f"    Details: {f.get('details')}")
    print(f"    Fix: {f.get('fix')}")
    print()

print("="*60)
print("WARNING FINDINGS (🟡):")
warnings = [f for f in findings if f["severity"] == "🟡"]
for idx, f in enumerate(warnings):
    print(f"[{idx+1}] File: {f['file']}")
    print(f"    Line: {f.get('line')}")
    print(f"    Category: {f.get('category')}")
    print(f"    Details: {f.get('details')}")
    print(f"    Fix: {f.get('fix')}")
    print()

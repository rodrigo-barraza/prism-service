import json

with open("scratch/findings.json") as f:
    findings = json.load(f)

print("CRITICAL FINDINGS (🔴) & WARNINGS (🟡):")
filtered = [f for f in findings if f["severity"] in ("🔴", "🟡")]
for idx, f in enumerate(filtered):
    print(f"=== Finding {idx+1} ===")
    print(f"File: {f.get('file')}")
    print(f"Category: {f.get('category')}")
    print(f"Severity: {f.get('severity')}")
    print(f"Source: {f.get('source')}")
    print(f"Exported: {f.get('exported')}")
    print(f"Description: {f.get('description')}")
    print(f"Fix: {f.get('fix')}")
    print(f"Line Range: {f.get('line_range')}")
    print()

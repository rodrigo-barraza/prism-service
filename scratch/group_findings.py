import json
from collections import defaultdict

with open("scratch/findings.json", "r") as f:
    findings = json.load(f)

# Group by severity and print summary
severity_counts = defaultdict(int)
category_counts = defaultdict(int)
file_findings = defaultdict(list)

for f in findings:
    severity_counts[f["severity"]] += 1
    category_counts[f["category"]] += 1
    file_findings[f["file"]].append(f)

print(f"Severity breakdown:")
for sev, count in severity_counts.items():
    print(f"  {sev}: {count}")

print("\nCategory breakdown:")
for cat, count in category_counts.items():
    print(f"  {cat}: {count}")

print("\nTop files with findings:")
sorted_files = sorted(file_findings.items(), key=lambda x: len(x[1]), reverse=True)
for file_path, file_f in sorted_files[:15]:
    critical_count = sum(1 for x in file_f if x["severity"] == "🔴")
    warning_count = sum(1 for x in file_f if x["severity"] == "🟡")
    info_count = sum(1 for x in file_f if x["severity"] == "🔵")
    print(f"  {file_path}: {len(file_f)} (🔴 {critical_count}, 🟡 {warning_count}, 🔵 {info_count})")

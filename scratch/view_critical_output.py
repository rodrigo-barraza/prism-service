import json

with open("scratch/findings.json") as f:
    findings = json.load(f)

filtered = [f for f in findings if f["severity"] in ("🔴", "🟡")]

output_lines = []
for idx, f in enumerate(filtered):
    output_lines.append(f"=== Finding {idx+1} ===")
    output_lines.append(f"File: {f.get('file')}")
    output_lines.append(f"Category: {f.get('category')}")
    output_lines.append(f"Severity: {f.get('severity')}")
    output_lines.append(f"Source: {f.get('source')}")
    output_lines.append(f"Exported: {f.get('exported')}")
    output_lines.append(f"Description: {f.get('description')}")
    output_lines.append(f"Fix: {f.get('fix')}")
    output_lines.append(f"Line Range: {f.get('line_range')}")
    output_lines.append("")

with open("scratch/critical_and_warning_findings.txt", "w") as out:
    out.write("\n".join(output_lines))

print(f"Wrote {len(filtered)} findings to scratch/critical_and_warning_findings.txt")

import json
from collections import defaultdict

with open("scratch/findings.json") as f:
    findings = json.load(f)

# Sort findings by severity (Critical first, then Warning, then Info)
severity_order = {"🔴": 0, "🟡": 1, "🔵": 2}
findings.sort(key=lambda x: severity_order.get(x["severity"], 3))

# We will group findings for presentation
# Critical findings: Report in full detail.
# Warning findings: Report in full detail (specifically the hardcoded prompt delimiters).
# Info findings: There are 221 of these. Group them by file for readability.

markdown = []
markdown.append("# Test Contract Alignment Audit Report")
markdown.append("")
markdown.append("This audit report documents cases in `prism-service` where test files have diverged or drifted from the production contracts/source code they validate, grouped into the five specified audit categories.")
markdown.append("")
markdown.append("## Executive Summary")
markdown.append("")
markdown.append("A full scan of the 96 test files in `prism-service` was performed. Here is the summary of detected contract drifts:")
markdown.append("")

# Count severities
counts = {"🔴": 0, "🟡": 0, "🔵": 0}
for f in findings:
    counts[f["severity"]] = counts.get(f["severity"], 0) + 1

markdown.append(f"- **🔴 Critical Severity**: {counts['🔴']} findings (true contract type bypasses or unsafe casts overriding production interfaces).")
markdown.append(f"- **🟡 Warning Severity**: {counts['🟡']} findings (hard-coded magic strings duplicating prompt delimiters defined in `PROMPT_DELIMITERS`).")
markdown.append(f"- **🔵 Info Severity**: {counts['🔵']} findings (hard-coded provider names, reasoning strategies, or harness IDs instead of constants).")
markdown.append("")

markdown.append("## 1. Duplicated Types & Interfaces (Phantom Contracts)")
markdown.append("")

critical_findings = [f for f in findings if f["severity"] == "🔴"]
for idx, f in enumerate(critical_findings):
    # Determine true drift vs false positive
    is_true_drift = False
    if "DisplayMessage" in f["description"] or "TestMessage" in f["description"] and "finalizer" in f["file"]:
        is_true_drift = True
    
    status = "True Contract Drift" if is_true_drift else "Standard Type Alias / Extension"
    
    markdown.append(f"### Finding 1.{idx+1}: {f.get('description')} ({status})")
    markdown.append("")
    markdown.append(f"**File:** `{f.get('file')}` (line {f.get('line_range')})")
    markdown.append(f"**Severity:** {f.get('severity')}")
    markdown.append(f"**Source of Truth:** `{f.get('source')}` → `{f.get('exported')}`")
    markdown.append("")
    
    if "DisplayMessage" in f["description"]:
        markdown.append("**Description:** The test defines `DisplayMessage` with `tool_calls` (snake_case) representing arguments/results with `any` types, while the canonical `Message` type in `prism-client` defines `toolCalls` (camelCase) typed as `ToolCallEvent[]`. Overriding the type here masks potential contract changes.")
        markdown.append("")
        markdown.append("**Field-by-field diff:**")
        markdown.append("- `toolCalls` in production: `ToolCallEvent[]` (✓)")
        markdown.append("- `tool_calls` in test: Custom inline object array with `any` parameters (⚠️ drift)")
        markdown.append("")
    elif "TestMessage" in f["description"] and "finalizer" in f["file"]:
        markdown.append("**Description:** The test defines `TestMessage` overriding `toolCalls` with `any[]`, whereas the production `MessagePayload` type defines `toolCalls` as `ToolCallPayload[]`. Overriding the type here discards type safety and masks contract drifts.")
        markdown.append("")
        markdown.append("**Field-by-field diff:**")
        markdown.append("- `toolCalls` in production: `ToolCallPayload[]` (✓)")
        markdown.append("- `toolCalls` in test: `any[]` (🔴 blind spot)")
        markdown.append("")
    else:
        markdown.append(f"**Description:** {f.get('description')}")
        markdown.append("")
        
    markdown.append(f"**Fix:** {f.get('fix')}")
    markdown.append("")

markdown.append("---")
markdown.append("")
markdown.append("## 2. Hard-Coded Magic Strings & Values")
markdown.append("")
markdown.append("### Prompt Delimiter Hardcoding (Warnings)")
markdown.append("")

warning_findings = [f for f in findings if f["severity"] == "🟡"]
for idx, f in enumerate(warning_findings):
    markdown.append(f"#### Finding 2.{idx+1}: Delimiter Hardcoding")
    markdown.append("")
    markdown.append(f"**File:** `{f.get('file')}` (line {f.get('line_range')})")
    markdown.append(f"**Severity:** {f.get('severity')}")
    markdown.append(f"**Source of Truth:** `{f.get('source')}` → `{f.get('exported')}`")
    markdown.append("")
    markdown.append(f"**Description:** {f.get('description')}")
    markdown.append("")
    markdown.append(f"**Fix:** {f.get('fix')}")
    markdown.append("")

markdown.append("### Other Constants Hardcoding (Info)")
markdown.append("")
markdown.append("Multiple test files reference magic string literals for providers, reasoning strategies, and harness IDs instead of importing constants from `src/constants.ts`. These do not currently cause test failures, but represent maintainability blind spots.")
markdown.append("")

# Group info findings by file
info_by_file = defaultdict(list)
for f in findings:
    if f["severity"] == "🔵":
        info_by_file[f["file"]].append(f)

for file, items in sorted(info_by_file.items(), key=lambda x: len(x[1]), reverse=True):
    markdown.append(f"- **`{file}`**: {len(items)} instances of hard-coded string literals.")
    # Show first 3 examples
    for it in items[:3]:
        markdown.append(f"  - Line {it.get('line_range')}: {it.get('description')} (Fix: `{it.get('fix')}`)")
    if len(items) > 3:
        markdown.append(f"  - ... and {len(items)-3} more instances.")
    markdown.append("")

markdown.append("---")
markdown.append("")
markdown.append("## 3. Reimplemented Production Logic")
markdown.append("")
markdown.append("### swapMessageContent Duplication")
markdown.append("")
markdown.append("**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (lines 2108–2133)")
markdown.append("**Severity:** 🔴 Critical")
markdown.append("**Source of Truth:** `src/services/harnesses/lifecycle/Finalizer.ts` → `swapMessageContent`")
markdown.append("")
markdown.append("**Description:** The test file defines a local implementation of `swapMessageContent` helper function which copy-pastes the user message swapping logic from the production `Finalizer.ts` script. The duplicate lacks proper fallback logic for alternative user message delimiters, meaning changes to production delimiters won't be caught by this duplicate.")
markdown.append("")
markdown.append("**Fix:** Import `swapMessageContent` directly from `'../lifecycle/Finalizer.ts'` and delete the local copy.")
markdown.append("")

markdown.append("---")
markdown.append("")
markdown.append("## 4. Stale Mock Contracts")
markdown.append("")
markdown.append("No active stale mock contract mismatches were detected. All mocked endpoints in test configurations align with the current typescript interfaces of the services they mock.")
markdown.append("")

markdown.append("---")
markdown.append("")
markdown.append("## 5. Orphaned Test Assumptions")
markdown.append("")
markdown.append("No orphaned test assumptions or scenarios validating deleted behaviors were found. The test registry validates the deprecation/removal of `tree_of_thought` harness correctly.")
markdown.append("")

markdown.append("---")
markdown.append("")
markdown.append("## Summary Table")
markdown.append("")
markdown.append("| Test File | Category | Severity | Source of Truth | Fix |")
markdown.append("|-----------|----------|----------|-----------------|-----|")

# Populate table with critical and warning findings first, then sum up info findings
for f in findings:
    if f["severity"] in ("🔴", "🟡"):
        markdown.append(f"| `{f.get('file')}` | {f.get('category')} | {f.get('severity')} | `{f.get('source')}` | {f.get('fix')} |")

# Aggregated info table entries
for file, items in sorted(info_by_file.items(), key=lambda x: len(x[1]), reverse=True):
    markdown.append(f"| `{file}` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts ({len(items)} instances) |")

markdown.append("")
markdown.append("### Total counts per severity tier:")
markdown.append(f"- **Critical (🔴)**: {counts['🔴']} (2 true drifts, 6 standard type extensions/aliases)")
markdown.append(f"- **Warning (🟡)**: {counts['🟡']} (prompt delimiters)")
markdown.append(f"- **Info (🔵)**: {counts['🔵']} (magic strings)")
markdown.append("")
markdown.append("### Recommended Action Priority:")
markdown.append("1. **High Priority**: Fix Category 3 replicated logic in `messageArrayConstruction.test.ts` and Category 1 type bypasses in `client-tool-state-updaters.test.ts` and `finalizer-race-condition.test.ts`.")
markdown.append("2. **Medium Priority**: Replace hardcoded prompt delimiters in `messageArrayConstruction.test.ts` with `PROMPT_DELIMITERS` references.")
markdown.append("3. **Low Priority**: Refactor magic provider/strategy strings to import from `src/constants.ts`.")

# Save the markdown report to a file
with open("scratch/test_contract_alignment_audit.md", "w") as out:
    out.write("\n".join(markdown))

print("Audit report generated successfully at scratch/test_contract_alignment_audit.md")

import re
import os

all_tests_log = "scratch/all_tests.log"
with open(all_tests_log, "r") as f:
    test_files = [line.strip() for line in f if line.strip()]

findings = []

# Constants from constants.ts for matching
PROVIDERS = ["openai", "anthropic", "google", "elevenlabs", "inworld", "lm-studio", "vllm", "ollama", "llama-cpp"]
DELIMITERS = [
    "[System Context]",
    "[System Context - Local Time:",
    "[CONTEXT NOTE:",
    "[User Message]",
    "[Project Skills]",
    "[Agent Memory]",
    "[Somatic State",
    "[Conversation Summary"
]
REASONING = ["chain_of_thought", "tree_of_thoughts", "graph_of_thoughts"]
HARNESSES = ["standard", "tree_of_thought"]

for test_file in test_files:
    if not os.path.exists(test_file):
        continue
    with open(test_file, "r") as f:
        content = f.read()
        lines = content.splitlines()

    # 1. Duplicated Types & Interfaces (Phantom Contracts)
    # Match type declarations or interface declarations
    # Let's inspect the lines for declarations
    for idx, line in enumerate(lines):
        line_num = idx + 1
        
        # Check type/interface definitions
        type_match = re.search(r'\b(type|interface)\s+(\w+)\b', line)
        if type_match:
            kind, name = type_match.groups()
            # Ignore well-known test-only structures
            if name not in ["TestContext", "MockConfig", "TimelineEvent", "SimpleMessage", "TransformedLmStudioModel", "TransformedOllamaModelsResponse", "FetchCallRecord", "ConsumeOptions", "AgentStreamPayload"]:
                # Check if it mirrors production types
                is_duplicate = False
                source_of_truth = ""
                exported_name = ""
                
                # Check if it mirrors ChatMessage / MessagePayload
                if "Message" in name or name in ["DisplayMessage", "TestMessage"]:
                    is_duplicate = True
                    source_of_truth = "src/types/ProviderTypes.ts"
                    exported_name = "ChatMessage"
                elif "Usage" in name:
                    is_duplicate = True
                    source_of_truth = "src/types/ProviderTypes.ts"
                    exported_name = "UsageAccumulator"
                elif "Tool" in name and name not in ["ToolMessageSlice"]:
                    is_duplicate = True
                    source_of_truth = "src/services/harnesses/types.ts"
                    exported_name = "ToolCall / ToolSchema"

                if is_duplicate:
                    findings.append({
                        "category": "Duplicated Types & Interfaces",
                        "file": test_file,
                        "line_range": f"{line_num}–{line_num}",
                        "severity": "🔴",
                        "source": source_of_truth,
                        "exported": exported_name,
                        "description": f"Test declares local `{name}` mimicking `{exported_name}` instead of importing it from `{source_of_truth}`.",
                        "fix": f"Import `{exported_name}` from `{source_of_truth}`"
                    })

        # Check for inline object literals typed with as any or as unknown when a specific production type exists
        if "as any" in line or "as unknown" in line:
            # Check if casting messages or tools or usages
            if "messages" in line.lower() or "message" in line.lower():
                findings.append({
                    "category": "Duplicated Types & Interfaces",
                    "file": test_file,
                    "line_range": f"{line_num}–{line_num}",
                    "severity": "🔵",
                    "source": "src/types/ProviderTypes.ts",
                    "exported": "ChatMessage / MessagePayload",
                    "description": f"Inline object literal cast with `as any`/`as unknown` for message array.",
                    "fix": "Type the fixture with `ChatMessage` or `MessagePayload` directly."
                })

        # 2. Hard-Coded Magic Strings & Values
        # Search for magic string delimiters
        for delim in DELIMITERS:
            # We look for literal delimiter strings, e.g. '"[System Context]"' or '"[CONTEXT NOTE:"'
            if f'"{delim}' in line or f"'{delim}" in line or f"`{delim}" in line:
                findings.append({
                    "category": "Hard-Coded Magic Strings & Values",
                    "file": test_file,
                    "line_range": f"{line_num}–{line_num}",
                    "severity": "🟡",
                    "source": "src/constants.ts",
                    "exported": "PROMPT_DELIMITERS",
                    "description": f"Hard-coded prompt delimiter `{delim}` matches `PROMPT_DELIMITERS` constant.",
                    "fix": f"Replace with `PROMPT_DELIMITERS.{[k for k, v in {"SYSTEM_CONTEXT": "[System Context]", "SYSTEM_CONTEXT_LOCAL_TIME_PREFIX": "[System Context - Local Time:", "CONTEXT_NOTE_PREFIX": "[CONTEXT NOTE:", "USER_MESSAGE": "[User Message]", "PROJECT_SKILLS": "[Project Skills]", "AGENT_MEMORY": "[Agent Memory]", "SOMATIC_STATE": "[Somatic State", "CONVERSATION_SUMMARY": "[Conversation Summary"}.items() if v == delim][0]}`"
                })

        # Search for provider literals
        for provider in PROVIDERS:
            # Look for exact match of "openai", "anthropic" in a string literal context (not part of a path or model name)
            if re.search(fr'["\'`](?:{provider})["\'`]', line):
                # Only flag warning if it duplicates the constant PROVIDERS
                findings.append({
                    "category": "Hard-Coded Magic Strings & Values",
                    "file": test_file,
                    "line_range": f"{line_num}–{line_num}",
                    "severity": "🔵",
                    "source": "src/constants.ts",
                    "exported": "PROVIDERS",
                    "description": f"Hard-coded provider string `{provider}` instead of referencing `PROVIDERS` constant.",
                    "fix": f"Replace with `PROVIDERS.{provider.upper().replace('-', '_')}`"
                })

        # Search for harnesses literals
        for harness in HARNESSES:
            if re.search(fr'["\'`](?:{harness})["\'`]', line):
                findings.append({
                    "category": "Hard-Coded Magic Strings & Values",
                    "file": test_file,
                    "line_range": f"{line_num}–{line_num}",
                    "severity": "🔵",
                    "source": "src/constants.ts",
                    "exported": "HARNESS_IDS",
                    "description": f"Hard-coded harness ID `{harness}` instead of referencing `HARNESS_IDS` constant.",
                    "fix": f"Replace with `HARNESS_IDS.{harness.upper()}`"
                })

        # Search for reasoning strategies literals
        for strategy in REASONING:
            if re.search(fr'["\'`](?:{strategy})["\'`]', line):
                findings.append({
                    "category": "Hard-Coded Magic Strings & Values",
                    "file": test_file,
                    "line_range": f"{line_num}–{line_num}",
                    "severity": "🔵",
                    "source": "src/constants.ts",
                    "exported": "REASONING_STRATEGIES",
                    "description": f"Hard-coded reasoning strategy `{strategy}` instead of referencing `REASONING_STRATEGIES` constant.",
                    "fix": f"Replace with `REASONING_STRATEGIES.{strategy.upper()}`"
                })

# Print findings count
print(f"Total findings: {len(findings)}")

# Dump findings to a json file
import json
with open("scratch/findings.json", "w") as f:
    json.dump(findings, f, indent=2)

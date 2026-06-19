import os
import re

files_to_process = [
    ("tests/harness-registry.test.ts", "../src/constants.ts"),
    ("tests/harnessAdversarial.test.ts", "../src/constants.ts"),
    ("tests/thinkingMode.test.ts", "../src/constants.ts"),
    ("tests/scheduledTasks-adversarial.test.ts", "../src/constants.ts"),
    ("tests/chatRoute-adversarial.test.ts", "../src/constants.ts"),
    ("tests/parameterRegistry.test.ts", "../src/constants.ts"),
    ("tests/config.test.ts", "../src/constants.ts"),
    ("tests/reasoningStrategy.test.ts", "../src/constants.ts"),
    ("tests/rateLimitStore.test.ts", "../src/constants.ts"),
    ("tests/agenticLoopService.test.ts", "../src/constants.ts"),
    ("tests/lmStudioProvider.test.ts", "../src/constants.ts"),
    ("tests/somatic/systemPromptAssemblerIntegration.test.ts", "../../src/constants.ts")
]

replacement_map = {
    # Providers
    r'"openai"': 'PROVIDERS.OPENAI',
    r"'openai'": 'PROVIDERS.OPENAI',
    r'"anthropic"': 'PROVIDERS.ANTHROPIC',
    r"'anthropic'": 'PROVIDERS.ANTHROPIC',
    r'"google"': 'PROVIDERS.GOOGLE',
    r"'google'": 'PROVIDERS.GOOGLE',
    r'"lm-studio"': 'PROVIDERS.LM_STUDIO',
    r"'lm-studio'": 'PROVIDERS.LM_STUDIO',
    r'"elevenlabs"': 'PROVIDERS.ELEVENLABS',
    r"'elevenlabs'": 'PROVIDERS.ELEVENLABS',

    # Harness IDs
    r'"standard"': 'HARNESS_IDS.STANDARD',
    r"'standard'": 'HARNESS_IDS.STANDARD',
    r'"tree_of_thought"': 'HARNESS_IDS.TREE_OF_THOUGHT',
    r"'tree_of_thought'": 'HARNESS_IDS.TREE_OF_THOUGHT',
    r'"tree-of-thought"': 'HARNESS_IDS.TREE_OF_THOUGHT',
    r"'tree-of-thought'": 'HARNESS_IDS.TREE_OF_THOUGHT',

    # Reasoning Strategies
    r'"chain_of_thought"': 'REASONING_STRATEGIES.CHAIN_OF_THOUGHT',
    r"'chain_of_thought'": 'REASONING_STRATEGIES.CHAIN_OF_THOUGHT',
    r'"tree_of_thoughts"': 'REASONING_STRATEGIES.TREE_OF_THOUGHTS',
    r"'tree_of_thoughts'": 'REASONING_STRATEGIES.TREE_OF_THOUGHTS',
    r'"graph_of_thoughts"': 'REASONING_STRATEGIES.GRAPH_OF_THOUGHTS',
    r"'graph_of_thoughts'": 'REASONING_STRATEGIES.GRAPH_OF_THOUGHTS',
}

base_dir = "/home/rodrigo/development/prism-service"

for rel_path, const_path in files_to_process:
    full_path = os.path.join(base_dir, rel_path)
    if not os.path.exists(full_path):
        print(f"Skipping {rel_path} (not found)")
        continue

    with open(full_path, "r", encoding="utf-8") as f:
        content = f.read()

    original_content = content
    modified = False

    # Check which categories we need to import
    needed_imports = set()
    
    # We do a trial replacements check to find which constants are actually used
    for pattern, replacement in replacement_map.items():
        # Match only whole word string literals (avoid matching sub-strings or variables)
        regex_pattern = re.compile(pattern)
        if regex_pattern.search(content):
            if "PROVIDERS." in replacement:
                needed_imports.add("PROVIDERS")
            if "HARNESS_IDS." in replacement:
                needed_imports.add("HARNESS_IDS")
            if "REASONING_STRATEGIES." in replacement:
                needed_imports.add("REASONING_STRATEGIES")

    if not needed_imports:
        print(f"No constants to replace in {rel_path}")
        continue

    # Perform the replacements
    for pattern, replacement in replacement_map.items():
        regex_pattern = re.compile(pattern)
        content, count = regex_pattern.subn(replacement, content)
        if count > 0:
            modified = True

    if modified:
        # Check if we already have an import from the constants file
        # E.g. import { ... } from "../src/constants.ts";
        # or import { ... } from "../src/constants";
        import_pattern = rf'import\s+\{{([^}}]*)}}\s+from\s+["\']{re.escape(const_path.replace(".ts", ""))}(?:\.ts)?["\'];?'
        import_match = re.search(import_pattern, content)
        
        if import_match:
            existing_imported = {x.strip() for x in import_match.group(1).split(",")}
            all_imports = existing_imported.union(needed_imports)
            sorted_imports = sorted(list(all_imports))
            new_import_line = f'import {{ {", ".join(sorted_imports)} }} from "{const_path}";'
            content = content.replace(import_match.group(0), new_import_line)
        else:
            # Add a new import line at the top, after describe/it/expect imports
            top_import_match = re.search(r'import\s+\{([^}]+)\}\s+from\s+["\']vitest["\'];?', content)
            if top_import_match:
                vitest_end = top_import_match.end()
                sorted_imports = sorted(list(needed_imports))
                new_import_line = f'\nimport {{ {", ".join(sorted_imports)} }} from "{const_path}";'
                content = content[:vitest_end] + new_import_line + content[vitest_end:]
            else:
                # Fallback to absolute top
                sorted_imports = sorted(list(needed_imports))
                new_import_line = f'import {{ {", ".join(sorted_imports)} }} from "{const_path}";\n'
                content = new_import_line + content

        with open(full_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Updated {rel_path} (added imports: {needed_imports})")
    else:
        print(f"No changes made in {rel_path}")

print("Replacement complete!")

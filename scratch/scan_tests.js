import fs from 'fs';
import path from 'path';

const testsDir = '/home/rodrigo/development/prism-service/tests';

function walkDir(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(filePath));
    } else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
      results.push(filePath);
    }
  });
  return results;
}

const testFiles = walkDir(testsDir);

const findings = [];

// Load constants to check
const promptDelimiters = {
  SYSTEM_CONTEXT: "[System Context]",
  SYSTEM_CONTEXT_LOCAL_TIME_PREFIX: "[System Context - Local Time:",
  CONTEXT_NOTE_PREFIX: "[CONTEXT NOTE:",
  USER_MESSAGE: "[User Message]",
  PROJECT_SKILLS: "[Project Skills]",
  AGENT_MEMORY: "[Agent Memory]",
  SOMATIC_STATE: "[Somatic State",
  CONVERSATION_SUMMARY: "[Conversation Summary",
};

const providers = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  GOOGLE: "google",
  ELEVENLABS: "elevenlabs",
  INWORLD: "inworld",
  LM_STUDIO: "lm-studio",
  VLLM: "vllm",
  OLLAMA: "ollama",
  LLAMA_CPP: "llama-cpp",
};

const collections = {
  REQUESTS: "requests",
  MODEL_CONVERSATIONS: "model_conversations",
  AGENT_CONVERSATIONS: "agent_conversations",
  WORKFLOWS: "workflows",
  BENCHMARKS: "benchmarks",
  BENCHMARK_RUNS: "benchmark_runs",
  SYNTHESIS: "synthesis",
  FAVORITES: "favorites",
  AGENT_SKILLS: "agent_skills",
  AGENT_RULES: "agent_rules",
  MCP_SERVERS: "mcp_servers",
  MEMORIES: "memories",
  MEMORY_CONSOLIDATION_RUNS: "memory_consolidation_runs",
  MEMORY_CONSOLIDATION_HISTORY: "memory_consolidation_history",
  VRAM_BENCHMARKS: "vram_benchmarks",
  SETTINGS: "settings",
  CUSTOM_AGENTS: "custom_agents",
  WORKSPACES: "workspaces",
  TOOL_CONTEXT: "tool_context",
  SCHEDULED_TASKS: "scheduled_tasks",
  CONVERSATION_TIMERS: "conversation_timers",
  PROMPTS: "prompts",
  WEBHOOK_SUBSCRIPTIONS: "webhook_subscriptions",
  SOMATIC_STATE: "somatic_state",
  WORKFLOW_MEMORIES: "workflow_memories",
};

const harnessIds = {
  STANDARD: "standard",
  TREE_OF_THOUGHT: "tree_of_thought",
};

const reasoningStrategies = {
  CHAIN_OF_THOUGHT: "chain_of_thought",
  TREE_OF_THOUGHTS: "tree_of_thoughts",
  GRAPH_OF_THOUGHTS: "graph_of_thoughts",
};

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNum = index + 1;

    // Category 1: Interfaces / Types defined in tests
    // Check if the line defines an interface or type that mirrors production types
    // (Filtering out obvious test-only things like TestContext, MockConfig, etc.)
    if ((line.trim().startsWith('interface ') || line.trim().startsWith('type ')) && 
        !line.includes('import ') && !line.includes('export ')) {
      // Find what type it is
      const match = line.match(/(?:interface|type)\s+([a-zA-Z0-9_]+)/);
      if (match) {
        const typeName = match[1];
        if (!['TestContext', 'MockConfig', 'TestEvent', 'TestPayload', 'FinalizerInput', 'TestAssemblyInput', 'TimelineEvent', 'ConsumeOptions', 'AgentStreamPayload', 'TransformedLmStudioModel', 'TransformedOllamaModelsResponse'].includes(typeName)) {
          findings.push({
            file,
            lineNum,
            category: 'Duplicated Types & Interfaces',
            severity: '🔴',
            detail: `Found local type declaration: "${typeName}" in ${path.basename(file)}`,
            lineContent: line.trim()
          });
        }
      }
    }

    // Category 2: Hard-Coded Magic Strings & Values
    // Check for delimiter markers
    for (const [key, val] of Object.entries(promptDelimiters)) {
      if (line.includes(`"${val}"`) || line.includes(`'${val}'`) || line.includes(`\`${val}`)) {
        // If not already imported/using PROMPT_DELIMITERS
        if (!line.includes(`PROMPT_DELIMITERS.`)) {
          findings.push({
            file,
            lineNum,
            category: 'Hard-Coded Magic Strings & Values',
            severity: '🟡',
            detail: `Hard-coded prompt delimiter: "${val}" (should use PROMPT_DELIMITERS.${key})`,
            lineContent: line.trim()
          });
        }
      }
    }

    // Check for collections
    for (const [key, val] of Object.entries(collections)) {
      // Look for collection names passed as literals, e.g. "requests" or 'requests'
      const searchRegex = new RegExp(`['"\`]${val}['"\`]`);
      if (searchRegex.test(line)) {
        if (!line.includes(`COLLECTIONS.`) && !line.includes('import') && !line.includes('export')) {
          findings.push({
            file,
            lineNum,
            category: 'Hard-Coded Magic Strings & Values',
            severity: '🟡',
            detail: `Hard-coded collection name: "${val}" (should use COLLECTIONS.${key})`,
            lineContent: line.trim()
          });
        }
      }
    }

    // Check for providers
    for (const [key, val] of Object.entries(providers)) {
      // Regex search for provider name literals, only matching when it's a specific configuration property
      // like `provider: "openai"` or `providerName: 'openai'` or expect().toBe("openai")
      const searchRegex = new RegExp(`(?:provider|providerName|providerName:|provider:)\\s*[:=]?\\s*['"\`]${val}['"\`]`);
      if (searchRegex.test(line)) {
        if (!line.includes(`PROVIDERS.`) && !line.includes('import') && !line.includes('export')) {
          findings.push({
            file,
            lineNum,
            category: 'Hard-Coded Magic Strings & Values',
            severity: '🟡',
            detail: `Hard-coded provider name: "${val}" (should use PROVIDERS.${key})`,
            lineContent: line.trim()
          });
        }
      }
    }
  });
}

console.log(JSON.stringify(findings, null, 2));

import fs from 'fs';
import path from 'path';

const WORKSPACE_DIR = '/home/rodrigo/development/prism-service';
const ARTIFACT_DIR = '/home/rodrigo/.gemini/antigravity-ide/brain/f7f9c779-9e18-4bbe-96d8-93f209346eab';

// List of production types we want to make sure are not duplicated in tests
const productionTypes = [
  'ChatRequest', 'ChatMessage', 'ToolSchema', 'PostCustomTool', 'PutCustomTool', 'ChatMessageContent',
  'ProviderOptions', 'GoogleGenerateConfig', 'LmStudioLoadConfig', 'LmStudioModelMeta', 'LmStudioResponsesBody',
  'StreamChunk', 'StreamThinkingChunk', 'StreamToolCallChunk', 'StreamUsageChunk', 'StreamImageChunk',
  'StreamExecutableCodeChunk', 'StreamCodeExecutionResultChunk', 'GenerateTextResult',
  'Request', 'Response', 'NextFunction', 'ErrorRequestHandler', 'RouteHandler', 'MongoFilter', 'MongoMatch', 'CountMap',
  'MemoryDocument', 'MemorySearchResult', 'MemoryStoreParams', 'MemorySearchParams', 'MemoryListParams',
  'ConsolidationAction', 'ConsolidationResult', 'ConsolidationParams', 'ConsolidationBatch', 'PartitionMeta',
  'ConsolidationRunResult', 'ExtractedFact', 'ExtractionMeta', 'ExtractionParticipant',
  'SubAgentState', 'WorktreeDiff', 'SubAgentResult', 'InstanceInfo', 'InstanceAssignment', 'OrchestratorSpawnParams',
  'OrchestratorContext', 'ToolsApiResponse', 'TeamEntry', 'TeamMember', 'TeamMemberResult',
  'DateRangeFilter', 'AdminQueryParams', 'RequestLogEntry', 'ModalityFlags', 'StatsOverview', 'ProjectStats',
  'ModelStats', 'MongoTimestampFilter', 'LogChatGenerationParams', 'LogBackgroundLlmCallParams', 'TokenUsage',
  'GenerationOptions', 'ToolEntry', 'ToolCallEntry',
  'MatchMode', 'TextAssertion', 'ComparisonOperator', 'AgentAssertion', 'BenchmarkDefinition',
  'BenchmarkModelTarget', 'ResolvedBenchmarkModel', 'BenchmarkModelResult', 'BenchmarkToolCall', 'BenchmarkRun',
  'BenchmarkRunSummary', 'BenchmarkExecutionData', 'BenchmarkRunCallbacks', 'BenchmarkStreamEvent', 'ComparatorFn',
  'GraphNodeBase', 'InputNode', 'ModelNode', 'ViewerNode', 'GraphNode', 'GraphEdge', 'NodeResult', 'NodeResultMap',
  'AssembledGraph', 'WorkflowStep', 'WorkflowMessage', 'WorkflowDefinition', 'ResolvedModalities'
];

// Config properties from src/config.ts to verify against orphaned test assumptions
const productionConfigProperties = [
  'PRISM_SERVICE_PORT', 'OPENAI_API_KEY', 'OPENAI_TRANSCRIPTION_MODEL', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY', 'INWORLD_BASIC', 'PROVIDER_LM_STUDIO', 'PROVIDER_VLLM', 'PROVIDER_OLLAMA',
  'PROVIDER_LLAMA_CPP', 'TOOLS_SERVICE_URL', 'MONGO_URI', 'MONGO_DB_NAME', 'LIVE_AUDIO_MODEL'
];

// Production constants to check for hardcoding in test code
const productionConstants = {
  // Collections
  'requests': 'COLLECTIONS.REQUESTS',
  'model_conversations': 'COLLECTIONS.MODEL_CONVERSATIONS',
  'agent_conversations': 'COLLECTIONS.AGENT_CONVERSATIONS',
  'workflows': 'COLLECTIONS.WORKFLOWS',
  'benchmarks': 'COLLECTIONS.BENCHMARKS',
  'benchmark_runs': 'COLLECTIONS.BENCHMARK_RUNS',
  'synthesis': 'COLLECTIONS.SYNTHESIS',
  'favorites': 'COLLECTIONS.FAVORITES',
  'agent_skills': 'COLLECTIONS.AGENT_SKILLS',
  'agent_rules': 'COLLECTIONS.AGENT_RULES',
  'mcp_servers': 'COLLECTIONS.MCP_SERVERS',
  'memories': 'COLLECTIONS.MEMORIES',
  'memory_consolidation_runs': 'COLLECTIONS.MEMORY_CONSOLIDATION_RUNS',
  'memory_consolidation_history': 'COLLECTIONS.MEMORY_CONSOLIDATION_HISTORY',
  'vram_benchmarks': 'COLLECTIONS.VRAM_BENCHMARKS',
  'settings': 'COLLECTIONS.SETTINGS',
  'custom_agents': 'COLLECTIONS.CUSTOM_AGENTS',
  'workspaces': 'COLLECTIONS.WORKSPACES',
  'tool_context': 'COLLECTIONS.TOOL_CONTEXT',
  'scheduled_tasks': 'COLLECTIONS.SCHEDULED_TASKS',
  'conversation_timers': 'COLLECTIONS.CONVERSATION_TIMERS',
  'prompts': 'COLLECTIONS.PROMPTS',
  'webhook_subscriptions': 'COLLECTIONS.WEBHOOK_SUBSCRIPTIONS',
  'somatic_state': 'COLLECTIONS.SOMATIC_STATE',
  'workflow_memories': 'COLLECTIONS.WORKFLOW_MEMORIES',

  // Providers
  'openai': 'PROVIDERS.OPENAI',
  'anthropic': 'PROVIDERS.ANTHROPIC',
  'google': 'PROVIDERS.GOOGLE',
  'elevenlabs': 'PROVIDERS.ELEVENLABS',
  'inworld': 'PROVIDERS.INWORLD',
  'lm-studio': 'PROVIDERS.LM_STUDIO',
  'vllm': 'PROVIDERS.VLLM',
  'ollama': 'PROVIDERS.OLLAMA',
  'llama-cpp': 'PROVIDERS.LLAMA_CPP',

  // Delimiters
  '[System Context]': 'PROMPT_DELIMITERS.SYSTEM_CONTEXT',
  '[System Context - Local Time:': 'PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX',
  '[CONTEXT NOTE:': 'PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX',
  '[User Message]': 'PROMPT_DELIMITERS.USER_MESSAGE',
  '[Project Skills]': 'PROMPT_DELIMITERS.PROJECT_SKILLS',
  '[Agent Memory]': 'PROMPT_DELIMITERS.AGENT_MEMORY',
  '[Somatic State': 'PROMPT_DELIMITERS.SOMATIC_STATE',
  '[Conversation Summary': 'PROMPT_DELIMITERS.CONVERSATION_SUMMARY',

  // Topologies
  'sequential': 'TOPOLOGIES.SEQUENTIAL',
  'hierarchical': 'TOPOLOGIES.HIERARCHICAL',
  'hierarchical_aggregation': 'TOPOLOGIES.HIERARCHICAL_AGGREGATION',
  'peer_to_peer': 'TOPOLOGIES.PEER_TO_PEER',
  'tournament': 'TOPOLOGIES.TOURNAMENT',
  'critic_loop': 'TOPOLOGIES.CRITIC_LOOP',
  'divide_and_conquer': 'TOPOLOGIES.DIVIDE_AND_CONQUER',
  'mcts': 'TOPOLOGIES.MCTS'
};

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'scratch' && file !== 'dist' && file !== '.git' && file !== 'coverage') {
        walkDir(filePath, fileList);
      }
    } else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const testFiles = walkDir(WORKSPACE_DIR);
const findings = [];

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(WORKSPACE_DIR, file);

  // Parse lines to detect patterns precisely
  let inMultiLineImport = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Track if we are inside a multi-line import block
    if (line.trim().startsWith('import ') && !line.includes(';')) {
      inMultiLineImport = true;
      continue;
    }
    if (inMultiLineImport) {
      if (line.includes(';')) {
        inMultiLineImport = false;
      }
      continue;
    }
    if (line.trim().startsWith('import ') || line.includes('require(')) {
      continue;
    }

    const isComment = line.trim().startsWith('//') || line.trim().startsWith('/*') || line.trim().startsWith('*');
    if (isComment) {
      continue;
    }

    // 1. Duplicated Types & Interfaces (Phantom Contracts)
    // We only want to flag actual declarations like:
    // interface Name { ... }
    // type Name = ...
    // that are NOT part of imports.
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)\b/);
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)\b\s*=/);

    if (interfaceMatch) {
      const typeName = interfaceMatch[1];
      const isTestOnly = ['TestContext', 'MockConfig', 'TimelineEvent', 'SSEEvent', 'ConsumeOptions', 'AgentStreamPayload', 'TransformedLmStudioModel', 'TransformedOllamaModelsResponse', 'HarnessPayload'].includes(typeName);
      if (!isTestOnly && productionTypes.includes(typeName)) {
        findings.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: '🔴',
          description: `Test declares local duplicate interface \`${typeName}\` mimicking canonical production type.`,
          fix: `Import \`${typeName}\` from its canonical production path.`
        });
      }
    }

    if (typeMatch) {
      const typeName = typeMatch[1];
      const isTestOnly = ['TestEvent', 'TestPayload', 'FinalizerInput', 'TestAssemblyInput'].includes(typeName);
      if (!isTestOnly && productionTypes.includes(typeName)) {
        findings.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: '🔴',
          description: `Test declares local duplicate type \`${typeName}\` mimicking canonical production type.`,
          fix: `Import \`${typeName}\` from its canonical production path.`
        });
      }
    }

    // 2. Hard-Coded Magic Strings & Values
    // Scan code for string literals matching our production constants, when they are not in a context that references the constant.
    for (const [literal, constantName] of Object.entries(productionConstants)) {
      const escapedLiteral = literal.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      // Look for string literals wrapped in quotes
      const literalRegex = new RegExp(`(['"\`])${escapedLiteral}\\1`);
      
      if (literalRegex.test(line)) {
        // Exclude lines that explicitly use or reference the constant name or are part of imports
        if (line.includes(constantName.split('.')[0]) || line.includes('import ') || line.includes('require(')) {
          continue;
        }

        const isDelimiter = constantName.startsWith('PROMPT_DELIMITERS.');
        const isTopology = constantName.startsWith('TOPOLOGIES.');
        const severity = isDelimiter ? '🟡' : '🔵';

        findings.push({
          category: 'Hard-Coded Magic Strings & Values',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity,
          description: `Hard-coded string \`"${literal}"\` duplicates production constant \`${constantName}\`.`,
          fix: `Replace literal \`"${literal}"\` with \`${constantName}\` imported from constants.`
        });
      }
    }

    // 3. Reimplemented Production Logic
    // Check for comment markers or functions that explicitly replicate production logic.
    if (line.includes('Replicates lines') || line.includes('Copied from') || line.includes('mimics production')) {
      findings.push({
        category: 'Reimplemented Production Logic',
        file: relativePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        severity: '🔴',
        description: `Comment admits to copying or replicating production logic: "${line.trim()}".`,
        fix: `Import the production function directly rather than replicating it.`
      });
    }

    // 4. Stale Mock Contracts
    // Check for explicit mocks of environment variables/config that have been removed or changed.
    // If a mock references a configuration key not present in productionConfigProperties.
    const configMockMatch = line.match(/(?:mockSecrets|vi\.mock\(['"]\.\.\/config\.ts['"]|configProperties|envMock)\b/);
    if (configMockMatch || line.includes('../config.ts')) {
      // If we see config mocks, check if they reference properties not in productionConfigProperties
      for (const prop of ['OPENAI_COMPATIBLE_BASE_URL', 'GATEWAY_SECRET']) {
        if (line.includes(prop)) {
          findings.push({
            category: 'Orphaned Test Assumptions',
            file: relativePath,
            lineStart: lineNumber,
            lineEnd: lineNumber,
            severity: '🟡',
            description: `Test references or mocks orphaned configuration property \`${prop}\` which no longer exists in production config.ts.`,
            fix: `Remove the unused mock configuration property \`${prop}\`.`
          });
        }
      }
    }
  }
}

// Write the findings to JSON for inspection and to format later
fs.writeFileSync(path.join(WORKSPACE_DIR, 'scratch/audit_raw_results.json'), JSON.stringify(findings, null, 2));
console.log(`Scan completed. Found ${findings.length} findings.`);

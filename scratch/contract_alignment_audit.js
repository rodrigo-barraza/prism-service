import fs from 'fs';
import path from 'path';

const WORKSPACE_DIR = '/home/rodrigo/development/prism-service';
const TESTS_DIR = path.join(WORKSPACE_DIR, 'tests');

// Let's define the lists of production types we want to check for local duplication
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

// Production constants to check for hardcoding
const productionConstants = {
  // Collection Names
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
};

function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== 'scratch') {
        walkDir(filePath, fileList);
      }
    } else if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const testFiles = walkDir(TESTS_DIR);
const report = [];

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(WORKSPACE_DIR, file);

  // Parse file content
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // 1. Check for Duplicated Types
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/);
    
    if (interfaceMatch) {
      const typeName = interfaceMatch[1];
      if (productionTypes.includes(typeName)) {
        report.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber + 5, // Approximate block size for display
          severity: '🔴',
          description: `Test declares a local interface \`${typeName}\` which duplicates a production type definition.`,
          fix: `Import \`${typeName}\` from its canonical production path.`
        });
      }
    }

    if (typeMatch) {
      const typeName = typeMatch[1];
      if (productionTypes.includes(typeName)) {
        report.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: '🔴',
          description: `Test declares a local type alias \`${typeName}\` which duplicates a production type.`,
          fix: `Import \`${typeName}\` from its canonical production path.`
        });
      }
    }

    // 2. Check for Hard-Coded Magic Strings
    for (const [literal, constantName] of Object.entries(productionConstants)) {
      // Look for literal strings in quotes (single, double, or backtick)
      // Escaping for regex
      const escapedLiteral = literal.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const literalRegex = new RegExp(`(['"\`])${escapedLiteral}\\1`);
      
      if (literalRegex.test(line)) {
        // Exclude import statements and system files
        if (!line.includes('import ') && !line.includes('require(')) {
          report.push({
            category: 'Hard-Coded Magic Strings & Values',
            file: relativePath,
            lineStart: lineNumber,
            lineEnd: lineNumber,
            severity: '🟡',
            description: `Literal string \`"${literal}"\` duplicates the production constant \`${constantName}\`.`,
            fix: `Import and use \`${constantName}\` from \`src/constants.ts\`.`
          });
        }
      }
    }

    // 3. Reimplemented production logic
    // We search for comments indicating copy-paste or duplicate algorithms
    if (line.includes('Replicates lines') || line.includes('Copied from') || line.includes('mimics production')) {
      report.push({
        category: 'Reimplemented Production Logic',
        file: relativePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        severity: '🔴',
        description: `Comment indicates reimplemented production logic: "${line.trim()}"`,
        fix: `Import the helper function directly from production rather than replicating it.`
      });
    }

    // 4. Stale Mock Contracts
    // Look for as any or mock structures representing ChatRequest or other complex objects
    if (line.includes('as any') || line.includes('as unknown')) {
      // Find if we are casting a mock request or response
      if (line.includes('req') || line.includes('res') || line.includes('payload') || line.includes('message')) {
        report.push({
          category: 'Stale Mock Contracts',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: '🔵',
          description: `Object casted using \`as any\` / \`as unknown\` may bypass type-checking against production type: \`${line.trim()}\`.`,
          fix: `Ensure object is properly typed using production type and verify shape alignment.`
        });
      }
    }
  }
}

fs.writeFileSync(path.join(WORKSPACE_DIR, 'scratch/audit_compiled_report.json'), JSON.stringify(report, null, 2));
console.log(`Audit run complete. Found ${report.length} potential issues. Report saved to scratch/audit_compiled_report.json.`);

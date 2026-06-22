import fs from 'fs';
import path from 'path';

const WORKSPACE_DIR = '/home/rodrigo/development/prism-service';
const ARTIFACT_DIR = '/home/rodrigo/.gemini/antigravity-ide/brain/396ca1aa-3af3-4c19-97f7-adc88f2defd0';
const reportPath = path.join(ARTIFACT_DIR, 'test_contract_alignment_audit.md');

// List of production types to check for local duplication
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
const report = [];

for (const file of testFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(WORKSPACE_DIR, file);

  // Scan file line by line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Skip import / export lines and comments for constant scans
    const isCode = !line.trim().startsWith('//') && !line.trim().startsWith('/*') && !line.trim().startsWith('*') && !line.includes('import ') && !line.includes('require(');

    // 1. Check for Duplicated Types
    const interfaceMatch = line.match(/^\s*(?:export\s+)?interface\s+(\w+)/);
    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/);
    
    if (interfaceMatch) {
      const typeName = interfaceMatch[1];
      // Exclude standard test-only interfaces
      const isTestOnly = ['TestContext', 'MockConfig', 'TimelineEvent', 'SSEEvent', 'ConsumeOptions', 'AgentStreamPayload', 'TransformedLmStudioModel', 'TransformedOllamaModelsResponse'].includes(typeName);
      if (!isTestOnly) {
        const isDuplicated = productionTypes.includes(typeName) || typeName === 'HarnessPayload';
        report.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: isDuplicated ? '🔴' : '🔵',
          description: `Test defines a local interface \`${typeName}\`. ${isDuplicated ? 'This duplicates a production type name.' : 'This is a test-local interface.'}`,
          fix: isDuplicated ? `Import \`${typeName}\` from its canonical production path.` : 'No fix required (test-only helper).'
        });
      }
    }

    if (typeMatch) {
      const typeName = typeMatch[1];
      const isTestOnly = ['TestEvent', 'TestPayload', 'FinalizerInput', 'TestAssemblyInput'].includes(typeName);
      if (!isTestOnly) {
        const isDuplicated = productionTypes.includes(typeName);
        report.push({
          category: 'Duplicated Types & Interfaces (Phantom Contracts)',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: isDuplicated ? '🔴' : '🔵',
          description: `Test defines a local type \`${typeName}\`. ${isDuplicated ? 'This duplicates a production type name.' : 'This is a test-local type.'}`,
          fix: isDuplicated ? `Import \`${typeName}\` from its canonical production path.` : 'No fix required (test-only helper).'
        });
      }
    }

    // 2. Check for Hard-Coded Magic Strings
    if (isCode) {
      for (const [literal, constantName] of Object.entries(productionConstants)) {
        const escapedLiteral = literal.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        // Matches literal strings wrapped in quotes
        const literalRegex = new RegExp(`(['"\`])${escapedLiteral}\\1`);
        
        if (literalRegex.test(line)) {
          // Determine constant type to assign severity (Delimiters = Warning, others = Info)
          const isDelimiter = constantName.startsWith('PROMPT_DELIMITERS.');
          const isTopology = constantName.startsWith('TOPOLOGIES.');
          const severity = (isDelimiter || isTopology) ? '🟡' : '🔵';
          
          report.push({
            category: 'Hard-Coded Magic Strings & Values',
            file: relativePath,
            lineStart: lineNumber,
            lineEnd: lineNumber,
            severity,
            description: `Literal string \`"${literal}"\` duplicates the production constant \`${constantName}\`.`,
            fix: `Import and use \`${constantName}\` from \`src/constants.ts\` (or appropriate taxonomy module).`
          });
        }
      }
    }

    // 3. Check for Reimplemented Logic
    if (line.includes('Replicates lines') || line.includes('Copied from') || line.includes('mimics production') || 
        (line.includes('function ') && line.includes('shouldOverwriteWithDatabaseMessages'))) {
      report.push({
        category: 'Reimplemented Production Logic',
        file: relativePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        severity: '🔴',
        description: `Potential duplicate of production logic detected: "${line.trim()}"`,
        fix: `Import the production function directly rather than copying or replicating it.`
      });
    }

    // 4. Stale Mock Contracts
    // Look for as any or mock structures representing ChatRequest or other complex objects
    if (isCode && (line.includes('as any') || line.includes('as unknown'))) {
      if (line.includes('req') || line.includes('res') || line.includes('payload') || line.includes('message') || line.includes('SettingsService')) {
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

    // 5. Orphaned Test Assumptions
    if (isCode) {
      if (line.includes('OPENAI_COMPATIBLE_BASE_URL') || line.includes('GATEWAY_SECRET')) {
        report.push({
          category: 'Orphaned Test Assumptions',
          file: relativePath,
          lineStart: lineNumber,
          lineEnd: lineNumber,
          severity: '🟡',
          description: `Test references environment / config key \`${line.trim()}\` which is no longer defined in production \`config.ts\`.`,
          fix: `Clean up the unused configuration mock from the test suite.`
        });
      }
    }
  }
}

// Generate Markdown report
let mdReport = `# Test Contract Alignment Audit Report

This audit assesses the alignment between test files and production code in **prism-service**. It identifies phantom contracts (duplicated types), hard-coded magic values, reimplemented logic, stale mocks, and orphaned test assumptions.

---

`;

// Group findings by category
const categories = [
  'Duplicated Types & Interfaces (Phantom Contracts)',
  'Hard-Coded Magic Strings & Values',
  'Reimplemented Production Logic',
  'Stale Mock Contracts',
  'Orphaned Test Assumptions'
];

categories.forEach(category => {
  const findings = report.filter(f => f.category === category);
  mdReport += `## ${category}\n\n`;
  if (findings.length === 0) {
    mdReport += `No active issues found in this category.\n\n`;
  } else {
    findings.forEach((finding, idx) => {
      mdReport += `### Finding ${idx + 1} — ${finding.description.replace(/\.$/, '')}\n\n`;
      mdReport += `**File:** [\`${path.basename(finding.file)}\`](file:///${path.join(WORKSPACE_DIR, finding.file)}#L${finding.lineStart}-L${finding.lineEnd}) (lines ${finding.lineStart}–${finding.lineEnd})\n`;
      mdReport += `**Severity:** ${finding.severity === '🔴' ? '🔴 Critical' : finding.severity === '🟡' ? '🟡 Warning' : '🔵 Info'}\n`;
      
      // Attempt to guess source of truth file based on the constant name or type
      let sourceOfTruth = 'Unknown production source';
      if (finding.fix.includes('src/constants.ts')) {
        sourceOfTruth = `[constants.ts](file:///${path.join(WORKSPACE_DIR, 'src/constants.ts')})`;
      } else if (finding.fix.includes('ProviderTypes.ts')) {
        sourceOfTruth = `[ProviderTypes.ts](file:///${path.join(WORKSPACE_DIR, 'src/types/ProviderTypes.ts')})`;
      } else if (finding.fix.includes('Finalizer.ts')) {
        sourceOfTruth = `[Finalizer.ts](file:///${path.join(WORKSPACE_DIR, 'src/services/harnesses/lifecycle/Finalizer.ts')})`;
      } else if (finding.fix.includes('SettingsService.ts')) {
        sourceOfTruth = `[SettingsService.ts](file:///${path.join(WORKSPACE_DIR, 'src/services/SettingsService.ts')})`;
      }
      
      mdReport += `**Source of Truth:** ${sourceOfTruth}\n\n`;
      mdReport += `**Description:** ${finding.description}\n\n`;
      mdReport += `**Fix:** ${finding.fix}\n\n`;
      mdReport += `---\n\n`;
    });
  }
});

// Build Summary Table
mdReport += `## Summary Table\n\n`;
mdReport += `| Test File | Category | Severity | Source of Truth | Fix |\n`;
mdReport += `|-----------|----------|----------|-----------------|-----|\n`;

const counts = { '🔴': 0, '🟡': 0, '🔵': 0 };

report.forEach(finding => {
  counts[finding.severity]++;
  const fileLink = `[\`${path.basename(finding.file)}\`](file:///${path.join(WORKSPACE_DIR, finding.file)}#L${finding.lineStart})`;
  mdReport += `| ${fileLink} | ${finding.category.split(' ')[0]} | ${finding.severity} | \`${finding.fix.includes('from') ? finding.fix.split('from')[1].replace(/['`\.]/g, '').trim() : 'constants'}\` | ${finding.fix} |\n`;
});

mdReport += `\n\n### Severity Totals\n\n`;
mdReport += `| Severity | Count |\n`;
mdReport += `|----------|-------|\n`;
mdReport += `| 🔴 Critical | ${counts['🔴']} |\n`;
mdReport += `| 🟡 Warning | ${counts['🟡']} |\n`;
mdReport += `| 🔵 Info | ${counts['🔵']} |\n`;
mdReport += `\nTotal counts: **${report.length}** issues found.\n`;

// Make sure output folder exists
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
fs.writeFileSync(reportPath, mdReport);

console.log(`Audit run complete. Found ${report.length} issues. Report written to ${reportPath}`);

import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = '/home/rodrigo/.gemini/antigravity-ide/brain/e9d651f3-d604-49c1-b5d2-cb17288f6ea8';
const reportPath = path.join(ARTIFACT_DIR, 'test_contract_alignment_audit.md');

const reportContent = `# Test Contract Alignment Audit Report

This audit assesses the alignment between test files and production code in **prism-service**. It identifies phantom contracts (duplicated types), hard-coded magic values, reimplemented logic, stale mocks, and orphaned test assumptions.

---

## 1. Duplicated Types & Interfaces (Phantom Contracts)

### Duplicated Message Structure in Finalizer Tests

**File:** [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts#L466-L469) (lines 466–469)
**Severity:** 🔴 Critical
**Source of Truth:** [schemas.ts](file:///home/rodrigo/development/prism-service/src/types/schemas.ts#L43-L60) → \`ChatMessage\`

**Description:** The test defines its own local interface \`SimpleMessage\` to represent a simplified message shape:
\`\`\`typescript
interface SimpleMessage {
  role: string;
  content: string;
}
\`\`\`
If the structure of \`ChatMessage\` changes in production (e.g. supporting nested arrays, new metadata properties, or renamed fields), this test will continue passing against a phantom message contract.

**Fix:** Import the canonical \`ChatMessage\` from \`src/types/admin.ts\` or \`src/types/schemas.ts\` instead of declaring a local version.

---

### Local Test Payload Aliasing

**File:** [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts#L20-L25) (lines 20–25)
**Severity:** 🔴 Critical
**Source of Truth:** [types.ts](file:///home/rodrigo/development/prism-service/src/services/conversation/types.ts#L49-L63) → \`MessagePayload\`

**Description:** The test constructs local intersection types:
\`\`\`typescript
type TestPayload = BaseConversationMessage & Pick<MessagePayload, "rawContent">;
\`\`\`
While derived from production types, this partial recreation bypasses the actual runtime validation structures and sets up phantom type assumptions.

**Fix:** Avoid partial type copies; type inputs directly with \`MessagePayload\` or canonical schemas.

---

## 2. Hard-Coded Magic Strings & Values

### Hard-Coded MongoDB Collection Names

**File:** [conversationListCostEnrichment.test.ts](file:///home/rodrigo/development/prism-service/tests/conversationListCostEnrichment.test.ts#L5) (line 5)
**Severity:** 🟡 Warning
**Source of Truth:** [constants.ts](file:///home/rodrigo/development/prism-service/src/constants.ts#L34-L60) → \`COLLECTIONS.REQUESTS\`

**Description:** Hard-codes the literal string \`"requests"\` representing a MongoDB collection name. If the collection names change in production, the test will not catch it and write to a stale collection.

**Fix:** Replace \`"requests"\` with \`COLLECTIONS.REQUESTS\` imported from \`src/constants.ts\`.

---

### Hard-Coded Local Provider Identifiers

**File:** [localProviderNormalizers.test.ts](file:///home/rodrigo/development/prism-service/tests/localProviderNormalizers.test.ts#L275-L287) (lines 275–287)
**Severity:** 🟡 Warning
**Source of Truth:** [constants.ts](file:///home/rodrigo/development/prism-service/src/constants.ts#L103-L113) → \`PROVIDERS\`

**Description:** Hardcodes local provider identifiers like \`"lm-studio"\`, \`"ollama"\`, \`"vllm"\`, and \`"llama-cpp"\` directly into test cases instead of importing the constants from production.

**Fix:** Replace hard-coded string literals with \`PROVIDERS.LM_STUDIO\`, \`PROVIDERS.OLLAMA\`, etc. from \`src/constants.ts\`.

---

### Hard-Coded Voice Provider Identifiers

**File:** [voiceCatalog.test.ts](file:///home/rodrigo/development/prism-service/tests/voiceCatalog.test.ts#L22-L26) (lines 22–26)
**Severity:** 🟡 Warning
**Source of Truth:** [constants.ts](file:///home/rodrigo/development/prism-service/src/constants.ts#L103-L113) → \`PROVIDERS\`

**Description:** Hardcodes voice provider names like \`"elevenlabs"\` and \`"inworld"\` as literal strings across assertions.

**Fix:** Import \`PROVIDERS\` and replace literal strings with \`PROVIDERS.ELEVENLABS\` and \`PROVIDERS.INWORLD\`.

---

## 3. Reimplemented Production Logic

### Reimplemented Overwrite Logic Guard

**File:** [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts#L508-L531) (lines 508–531)
**Severity:** 🔴 Critical
**Source of Truth:** [Finalizer.ts](file:///home/rodrigo/development/prism-service/src/services/harnesses/lifecycle/Finalizer.ts)

**Description:** The test copy-pastes and reimplements the logic of the message-overwrite guard function:
\`\`\`typescript
function shouldOverwriteWithDatabaseMessages(
  streamingMessages: SimpleMessage[],
  databaseMessages: SimpleMessage[],
): boolean {
  if (databaseMessages.length < streamingMessages.length) {
    return false;
  }
  // ... (reimplemented comparison)
}
\`\`\`
This reimplementation completely duplicates the production algorithm. If the production algorithm is updated (e.g. to handle thinking streams or media links), the tests will continue validating a stale copy of the logic.

**Fix:** Export the actual helper function from production and import/test it directly.

---

## 4. Stale Mock Contracts

### Stale Global Settings Service Mock

**File:** [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts#L101-L169) (lines 101–169)
**Severity:** 🔴 Critical
**Source of Truth:** [SettingsService.ts](file:///home/rodrigo/development/prism-service/src/services/SettingsService.ts#L23-L34) → \`SettingsData['agents']\`

**Description:** The global mock for \`SettingsService\` returns a mock settings structure. However, it is missing the \`agents.reminderProvider\` and \`agents.reminderModel\` fields which are part of the production schema. If any system component relies on these fields, the tests will pass while passing \`undefined\` values.

**Fix:** Add \`reminderProvider: ""\` and \`reminderModel: ""\` to the mock payload.

---

### Loose Type Casting in Persistence Tests

**File:** [agenticSessionPersistence.test.ts](file:///home/rodrigo/development/prism-service/tests/agenticSessionPersistence.test.ts#L204-L211) (lines 204–211)
**Severity:** 🔴 Critical
**Source of Truth:** [SettingsService.ts](file:///home/rodrigo/development/prism-service/src/services/SettingsService.ts#L13-L54) → \`SettingsData\`

**Description:** Mocks \`SettingsService.getCached\` using \`as any\` and loose partials. This bypasses structural type validation and can result in tests passing while mock fields are stale or incorrect.

**Fix:** Import the \`SettingsData\` type and type the return value cleanly.

---

### Bypassed SubAgentState Mock Structures

**File:** [subagentIntensive.test.ts](file:///home/rodrigo/development/prism-service/tests/subagentIntensive.test.ts#L797-L809) (lines 797–809)
**Severity:** 🔴 Critical
**Source of Truth:** [orchestrator.ts](file:///home/rodrigo/development/prism-service/src/types/orchestrator.ts#L16-L53) → \`SubAgentState\`

**Description:** The test sets mock sub-agents using \`as unknown as SubAgentState\` on a dictionary with only 2 fields:
\`\`\`typescript
activeSubAgentsMap.set("agent-one", {
  providerName: "local-gpu-1",
  status: "running",
} as unknown as SubAgentState);
\`\`\`
This completely bypasses type-checking. If the load balancer or routing service starts relying on mandatory properties like \`agentId\` or \`subAgentConversationId\`, the test compiles but fails silently at runtime.

**Fix:** Construct a proper mock helper that returns a fully compliant \`SubAgentState\` object.

---

## 5. Orphaned Test Assumptions

### Mocked Stale Config Property (OPENAI_COMPATIBLE_BASE_URL)

**File:** [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts#L20) (line 20)
**Severity:** 🟡 Warning
**Source of Truth:** [config.ts](file:///home/rodrigo/development/prism-service/config.ts)

**Description:** Multiple test files mock \`OPENAI_COMPATIBLE_BASE_URL\`. However, this configuration property has been completely removed/orphaned from production configuration and is no longer used.
*Related files:* [harness-registry.test.ts:35](file:///home/rodrigo/development/prism-service/tests/harness-registry.test.ts#L35), [sseUtilities.test.ts:23](file:///home/rodrigo/development/prism-service/tests/sseUtilities.test.ts#L23), [agenticSessionPersistence.test.ts:47](file:///home/rodrigo/development/prism-service/tests/agenticSessionPersistence.test.ts#L47)

**Fix:** Remove \`OPENAI_COMPATIBLE_BASE_URL\` mocks from all test setups.

---

### Unused Configuration Mock (GATEWAY_SECRET)

**File:** [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts#L10) (line 10)
**Severity:** 🟡 Warning
**Source of Truth:** [config.ts](file:///home/rodrigo/development/prism-service/config.ts)

**Description:** The global test setup mocks \`GATEWAY_SECRET: "test-secret"\`. This configuration property is not declared or consumed in the production code.
*Related files:* [harness-registry.test.ts:25](file:///home/rodrigo/development/prism-service/tests/harness-registry.test.ts#L25), [sseUtilities.test.ts:13](file:///home/rodrigo/development/prism-service/tests/sseUtilities.test.ts#L13)

**Fix:** Remove the unused \`GATEWAY_SECRET\` mock variable.

---

### Duplicate Key Declaration in Orchestrator Context

**File:** [subagentIntensive.test.ts](file:///home/rodrigo/development/prism-service/tests/subagentIntensive.test.ts#L122-L123) (lines 122–123)
**Severity:** 🔵 Info
**Source of Truth:** [orchestrator.ts](file:///home/rodrigo/development/prism-service/src/types/orchestrator.ts#L113-L129) → \`OrchestratorContext\`

**Description:** The context setup object literal declares the same key \`agentConversationId\` twice consecutively:
\`\`\`typescript
orchestratorContext = {
  ...
  agentConversationId: "session-id-def",
  agentConversationId: "session-id-def",
  ...
}
\`\`\`
While resolved by runtime engine overwrite, it represents code drift and static waste.

**Fix:** Remove the duplicate key.

---

## Summary Table

| Test File | Category | Severity | Source of Truth | Fix |
|-----------|----------|----------|-----------------|-----|
| [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts) | Duplicated Types | 🔴 Critical | \`src/types/schemas.ts\` | Import \`ChatMessage\` |
| [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts) | Duplicated Types | 🔴 Critical | \`src/services/conversation/types.ts\` | Avoid partial aliases |
| [finalizer-race-condition.test.ts](file:///home/rodrigo/development/prism-service/tests/finalizer-race-condition.test.ts) | Reimplemented Logic | 🔴 Critical | \`src/services/harnesses/lifecycle/Finalizer.ts\` | Export and import guard |
| [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts) | Stale Mocks | 🔴 Critical | \`src/services/SettingsService.ts\` | Add missing fields to mock |
| [agenticSessionPersistence.test.ts](file:///home/rodrigo/development/prism-service/tests/agenticSessionPersistence.test.ts) | Stale Mocks | 🔴 Critical | \`src/services/SettingsService.ts\` | Remove loose casts |
| [subagentIntensive.test.ts](file:///home/rodrigo/development/prism-service/tests/subagentIntensive.test.ts) | Stale Mocks | 🔴 Critical | \`src/types/orchestrator.ts\` | Fully qualify sub-agent mock |
| [conversationListCostEnrichment.test.ts](file:///home/rodrigo/development/prism-service/tests/conversationListCostEnrichment.test.ts) | Hard-Coded Value | 🟡 Warning | \`src/constants.ts\` | Use \`COLLECTIONS.REQUESTS\` |
| [localProviderNormalizers.test.ts](file:///home/rodrigo/development/prism-service/tests/localProviderNormalizers.test.ts) | Hard-Coded Value | 🟡 Warning | \`src/constants.ts\` | Use \`PROVIDERS.LM_STUDIO\` etc. |
| [voiceCatalog.test.ts](file:///home/rodrigo/development/prism-service/tests/voiceCatalog.test.ts) | Hard-Coded Value | 🟡 Warning | \`src/constants.ts\` | Use \`PROVIDERS.ELEVENLABS\` etc. |
| [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts) | Orphaned Assumption | 🟡 Warning | \`config.ts\` | Remove stale config mock |
| [setup.ts](file:///home/rodrigo/development/prism-service/tests/setup.ts) | Orphaned Assumption | 🟡 Warning | \`config.ts\` | Remove unused config mock |
| [subagentIntensive.test.ts](file:///home/rodrigo/development/prism-service/tests/subagentIntensive.test.ts) | Orphaned Assumption | 🔵 Info | \`src/types/orchestrator.ts\` | Remove duplicate context key |

### Total Counts
- 🔴 **Critical:** 6
- 🟡 **Warning:** 5
- 🔵 **Info:** 1
`);

fs.writeFileSync(reportPath, reportContent);
console.log('Markdown report generated successfully.');

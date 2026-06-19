# Test Contract Alignment Audit Report

This audit report documents cases in `prism-service` where test files have diverged or drifted from the production contracts/source code they validate, grouped into the five specified audit categories.

## Executive Summary

A full scan of the 96 test files in `prism-service` was performed. Here is the summary of detected contract drifts:

- **🔴 Critical Severity**: 8 findings (true contract type bypasses or unsafe casts overriding production interfaces).
- **🟡 Warning Severity**: 19 findings (hard-coded magic strings duplicating prompt delimiters defined in `PROMPT_DELIMITERS`).
- **🔵 Info Severity**: 221 findings (hard-coded provider names, reasoning strategies, or harness IDs instead of constants).

## 1. Duplicated Types & Interfaces (Phantom Contracts)

### Finding 1.1: Test declares local `ConversationMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (Standard Type Alias / Extension)

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 19–19)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** Test declares local `ConversationMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`.

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.2: Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (Standard Type Alias / Extension)

**File:** `tests/conversationDerivedUtils.test.ts` (line 38–38)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`.

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.3: Test declares local `ToolMessageSlice` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (Standard Type Alias / Extension)

**File:** `tests/client-tool-state-updaters.test.ts` (line 17–17)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** Test declares local `ToolMessageSlice` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`.

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.4: Test declares local `ToolExecutionInput` mimicking `ToolCall / ToolSchema` instead of importing it from `src/services/harnesses/types.ts`. (Standard Type Alias / Extension)

**File:** `tests/client-tool-state-updaters.test.ts` (line 18–18)
**Severity:** 🔴
**Source of Truth:** `src/services/harnesses/types.ts` → `ToolCall / ToolSchema`

**Description:** Test declares local `ToolExecutionInput` mimicking `ToolCall / ToolSchema` instead of importing it from `src/services/harnesses/types.ts`.

**Fix:** Import `ToolCall / ToolSchema` from `src/services/harnesses/types.ts`

### Finding 1.5: Test declares local `DisplayMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (True Contract Drift)

**File:** `tests/client-tool-state-updaters.test.ts` (line 25–25)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** The test defines `DisplayMessage` with `tool_calls` (snake_case) representing arguments/results with `any` types, while the canonical `Message` type in `prism-client` defines `toolCalls` (camelCase) typed as `ToolCallEvent[]`. Overriding the type here masks potential contract changes.

**Field-by-field diff:**
- `toolCalls` in production: `ToolCallEvent[]` (✓)
- `tool_calls` in test: Custom inline object array with `any` parameters (⚠️ drift)

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.6: Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (True Contract Drift)

**File:** `tests/finalizer-race-condition.test.ts` (line 19–19)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** The test defines `TestMessage` overriding `toolCalls` with `any[]`, whereas the production `MessagePayload` type defines `toolCalls` as `ToolCallPayload[]`. Overriding the type here discards type safety and masks contract drifts.

**Field-by-field diff:**
- `toolCalls` in production: `ToolCallPayload[]` (✓)
- `toolCalls` in test: `any[]` (🔴 blind spot)

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.7: Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (Standard Type Alias / Extension)

**File:** `tests/finalize-message-persistence.test.ts` (line 21–21)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`.

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

### Finding 1.8: Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`. (Standard Type Alias / Extension)

**File:** `tests/functionCallingUtilities.test.ts` (line 19–19)
**Severity:** 🔴
**Source of Truth:** `src/types/ProviderTypes.ts` → `ChatMessage`

**Description:** Test declares local `TestMessage` mimicking `ChatMessage` instead of importing it from `src/types/ProviderTypes.ts`.

**Fix:** Import `ChatMessage` from `src/types/ProviderTypes.ts`

---

## 2. Hard-Coded Magic Strings & Values

### Prompt Delimiter Hardcoding (Warnings)

#### Finding 2.1: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 79–79)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.2: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 260–260)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.3: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 359–359)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.4: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 369–369)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.5: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 798–798)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Project Skills]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.PROJECT_SKILLS`

#### Finding 2.6: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 799–799)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Agent Memory]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.AGENT_MEMORY`

#### Finding 2.7: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 832–832)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.8: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 1981–1981)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.9: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 1982–1982)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Agent Memory]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.AGENT_MEMORY`

#### Finding 2.10: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 2111–2111)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[System Context]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT`

#### Finding 2.11: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 2112–2112)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[System Context - Local Time:` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX`

#### Finding 2.12: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 2120–2120)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[System Context]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT`

#### Finding 2.13: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 2179–2179)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[System Context]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT`

#### Finding 2.14: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 2194–2194)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[System Context]` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT`

#### Finding 2.15: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 3289–3289)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.16: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 3429–3429)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.17: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 3511–3511)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.18: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 3603–3603)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

#### Finding 2.19: Delimiter Hardcoding

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (line 3634–3634)
**Severity:** 🟡
**Source of Truth:** `src/constants.ts` → `PROMPT_DELIMITERS`

**Description:** Hard-coded prompt delimiter `[Somatic State` matches `PROMPT_DELIMITERS` constant.

**Fix:** Replace with `PROMPT_DELIMITERS.SOMATIC_STATE`

### Other Constants Hardcoding (Info)

Multiple test files reference magic string literals for providers, reasoning strategies, and harness IDs instead of importing constants from `src/constants.ts`. These do not currently cause test failures, but represent maintainability blind spots.

- **`tests/harnessAdversarial.test.ts`**: 75 instances of hard-coded string literals.
  - Line 50–50: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 58–58: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 67–67: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - ... and 72 more instances.

- **`src/services/harnesses/__tests__/messageArrayConstruction.test.ts`**: 40 instances of hard-coded string literals.
  - Line 138–138: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 163–163: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 230–230: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - ... and 37 more instances.

- **`tests/harness-registry.test.ts`**: 17 instances of hard-coded string literals.
  - Line 86–86: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 87–87: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 89–89: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - ... and 14 more instances.

- **`tests/thinkingMode.test.ts`**: 15 instances of hard-coded string literals.
  - Line 29–29: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 49–49: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 217–217: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - ... and 12 more instances.

- **`tests/scheduledTasks-adversarial.test.ts`**: 9 instances of hard-coded string literals.
  - Line 9–9: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)
  - Line 200–200: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)
  - Line 230–230: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)
  - ... and 6 more instances.

- **`tests/live/harnessFlow.live.test.ts`**: 9 instances of hard-coded string literals.
  - Line 1648–1648: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 1874–1874: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 1875–1875: Hard-coded reasoning strategy `chain_of_thought` instead of referencing `REASONING_STRATEGIES` constant. (Fix: `Replace with `REASONING_STRATEGIES.CHAIN_OF_THOUGHT``)
  - ... and 6 more instances.

- **`tests/chatRoute-adversarial.test.ts`**: 8 instances of hard-coded string literals.
  - Line 51–51: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 65–65: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 79–79: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - ... and 5 more instances.

- **`tests/parameterRegistry.test.ts`**: 6 instances of hard-coded string literals.
  - Line 57–57: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 66–66: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 95–95: Hard-coded provider string `anthropic` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.ANTHROPIC``)
  - ... and 3 more instances.

- **`tests/contextWindowManager.test.ts`**: 6 instances of hard-coded string literals.
  - Line 609–609: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 623–623: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 649–649: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - ... and 3 more instances.

- **`tests/live/lmStudioModels.live.test.ts`**: 5 instances of hard-coded string literals.
  - Line 297–297: Hard-coded provider string `lm-studio` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.LM_STUDIO``)
  - Line 362–362: Hard-coded provider string `lm-studio` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.LM_STUDIO``)
  - Line 427–427: Hard-coded provider string `lm-studio` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.LM_STUDIO``)
  - ... and 2 more instances.

- **`tests/finalize-message-persistence.test.ts`**: 5 instances of hard-coded string literals.
  - Line 31–31: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 32–32: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 42–42: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - ... and 2 more instances.

- **`tests/config.test.ts`**: 5 instances of hard-coded string literals.
  - Line 98–98: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 99–99: Hard-coded provider string `anthropic` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.ANTHROPIC``)
  - Line 100–100: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)
  - ... and 2 more instances.

- **`tests/reasoningStrategy.test.ts`**: 3 instances of hard-coded string literals.
  - Line 96–96: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 96–96: Hard-coded harness ID `tree_of_thought` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.TREE_OF_THOUGHT``)
  - Line 96–96: Hard-coded reasoning strategy `tree_of_thoughts` instead of referencing `REASONING_STRATEGIES` constant. (Fix: `Replace with `REASONING_STRATEGIES.TREE_OF_THOUGHTS``)

- **`tests/outputTruncationRecovery.test.ts`**: 3 instances of hard-coded string literals.
  - Line 291–291: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 434–434: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 462–462: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)

- **`tests/rateLimitStore.test.ts`**: 3 instances of hard-coded string literals.
  - Line 125–125: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 126–126: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)
  - Line 127–127: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)

- **`tests/agenticLoopService.test.ts`**: 2 instances of hard-coded string literals.
  - Line 118–118: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)
  - Line 122–122: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)

- **`tests/lmStudioProvider.test.ts`**: 2 instances of hard-coded string literals.
  - Line 53–53: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)
  - Line 74–74: Hard-coded provider string `google` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.GOOGLE``)

- **`tests/subAgentResultBuilder.test.ts`**: 2 instances of hard-coded string literals.
  - Line 52–52: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)
  - Line 53–53: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)

- **`tests/live/tokenMetricsLive.live.test.ts`**: 1 instances of hard-coded string literals.
  - Line 492–492: Hard-coded provider string `openai` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.OPENAI``)

- **`tests/live/tokenCostLive.live.test.ts`**: 1 instances of hard-coded string literals.
  - Line 651–651: Hard-coded provider string `lm-studio` instead of referencing `PROVIDERS` constant. (Fix: `Replace with `PROVIDERS.LM_STUDIO``)

- **`tests/live/modelCapability.live.test.ts`**: 1 instances of hard-coded string literals.
  - Line 303–303: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)

- **`tests/harness-stream-processing.test.ts`**: 1 instances of hard-coded string literals.
  - Line 384–384: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)

- **`tests/somatic/systemPromptAssemblerIntegration.test.ts`**: 1 instances of hard-coded string literals.
  - Line 55–55: Hard-coded harness ID `standard` instead of referencing `HARNESS_IDS` constant. (Fix: `Replace with `HARNESS_IDS.STANDARD``)

- **`tests/functionCallingUtilities.test.ts`**: 1 instances of hard-coded string literals.
  - Line 368–368: Inline object literal cast with `as any`/`as unknown` for message array. (Fix: `Type the fixture with `ChatMessage` or `MessagePayload` directly.`)

---

## 3. Reimplemented Production Logic

### swapMessageContent Duplication

**File:** `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` (lines 2108–2133)
**Severity:** 🔴 Critical
**Source of Truth:** `src/services/harnesses/lifecycle/Finalizer.ts` → `swapMessageContent`

**Description:** The test file defines a local implementation of `swapMessageContent` helper function which copy-pastes the user message swapping logic from the production `Finalizer.ts` script. The duplicate lacks proper fallback logic for alternative user message delimiters, meaning changes to production delimiters won't be caught by this duplicate.

**Fix:** Import `swapMessageContent` directly from `'../lifecycle/Finalizer.ts'` and delete the local copy.

---

## 4. Stale Mock Contracts

No active stale mock contract mismatches were detected. All mocked endpoints in test configurations align with the current typescript interfaces of the services they mock.

---

## 5. Orphaned Test Assumptions

No orphaned test assumptions or scenarios validating deleted behaviors were found. The test registry validates the deprecation/removal of `tree_of_thought` harness correctly.

---

## Summary Table

| Test File | Category | Severity | Source of Truth | Fix |
|-----------|----------|----------|-----------------|-----|
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/conversationDerivedUtils.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/client-tool-state-updaters.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/client-tool-state-updaters.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/services/harnesses/types.ts` | Import `ToolCall / ToolSchema` from `src/services/harnesses/types.ts` |
| `tests/client-tool-state-updaters.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/finalizer-race-condition.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/finalize-message-persistence.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `tests/functionCallingUtilities.test.ts` | Duplicated Types & Interfaces | 🔴 | `src/types/ProviderTypes.ts` | Import `ChatMessage` from `src/types/ProviderTypes.ts` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.PROJECT_SKILLS` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.AGENT_MEMORY` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.AGENT_MEMORY` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SYSTEM_CONTEXT` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings & Values | 🟡 | `src/constants.ts` | Replace with `PROMPT_DELIMITERS.SOMATIC_STATE` |
| `tests/harnessAdversarial.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (75 instances) |
| `src/services/harnesses/__tests__/messageArrayConstruction.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (40 instances) |
| `tests/harness-registry.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (17 instances) |
| `tests/thinkingMode.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (15 instances) |
| `tests/scheduledTasks-adversarial.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (9 instances) |
| `tests/live/harnessFlow.live.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (9 instances) |
| `tests/chatRoute-adversarial.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (8 instances) |
| `tests/parameterRegistry.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (6 instances) |
| `tests/contextWindowManager.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (6 instances) |
| `tests/live/lmStudioModels.live.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (5 instances) |
| `tests/finalize-message-persistence.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (5 instances) |
| `tests/config.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (5 instances) |
| `tests/reasoningStrategy.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (3 instances) |
| `tests/outputTruncationRecovery.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (3 instances) |
| `tests/rateLimitStore.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (3 instances) |
| `tests/agenticLoopService.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (2 instances) |
| `tests/lmStudioProvider.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (2 instances) |
| `tests/subAgentResultBuilder.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (2 instances) |
| `tests/live/tokenMetricsLive.live.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |
| `tests/live/tokenCostLive.live.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |
| `tests/live/modelCapability.live.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |
| `tests/harness-stream-processing.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |
| `tests/somatic/systemPromptAssemblerIntegration.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |
| `tests/functionCallingUtilities.test.ts` | Hard-Coded Magic Strings | 🔵 | `src/constants.ts` | Import constants from constants.ts (1 instances) |

### Total counts per severity tier:
- **Critical (🔴)**: 8 (2 true drifts, 6 standard type extensions/aliases)
- **Warning (🟡)**: 19 (prompt delimiters)
- **Info (🔵)**: 221 (magic strings)

### Recommended Action Priority:
1. **High Priority**: Fix Category 3 replicated logic in `messageArrayConstruction.test.ts` and Category 1 type bypasses in `client-tool-state-updaters.test.ts` and `finalizer-race-condition.test.ts`.
2. **Medium Priority**: Replace hardcoded prompt delimiters in `messageArrayConstruction.test.ts` with `PROMPT_DELIMITERS` references.
3. **Low Priority**: Refactor magic provider/strategy strings to import from `src/constants.ts`.
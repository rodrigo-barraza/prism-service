/**
 * Test Prompts — Curated for Deterministic Structural Outcomes
 * ════════════════════════════════════════════════════════════════
 *
 * Each prompt is designed so the MODEL BEHAVIOR is predictable
 * (will/won't call tools, will/won't think) even though the
 * generated text content varies between runs and providers.
 *
 * Categories:
 *   TEXT_ONLY   — should NOT trigger tool calls
 *   TOOL_CALL   — should trigger specific tool calls
 *   THINKING    — designed to elicit reasoning traces
 *   ADVERSARIAL — edge cases that probe failure modes
 */

// ── Text-Only Prompts (no tools expected) ──────────────────────

export const SIMPLE_ARITHMETIC = "What is 2 + 2? Answer with ONLY the number, nothing else.";

export const BRIEF_GREETING = "Say 'hello' and nothing else.";

export const ONE_SENTENCE_ANSWER = "What is the capital of France? Answer in one sentence.";

export const MINIMAL_PROMPT = "Hi";

export const RECALL_NAME_TURN_TWO = "What did I just tell you my name was? Answer briefly.";

export const STABILITY_CHECK = "What is 7 * 8? Just the number, nothing else.";

// ── Tool-Triggering Prompts ────────────────────────────────────

export const LIST_CURRENT_DIRECTORY =
  "List the files in the current directory. Use the appropriate tool to check the filesystem.";

export const READ_SPECIFIC_FILE =
  "Read the contents of /etc/hostname using the appropriate tool. Show me what it says.";

export const CHAIN_TWO_TOOLS =
  "First, list the files in /tmp using a tool. Then, tell me how many files you found. " +
  "You MUST use a tool to list the directory — do not guess.";

export const DELIBERATE_TOOL_ERROR =
  "Read the file at /nonexistent/path/that/does/not/exist using the appropriate tool. " +
  "Report what happened.";

export const MULTI_STEP_FILE_OPERATIONS =
  "Using tools: 1) List files in /tmp, 2) Check what's in /etc/hostname. " +
  "Report both results. You must use tools for each step.";

// ── Thinking-Eliciting Prompts ─────────────────────────────────

export const COMPLEX_REASONING =
  "A farmer has 17 sheep. All but 9 die. How many sheep are left? " +
  "Think through this step by step before answering.";

export const LOGIC_PUZZLE =
  "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take " +
  "100 machines to make 100 widgets? Reason carefully.";

export const THINKING_PLUS_TOOL =
  "I need you to think carefully about what files might be in /tmp, then use a tool " +
  "to verify your hypothesis. Compare your prediction with reality.";

// ── Plan Mode Prompts ──────────────────────────────────────────

export const PLAN_MODE_TASK =
  "I want you to refactor a hypothetical function. Plan out the steps you would take " +
  "to rename all variables in a file from camelCase to snake_case. " +
  "Don't execute anything, just create a plan.";

// ── Multi-Turn Context ─────────────────────────────────────────

export const TURN_ONE_INTRODUCTION = "Hello! My name is Rodrigo. Remember my name.";

export const TURN_TWO_RECALL = "What is my name? Answer in one word.";

export const TURN_THREE_ARITHMETIC = "Great! Now, what is 10 * 10? Just the number.";

// ── Multi-Agent / Orchestration ────────────────────────────────

export const SPAWN_TWO_WORKERS =
  "I need you to research 2 topics IN PARALLEL using your team_create tool. " +
  "Create a team with 2 workers:\n" +
  "1. Worker 1: Run `echo 'hello from worker 1'` using shell\n" +
  "2. Worker 2: Run `echo 'hello from worker 2'` using shell\n\n" +
  "Use team_create with 2 members. Each worker should use shell_execute.";

// ── Adversarial / Edge Case Prompts ────────────────────────────

export const EMPTY_STRING = "";

export const EXTREMELY_LONG_MESSAGE = "A".repeat(50_000) + "\n\nWhat letter did I repeat? Answer briefly.";

export const UNICODE_HEAVY =
  "🎨🎭🎪 Translate this to English: 你好世界. " +
  "Also, what emoji did I use? Answer briefly. 🌍🌎🌏";

export const RAPID_FIRE_TEMPLATE = (turnIndex: number) =>
  `Turn ${turnIndex}: What is ${turnIndex} + ${turnIndex}? Answer with just the number.`;

// ── Zero-Tools Prompt ──────────────────────────────────────────

export const TEXT_ONLY_NO_TOOLS =
  "Explain what the word 'ephemeral' means in one sentence. " +
  "Do NOT use any tools — just answer directly.";

// ── Max Iterations Stress ──────────────────────────────────────

export const ITERATION_STRESS =
  "I need you to do the following steps, each requiring a tool call:\n" +
  "1. List files in /tmp\n" +
  "2. Read /etc/hostname\n" +
  "3. List files in /home\n" +
  "4. Read /etc/os-release\n" +
  "5. List files in /var\n" +
  "Complete all steps using tools.";

// ── Plan Mode Exit ─────────────────────────────────────────────

export const PLAN_MODE_EXIT_INSTRUCTION =
  "The plan looks good. Please exit plan mode now and proceed with implementation. " +
  "Call the exit_plan_mode tool to leave planning mode.";

// ── Context Window Stress ──────────────────────────────────────

export const CONTEXT_WINDOW_FILLER_MESSAGE =
  "This is a context window filler message that contains a lot of text to push " +
  "the conversation closer to the context window limit. ".repeat(200);

// ── Truncation Recovery Verification ───────────────────────────

export const LONG_STRUCTURED_OUTPUT =
  "Write a detailed numbered list of the first 50 elements on the periodic table. " +
  "For each element, include its symbol, atomic number, and a one-sentence description. " +
  "Do not skip any elements. Output ALL 50.";

// ── Error Recovery ─────────────────────────────────────────────

export const POST_ERROR_HEALTH_CHECK =
  "Say 'system healthy' and nothing else.";

// ── Tree-of-Thought Branch Verification ────────────────────────

export const TREE_OF_THOUGHT_BRANCH_PROMPT =
  "Should I use a linked list or an array for a queue implementation? " +
  "Consider different approaches and pick the best one. Explain briefly.";

// ── Dynamic Tool Discovery ─────────────────────────────────────

export const SEARCH_FOR_TOOLS =
  "Search for available tools that can help with file operations. " +
  "Use the search_tools tool to find them.";


// ────────────────────────────────────────────────────────────
// Internal Tool Emojis — per-tool emoji displayed in the client UI
// Single source of truth for all Prism-local tools (orchestrator
// + InternalToolRegistry). Mirrors TOOL_EMOJIS in tools-service.
// ────────────────────────────────────────────────────────────

export const INTERNAL_TOOL_EMOJIS: Record<string, string[]> = {
  // Plan mode
  enter_plan_mode: ["📝", "🧠"],
  exit_plan_mode: ["🚀", "🧠"],

  // Skills
  create_skill: ["🪄", "🛠️"],
  execute_skill: ["⚡", "🪄"],
  list_skills: ["📋", "🪄"],
  delete_skill: ["🗑️", "🪄"],

  // Worktree
  enter_worktree: ["🌳", "💻"],
  exit_worktree: ["🚪", "🌳"],

  // Cognitive
  write_todo: ["📝", "📌"],
  summarize_conversation: ["💬", "📝"],
  ask_user: ["💬", "❓"],
  search_conversations: ["🔍", "💬"],
  retrieve_offloaded_content: ["📦", "🔎"],
  compact_context: ["🗜️", "🧠"],

  // MCP
  list_mcp_resources: ["🔌", "📋"],
  read_mcp_resource: ["🔌", "📄"],
  authenticate_mcp_server: ["🔌", "🔐"],

  // Timers
  set_timer: ["⏰", "⏳"],
  list_timers: ["⏱️", "📋"],
  cancel_timer: ["⏰", "❌"],

  // Orchestrator (subagent management)
  create_subagent: ["🤖", "📤"],
  create_subagents: ["🤖", "🫡"],
  send_subagent_message: ["💬", "📤"],
  stop_subagent: ["⏹️", "🤖"],
  get_subagent_output: ["📥", "🤖"],
  delete_subagents: ["🗑️", "👥"],
  resume_subagent: ["🔄", "🤖"],

  // Async tasks
  run_async_task: ["⚡", "🔄"],
  list_async_tasks: ["📋", "🔄"],
  cancel_async_task: ["⏹️", "🔄"],

  // Tool activation
  enable_tools: ["🔓", "🧰"],
  disable_tools: ["🔒", "🧰"],
  discover_and_enable_tools: ["🔍", "🧰"],
};

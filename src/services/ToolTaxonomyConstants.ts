export {
  DOMAINS,
  DOMAIN_TAGS,
  DOMAIN_KEY_TAGS,
  TOOL_NAMES,
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  AGENT_IDS,
  AGENTLESS_AGENT,
  TOPOLOGIES,
  DEFAULT_TOPOLOGY,
  DEFAULT_CONVERSATION_TITLE,
  DEFAULT_WORKFLOW_TITLE,
  DEFAULT_USERNAME,
  DEFAULT_PROJECT,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";

export type {
  ToolName,
  ServerSentEventType,
  StatusMessage,
  AgentId,
  TopologyType,
  DomainConstantKey,
  DomainEntry,
  DomainKey,
  DomainDisplayName,
} from "@rodrigo-barraza/utilities-library/taxonomy";

// Core tool names the shared taxonomy's TOOL_NAMES does not carry yet —
// tools-service's datastore trio and the Prism-local checkpoint, project
// instructions, tool-program and goal tools (CheckpointTools,
// ProjectInstructionsTools, RunToolProgramTool, GoalTools). Kept here, the
// way AsyncTaskConstants keeps the async-task names, until they move into
// the utilities-library taxonomy.
export const LOCAL_TOOL_NAMES = {
  WRITE_DATASTORE: "write_datastore",
  QUERY_DATASTORE: "query_datastore",
  DELETE_DATASTORE: "delete_datastore",
  CHECKPOINT: "checkpoint",
  REWIND: "rewind",
  READ_PROJECT_INSTRUCTIONS: "read_project_instructions",
  UPDATE_PROJECT_INSTRUCTIONS: "update_project_instructions",
  EDIT_PROJECT_INSTRUCTIONS: "edit_project_instructions",
  RUN_TOOL_PROGRAM: "run_tool_program",
  PROPOSE_GOAL: "propose_goal",
  UPDATE_GOAL: "update_goal",
  CLEAR_GOAL: "clear_goal",
} as const;

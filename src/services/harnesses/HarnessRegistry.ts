import ReActHarness from "./ReActHarness.ts";
import AcpAgentRuntime from "./AcpAgentRuntime.ts";
import type { AgenticContext, ConversationMessage } from "./types.ts";

/**
 * HarnessRegistry — maps harness IDs to their implementation classes.
 *
 * Adding a new harness:
 *   1. Create a class extending BaseAgenticHarness in this directory
 *   2. Set static `id`, `label`, and `description`
 *   3. Import and register it here
 *
 * Note: Tree of Thoughts is not a separate harness — it's a reasoning
 * strategy within ReActHarness (options.thoughtStructure = "tree_of_thoughts").
 *
 * External runtimes are the other kind of entry: the turn is not run by
 * Prism's loop on a Prism provider at all, but by an external agent process
 * (an ACP agent — AcpAgentRuntime). They are selected by `options.runtime`,
 * which only the orchestrator sets (for a custom agent whose definition names
 * the runtime), never by `options.harness`: `get()` and `list()` — what a
 * request and the settings UI can choose from — do not include them.
 */

interface HarnessConstructor {
  id: string;
  label: string;
  description: string;
  new (...args: unknown[]): {
    run(): Promise<{ messages: ConversationMessage[] }>;
  };
}

/** An external runtime: built from the turn's context alone, it runs the turn itself. */
export interface ExternalRuntimeConstructor {
  id: string;
  label: string;
  description: string;
  new (context: AgenticContext): {
    run(): Promise<{ messages: ConversationMessage[] }>;
  };
}

const registry = new Map<string, HarnessConstructor>();
const runtimes = new Map<string, ExternalRuntimeConstructor>();

function register(HarnessClass: HarnessConstructor) {
  registry.set(HarnessClass.id, HarnessClass);
}

function registerRuntime(RuntimeClass: ExternalRuntimeConstructor) {
  runtimes.set(RuntimeClass.id, RuntimeClass);
}

// ── Built-in harnesses ───────────────────────────────────────
register(ReActHarness as unknown as HarnessConstructor);

// ── External runtimes ────────────────────────────────────────
registerRuntime(AcpAgentRuntime);

const HarnessRegistry = {
  get(id: string) {
    return registry.get(id) || registry.get("standard");
  },
  list() {
    return [...registry.values()].map((harness) => ({
      id: harness.id,
      label: harness.label,
      description: harness.description,
    }));
  },
  has(id: string) {
    return registry.has(id);
  },
  /** The external runtime registered as `id`, or null. */
  runtime(id: string): ExternalRuntimeConstructor | null {
    return runtimes.get(id) ?? null;
  },
  listRuntimes() {
    return [...runtimes.values()].map((runtime) => ({
      id: runtime.id,
      label: runtime.label,
      description: runtime.description,
    }));
  },
};

export default HarnessRegistry;

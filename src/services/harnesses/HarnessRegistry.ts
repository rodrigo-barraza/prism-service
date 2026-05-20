import ReActHarness from "./ReActHarness.ts";

/**
 * HarnessRegistry — maps harness IDs to their implementation classes.
 *
 * Adding a new harness:
 *   1. Create a class extending BaseAgenticHarness in this directory
 *   2. Set static `id`, `label`, and `description`
 *   3. Import and register it here
 */


const registry = new Map();

function register(HarnessClass: Record<string, unknown>) {
  registry.set(HarnessClass.id, HarnessClass);
}

// ── Built-in harnesses ───────────────────────────────────────
register((ReActHarness as any));

// Future: register(SingleShotHarness);
// Future: register(PlanExecuteHarness);

const HarnessRegistry = {
  get(id: string) {
    return registry.get(id) || registry.get("standard");
  },
  list() {
    return [...registry.values()].map((H: Record<string, unknown>) => ({
      id: H.id,
      label: H.label,
      description: H.description,
    }));
  },
  has(id: string) {
    return registry.has(id);
  },
};

export default HarnessRegistry;

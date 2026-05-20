import ReActHarness from "./ReActHarness.js";
/**
 * HarnessRegistry — maps harness IDs to their implementation classes.
 *
 * Adding a new harness:
 *   1. Create a class extending BaseAgenticHarness in this directory
 *   2. Set static `id`, `label`, and `description`
 *   3. Import and register it here
 */
const registry = new Map();
function register(HarnessClass) {
    registry.set(HarnessClass.id, HarnessClass);
}
// ── Built-in harnesses ───────────────────────────────────────
register(ReActHarness);
// Future: register(SingleShotHarness);
// Future: register(PlanExecuteHarness);
const HarnessRegistry = {
    /**
     * Get a harness class by ID, falling back to the ReAct harness.
  
  
     */
    get(id) {
        return registry.get(id) || registry.get("standard");
    },
    /**
     * List all registered harnesses for the settings UI.
     * @returns {Array<{ id: string, label: string, description: string }>}
     */
    list() {
        return [...registry.values()].map((H) => ({
            id: H.id,
            label: H.label,
            description: H.description,
        }));
    },
    /**
     * Check if a harness ID exists.
  
  
     */
    has(id) {
        return registry.has(id);
    },
};
export default HarnessRegistry;
//# sourceMappingURL=HarnessRegistry.js.map
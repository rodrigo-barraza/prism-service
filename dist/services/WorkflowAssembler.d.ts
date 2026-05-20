/**
 * Assemble a visual workflow graph from raw step data.
 *
 * Each step produces:
 *   1. Text Input nodes (system prompt + user message)
 *   2. Conversation Input node (groups messages with compound ports)
 *   3. Model node (AI model with config-derived modality ports)
 *
 * Non-utility steps additionally produce:
 *   4. Output Viewer node (displays the model's text/image output)
 *   5. Chain edges (previous output model → this model)
 *
 * Utility steps (🧠 prefix) are shown in the graph but without viewers
 * or chain edges, keeping the visualization focused on output.
 *

 * @returns {{ nodes, edges, nodeResults }}
 */
declare function assembleGraph(steps: any): {
    nodes: any[];
    edges: any[];
    nodeResults: any;
};
export { assembleGraph };
//# sourceMappingURL=WorkflowAssembler.d.ts.map
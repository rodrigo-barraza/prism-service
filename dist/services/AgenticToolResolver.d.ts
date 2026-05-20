export default class AgenticToolResolver {
    /**
     * Resolves the final set of tools and a map of custom tools for an agentic loop.
     * Handles MongoDB custom tools, MCP tools, disabledBuiltIns mode, prefix expansion,
     * and native provider tool collision prevention.
     */
    static resolve({ options, agent, project, username, modelDef }: any): Promise<{
        finalTools: any[];
        customToolMap: Map<any, any>;
        resolvedEnabledTools: any;
    }>;
}
//# sourceMappingURL=AgenticToolResolver.d.ts.map
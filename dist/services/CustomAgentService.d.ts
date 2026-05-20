import { ObjectId } from "mongodb";
declare const CustomAgentService: {
    /**
     * List all custom agents.
  
     */
    list(): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    /**
     * Get a single custom agent by MongoDB _id.
  
  
     */
    get(id: string): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Get a custom agent by its derived agentId.
  
  
     */
    getByAgentId(agentId: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Create a new custom agent.
  
     * @returns {Promise<object>} The created document
     */
    create(data: Record<string, unknown>): Promise<{
        _id: ObjectId;
        name: unknown;
        agentId: string;
        type: {};
        description: {};
        project: {};
        icon: {};
        color: {};
        backgroundImage: {};
        identity: {};
        guidelines: {};
        toolPolicy: {};
        enabledTools: any[];
        usesDirectoryTree: {};
        usesCodingGuidelines: {};
        createdAt: string;
        updatedAt: string;
    }>;
    /**
     * Update an existing custom agent.
  
  
     * @returns {Promise<object>} The updated document
     */
    update(id: string, updates: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Delete a custom agent.
  
  
     */
    delete(id: string): Promise<boolean>;
};
export default CustomAgentService;
//# sourceMappingURL=CustomAgentService.d.ts.map
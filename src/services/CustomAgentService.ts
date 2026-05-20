import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

// ────────────────────────────────────────────────────────────
// CustomAgentService — CRUD for user-defined agent personas
//
// Stores custom agents in the `custom_agents` collection.
// Each document defines an agent persona that gets registered
// into AgentPersonaRegistry at runtime.
// ────────────────────────────────────────────────────────────

/**
 * Derive a stable agent ID from a display name.
 * Always uppercased and prefixed with CUSTOM_ to avoid collisions.


 */
function deriveAgentId(name: string) {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `CUSTOM_${slug}`;
}

/** @returns {import("mongodb").Collection} */
function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.CUSTOM_AGENTS);
}

const CustomAgentService = {
  /**
   * List all custom agents.

   */
  async list() {
    const col = getCollection();
    if (!col) return [];
    return col.find({}).sort({ createdAt: -1 }).toArray();
  },

  /**
   * Get a single custom agent by MongoDB _id.


   */
  async get(id: string) {
    const col = getCollection();
    if (!col) return null;
    return col.findOne({ _id: new ObjectId(id) });
  },

  /**
   * Get a custom agent by its derived agentId.


   */
  async getByAgentId(agentId: Record<string, unknown>) {
    const col = getCollection();
    if (!col) return null;
    return col.findOne({ agentId });
  },

  /**
   * Create a new custom agent.

   * @returns {Promise<object>} The created document
   */
  async create(data: Record<string, unknown>) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    // @ts-ignore - TODO: strict typing
    const agentId = deriveAgentId(data.name);

    // Check for duplicate agentId
    const existing = await col.findOne({ agentId });
    if (existing) {
      throw new Error(`Agent with ID "${agentId}" already exists`);
    }

    const document = {
      name: data.name,
      agentId,
      type: data.type || "",
      description: data.description || "",
      project: data.project || "coding",
      icon: data.icon || "",
      color: data.color || "",
      backgroundImage: data.backgroundImage || "",
      identity: data.identity || "",
      guidelines: data.guidelines || "",
      toolPolicy: data.toolPolicy || "",
      enabledTools: Array.isArray(data.enabledTools) ? data.enabledTools : [],
      usesDirectoryTree: data.usesDirectoryTree || false,
      usesCodingGuidelines: data.usesCodingGuidelines || false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await col.insertOne(document);
    logger.info(
      `[CustomAgentService] Created agent "${document.name}" (${document.agentId})`,
    );
    return { ...document, _id: result.insertedId };
  },

  /**
   * Update an existing custom agent.


   * @returns {Promise<object>} The updated document
   */
  async update(id: string, updates: Record<string, unknown>) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    // If name changed, re-derive agentId
    const setFields = { ...updates, updatedAt: new Date().toISOString() };
    if (updates.name) {
      // @ts-ignore - TODO: strict typing
      setFields.agentId = deriveAgentId(updates.name);
    }

    // Remove _id from $set if present
    // @ts-ignore - TODO: strict typing
    delete setFields._id;

    await col.updateOne({ _id: new ObjectId(id) }, { $set: setFields });

    const updated = await col.findOne({ _id: new ObjectId(id) });
    logger.info(
      `[CustomAgentService] Updated agent "${updated?.name}" (${updated?.agentId})`,
    );
    return updated;
  },

  /**
   * Delete a custom agent.


   */
  async delete(id: string) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    const document = await col.findOne({ _id: new ObjectId(id) });
    const result = await col.deleteOne({ _id: new ObjectId(id) });
    if (document) {
      logger.info(
        `[CustomAgentService] Deleted agent "${document.name}" (${document.agentId})`,
      );
    }
    return result.deletedCount > 0;
  },
};

export default CustomAgentService;

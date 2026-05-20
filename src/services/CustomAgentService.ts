import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
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
  async list() {
    const collection = getCollection();
    if (!collection) return [];
    return collection.find({}).sort({ createdAt: -1 }).toArray();
  },
  async get(id: string) {
    const collection = getCollection();
    if (!collection) return null;
    return collection.findOne({ _id: new ObjectId(id) });
  },
  async getByAgentId(agentId: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) return null;
    return collection.findOne({ agentId });
  },
  async create(data: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

        const agentId = deriveAgentId((data.name as any));

    // Check for duplicate agentId
    const existing = await collection.findOne({ agentId });
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

    const result = await collection.insertOne(document);
    logger.info(
      `[CustomAgentService] Created agent "${document.name}" (${document.agentId})`,
    );
    return { ...document, _id: result.insertedId };
  },
  async update(id: string, updates: Record<string, unknown>) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

    // If name changed, re-derive agentId
    const setFields = { ...updates, updatedAt: new Date().toISOString() };
    if (updates.name) {
            (setFields as any).agentId = deriveAgentId((updates.name as any));
    }

    // Remove _id from $set if present
        delete (setFields as any)._id;

    await collection.updateOne({ _id: new ObjectId(id) }, { $set: setFields });

    const updated = await collection.findOne({ _id: new ObjectId(id) });
    logger.info(
      `[CustomAgentService] Updated agent "${updated?.name}" (${updated?.agentId})`,
    );
    return updated;
  },
  async delete(id: string) {
    const collection = getCollection();
    if (!collection) throw new Error("Database not available");

    const document = await collection.findOne({ _id: new ObjectId(id) });
    const result = await collection.deleteOne({ _id: new ObjectId(id) });
    if (document) {
      logger.info(
        `[CustomAgentService] Deleted agent "${document.name}" (${document.agentId})`,
      );
    }
    return result.deletedCount > 0;
  },
};

export default CustomAgentService;

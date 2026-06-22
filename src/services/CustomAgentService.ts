import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import { deriveAgentId } from "@rodrigo-barraza/utilities-library";
import logger from "../utils/logger.ts";

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

    const agentId = deriveAgentId(data.name as string);

    // Check for duplicate agentId
    const existing = await collection.findOne({ agentId });
    if (existing) {
      throw new Error(`Agent with name "${data.name}" already exists`);
    }

    const document = {
      name: data.name,
      agentId,
      type: data.type || "",
      description: data.description || "",
      project: data.project || "coding",
      icon: data.icon || "",
      avatar: data.avatar || "",
      color: data.color || "",
      backgroundImage: data.backgroundImage || "",
      identity: data.identity || "",
      guidelines: data.guidelines || "",
      toolPolicy: data.toolPolicy || "",
      availableTools: Array.isArray(data.availableTools)
        ? data.availableTools
        : Array.isArray(data.enabledTools)
          ? data.enabledTools
          : [],
      enabledByDefaultTools: Array.isArray(data.enabledByDefaultTools)
        ? data.enabledByDefaultTools
        : [],
      policies: Array.isArray(data.policies) ? data.policies : [],
      platformRules:
        typeof data.platformRules === "object" && data.platformRules !== null
          ? data.platformRules
          : {},
      hasSomaticState: data.hasSomaticState || false,
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

    // If name changed, re-derive agentId and verify uniqueness
    const setFields: Record<string, unknown> = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    if (updates.name) {
      const newAgentId = deriveAgentId(updates.name as string);
      const conflictingAgent = await collection.findOne({
        agentId: newAgentId,
        _id: { $ne: new ObjectId(id) },
      });
      if (conflictingAgent) {
        throw new Error(`Agent with name "${updates.name}" already exists`);
      }
      setFields.agentId = newAgentId;
    }

    // Remove _id from $set if present
    delete setFields._id;

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

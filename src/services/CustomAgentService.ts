import { ObjectId } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { deriveAgentId } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import { AGENT_DEFINITION_PIN_KEYS } from "#src/services/agents/AgentDefinitionFields";

/** The definition pins a document stores, only those that are set. */
function pickAgentDefinitionPins(data: Record<string, unknown>) {
  const pins: Record<string, unknown> = {};
  for (const key of AGENT_DEFINITION_PIN_KEYS) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== "") pins[key] = data[key];
  }
  return pins;
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
      // Sub-agent pins (prompt 17), validated by the route:
      // model/provider/effort/maxTurns/permissionMode/disallowedTools.
      ...pickAgentDefinitionPins(data),
      // An external runtime and its launch configuration (agents/AgentRuntime),
      // validated and owner-stamped by the route.
      ...(typeof data.runtime === "string" && data.runtime ? { runtime: data.runtime } : {}),
      ...(data.acp && typeof data.acp === "object" && !Array.isArray(data.acp) ? { acp: data.acp } : {}),
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
      negativeConstraints: Array.isArray(data.negativeConstraints)
        ? data.negativeConstraints
        : [],
      usesDirectoryTree: data.usesDirectoryTree || false,
      usesCodingGuidelines: data.usesCodingGuidelines || false,
      // Role models this agent pins ({ main: { provider, model, effort }, … })
      // and its routing preset — routing/RoleModelResolver.
      modelRoles:
        typeof data.modelRoles === "object" && data.modelRoles !== null
          ? data.modelRoles
          : {},
      routingPreset: typeof data.routingPreset === "string" ? data.routingPreset : "",
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

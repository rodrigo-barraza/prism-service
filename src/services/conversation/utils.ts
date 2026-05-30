import FileService from "../FileService.ts";
import logger from "../../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type { ChatMessage } from "../../types/admin.ts";
import type { MessagePayload, ConversationSettings, ConversationPatchInput, ConversationPatchFields } from "./types.ts";

/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 */
export async function extractFiles(
  messages: Array<ChatMessage | MessagePayload>,
  project: string | null = null,
  username: string | null = null,
): Promise<Array<ChatMessage | MessagePayload>> {
  if (!messages || !FileService.isExternalStorage()) return messages;

  const processed: Array<ChatMessage | MessagePayload> = [];
  for (const message of messages) {
    const updated = { ...message } as ChatMessage | MessagePayload;

    // Handle images
    if (message.images && message.images.length > 0) {
      const category = message.role === "assistant" ? "generations" : "uploads";
      const newImages: string[] = [];
      for (const rawImage of message.images) {
        if (typeof rawImage !== "string") {
          newImages.push(String(rawImage));
          continue;
        }
        const image = rawImage;
        if (image.startsWith("minio://") || image.startsWith("http")) {
          newImages.push(image);
          continue;
        }
        if (image.startsWith("data:")) {
          try {
            const { ref } = await FileService.uploadFile(
              image,
              category,
              project,
              username,
            );
            newImages.push(ref);
          } catch (error: unknown) {
            logger.error(`Failed to upload file: ${errorMessage(error)}`);
            newImages.push(image);
          }
        } else {
          newImages.push(image);
        }
      }
      updated.images = newImages;
    }

    // Handle audio data URLs
    if (
      updated.audio &&
      typeof updated.audio === "string" &&
      updated.audio.startsWith("data:")
    ) {
      const category = updated.role === "assistant" ? "generations" : "uploads";
      try {
        const { ref } = await FileService.uploadFile(
          updated.audio,
          category,
          project,
          username,
        );
        updated.audio = ref;
      } catch (error: unknown) {
        logger.error(`Failed to upload audio: ${errorMessage(error)}`);
      }
    }

    processed.push(updated);
  }
  return processed;
}

/**
 * Compute input/output modalities from messages for lightweight querying.
 */
export function computeModalities(messages: ChatMessage[]): Record<string, boolean> {
  const modalities = {
    textIn: false,
    textOut: false,
    imageIn: false,
    imageOut: false,
    audioIn: false,
    audioOut: false,
    docIn: false,
    webSearch: false,
    codeExecution: false,
    functionCalling: false,
    thinking: false,
  };

  const WEB_SEARCH_NAMES = new Set(["web_search", "web_search_preview"]);
  const CODE_EXEC_NAMES = new Set(["code_execution"]);

  for (const m of messages || []) {
    if (m.deleted) continue;
    const isUser = m.role === "user";
    const isAssistant = m.role === "assistant";
    if (m.content && (isUser || isAssistant)) {
      if (isUser && !(m as Record<string, unknown>).liveTranscription) modalities.textIn = true;
      if (isAssistant) modalities.textOut = true;
    }
    // Tool calls are structured text output
    if (isAssistant && m.toolCalls && m.toolCalls.length > 0) {
      modalities.textOut = true;
    }
    if ((m.images && m.images.length > 0) || (m as Record<string, unknown>).image) {
      if (isUser) modalities.imageIn = true;
      if (isAssistant) modalities.imageOut = true;
    }
    if (m.audio) {
      if (isUser) modalities.audioIn = true;
      if (isAssistant) modalities.audioOut = true;
    }
    if (
      ((m as Record<string, unknown>).documents as string[] | undefined)?.length ||
      m.images?.some(
        (ref: string) =>
          typeof ref === "string" &&
          (ref.endsWith(".pdf") || ref.endsWith(".txt")),
      )
    ) {
      modalities.docIn = true;
    }

    // Classify tool calls by type
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const toolCall of m.toolCalls) {
        const name = (toolCall.name || "").toLowerCase();
        if (WEB_SEARCH_NAMES.has(name)) {
          modalities.webSearch = true;
        } else if (CODE_EXEC_NAMES.has(name)) {
          modalities.codeExecution = true;
        } else {
          modalities.functionCalling = true;
        }
      }
    }

    // Detect inline web search results (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("> **Sources:**")
    ) {
      modalities.webSearch = true;
    }

    // Detect inline code execution blocks (from streaming)
    if (
      isAssistant &&
      typeof m.content === "string" &&
      m.content.includes("```exec-")
    ) {
      modalities.codeExecution = true;
    }

    // Tool result messages — mark as function calling
    // (web_search and code_execution results are inlined, not stored as role:"tool")
    if (m.role === "tool") {
      modalities.functionCalling = true;
    }

    // Detect thinking / reasoning
    if (isAssistant && m.thinking) {
      modalities.thinking = true;
    }
  }
  return modalities;
}

/**
 * Extract unique providers from messages and settings.
 */
export function extractProviders(messages: ChatMessage[], settings: ConversationSettings | null): string[] {
  const providers = new Set<string>();
  for (const m of messages || []) {
    if (m.deleted) continue;
    if ((m as Record<string, unknown>).provider) {
      providers.add(((m as Record<string, unknown>).provider as string).toLowerCase());
    }
  }
  if (settings?.provider) providers.add(settings.provider.toLowerCase());
  return [...providers];
}

/**
 * Compute total estimated cost across all messages.
 */
export function computeTotalCost(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages || []) {
    if (m.deleted) continue;
    const cost = (m as Record<string, unknown>).estimatedCost;
    if (typeof cost === "number") total += cost;
  }
  return total;
}

/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 */
export function buildConversationPatchFields({
  title,
  messages,
  systemPrompt,
  settings,
}: ConversationPatchInput): ConversationPatchFields {
  const setFields: ConversationPatchFields = { updatedAt: new Date().toISOString() };
  if (title !== undefined) setFields.title = title;
  if (messages !== undefined) {
    setFields.messages = messages;
    setFields.modalities = computeModalities(messages);
    setFields.providers = extractProviders(messages, settings || null);
    setFields.totalCost = computeTotalCost(messages);
  }
  if (systemPrompt !== undefined) setFields.systemPrompt = systemPrompt;
  if (settings !== undefined) {
    setFields.settings = { ...settings, systemPrompt: systemPrompt || "" };
  }
  return setFields;
}

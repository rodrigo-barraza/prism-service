import logger from "#src/utils/logger";
import type { WebSocket } from "ws";

/**
 * WebSocket Connection Registry
 *
 * Maps conversationId → Set<EmitFunction> so background auto-responses
 * (sub-agent completion notifications) can stream directly to the client's
 * active WebSocket connection(s) instead of running headlessly.
 *
 * Supports broadcast to multiple connected clients (e.g. multiple browser tabs
 * open on the same conversation).
 *
 * Lifecycle:
 *   register()   — called when a WebSocket message for a conversation is processed
 *   deregister() — called on WebSocket close, or when the emit entry goes stale
 *
 * Follows the Antigravity reactive wake-up pattern: background tasks deliver
 * results through the parent's existing connection channel.
 */

type EmitFunction = (event: { type: string; [key: string]: unknown }) => void;

interface RegisteredConnection {
  emit: EmitFunction;
  websocket: WebSocket;
}

const connectionsByConversation = new Map<string, Set<RegisteredConnection>>();

const WebSocketConnectionRegistry = {
  /**
   * Register a WebSocket + emit function for a conversation.
   * Supports multiple connections per conversation (multi-tab broadcast).
   */
  register(
    conversationId: string,
    websocket: WebSocket,
    emit: EmitFunction,
  ): void {
    let connectionSet = connectionsByConversation.get(conversationId);
    if (!connectionSet) {
      connectionSet = new Set();
      connectionsByConversation.set(conversationId, connectionSet);
    }

    // Avoid duplicate registrations for the same WebSocket
    for (const existingConnection of connectionSet) {
      if (existingConnection.websocket === websocket) {
        existingConnection.emit = emit;
        return;
      }
    }

    connectionSet.add({ emit, websocket });
    logger.debug(
      `[WebSocketRegistry] Registered connection for conversation ${conversationId} (${connectionSet.size} active)`,
    );
  },

  /**
   * Deregister all connections for a specific WebSocket instance.
   * Called on WebSocket close to prevent stale references.
   */
  deregisterByWebSocket(websocket: WebSocket): void {
    for (const [conversationId, connectionSet] of connectionsByConversation) {
      for (const connection of connectionSet) {
        if (connection.websocket === websocket) {
          connectionSet.delete(connection);
          logger.debug(
            `[WebSocketRegistry] Deregistered connection for conversation ${conversationId} (${connectionSet.size} remaining)`,
          );
        }
      }
      if (connectionSet.size === 0) {
        connectionsByConversation.delete(conversationId);
      }
    }
  },

  /**
   * Deregister all connections for a specific conversation.
   */
  deregister(conversationId: string): void {
    const wasPresent = connectionsByConversation.delete(conversationId);
    if (wasPresent) {
      logger.debug(
        `[WebSocketRegistry] Deregistered all connections for conversation ${conversationId}`,
      );
    }
  },

  /**
   * Get a broadcast emit function for a conversation.
   * Returns an emit that sends to ALL connected clients for this conversation,
   * or null if no active connections exist.
   *
   * Automatically prunes closed WebSockets during lookup.
   */
  getEmitFunction(conversationId: string): EmitFunction | null {
    const connectionSet = connectionsByConversation.get(conversationId);
    if (!connectionSet || connectionSet.size === 0) return null;

    // Prune closed WebSockets
    for (const connection of connectionSet) {
      if (connection.websocket.readyState !== connection.websocket.OPEN) {
        connectionSet.delete(connection);
      }
    }

    if (connectionSet.size === 0) {
      connectionsByConversation.delete(conversationId);
      return null;
    }

    // Return a broadcast emit that sends to all connected clients
    return (event: { type: string; [key: string]: unknown }) => {
      for (const connection of connectionSet) {
        try {
          if (connection.websocket.readyState === connection.websocket.OPEN) {
            connection.emit(event);
          }
        } catch (error: unknown) {
          logger.warn(
            `[WebSocketRegistry] Failed to emit to connection for conversation ${conversationId}: ${error}`,
          );
        }
      }
    };
  },

  /**
   * Check if any active connections exist for a conversation.
   */
  hasActiveConnection(conversationId: string): boolean {
    const connectionSet = connectionsByConversation.get(conversationId);
    if (!connectionSet || connectionSet.size === 0) return false;

    // Check for at least one open connection
    for (const connection of connectionSet) {
      if (connection.websocket.readyState === connection.websocket.OPEN) {
        return true;
      }
    }
    return false;
  },

  /**
   * Get the total number of registered conversations (for diagnostics).
   */
  get size(): number {
    return connectionsByConversation.size;
  },

  /**
   * Clear all registrations (for testing / shutdown).
   */
  clear(): void {
    connectionsByConversation.clear();
  },
};

export default WebSocketConnectionRegistry;

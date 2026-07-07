import { describe, it, expect } from "vitest";
import AgentNotificationService from "../AgentNotificationService.ts";
import { NOTIFICATION_SOURCES } from "../../constants.ts";

describe("AgentNotificationService", () => {
  describe("formatTaskNotification", () => {
    it("should format a standard task notification", () => {
      const options = {
        status: "success",
        summary: "Task completed",
        toolUses: 5,
        durationMilliseconds: 1500,
        resultBody: "Final result text",
        source: NOTIFICATION_SOURCES.ORCHESTRATOR,
      };

      const result = AgentNotificationService.formatTaskNotification(options);

      expect(result).toContain("<task-notification>");
      expect(result).toContain("<status>success</status>");
      expect(result).toContain("<summary>Task completed</summary>");
      expect(result).toContain("<tool_uses>5</tool_uses>");
      expect(result).toContain("<duration_ms>1500</duration_ms>");
      expect(result).toContain("<result>\nFinal result text\n</result>");
    });

    it("should use defaults for optional fields", () => {
      const options = {
        status: "pending",
        summary: "Running",
        resultBody: "Working...",
        source: NOTIFICATION_SOURCES.BACKGROUND_TASK,
      };

      const result = AgentNotificationService.formatTaskNotification(options);

      expect(result).toContain("<tool_uses>0</tool_uses>");
      expect(result).toContain("<duration_ms>0</duration_ms>");
    });
  });

  describe("createNotificationMessage", () => {
    it("should create a valid ConversationMessage", () => {
      const options = {
        status: "success",
        summary: "Done",
        resultBody: "Result",
        source: NOTIFICATION_SOURCES.ORCHESTRATOR,
      };

      const message = AgentNotificationService.createNotificationMessage(options);

      expect(message.role).toBe("user");
      expect(message.content).toContain("<task-notification>");
      expect(message._alreadyPersisted).toBe(true);
      expect(message._notificationSource).toBe(NOTIFICATION_SOURCES.ORCHESTRATOR);
      expect(message._notificationId).toContain("orchestrator:Done:");
      expect(message.timestamp).toBeDefined();
    });

    it("should use custom notificationId if provided", () => {
      const options = {
        status: "success",
        summary: "Done",
        resultBody: "Result",
        source: NOTIFICATION_SOURCES.ORCHESTRATOR,
      };
      const customId = "custom-id-123";

      const message = AgentNotificationService.createNotificationMessage(options, customId);

      expect(message._notificationId).toBe(customId);
    });
  });
});

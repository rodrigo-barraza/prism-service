import SettingsService from "../SettingsService.ts";

export async function getSubAgentFallback(): Promise<{
  provider: string;
  model: string;
} | null> {
  try {
    const agents = await SettingsService.getSection("agents");
    if (agents) {
      const provider = agents.subAgentProvider || agents.subagentProvider;
      const model = agents.subAgentModel || agents.subagentModel;
      if (typeof provider === "string" && typeof model === "string") {
        return { provider, model };
      }
    }
    return null;
  } catch {
    return null;
  }
}

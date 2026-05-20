// @ts-ignore
import { createLogger } from "@rodrigo-barraza/utilities-library/node";
import { getRequestContext } from "./RequestContext.ts";

const base = createLogger("prism");

/**
 * Build identity + IP tags from provided values or AsyncLocalStorage context.
 */
function buildContextTags(project: Record<string, unknown>, username: string, clientIp: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  const hasProject = project && project !== "unknown";
  const hasUser = username && username !== "unknown";

  let identityTag = "";
  if (hasProject && hasUser) {
    identityTag = ` [${project}/${username}]`;
  } else if (hasProject) {
    identityTag = ` [${project}]`;
  } else if (hasUser) {
    identityTag = ` [${username}]`;
  }

  const ipTag = clientIp ? ` (${clientIp})` : "";

  return `${identityTag}${ipTag}`;
}

const logger = {
  ...base,

  // @ts-ignore - TODO: strict typing
  provider(provider: Record<string, unknown>, action: Record<string, unknown>, ...args: Record<string, unknown>) {
    const context = getRequestContext();
    // @ts-ignore
    const tags = buildContextTags(context.project, context.username, context.clientIp);
    // @ts-ignore - TODO: strict typing
    base.info(`[${provider}] ${action}${tags}`, ...args);
  },

  request(
    project: Record<string, unknown>,
    username: string,
    clientIp: Record<string, unknown>,
    message: string,
    // @ts-ignore - TODO: strict typing
    ...args: Record<string, unknown>
  ) {
    const tags = buildContextTags(project, username, clientIp);
    // @ts-ignore - TODO: strict typing
    base.info(`${message}${tags}`, ...args);
  },
};

export default logger;

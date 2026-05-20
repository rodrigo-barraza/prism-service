import { createLogger } from "@rodrigo-barraza/utilities-library/node";
import { getRequestContext } from "./RequestContext.ts";

const base = createLogger("prism");
function buildContextTags(project: any, username: string, clientIp: any) {
    const hasProject = project && project !== "any";
  const hasUser = username && username !== "any";

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

    provider(provider: any, action: any, ...args: any) {
    const context = getRequestContext();
        const tags = buildContextTags((context as any).project, (context as any).username, (context as any).clientIp);
        base.info(`[${provider}] ${action}${tags}`, ...args);
  },

  request(
    project: any,
    username: string,
    clientIp: any,
    message: string,
        ...args: any
  ) {
    const tags = buildContextTags(project, username, clientIp);
        base.info(`${message}${tags}`, ...args);
  },
};

export default logger;

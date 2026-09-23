import { createLogger } from "@rodrigo-barraza/utilities-library/node";
import { getRequestContext } from "./RequestContext.ts";
import { redactSecrets } from "./SecretRedaction.ts";

const unredacted = createLogger("prism");

type LogMethod = (message: string, ...additionalData: unknown[]) => void;

/** Every printed line — message, extra data, Errors — goes out with credentials masked. */
function redacting(method: LogMethod): LogMethod {
  return (message, ...additionalData) =>
    method(redactSecrets(message), ...additionalData.map(redactSecrets));
}

const base = {
  info: redacting(unredacted.info),
  success: redacting(unredacted.success),
  warn: redacting(unredacted.warn),
  error: redacting(unredacted.error),
  debug: redacting(unredacted.debug),
};

function buildContextTags(
  project: string,
  username: string,
  clientIp: string | null,
): string {
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

  provider(provider: string, action: string, ...args: unknown[]) {
    const context = getRequestContext();
    const tags = buildContextTags(
      context.project,
      context.username,
      context.clientIp,
    );
    base.info(`[${provider}] ${action}${tags}`, ...args);
  },

  request(
    project: string,
    username: string,
    clientIp: string | null,
    message: string,
    ...args: unknown[]
  ) {
    const tags = buildContextTags(project, username, clientIp);
    base.info(`${message}${tags}`, ...args);
  },
};

export default logger;

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import logger from "#src/utils/logger";
import { requestContext } from "#src/utils/RequestContext";
import { FAKE_SECRETS, lastFour } from "./fakeSecrets.ts";

// ────────────────────────────────────────────────────────────
// Error logs (prompt 23 Landing 2): every line the service logger
// prints — message and extra arguments, Error objects included —
// goes out with credentials masked.
// ────────────────────────────────────────────────────────────

const printed = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls
    .flat()
    .map((argument) =>
      argument instanceof Error
        ? `${argument.message}\n${argument.stack}`
        : typeof argument === "string"
          ? argument
          : JSON.stringify(argument),
    )
    .join("\n");

describe("logger masks secrets", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("masks a key in an error message and in the Error it carries", () => {
    const key = FAKE_SECRETS.anthropicKey();
    logger.error(
      `[anthropic] 401 for key ${key}`,
      new Error(`invalid x-api-key ${key}`),
    );

    const output = printed(errorSpy);
    expect(output).not.toContain(key);
    expect(output).toContain(`***${lastFour(key)}`);
    expect(output).toContain("invalid x-api-key");
  });

  it("masks a JWT inside an object argument to warn", () => {
    const jwt = FAKE_SECRETS.jwt();
    logger.warn("[mcp] refresh failed", {
      status: 401,
      body: { access_token: jwt, token_type: "bearer" },
    });

    const output = printed(warnSpy);
    expect(output).not.toContain(jwt);
    expect(output).toContain("token_type");
  });

  it("masks a PEM private key logged at info", () => {
    const pem = FAKE_SECRETS.pemPrivateKey();
    logger.info(`[tools] read_file returned:\n${pem}`);

    const output = printed(logSpy);
    const body = pem.split("\n")[1];
    expect(output).not.toContain(body);
    expect(output).toContain("PRIVATE KEY");
  });

  it("masks a credential in a request-line URL and a provider line", () => {
    const key = FAKE_SECRETS.googleKey();
    requestContext.run({ project: "prism", username: "rodrigo", clientIp: null }, () => {
      logger.request("prism", "rodrigo", null, `GET /proxy?key=${key} 200`);
      logger.provider("google", `retrying with key=${key}`);
    });

    const output = printed(logSpy);
    expect(output).not.toContain(key);
  });
});

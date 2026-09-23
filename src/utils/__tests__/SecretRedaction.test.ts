import { describe, it, expect, vi, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import {
  maskSecret,
  redactSecrets,
  resetSecretRedaction,
} from "#src/utils/SecretRedaction";
import { LOG_REDACTION } from "#src/constants";
import { FAKE_SECRETS, fakeRandom, lastFour } from "./fakeSecrets.ts";

// ────────────────────────────────────────────────────────────
// The one redaction function (prompt 23 Landing 2): each shape it
// catches, the environment values and denylist it matches by value,
// and the corpus of ordinary text it must leave byte-for-byte alone.
// ────────────────────────────────────────────────────────────

function expectMasked(text: string, secret: string) {
  const redacted = redactSecrets(text);
  expect(redacted).not.toContain(secret);
  expect(redacted).toContain(`***${lastFour(secret)}`);
  return redacted;
}

afterEach(() => {
  resetSecretRedaction();
  vi.restoreAllMocks();
});

describe("maskSecret", () => {
  it("keeps the last four characters of a long secret", () => {
    expect(maskSecret("abcdefghijklmnop1234")).toBe("***1234");
  });

  it("keeps nothing of a short one", () => {
    expect(maskSecret("hunter22")).toBe("***");
    expect(maskSecret("a".repeat(LOG_REDACTION.MIN_LENGTH_FOR_LAST_FOUR - 1))).toBe(
      "***",
    );
  });
});

describe("shapes", () => {
  it("sk-ant- keys, keeping the vendor prefix", () => {
    const key = FAKE_SECRETS.anthropicKey();
    const redacted = expectMasked(`x-api-key: ${key}`, key);
    expect(redacted).toBe(`x-api-key: sk-ant-***${lastFour(key)}`);
  });

  it("sk-proj- and legacy sk- keys", () => {
    const project = FAKE_SECRETS.openaiProjectKey();
    const legacy = FAKE_SECRETS.openaiLegacyKey();
    expectMasked(`{"key":"${project}"}`, project);
    expectMasked(`curl -H "Authorization: Bearer ${legacy}" …`, legacy);
  });

  it("what is left of a strong-prefix key a preview cut short", () => {
    expect(redactSecrets("…ANTHROPIC key sk-ant-api03-Zq7")).toBe(
      "…ANTHROPIC key sk-ant-***",
    );
  });

  it("AIza keys", () => {
    const key = FAKE_SECRETS.googleKey();
    expectMasked(
      `https://generativelanguage.googleapis.com/v1/models?key=${key}`,
      key,
    );
  });

  it("xoxb- / xoxp- Slack tokens", () => {
    const bot = FAKE_SECRETS.slackBotToken();
    const user = FAKE_SECRETS.slackUserToken();
    expectMasked(`SLACK=${bot}`, bot);
    expectMasked(`token ${user} rejected`, user);
  });

  it("ghp_ and github_pat_ tokens", () => {
    const classic = FAKE_SECRETS.githubClassicToken();
    const fineGrained = FAKE_SECRETS.githubFineGrainedToken();
    expectMasked(`git remote add origin https://${classic}@github.com/o/r`, classic);
    expectMasked(`GH_TOKEN=${fineGrained}`, fineGrained);
  });

  it("JWTs", () => {
    const jwt = FAKE_SECRETS.jwt();
    expectMasked(`{"id_token":"${jwt}","expires_in":3600}`, jwt);
    expectMasked(`cookie: session=${jwt}; Path=/`, jwt);
  });

  it("PEM private keys, with their BEGIN/END lines kept", () => {
    const pem = FAKE_SECRETS.pemPrivateKey();
    const redacted = redactSecrets(`key file:\n${pem}\nend of file`);
    for (const line of pem.split("\n").slice(1, -1)) {
      expect(redacted).not.toContain(line);
    }
    expect(redacted).toMatch(
      /-----BEGIN RSA PRIVATE KEY-----\*\*\*\S{4}-----END RSA PRIVATE KEY-----\nend of file$/,
    );
  });

  it("a PEM private key inside a JSON string (escaped newlines)", () => {
    const pem = FAKE_SECRETS.pemPrivateKey();
    const serialized = JSON.stringify({ private_key: pem });
    const redacted = redactSecrets(serialized);
    expect(redacted).not.toContain(pem.split("\n")[1]);
    expect(redacted).toContain("PRIVATE KEY");
  });

  it("a PEM private key a preview cut before its END line", () => {
    const pem = FAKE_SECRETS.pemPrivateKey();
    const cut = pem.slice(0, 120);
    const redacted = redactSecrets(cut);
    expect(redacted).not.toContain(pem.split("\n")[1].slice(0, 20));
    expect(redacted.startsWith("-----BEGIN RSA PRIVATE KEY-----***")).toBe(true);
  });

  it("Bearer tokens, keeping the scheme", () => {
    const token = FAKE_SECRETS.bearerToken();
    expect(redactSecrets(`Authorization: Bearer ${token}`)).toBe(
      `Authorization: Bearer ***${lastFour(token)}`,
    );
    expectMasked(`"authorization":"bearer ${token}"`, token);
  });

  it("Basic credentials — only when they decode to user:password", () => {
    const credentials = FAKE_SECRETS.basicCredentials();
    expectMasked(`Authorization: Basic ${credentials}`, credentials);
  });

  it("the password in a URL, keeping the user and host", () => {
    const password = fakeRandom(24, 71);
    const redacted = expectMasked(
      `connecting to mongodb://prism:${password}@db.internal:27017/prism`,
      password,
    );
    expect(redacted).toContain("mongodb://prism:***");
    expect(redacted).toContain("@db.internal:27017/prism");
  });

  it("webhook URLs whose path is the credential", () => {
    const path = `T0${fakeRandom(8, 73)}/B0${fakeRandom(8, 79)}/${fakeRandom(24, 83)}`;
    const redacted = redactSecrets(`POST https://hooks.slack.com/services/${path}`);
    expect(redacted).not.toContain(path);
    expect(redacted).toContain("hooks.slack.com/services/***");
  });

  it("AWS access key ids and Stripe secret keys", () => {
    const aws = `AKIA${fakeRandom(16, 89, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`;
    const stripe = `sk_${"live"}_${fakeRandom(24, 97)}`;
    expect(redactSecrets(`aws_access_key_id = ${aws}`)).not.toContain(aws);
    expectMasked(`STRIPE=${stripe}`, stripe);
  });

  it("secret assignments whose value has no known shape", () => {
    const hex = fakeRandom(32, 101, "0123456789abcdef");
    const secret = fakeRandom(28, 103);
    expect(redactSecrets(`ELEVENLABS_API_KEY=${hex}\nPORT=7777`)).toBe(
      `ELEVENLABS_API_KEY=***${lastFour(hex)}\nPORT=7777`,
    );
    expectMasked(`{"client_secret": "${secret}", "client_id": "prism"}`, secret);
    expectMasked(`database:\n  password: ${secret}\n  port: 5432`, secret);
    expectMasked(`?grant_type=refresh&access_token=${secret}&x=1`, secret);
  });

  it("plain-object fields named for a credential, whatever their shape", () => {
    const token = FAKE_SECRETS.bearerToken();
    expect(
      redactSecrets({
        password: "hunter2",
        headers: { Authorization: `Bearer ${token}` },
        "x-api-key": "short-key",
      }),
    ).toEqual({
      password: "***",
      headers: { Authorization: `Bearer ***${lastFour(token)}` },
      "x-api-key": "***",
    });
  });
});

describe("no false positives — the corpus passes unchanged", () => {
  const base64Media = Buffer.from(
    fakeRandom(6000, 107, "\u0000\u0001\u00ff\u0080abcdefghij0123456789"),
    "latin1",
  ).toString("base64");

  const corpus: Record<string, string> = {
    prose: [
      "The bearer of this letter is a friend.",
      "Basic understanding of the task is required; see Basic realm=\"prism\".",
      "We use sk-learn (scikit-learn) and a risk-assessment-framework-for-2024.",
      "Ask for the API key in the settings page, and set a strong password.",
      "The token count was 4096; max_tokens: 8192, inputTokens: 12000.",
      "Google keys start with AIza, GitHub classic tokens with ghp_, Slack's with xoxb-.",
      "Rotate your secret: every 90 days. Token: expired.",
    ].join("\n"),
    code: [
      "export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;",
      "const apiKey = config.apiKey;",
      "headers: { Authorization: `Bearer ${token}` },",
      "const password = hashPassword(input2);",
      "api_key = os.environ.get(\"OPENAI_API_KEY\")",
      "token = await getToken(); secret ??= loadSecret();",
      "interface Options { password: string; token?: string; apiKey: string }",
      "if (!secret) throw new Error(\"missing client_secret\");",
      "const desk = 'desk-layout-sidebar-collapsed-2024-v2';",
      "export PATH=/usr/local/bin:$PATH OLDPWD=/home/rodrigo/development2024",
      "OPENAI_API_KEY=your-key-here  # API_KEY=<your key>  TOKEN=${TOKEN}",
      "Authorization: Bearer YOUR_ACCESS_TOKEN",
      "mongodb://user:password@localhost:27017/db",
    ].join("\n"),
    "base64 media": [
      `data:image/png;base64,${base64Media}`,
      "[base64 data]",
      base64Media,
    ].join("\n"),
    ids: [
      "123e4567-e89b-12d3-a456-426614174000",
      "65f1c2a9b3e4d5f6a7b8c9d0",
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "commit 3a919529d215565d7bc55a2a96e43a2d39341c60",
      "toolu_01A09q90qw90lq917835lq9 call_abc123def456 msg_01XFDUDYJgAACzvnptvVoYEL",
      "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "2026-09-22T21:10:48.123Z",
    ].join("\n"),
    urls: [
      "https://api.prism.rod.dev/agent?stream=false&conversationId=abc123",
      "mongodb://localhost:27017/prism_test_log_redaction",
      "postgres://db.internal:5432/app",
      "git@github.com:rodrigo/prism-service.git",
      "https://user@example.com/path/to/thing?page=2",
    ].join("\n"),
  };

  for (const [kind, text] of Object.entries(corpus)) {
    it(kind, () => {
      expect(redactSecrets(text)).toBe(text);
    });
  }

  it("a request row's own fields", () => {
    const row = {
      requestId: "65f1c2a9b3e4d5f6a7b8c9d0-3",
      inputTokens: 28_000,
      maxTokens: 8192,
      promptCacheKey: "conv-65f1c2a9b3e4d5f6a7b8c9d0",
      prefixHashes: {
        system: "9f86d081884c7d659a2feaa0c55ad015",
        tools: "a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
      responsePayload: {
        logprobs: [{ token: "Hello", logprob: -0.01 }],
        toolCalls: [{ id: "toolu_01A09q90qw90lq917835lq9", args: { page: 2 } }],
      },
      token_type: "bearer",
    };
    expect(redactSecrets(row)).toBe(row);
  });
});

describe("known secret values — the environment and the denylist", () => {
  const touched: string[] = [];
  const setVariable = (name: string, value: string) => {
    touched.push(name);
    process.env[name] = value;
  };

  afterEach(() => {
    for (const name of touched.splice(0)) delete process.env[name];
  });

  it("masks a secret variable's value wherever it appears, never naming it", () => {
    const value = `vault-value-${fakeRandom(20, 109)}`;
    setVariable("PRISM_TEST_FAKE_SERVICE_API_KEY", value);
    resetSecretRedaction();

    const redacted = redactSecrets(`upstream said: invalid credential ${value}.`);
    expect(redacted).toBe(`upstream said: invalid credential ***${lastFour(value)}.`);
    expect(redacted).not.toContain("PRISM_TEST_FAKE_SERVICE_API_KEY");
  });

  it("takes the password out of a URL-valued variable", () => {
    const password = fakeRandom(18, 113);
    setVariable(
      "PRISM_TEST_FAKE_MONGO_URI",
      `mongodb://svc:${encodeURIComponent(password)}@db.internal:27017/x`,
    );
    resetSecretRedaction();

    expect(redactSecrets(`auth failed (${password})`)).toBe(
      `auth failed (***${lastFour(password)})`,
    );
  });

  it("takes the secret leaves out of a JSON-valued credential", () => {
    const keyId = fakeRandom(40, 127, "0123456789abcdef");
    setVariable(
      "PRISM_TEST_FAKE_ANALYTICS_CREDENTIALS",
      JSON.stringify({ type: "service_account", private_key_id: keyId }),
    );
    resetSecretRedaction();

    expect(redactSecrets(`kid=${keyId}`)).toBe(`kid=***${lastFour(keyId)}`);
    expect(redactSecrets("type service_account")).toBe("type service_account");
  });

  it("leaves short values, public halves and non-secret names alone", () => {
    setVariable("PRISM_TEST_FAKE_TOKEN", "abc");
    setVariable("PRISM_TEST_FAKE_VAPID_PUBLIC_KEY", `public-${fakeRandom(20, 131)}`);
    setVariable("PRISM_TEST_FAKE_TOKEN_LIMIT", "100000000");
    setVariable("PRISM_TEST_FAKE_MODEL", "gemini-3.5-flash-preview");
    resetSecretRedaction();

    const text = [
      "abc",
      process.env.PRISM_TEST_FAKE_VAPID_PUBLIC_KEY,
      "100000000",
      "gemini-3.5-flash-preview",
    ].join(" ");
    expect(redactSecrets(text)).toBe(text);
  });

  it("re-reads the environment once the cache expires", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const value = `rotated-${fakeRandom(20, 137)}`;
    redactSecrets("prime the cache");
    setVariable("PRISM_TEST_FAKE_ROTATED_SECRET", value);

    expect(redactSecrets(value)).toBe(value);
    now.mockReturnValue(
      1_000_000 + LOG_REDACTION.SECRET_VALUES_TIME_TO_LIVE_MILLISECONDS,
    );
    expect(redactSecrets(value)).toBe(`***${lastFour(value)}`);
  });

  it("drops remembered redactions of long strings when the secret set changes", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const value = `late-${fakeRandom(20, 139)}`;
    const long = `${"history ".repeat(LOG_REDACTION.MEMO_MIN_LENGTH / 8)}${value}`;

    expect(redactSecrets(long)).toBe(long);
    setVariable("PRISM_TEST_FAKE_LATE_SECRET", value);
    now.mockReturnValue(
      2_000_000 + LOG_REDACTION.SECRET_VALUES_TIME_TO_LIVE_MILLISECONDS,
    );
    expect(redactSecrets(long)).not.toContain(value);
  });

  it("masks denylist literals and /regex/ entries", () => {
    setVariable(
      LOG_REDACTION.DENYLIST_ENVIRONMENT_VARIABLE,
      "internal-codename-nebula,\n/acct-\\d{6}/",
    );
    resetSecretRedaction();

    expect(redactSecrets("project internal-codename-nebula for acct-123456")).toBe(
      "project ***bula for ***",
    );
  });

  it("skips an invalid /regex/ entry without printing it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setVariable(LOG_REDACTION.DENYLIST_ENVIRONMENT_VARIABLE, "/([/,plain-denied-value");
    resetSecretRedaction();

    expect(redactSecrets("a plain-denied-value here")).toBe("a ***alue here");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("([");

    // A reload of the same denylist does not repeat the warning.
    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + LOG_REDACTION.SECRET_VALUES_TIME_TO_LIVE_MILLISECONDS * 2,
    );
    redactSecrets("reload the denylist");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("structures", () => {
  it("returns a masked copy and never mutates the input", () => {
    const key = FAKE_SECRETS.anthropicKey();
    const input = { messages: [{ role: "tool", content: `k=${key}` }], n: 1 };
    const snapshot = structuredClone(input);

    const output = redactSecrets(input);
    expect(input).toEqual(snapshot);
    expect(output).not.toBe(input);
    expect(JSON.stringify(output)).not.toContain(key);
  });

  it("returns untouched branches as the same reference", () => {
    const clean = { big: "x".repeat(10_000), list: [1, 2, 3] };
    const input = { clean, dirty: `Bearer ${FAKE_SECRETS.bearerToken()}` };
    const output = redactSecrets(input);
    expect(output.clean).toBe(clean);
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("writes ObjectIds, Dates and Buffers as they are", () => {
    const id = new ObjectId();
    const at = new Date();
    const bytes = Buffer.from("raw");
    const output = redactSecrets({ _id: id, at, bytes, text: "ok" });
    expect(output._id).toBe(id);
    expect(output.at).toBe(at);
    expect(output.bytes).toBe(bytes);
  });

  it("survives a cycle", () => {
    const node: Record<string, unknown> = { name: "loop" };
    node.self = node;
    expect(() => redactSecrets(node)).not.toThrow();
  });

  it("masks an Error's message, stack and fields, keeping its class", () => {
    const key = FAKE_SECRETS.githubClassicToken();
    class UpstreamError extends Error {
      status = 401;
      body = `bad credentials ${key}`;
    }
    const error = new UpstreamError(`GitHub refused ${key}`);
    const output = redactSecrets(error);

    expect(output).toBeInstanceOf(UpstreamError);
    expect(output.message).not.toContain(key);
    expect(output.stack).not.toContain(key);
    expect(output.body).not.toContain(key);
    expect(output.status).toBe(401);
    expect(error.message).toContain(key);
  });

  it("returns an Error with nothing to mask as itself", () => {
    const error = new Error("plain failure");
    expect(redactSecrets(error)).toBe(error);
  });
});

describe("no pathological backtracking", () => {
  const cases: Record<string, string> = {
    "repeated names without values": "api_key".repeat(40_000),
    "separators without values": "a=".repeat(100_000),
    "BEGIN lines without a body": "-----BEGIN PRIVATE KEY-----".repeat(8_000),
    "one long token": "A".repeat(250_000),
    "bearer without a token": "Bearer ".repeat(30_000),
  };

  for (const [kind, text] of Object.entries(cases)) {
    it(kind, () => {
      const started = performance.now();
      redactSecrets(text);
      // Generous: a backtracking blow-up is seconds to minutes, not ms.
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  }
});

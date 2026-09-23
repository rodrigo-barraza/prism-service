import { LOG_REDACTION } from "#src/constants";

/**
 * SecretRedaction — the one mask applied wherever Prism writes something a
 * credential could be inside of: request rows (`RequestLogger` — which is
 * also where a prompt/agent hook's payload lands), their webhook copies, and
 * every line the service logger prints.
 *
 * A secret becomes `***<last4>` (just `***` when it is short), keeping the
 * text around it — a key's vendor prefix, `Bearer `, a variable's name — so a
 * row still says what was there. What it catches, in order:
 *
 *   1. the values of this service's secret environment variables, matched by
 *      value (the vault fills `process.env`; the names only choose which
 *      values, and never appear in the output) plus the configurable denylist
 *      (`PRISM_LOG_REDACTION_DENYLIST`);
 *   2. PEM private keys and JWTs;
 *   3. provider key shapes: `sk-ant-…`, `sk-…`, `AIza…`, `xox[abeoprs]-…`,
 *      `gh[pousr]_…` / `github_pat_…`, and a few more with unmistakable
 *      prefixes;
 *   4. credentials in URLs (`scheme://user:secret@`), Slack/Discord webhook
 *      URLs, `Bearer` and `Basic` authorization values;
 *   5. secret assignments — `NAME_API_KEY=…`, `"apiKey": "…"`, `password: …`
 *      — whose value looks machine-made, and plain-object fields with a
 *      credential's name.
 *
 * The shapes are strict on purpose (a boundary before the prefix, a length
 * floor, a "looks random" check where a shape could be a word), so normal
 * text, code, base64 media and ids pass through untouched — the corpus in
 * `__tests__/SecretRedaction.test.ts` pins that.
 */

const { MASK } = LOG_REDACTION;

/** Mask a secret: `***<last4>` when it is long enough to spare four characters. */
export function maskSecret(secret: string): string {
  return secret.length >= LOG_REDACTION.MIN_LENGTH_FOR_LAST_FOUR
    ? `${MASK}${secret.slice(-4)}`
    : MASK;
}

// ── Value heuristics ─────────────────────────────────────────

const countMatches = (text: string, pattern: RegExp) =>
  text.match(pattern)?.length ?? 0;

/**
 * A placeholder or a reference rather than a value: `${TOKEN}`, `<key>`,
 * `YOUR_API_KEY`, `xxxxxxxx`, `process.env.X`, a dotted member path.
 */
function isPlaceholder(value: string): boolean {
  return (
    /^[$%<{[]/.test(value) ||
    /^[A-Z][A-Z0-9_]*$/.test(value) ||
    /^[xX*.\-_#]+$/.test(value) ||
    /^(?:process\.env|os\.environ|import\.meta\.env|env)\b/.test(value) ||
    // `config.apiKey`, `this.options.token` — code, not a credential.
    (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) &&
      countMatches(value, /\d/g) < 3)
  );
}

/**
 * Machine-made rather than written: at least two digits among the letters
 * (a random base62/hex body nearly always has them, a word or an identifier
 * nearly never), or a long mixed-case base64 body.
 */
function looksMachineMade(value: string): boolean {
  if (isPlaceholder(value)) return false;
  const digits = countMatches(value, /\d/g);
  const letters = countMatches(value, /[A-Za-z]/g);
  if (digits >= 2 && letters >= 2) {
    // A lowercase kebab slug with version numbers (`v2-release-2024-notes`).
    return !/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(value);
  }
  return (
    value.length >= 20 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /[+/=_-]/.test(value)
  );
}

/** `Basic` credentials decode to printable `user:password`. */
function isBasicCredential(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, "base64").toString("latin1");
  return (
    Buffer.from(decoded, "latin1").toString("base64") === value &&
    /^[\x20-\x7e]+$/.test(decoded) &&
    /^[^:]+:./.test(decoded)
  );
}

// ── Shape rules ──────────────────────────────────────────────

/**
 * A shape: `pre` and `post` are kept, `secret` is masked. `accept` vetoes a
 * match that is not a credential after all.
 */
interface ShapeRule {
  pattern: RegExp;
  accept?: (secret: string) => boolean;
}

/** Not preceded by a token character — `task-…` is not `sk-…`. */
const BEFORE = "(?<![A-Za-z0-9_-])";

/** A secret-assignment's name: env style, camelCase or kebab. */
const SECRET_NAME =
  "api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?key|" +
  "access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer[_-]?token|" +
  "session[_-]?token|private[_-]?key|encryption[_-]?key|signing[_-]?key|password|passwd|secret|token";

/** A secret-assignment value ends at a delimiter, never at `(` (a call). */
const VALUE_END = "(?=[\\s\"'`,;&<>{}\\[\\]\\\\)]|$)";

const SHAPE_RULES: ShapeRule[] = [
  // PEM private keys — the body, with or without its END line (a preview
  // may have cut it off).
  {
    pattern:
      /(?<pre>-----BEGIN (?<label>(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----)(?<secret>[\s\S]*?)(?<post>-----END \k<label>-----)/g,
  },
  {
    pattern:
      /(?<pre>-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----)(?<secret>(?:[A-Za-z0-9+/=:,-]|\s|\\[nr])+)/g,
    accept: (secret) => /[A-Za-z0-9+/]{8}/.test(secret),
  },
  // JWTs (header.payload.signature, both JSON parts base64url `ey…`).
  {
    pattern: new RegExp(
      `${BEFORE}(?<secret>eyJ[A-Za-z0-9_-]{5,}\\.ey[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]*)`,
      "g",
    ),
  },
  // Provider keys whose prefix alone says "credential": any length masks,
  // so a preview that cut the key short still hides what is left of it.
  {
    pattern: new RegExp(
      `${BEFORE}(?<pre>sk-ant-|sk-(?:proj|svcacct|admin)-|github_pat_|gh[pousr]_|glpat-|xox[abeoprs]-|xapp-|whsec_|(?:sk|rk)_(?:live|test)_)(?<secret>[A-Za-z0-9_-]{4,})`,
      "g",
    ),
  },
  // Google API keys.
  {
    pattern: new RegExp(`${BEFORE}(?<pre>AIza)(?<secret>[0-9A-Za-z_-]{20,})`, "g"),
  },
  // Generic `sk-` keys (OpenAI legacy, Moonshot, DeepSeek, …), npm, xAI,
  // Hugging Face — prefixes a word can carry, so the body must look random.
  {
    pattern: new RegExp(
      `${BEFORE}(?<pre>sk-|npm_|xai-)(?<secret>[A-Za-z0-9_-]{20,})`,
      "g",
    ),
    accept: looksMachineMade,
  },
  {
    pattern: new RegExp(`${BEFORE}(?<pre>hf_)(?<secret>[A-Za-z]{30,})`, "g"),
    accept: (secret) => /[A-Z]/.test(secret) && /[a-z]/.test(secret),
  },
  // AWS access key ids.
  {
    pattern: /(?<![A-Za-z0-9])(?<pre>AKIA|ASIA)(?<secret>[0-9A-Z]{16})(?![A-Za-z0-9])/g,
  },
  // Webhook URLs whose path IS the credential.
  {
    pattern:
      /(?<pre>hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/\d+\/)(?<secret>[A-Za-z0-9_/-]{20,})/g,
  },
  // `scheme://user:secret@host` — anchored on `://`, the scheme checked
  // behind it (scanning for a rare literal, not trying every word).
  {
    pattern:
      /(?<=\b[a-z][a-z0-9+.-]{1,20})(?<pre>:\/\/[^\s:/@"'`<>]{1,128}:)(?<secret>[^\s/@"'`<>]{3,256})(?<post>@)/gi,
    accept: (secret) => !isPlaceholder(secret) && !/^pass(?:word)?$/i.test(secret),
  },
  // Authorization values.
  {
    pattern: /(?<pre>\bBearer\s+)(?<secret>[A-Za-z0-9_\-.~+/]{12,}=*)/gi,
    accept: (secret) =>
      !isPlaceholder(secret) && (/\d/.test(secret) || /[-._~+/]/.test(secret)),
  },
  {
    pattern: /(?<pre>\bBasic\s+)(?<secret>[A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi,
    accept: isBasicCredential,
  },
  // Secret assignments: `X_API_KEY=…`, `"apiKey": "…"`, `password: …`.
  // Anchored on the `:` / `=`, the name checked behind it; the name itself
  // is outside the match, so it is kept as written.
  {
    pattern: new RegExp(
      `(?<=(?:${SECRET_NAME})["']?\\s*)(?<pre>[:=]\\s*["']?)(?<secret>[^\\s"'\`,;&<>{}()\\[\\]\\\\]{8,})${VALUE_END}`,
      "gi",
    ),
    accept: looksMachineMade,
  },
];

/**
 * A plain-object key that names a credential — its string value is masked
 * whole. Not a bare `token`: logprob entries are `{ token, logprob }`.
 */
const SECRET_FIELD_NAME =
  /^(?:x[_-])?(?:api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer[_-]?token|session[_-]?token|private[_-]?key|encryption[_-]?key|signing[_-]?key|password|passwd|secret|authorization|proxy[_-]?authorization)$/i;

function applyShapeRule(text: string, rule: ShapeRule): string {
  return text.replace(rule.pattern, (match, ...replaceArguments) => {
    const groups = replaceArguments.at(-1) as Record<string, string | undefined>;
    const secret = groups.secret ?? "";
    // Already masked by an earlier rule, or not a credential after all.
    if (!secret || secret.includes(MASK)) return match;
    if (rule.accept && !rule.accept(secret)) return match;
    const trimmed = secret.replace(/(?:\s|\\[nr])+$/, "");
    return `${groups.pre ?? ""}${maskSecret(trimmed)}${groups.post ?? ""}`;
  });
}

// ── Known secret values (environment + denylist) ─────────────

/**
 * Which environment variables hold secrets: the vault's naming convention,
 * by SUFFIX (`_API_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`, `_CREDENTIALS`,
 * `_BASIC`, `_PRIVATE_KEY`, …) — `MAX_TOKENS` or `TOKEN_LIMIT` hold numbers,
 * not secrets. A `_URI` holds a URL; only the password in it is a secret,
 * and that is taken from every variable. Public halves are not secrets.
 */
const SECRET_VARIABLE_NAME =
  /(?:^|_)(?:API_?KEY|SECRET|SECRET_KEY|JWT_KEY|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|ENCRYPTION_KEY|SIGNING_KEY|CREDENTIALS?|BASIC)$/;
const PUBLIC_VARIABLE_NAME = /PUBLIC/;

/** The password inside a URL-shaped value, if any. */
function urlPassword(value: string): string | null {
  if (!value.includes("://") || !value.includes("@")) return null;
  try {
    const password = decodeURIComponent(new URL(value).password);
    return password || null;
  } catch {
    return null;
  }
}

/** Secret string leaves of a JSON-valued secret (a service-account file). */
function jsonSecretLeaves(value: string): string[] {
  if (!value.trimStart().startsWith("{")) return [];
  try {
    const leaves: string[] = [];
    const walk = (node: unknown, key: string) => {
      if (typeof node === "string") {
        if (/key|secret|token|password/i.test(key)) leaves.push(node);
      } else if (node && typeof node === "object") {
        for (const [childKey, child] of Object.entries(node)) walk(child, childKey);
      }
    };
    walk(JSON.parse(value), "");
    return leaves;
  } catch {
    return [];
  }
}

function secretValuesFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Set<string> {
  const values = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    // Short values would mask ordinary words wherever they appear.
    if (trimmed && trimmed.length >= LOG_REDACTION.MIN_SECRET_VALUE_LENGTH) {
      values.add(trimmed);
    }
  };
  for (const [name, value] of Object.entries(environment)) {
    if (!value) continue;
    // Any URL that carries a password — `MONGO_URI`, a provider URL.
    add(urlPassword(value));
    if (!SECRET_VARIABLE_NAME.test(name) || PUBLIC_VARIABLE_NAME.test(name)) {
      continue;
    }
    const leaves = jsonSecretLeaves(value);
    if (leaves.length > 0) leaves.forEach(add);
    else if (!urlPassword(value)) add(value);
  }
  return values;
}

interface Denylist {
  literals: string[];
  patterns: RegExp[];
}

/** The denylist last parsed — its warnings are printed once, not every reload. */
let warnedDenylist: string | undefined;

function parseDenylist(raw: string | undefined): Denylist {
  const denylist: Denylist = { literals: [], patterns: [] };
  const firstParse = raw !== warnedDenylist;
  warnedDenylist = raw;
  for (const entry of (raw ?? "").split(/[\n,]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const regexEntry = /^\/(.+)\/([a-z]*)$/.exec(trimmed);
    if (!regexEntry) {
      denylist.literals.push(trimmed);
      continue;
    }
    try {
      const flags = regexEntry[2].includes("g")
        ? regexEntry[2]
        : `${regexEntry[2]}g`;
      denylist.patterns.push(new RegExp(regexEntry[1], flags));
    } catch {
      // The entry itself may be a secret: say that one is broken, not which.
      if (firstParse) {
        console.warn(
          `[SecretRedaction] ${LOG_REDACTION.DENYLIST_ENVIRONMENT_VARIABLE} has an invalid /regex/ entry; skipped.`,
        );
      }
    }
  }
  return denylist;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface KnownSecrets {
  /** One alternation of every literal, longest first. */
  literals: RegExp | null;
  patterns: RegExp[];
  /** Changes whenever the set does — a memoised result is only valid under it. */
  signature: string;
  loadedAt: number;
}

let knownSecrets: KnownSecrets | null = null;

/**
 * Redactions of long strings, keyed by the string. Every agent iteration
 * re-logs the whole history, so the same (often the very same) strings come
 * back each time: ~6 ms per MB scanned once, a hash lookup after that.
 * Bounded by the characters it retains; oldest first out.
 */
const memo = new Map<string, string>();
let memoCharacters = 0;

function remember(text: string, redacted: string): void {
  const size = text.length + (redacted === text ? 0 : redacted.length);
  if (size > LOG_REDACTION.MEMO_MAX_CHARACTERS / 4) return;
  memo.set(text, redacted);
  memoCharacters += size;
  for (const [oldest, oldestRedacted] of memo) {
    if (memoCharacters <= LOG_REDACTION.MEMO_MAX_CHARACTERS) break;
    memo.delete(oldest);
    memoCharacters -=
      oldest.length + (oldestRedacted === oldest ? 0 : oldestRedacted.length);
  }
}

function forgetMemo(): void {
  memo.clear();
  memoCharacters = 0;
}

function loadKnownSecrets(): KnownSecrets {
  const now = Date.now();
  if (
    knownSecrets &&
    now - knownSecrets.loadedAt < LOG_REDACTION.SECRET_VALUES_TIME_TO_LIVE_MILLISECONDS
  ) {
    return knownSecrets;
  }
  const denylist = parseDenylist(
    process.env[LOG_REDACTION.DENYLIST_ENVIRONMENT_VARIABLE],
  );
  const literals = [
    ...new Set([...secretValuesFromEnvironment(process.env), ...denylist.literals]),
  ].sort((left, right) => right.length - left.length);
  const literalSource = literals.map(escapeRegExp).join("|");
  const signature = [literalSource, ...denylist.patterns.map(String)].join("\n");
  if (signature !== knownSecrets?.signature) forgetMemo();
  knownSecrets = {
    literals: literals.length > 0 ? new RegExp(literalSource, "g") : null,
    patterns: denylist.patterns,
    signature,
    loadedAt: now,
  };
  return knownSecrets;
}

/**
 * Forget the secret values read from the environment and the denylist, so
 * the next redaction re-reads them (tests; a rotated vault secret is picked
 * up within `SECRET_VALUES_TIME_TO_LIVE_MILLISECONDS` without this).
 */
export function resetSecretRedaction(): void {
  knownSecrets = null;
  warnedDenylist = undefined;
  forgetMemo();
}

// ── The redaction function ───────────────────────────────────

function redactText(text: string): string {
  // Nothing shorter than the smallest shape can hold a credential.
  if (text.length < 8) return text;
  const known = loadKnownSecrets();
  const memoised = text.length >= LOG_REDACTION.MEMO_MIN_LENGTH;
  if (memoised) {
    const cached = memo.get(text);
    if (cached !== undefined) return cached;
  }
  let redacted = text;
  if (known.literals) {
    redacted = redacted.replace(known.literals, (match) => maskSecret(match));
  }
  for (const pattern of known.patterns) {
    redacted = redacted.replace(pattern, (match) =>
      match ? maskSecret(match) : match,
    );
  }
  for (const rule of SHAPE_RULES) {
    redacted = applyShapeRule(redacted, rule);
  }
  if (memoised) remember(text, redacted);
  return redacted;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactError(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Error {
  seen.add(error);
  const message = redactText(error.message);
  const stack = error.stack === undefined ? undefined : redactText(error.stack);
  const changedFields: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    const field = (error as unknown as Record<string, unknown>)[key];
    const next = redactValue(field, depth + 1, seen, key);
    if (next !== field) changedFields[key] = next;
  }
  const cause = (error as { cause?: unknown }).cause;
  const redactedCause =
    cause === undefined ? undefined : redactValue(cause, depth + 1, seen, "cause");
  if (
    message === error.message &&
    stack === error.stack &&
    Object.keys(changedFields).length === 0 &&
    redactedCause === cause
  ) {
    return error;
  }
  const copy = Object.create(Object.getPrototypeOf(error)) as Error;
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(error));
  Object.defineProperty(copy, "message", {
    value: message,
    writable: true,
    configurable: true,
  });
  if (stack !== undefined) {
    Object.defineProperty(copy, "stack", {
      value: stack,
      writable: true,
      configurable: true,
    });
  }
  if (redactedCause !== cause) {
    Object.defineProperty(copy, "cause", {
      value: redactedCause,
      writable: true,
      configurable: true,
    });
  }
  Object.assign(copy, changedFields);
  return copy;
}

function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (typeof value === "string") {
    if (
      key !== undefined &&
      SECRET_FIELD_NAME.test(key) &&
      value.length > 0 &&
      !value.includes(MASK) &&
      !isPlaceholder(value)
    ) {
      // `{ password: "…" }` — the name says what the value is. An
      // `Authorization` value keeps its scheme.
      const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? "";
      return `${scheme}${maskSecret(value.slice(scheme.length))}`;
    }
    return redactText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > LOG_REDACTION.MAX_DEPTH || seen.has(value)) return value;
  if (value instanceof Error) return redactError(value, depth, seen);
  if (Array.isArray(value)) {
    seen.add(value);
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index++) {
      const next = redactValue(value[index], depth + 1, seen);
      if (next !== value[index]) {
        copy ??= [...value];
        copy[index] = next;
      }
    }
    return copy ?? value;
  }
  // ObjectIds, Dates, Buffers and other class instances are written as they are.
  if (!isPlainObject(value)) return value;
  seen.add(value);
  let copy: Record<string, unknown> | null = null;
  for (const childKey of Object.keys(value)) {
    const child = value[childKey];
    const next = redactValue(child, depth + 1, seen, childKey);
    if (next !== child) {
      copy ??= { ...value };
      copy[childKey] = next;
    }
  }
  return copy ?? value;
}

/**
 * Mask every credential in `value` — a string, or any structure of plain
 * objects, arrays and Errors (redacted copies; the input is never mutated,
 * and an untouched branch is returned as the same reference).
 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

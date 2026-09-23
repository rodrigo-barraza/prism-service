/**
 * Fake credentials for the log-redaction tests.
 *
 * Every value is assembled at runtime from split prefixes and a seeded
 * pseudo-random body, so no key-shaped literal sits in the source for a
 * secret scanner (or a reader) to mistake for a real one. None of them is
 * valid anywhere.
 */

const BASE62 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DIGITS = "0123456789";

/** Deterministic pseudo-random string (LCG) — the same seed, the same body. */
export function fakeRandom(
  length: number,
  seed: number,
  alphabet: string = BASE62,
): string {
  let state = seed >>> 0 || 1;
  let output = "";
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    output += alphabet[(state >>> 16) % alphabet.length];
  }
  return output;
}

const base64Url = (text: string) => Buffer.from(text).toString("base64url");

export const FAKE_SECRETS = {
  anthropicKey: () => ["sk", "ant", "api03", `${fakeRandom(93, 7)}AA`].join("-"),
  openaiProjectKey: () => ["sk", "proj", fakeRandom(120, 11)].join("-"),
  openaiLegacyKey: () => `sk-${fakeRandom(48, 13)}`,
  googleKey: () => `AI${"za"}${fakeRandom(35, 17)}`,
  slackBotToken: () =>
    [
      `xox${"b"}`,
      fakeRandom(12, 19, DIGITS),
      fakeRandom(13, 21, DIGITS),
      fakeRandom(24, 23),
    ].join("-"),
  slackUserToken: () =>
    [`xox${"p"}`, fakeRandom(12, 25, DIGITS), fakeRandom(32, 27)].join("-"),
  githubClassicToken: () => `gh${"p"}_${fakeRandom(36, 29)}`,
  githubFineGrainedToken: () =>
    `github${"_pat_"}${fakeRandom(22, 31)}_${fakeRandom(59, 37)}`,
  jwt: () =>
    [
      base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      base64Url(JSON.stringify({ sub: "user-42", iat: 1790000000 })),
      fakeRandom(43, 41, `${BASE62}-_`),
    ].join("."),
  pemPrivateKey: () =>
    [
      `-----BEGIN ${"RSA PRIVATE"} KEY-----`,
      fakeRandom(64, 43, `${BASE62}+/`),
      fakeRandom(64, 47, `${BASE62}+/`),
      `${fakeRandom(40, 53, `${BASE62}+/`)}==`,
      `-----END ${"RSA PRIVATE"} KEY-----`,
    ].join("\n"),
  bearerToken: () => fakeRandom(40, 59, `${BASE62}-._`),
  basicCredentials: () =>
    Buffer.from(`svc-user:${fakeRandom(20, 61)}`).toString("base64"),
} as const;

/** What a masked value keeps: its last four characters. */
export const lastFour = (secret: string) => secret.slice(-4);

import crypto from "node:crypto";

/**
 * WebPushProtocol — the two standards a Web Push send needs, on node:crypto
 * alone (no `web-push` dependency):
 *
 *   - RFC 8291 message encryption, `aes128gcm` content coding (RFC 8188):
 *     one record, ephemeral ECDH P-256 key, HKDF-SHA-256 key schedule.
 *   - RFC 8292 VAPID: an ES256 JWT for the push service's origin, sent as
 *     `Authorization: vapid t=<jwt>, k=<public key>`.
 *
 * Keys travel as base64url, the form browsers hand out (`p256dh`, `auth`)
 * and `applicationServerKey` expects: the VAPID public key is the 65-byte
 * uncompressed point, the private key its 32-byte scalar.
 */

export interface PushSubscriptionKeys {
  /** The user agent's P-256 public key (uncompressed point, base64url). */
  p256dh: string;
  /** The 16-byte authentication secret (base64url). */
  auth: string;
}

export interface WebPushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface VapidDetails {
  /** `mailto:` or `https:` contact for the push service operator. */
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface EncryptionOverrides {
  /** Fixed sender key pair — only the RFC 8291 test vector needs this. */
  senderPrivateKey?: string;
  /** Fixed 16-byte salt (base64url) — likewise. */
  salt?: string;
}

export interface WebPushSendOptions {
  /** Seconds the push service may hold the message for an offline device. */
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Replaces an undelivered message with the same topic (≤ 32 base64url chars). */
  topic?: string;
  timeoutMilliseconds?: number;
}

export interface WebPushSendResult {
  statusCode: number;
  body: string;
}

const RECORD_SIZE = 4096;
const KEY_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
/** Padding delimiter of the final (here: only) record. */
const LAST_RECORD_DELIMITER = 0x02;
const VAPID_EXPIRATION_SECONDS = 12 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;

export function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** HKDF (RFC 5869) with a single-block expand — every length here is ≤ 32. */
function hkdf(salt: Buffer, inputKeyMaterial: Buffer, info: Buffer, length: number): Buffer {
  const pseudoRandomKey = hmacSha256(salt, inputKeyMaterial);
  return hmacSha256(pseudoRandomKey, Buffer.concat([info, Buffer.from([0x01])])).subarray(
    0,
    length,
  );
}

/** A fresh VAPID key pair (base64url public point + private scalar). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: toBase64Url(ecdh.getPublicKey()),
    privateKey: toBase64Url(ecdh.getPrivateKey()),
  };
}

/**
 * Encrypt a push message body for one subscription (RFC 8291 §3–4). Returns
 * the full `aes128gcm` body: salt ‖ record size ‖ key id length ‖ sender
 * public key ‖ ciphertext.
 */
export function encryptPayload(
  plaintext: Buffer | string,
  keys: PushSubscriptionKeys,
  overrides: EncryptionOverrides = {},
): Buffer {
  const userAgentPublicKey = fromBase64Url(keys.p256dh);
  const authSecret = fromBase64Url(keys.auth);
  if (userAgentPublicKey.length !== 65) {
    throw new Error("Invalid p256dh: expected a 65-byte uncompressed P-256 point");
  }
  if (authSecret.length < 16) {
    throw new Error("Invalid auth secret: expected 16 bytes");
  }

  const sender = crypto.createECDH("prime256v1");
  if (overrides.senderPrivateKey) {
    sender.setPrivateKey(fromBase64Url(overrides.senderPrivateKey));
  } else {
    sender.generateKeys();
  }
  const senderPublicKey = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(userAgentPublicKey);

  // RFC 8291 §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" ‖ 0 ‖ ua_public ‖ as_public)
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    userAgentPublicKey,
    senderPublicKey,
  ]);
  const inputKeyMaterial = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = overrides.salt ? fromBase64Url(overrides.salt) : crypto.randomBytes(SALT_LENGTH);
  const contentEncryptionKey = hkdf(
    salt,
    inputKeyMaterial,
    Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
    KEY_LENGTH,
  );
  const nonce = hkdf(
    salt,
    inputKeyMaterial,
    Buffer.from("Content-Encoding: nonce\0", "utf8"),
    NONCE_LENGTH,
  );

  const record = Buffer.concat([
    Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, "utf8"),
    Buffer.from([LAST_RECORD_DELIMITER]),
  ]);
  if (record.length + TAG_LENGTH > RECORD_SIZE) {
    throw new Error(`Push payload too large (${record.length - 1} bytes)`);
  }
  const cipher = crypto.createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(SALT_LENGTH + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_LENGTH);
  header.writeUInt8(senderPublicKey.length, SALT_LENGTH + 4);
  return Buffer.concat([header, senderPublicKey, ciphertext]);
}

/**
 * The inverse of encryptPayload, as a user agent would do it. Production
 * never decrypts; tests and the live check use it to read what was sent.
 */
export function decryptPayload(
  body: Buffer,
  userAgentPrivateKey: string,
  authSecretBase64Url: string,
): Buffer {
  const salt = body.subarray(0, SALT_LENGTH);
  const keyIdLength = body.readUInt8(SALT_LENGTH + 4);
  const senderPublicKey = body.subarray(SALT_LENGTH + 5, SALT_LENGTH + 5 + keyIdLength);
  const ciphertext = body.subarray(SALT_LENGTH + 5 + keyIdLength);

  const userAgent = crypto.createECDH("prime256v1");
  userAgent.setPrivateKey(fromBase64Url(userAgentPrivateKey));
  const sharedSecret = userAgent.computeSecret(senderPublicKey);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    userAgent.getPublicKey(),
    senderPublicKey,
  ]);
  const inputKeyMaterial = hkdf(fromBase64Url(authSecretBase64Url), sharedSecret, keyInfo, 32);
  const contentEncryptionKey = hkdf(
    salt,
    inputKeyMaterial,
    Buffer.from("Content-Encoding: aes128gcm\0", "utf8"),
    KEY_LENGTH,
  );
  const nonce = hkdf(salt, inputKeyMaterial, Buffer.from("Content-Encoding: nonce\0", "utf8"), NONCE_LENGTH);

  const decipher = crypto.createDecipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)),
    decipher.final(),
  ]);
  // Strip padding: trailing zeros, then the delimiter.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  return record.subarray(0, end);
}

/** The VAPID `Authorization` header value for one push service endpoint. */
export function buildVapidAuthorization(
  endpoint: string,
  vapid: VapidDetails,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const publicKey = fromBase64Url(vapid.publicKey);
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: toBase64Url(publicKey.subarray(1, 33)),
      y: toBase64Url(publicKey.subarray(33, 65)),
    },
    format: "jwk",
  });
  const header = toBase64Url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: nowSeconds + VAPID_EXPIRATION_SECONDS,
        sub: vapid.subject,
      }),
    ),
  );
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * POST one encrypted message to a subscription's push service. Resolves
 * with the service's status (201 accepted; 404/410 mean the subscription
 * is gone and should be forgotten); rejects only on network failure.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: string,
  vapid: VapidDetails,
  options: WebPushSendOptions = {},
): Promise<WebPushSendResult> {
  const body = encryptPayload(payload, subscription.keys);
  const headers: Record<string, string> = {
    Authorization: buildVapidAuthorization(subscription.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  if (options.urgency) headers.Urgency = options.urgency;
  if (options.topic) headers.Topic = options.topic;

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS),
  });
  return { statusCode: response.status, body: await response.text().catch(() => "") };
}

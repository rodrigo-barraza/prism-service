/**
 * WebPushProtocol — the local RFC 8291 / RFC 8292 implementation that
 * replaces the `web-push` dependency. The encryption is pinned to the
 * RFC 8291 Appendix A test vector byte for byte; VAPID is checked the way a
 * push service would check it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  buildVapidAuthorization,
  decryptPayload,
  encryptPayload,
  fromBase64Url,
  generateVapidKeys,
  sendWebPush,
  toBase64Url,
} from "#src/services/push/WebPushProtocol";

/** RFC 8291 Appendix A. */
const RFC_8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  userAgentPrivateKey: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  userAgentPublicKey:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function newUserAgent() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    privateKey: toBase64Url(ecdh.getPrivateKey()),
    keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) },
  };
}

describe("encryptPayload (RFC 8291, aes128gcm)", () => {
  it("reproduces the RFC 8291 Appendix A message byte for byte", () => {
    const body = encryptPayload(
      RFC_8291.plaintext,
      { p256dh: RFC_8291.userAgentPublicKey, auth: RFC_8291.authSecret },
      { senderPrivateKey: RFC_8291.senderPrivateKey, salt: RFC_8291.salt },
    );
    expect(toBase64Url(body)).toBe(RFC_8291.body);
  });

  it("decrypts the RFC message with the user agent's key", () => {
    const plaintext = decryptPayload(
      fromBase64Url(RFC_8291.body),
      RFC_8291.userAgentPrivateKey,
      RFC_8291.authSecret,
    );
    expect(plaintext.toString("utf8")).toBe(RFC_8291.plaintext);
  });

  it("round-trips a fresh message with a random key and salt", () => {
    const userAgent = newUserAgent();
    const payload = JSON.stringify({ kind: "approval_required", conversationId: "c-1" });
    const first = encryptPayload(payload, userAgent.keys);
    const second = encryptPayload(payload, userAgent.keys);
    expect(first.equals(second)).toBe(false);
    expect(decryptPayload(first, userAgent.privateKey, userAgent.keys.auth).toString()).toBe(payload);
  });

  it("refuses keys that are not a P-256 point / 16-byte secret, and payloads over one record", () => {
    const { keys } = newUserAgent();
    expect(() => encryptPayload("x", { ...keys, p256dh: toBase64Url(Buffer.alloc(33)) })).toThrow();
    expect(() => encryptPayload("x", { ...keys, auth: toBase64Url(Buffer.alloc(4)) })).toThrow();
    expect(() => encryptPayload("x".repeat(4096), keys)).toThrow(/too large/);
  });
});

describe("buildVapidAuthorization (RFC 8292)", () => {
  it("signs an ES256 JWT for the push service's origin that verifies with the public key", () => {
    const vapid = { ...generateVapidKeys(), subject: "https://prism.example" };
    const header = buildVapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc:def",
      vapid,
      1_800_000_000,
    );
    const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
    expect(match).not.toBeNull();
    const [, encodedHeader, encodedClaims, encodedSignature, publicKey] = match!;

    expect(publicKey).toBe(vapid.publicKey);
    expect(JSON.parse(fromBase64Url(encodedHeader).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(fromBase64Url(encodedClaims).toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_800_000_000 + 12 * 60 * 60,
      sub: "https://prism.example",
    });

    const point = fromBase64Url(vapid.publicKey);
    const verifyKey = crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: toBase64Url(point.subarray(1, 33)),
        y: toBase64Url(point.subarray(33, 65)),
      },
      format: "jwk",
    });
    const isValid = crypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: verifyKey, dsaEncoding: "ieee-p1363" },
      fromBase64Url(encodedSignature),
    );
    expect(isValid).toBe(true);
  });
});

describe("sendWebPush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the encrypted body with the Web Push headers and returns the service's status", async () => {
    const userAgent = newUserAgent();
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const vapid = { ...generateVapidKeys(), subject: "https://prism.example" };

    const result = await sendWebPush(
      { endpoint: "https://push.example/send/xyz", keys: userAgent.keys },
      '{"hello":"world"}',
      vapid,
      { ttlSeconds: 120, urgency: "high" },
    );

    expect(result.statusCode).toBe(201);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://push.example/send/xyz");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "120",
      Urgency: "high",
    });
    expect(init.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    const plaintext = decryptPayload(Buffer.from(init.body), userAgent.privateKey, userAgent.keys.auth);
    expect(plaintext.toString()).toBe('{"hello":"world"}');
  });
});

/**
 * /push routes — browser subscriptions are owned by the requesting
 * {username, profileId}: created there, listed there, deletable only there.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import crypto from "node:crypto";
import { app } from "./setup.ts";
import pushRouter from "#src/routes/PushRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

app.use("/push", pushRouter);

/** A subscription a browser would hand over: a real P-256 point and a 16-byte secret. */
function browserSubscription(endpoint: string) {
  const userAgent = crypto.createECDH("prime256v1");
  userAgent.generateKeys();
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: userAgent.getPublicKey().toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    },
  };
}

const RODRIGO = { "x-username": "rodrigo", "x-project": "prism-test" };
const RODRIGO_WORK = { ...RODRIGO, "x-profile-id": "work" };
const SOMEONE_ELSE = { "x-username": "someone", "x-project": "prism-test" };

describe("/push routes", () => {
  const agent = supertest(app);
  let subscriptions: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    subscriptions = createMockCollection();
    vi.mocked(MongoWrapper.getDb).mockReturnValue({
      collection: (name: string) =>
        name === COLLECTIONS.PUSH_SUBSCRIPTIONS ? subscriptions : createMockCollection(),
    } as never);
  });

  it("GET /push/vapid-public-key reports Web Push off when no keys are configured", async () => {
    const response = await agent.get("/push/vapid-public-key").set(RODRIGO).expect(200);
    expect(response.body).toEqual({ enabled: false, publicKey: null });
  });

  it("POST stores the subscription under the caller's username and profile", async () => {
    const subscription = browserSubscription("https://fcm.googleapis.com/fcm/send/abc");
    await agent.post("/push/subscriptions").set(RODRIGO_WORK).send(subscription).expect(201);

    const stored = await subscriptions.find({}).toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      username: "rodrigo",
      profileId: "work",
      project: "prism-test",
    });
  });

  it("GET lists only the caller's own subscriptions, per profile", async () => {
    await agent.post("/push/subscriptions").set(RODRIGO).send(browserSubscription("https://push.example/default")).expect(201);
    await agent.post("/push/subscriptions").set(RODRIGO_WORK).send({ subscription: browserSubscription("https://push.example/work") }).expect(201);
    await agent.post("/push/subscriptions").set(SOMEONE_ELSE).send(browserSubscription("https://push.example/other")).expect(201);

    const mine = await agent.get("/push/subscriptions").set(RODRIGO).expect(200);
    expect(mine.body.items.map((item: { endpoint: string }) => item.endpoint)).toEqual([
      "https://push.example/default",
    ]);
    expect(mine.body.items[0].keys).toBeUndefined();

    const work = await agent.get("/push/subscriptions").set(RODRIGO_WORK).expect(200);
    expect(work.body.items.map((item: { endpoint: string }) => item.endpoint)).toEqual([
      "https://push.example/work",
    ]);
  });

  it("re-subscribing the same endpoint updates it instead of duplicating it", async () => {
    const endpoint = "https://push.example/same-browser";
    await agent.post("/push/subscriptions").set(RODRIGO).send(browserSubscription(endpoint)).expect(201);
    await agent.post("/push/subscriptions").set(RODRIGO).send(browserSubscription(endpoint)).expect(201);
    expect(await subscriptions.find({}).toArray()).toHaveLength(1);
  });

  it("DELETE removes the caller's subscription, and not another owner's", async () => {
    const endpoint = "https://push.example/to-delete";
    await agent.post("/push/subscriptions").set(RODRIGO).send(browserSubscription(endpoint)).expect(201);

    await agent.delete("/push/subscriptions").set(SOMEONE_ELSE).send({ endpoint }).expect(404);
    await agent.delete("/push/subscriptions").set(RODRIGO_WORK).send({ endpoint }).expect(404);
    expect(await subscriptions.find({}).toArray()).toHaveLength(1);

    await agent.delete("/push/subscriptions").set(RODRIGO).send({ endpoint }).expect(200);
    expect(await subscriptions.find({}).toArray()).toHaveLength(0);
  });

  it("rejects malformed subscriptions with 400", async () => {
    const valid = browserSubscription("https://push.example/x");
    const cases = [
      {},
      { ...valid, endpoint: "not a url" },
      { ...valid, endpoint: "http://push.example/insecure" },
      { ...valid, keys: { auth: valid.keys.auth } },
      { ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(33, 2).toString("base64url") } },
      { ...valid, keys: { ...valid.keys, auth: Buffer.alloc(8).toString("base64url") } },
    ];
    for (const body of cases) {
      await agent.post("/push/subscriptions").set(RODRIGO).send(body).expect(400);
    }
    await agent.delete("/push/subscriptions").set(RODRIGO).send({}).expect(400);
    expect(await subscriptions.find({}).toArray()).toHaveLength(0);
  });

  it("accepts a plain-http endpoint only on localhost (a development push service)", async () => {
    await agent.post("/push/subscriptions").set(RODRIGO).send(browserSubscription("http://localhost:9999/push")).expect(201);
  });
});

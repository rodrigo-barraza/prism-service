import { ObjectId } from "mongodb";

/**
 * A small in-memory stand-in for the Mongo `Db` — enough for the MCP OAuth
 * store and routes: equality filters (ObjectId compared by value), $set /
 * $unset / $setOnInsert updates with upsert, insertOne, findOne, find.
 */
type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value instanceof ObjectId) return String(doc[key]) === String(value);
    if (value && typeof value === "object" && "$in" in value) {
      return (value.$in as unknown[]).includes(doc[key] ?? null);
    }
    return doc[key] === value;
  });
}

export function createMemoryDb() {
  const collections = new Map<string, Doc[]>();
  const docsOf = (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name)!;
  };
  const collection = (name: string) => ({
    findOne: async (filter: Doc) => docsOf(name).find((doc) => matches(doc, filter)) ?? null,
    find: (filter: Doc = {}) => ({
      toArray: async () => docsOf(name).filter((doc) => matches(doc, filter)),
    }),
    insertOne: async (doc: Doc) => {
      const _id = doc._id ?? new ObjectId();
      docsOf(name).push({ ...doc, _id });
      return { insertedId: _id };
    },
    updateOne: async (
      filter: Doc,
      update: { $set?: Doc; $unset?: Doc; $setOnInsert?: Doc },
      options: { upsert?: boolean } = {},
    ) => {
      let doc = docsOf(name).find((candidate) => matches(candidate, filter));
      if (!doc) {
        if (!options.upsert) return { matchedCount: 0 };
        doc = { _id: new ObjectId(), ...filter, ...(update.$setOnInsert ?? {}) };
        docsOf(name).push(doc);
      }
      Object.assign(doc, update.$set ?? {});
      for (const field of Object.keys(update.$unset ?? {})) delete doc[field];
      return { matchedCount: 1 };
    },
  });
  return {
    db: { collection } as never,
    docs: docsOf,
  };
}

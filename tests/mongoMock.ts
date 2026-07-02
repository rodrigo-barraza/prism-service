import { vi } from "vitest";

/**
 * Shared MongoDB Mock Engine
 * ════════════════════════════════════════════════════════════════
 *
 * Provides a functional in-memory mock for MongoDB collections that
 * supports:
 *   - Basic CRUD (find, findOne, updateOne, deleteMany, countDocuments)
 *   - Aggregation Pipelines ($set, $gt, $ifNull, $or, $and, $eq, $max, $add)
 *   - Upsert logic
 *   - MongoDB Constraints (Disjoint-path constraint for $set/$setOnInsert)
 *
 * ⚠️ WARNING: This is "Shadow Logic". It reimplements a subset of
 * MongoDB's behavior. Use only for unit tests.
 */

export function evaluateMongoExpression(doc: any, expression: any): any {
  if (expression && typeof expression === "object" && !Array.isArray(expression)) {
    // Stage-level operators
    if ("$gt" in expression) {
      const args = expression.$gt;
      if (Array.isArray(args) && args.length === 2) {
        return evaluateMongoExpression(doc, args[0]) > evaluateMongoExpression(doc, args[1]);
      }
    }
    if ("$ifNull" in expression) {
      const args = expression.$ifNull;
      if (Array.isArray(args) && args.length === 2) {
        const left = evaluateMongoExpression(doc, args[0]);
        const right = evaluateMongoExpression(doc, args[1]);
        return left !== undefined && left !== null ? left : right;
      }
    }
    if ("$or" in expression) {
      const args = expression.$or;
      if (Array.isArray(args)) {
        return args.some(arg => evaluateMongoExpression(doc, arg));
      }
    }
    if ("$and" in expression) {
      const args = expression.$and;
      if (Array.isArray(args)) {
        return args.every(arg => evaluateMongoExpression(doc, arg));
      }
    }
    if ("$eq" in expression) {
      const args = expression.$eq;
      if (Array.isArray(args) && args.length === 2) {
        return evaluateMongoExpression(doc, args[0]) === evaluateMongoExpression(doc, args[1]);
      }
    }
    if ("$max" in expression) {
      const args = expression.$max;
      if (Array.isArray(args)) {
        return Math.max(...args.map(arg => evaluateMongoExpression(doc, arg)));
      }
    }
    if ("$add" in expression) {
      const args = expression.$add;
      if (Array.isArray(args)) {
        return args.map(arg => evaluateMongoExpression(doc, arg)).reduce((a, b) => a + b, 0);
      }
    }

    // Fallback for simple query operators (used in find/findOne)
    for (const [key, val] of Object.entries(expression)) {
      if (key === "$or") {
        return (val as any[]).some(sub => evaluateMongoExpression(doc, sub));
      }
      if (val && typeof val === "object" && "$in" in (val as any)) {
        return ((val as any).$in as any[]).includes(doc[key]);
      }
      if (val && typeof val === "object" && "$ne" in (val as any)) {
        return doc[key] !== (val as any).$ne;
      }
      const docVal = doc[key];
      if (docVal && val && typeof docVal === "object" && typeof val === "object" && docVal.toString && val.toString) {
        if (docVal.toString() !== val.toString()) return false;
      } else if (docVal !== val) {
        return false;
      }
    }
    return true;
  }

  // Field references: "$fieldName"
  if (typeof expression === "string" && expression.startsWith("$")) {
    return doc[expression.slice(1)];
  }

  return expression;
}

export function createMockCollection(initialData: any[] = []) {
  const documents = new Map<string, any>();
  
  initialData.forEach(doc => {
    const key = doc.id || doc._id || Math.random().toString();
    documents.set(key, { ...doc });
  });

  const collection = {
    _docs: documents,

    find: (query: any = {}) => {
      let sortCriteria: any = null;
      const cursor = {
        project: () => cursor,
        limit: () => cursor,
        sort: (criteria: any) => {
          sortCriteria = criteria;
          return cursor;
        },
        toArray: async () => {
          let results = Array.from(documents.values()).filter(doc => evaluateMongoExpression(doc, query));
          if (sortCriteria) {
            const [field, order] = Object.entries(sortCriteria)[0];
            results.sort((a, b) => {
              const valA = a[field];
              const valB = b[field];
              if (valA < valB) return order === -1 ? 1 : -1;
              if (valA > valB) return order === -1 ? -1 : 1;
              return 0;
            });
          }
          return results;
        },
      };
      return cursor;
    },

    findOne: async (query: any) => {
      return Array.from(documents.values()).find(doc => evaluateMongoExpression(doc, query)) || null;
    },

    async updateOne(filter: any, update: any, options: any = {}) {
      let doc = Array.from(documents.values()).find(d => evaluateMongoExpression(d, filter));
      const isInsert = !doc;

      if (Array.isArray(update)) {
        // Aggregation Pipeline mode
        if (isInsert && options.upsert) {
          doc = { ...filter };
          documents.set(JSON.stringify(filter), doc);
        } else if (isInsert) {
          return { matchedCount: 0, modifiedCount: 0 };
        }

        for (const stage of update) {
          if (stage.$set) {
            for (const [field, expr] of Object.entries(stage.$set)) {
              doc[field] = evaluateMongoExpression(doc, expr);
            }
          }
        }
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: isInsert ? 1 : 0 };
      } 

      // Standard Update mode
      const $set = update.$set || {};
      const $setOnInsert = update.$setOnInsert || {};
      const $push = update.$push || {};
      const $inc = update.$inc || {};

      // Enforce disjoint-path constraint
      const setKeys = new Set(Object.keys($set));
      const conflicts = Object.keys($setOnInsert).filter(k => setKeys.has(k));
      if (conflicts.length > 0) {
        const error = new Error(`Updating the path '${conflicts[0]}' would create a conflict at '${conflicts[0]}'`) as any;
        error.name = "MongoServerError";
        error.code = 40;
        throw error;
      }

      if (isInsert && options.upsert) {
        doc = { ...filter, ...$setOnInsert };
        documents.set(JSON.stringify(filter), doc);
      } else if (isInsert) {
        return { matchedCount: 0, modifiedCount: 0 };
      }

      if (doc) {
        Object.assign(doc, $set);
        if (isInsert) Object.assign(doc, $setOnInsert);

        for (const [field, val] of Object.entries($push)) {
          if (!doc[field]) doc[field] = [];
          if ((val as any).$each) {
            doc[field].push(...(val as any).$each);
          } else {
            doc[field].push(val);
          }
        }

        for (const [field, val] of Object.entries($inc)) {
          doc[field] = (doc[field] || 0) + (val as number);
        }

        return { matchedCount: 1, modifiedCount: 1, upsertedCount: isInsert ? 1 : 0 };
      }

      return { matchedCount: 0, modifiedCount: 0 };
    },

    countDocuments: async (query: any = {}) => {
      return Array.from(documents.values()).filter(doc => evaluateMongoExpression(doc, query)).length;
    },

    async insertOne(doc: any) {
      const key = doc.id || doc._id || Math.random().toString();
      const newDoc = { ...doc };
      if (!newDoc._id && !newDoc.id) newDoc._id = key;
      documents.set(key, newDoc);
      return { insertedId: key };
    },

    async deleteOne(query: any) {
      const docEntry = Array.from(documents.entries()).find(([, d]) => evaluateMongoExpression(d, query));
      if (docEntry) {
        documents.delete(docEntry[0]);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },

    deleteMany: async (query: any = {}) => {
      const all = Array.from(documents.entries());
      let deletedCount = 0;
      for (const [key, doc] of all) {
        if (evaluateMongoExpression(doc, query)) {
          documents.delete(key);
          deletedCount++;
        }
      }
      return { deletedCount };
    },

    _setData: (newData: any[]) => {
      documents.clear();
      newData.forEach(doc => {
        const key = doc.id || doc._id || Math.random().toString();
        documents.set(key, { ...doc });
      });
    }
  };

  return collection;
}

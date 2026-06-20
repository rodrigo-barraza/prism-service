import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import adminRouter from "../src/routes/AdminRoutes.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import { COLLECTIONS, PROVIDERS } from "../src/constants.ts";


app.use("/admin", adminRouter);

function runAggregation(documents: any[], pipeline: any[]): any[] {
  let currentDocuments = JSON.parse(JSON.stringify(documents));

  for (const stage of pipeline) {
    if (stage.$match) {
      const match = stage.$match;
      currentDocuments = currentDocuments.filter((doc: any) => {
        for (const [key, value] of Object.entries(match)) {
          if (value && typeof value === "object" && "$exists" in value) {
            const exists = (value as any).$exists;
            const hasField = key in doc && doc[key] !== undefined && doc[key] !== null;
            if (exists && !hasField) return false;
            if (!exists && hasField) return false;
          } else if (value && typeof value === "object" && "$ne" in value) {
            const neValue = (value as any).$ne;
            if (Array.isArray(doc[key]) && Array.isArray(neValue) && doc[key].length === 0 && neValue.length === 0) {
              return false;
            }
            if (doc[key] === neValue) return false;
          } else {
            if (doc[key] !== value) return false;
          }
        }
        return true;
      });
    } else if (stage.$addFields) {
      const addFields = stage.$addFields;
      for (const doc of currentDocuments) {
        for (const [key, expression] of Object.entries(addFields)) {
          if (expression && typeof expression === "object") {
            if ("$size" in expression) {
              const sizeExpr = (expression as any).$size;
              if (sizeExpr && typeof sizeExpr === "object" && "$ifNull" in sizeExpr) {
                const ifNullArr = sizeExpr.$ifNull;
                const fieldName = ifNullArr[0].replace("$", "");
                const val = doc[fieldName] !== undefined ? doc[fieldName] : ifNullArr[1];
                doc[key] = Array.isArray(val) ? val.length : 0;
              } else if (typeof sizeExpr === "string") {
                const fieldName = sizeExpr.replace("$", "");
                doc[key] = Array.isArray(doc[fieldName]) ? doc[fieldName].length : 0;
              }
            } else if ("$size" in doc && typeof expression === "string") {
              const fieldName = (expression as any).replace("$", "");
              doc[key] = Array.isArray(doc[fieldName]) ? doc[fieldName].length : 0;
            }
          }
        }
      }
    } else if (stage.$unwind) {
      const fieldPath = stage.$unwind.replace("$", "");
      const unwound: any[] = [];
      for (const doc of currentDocuments) {
        const val = doc[fieldPath];
        if (Array.isArray(val)) {
          for (const item of val) {
            unwound.push({
              ...doc,
              [fieldPath]: item,
            });
          }
        } else if (val !== undefined && val !== null) {
          unwound.push({ ...doc });
        }
      }
      currentDocuments = unwound;
    } else if (stage.$group) {
      const group = stage.$group;
      const idExpr = group._id.replace("$", "");
      const groups = new Map<string, any[]>();
      for (const doc of currentDocuments) {
        const key = doc[idExpr];
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(doc);
      }

      const groupedDocs: any[] = [];
      for (const [groupId, docsInGroup] of groups.entries()) {
        const groupedDoc: any = { _id: groupId };
        for (const [key, op] of Object.entries(group)) {
          if (key === "_id") continue;
          if (op && typeof op === "object") {
            if ("$sum" in op) {
              const sumExpr = (op as any).$sum;
              if (sumExpr === 1) {
                groupedDoc[key] = docsInGroup.length;
              } else if (sumExpr && typeof sumExpr === "object") {
                if ("$cond" in sumExpr) {
                  const cond = sumExpr.$cond;
                  const condition = cond[0];
                  if (condition && condition.$eq) {
                    const fieldName = condition.$eq[0].replace("$", "");
                    const val = condition.$eq[1];
                    groupedDoc[key] = docsInGroup.reduce((totalSum, doc) => {
                      return totalSum + (doc[fieldName] === val ? cond[1] : cond[2]);
                    }, 0);
                  } else if (condition && condition.$gt) {
                    const fieldName = condition.$gt[0].replace("$", "");
                    const val = condition.$gt[1];
                    groupedDoc[key] = docsInGroup.reduce((totalSum, doc) => {
                      if (doc[fieldName] > val) {
                        const trueExpr = cond[1];
                        if (trueExpr && typeof trueExpr === "object" && "$divide" in trueExpr) {
                          const divideArgs = trueExpr.$divide;
                          const numeratorExpr = divideArgs[0];
                          const denominatorExpr = divideArgs[1];
                          let numeratorVal = 0;
                          if (typeof numeratorExpr === "string") {
                            numeratorVal = doc[numeratorExpr.replace("$", "")] || 0;
                          } else if (numeratorExpr && typeof numeratorExpr === "object" && "$ifNull" in numeratorExpr) {
                            const field = numeratorExpr.$ifNull[0].replace("$", "");
                            numeratorVal = doc[field] !== undefined ? doc[field] : numeratorExpr.$ifNull[1];
                          }
                          const denominatorVal = typeof denominatorExpr === "string"
                            ? doc[denominatorExpr.replace("$", "")] || 1
                            : denominatorExpr;
                          return totalSum + (numeratorVal / denominatorVal);
                        }
                        return totalSum + 1;
                      }
                      return totalSum + cond[2];
                    }, 0);
                  }
                } else if ("$ifNull" in sumExpr) {
                  const ifNullArr = sumExpr.$ifNull;
                  const fieldName = ifNullArr[0].replace("$", "");
                  groupedDoc[key] = docsInGroup.reduce((totalSum, doc) => {
                    const val = doc[fieldName] !== undefined ? doc[fieldName] : ifNullArr[1];
                    return totalSum + val;
                  }, 0);
                }
              }
            } else if ("$addToSet" in op) {
              const setExpr = (op as any).$addToSet.replace("$", "");
              const uniqueVals = new Set(docsInGroup.map((doc) => doc[setExpr]).filter(Boolean));
              groupedDoc[key] = Array.from(uniqueVals);
            } else if ("$avg" in op) {
              const avgExpr = (op as any).$avg;
              if (avgExpr && typeof avgExpr === "object" && "$ifNull" in avgExpr) {
                const ifNullArr = avgExpr.$ifNull;
                const fieldName = ifNullArr[0].replace("$", "");
                const total = docsInGroup.reduce((totalSum, doc) => {
                  const val = doc[fieldName] !== undefined ? doc[fieldName] : ifNullArr[1];
                  return totalSum + val;
                }, 0);
                groupedDoc[key] = total / docsInGroup.length;
              }
            } else if ("$min" in op) {
              const minExpr = (op as any).$min.replace("$", "");
              const vals = docsInGroup.map((doc) => doc[minExpr]).filter(Boolean);
              groupedDoc[key] = vals.length ? vals.reduce((a, b) => (a < b ? a : b)) : null;
            } else if ("$max" in op) {
              const maxExpr = (op as any).$max.replace("$", "");
              const vals = docsInGroup.map((doc) => doc[maxExpr]).filter(Boolean);
              groupedDoc[key] = vals.length ? vals.reduce((a, b) => (a > b ? a : b)) : null;
            } else if ("$push" in op) {
              const pushExpr = (op as any).$push.replace("$", "");
              groupedDoc[key] = docsInGroup.map((doc) => doc[pushExpr]).filter(Boolean);
            }
          }
        }
        groupedDocs.push(groupedDoc);
      }
      currentDocuments = groupedDocs;
    } else if (stage.$sort) {
      const sort = stage.$sort;
      const [key, order] = Object.entries(sort)[0];
      currentDocuments.sort((firstDoc: any, secondDoc: any) => {
        if (firstDoc[key] < secondDoc[key]) return (order as number) === -1 ? 1 : -1;
        if (firstDoc[key] > secondDoc[key]) return (order as number) === -1 ? -1 : 1;
        return 0;
      });
    }
  }

  return currentDocuments;
}

describe("GET /admin/stats/tools", () => {
  let mockDocuments: any[] = [];

  beforeEach(() => {
    mockDocuments = [
      {
        requestId: "request-1",
        toolApiNames: ["get_weather"],
        estimatedCost: 0.02,
        inputTokens: 1000,
        outputTokens: 500,
        totalTime: 120,
        success: true,
        model: "gpt-4o",
        agent: "CODING",
        provider: PROVIDERS.OPENAI,
        timestamp: "2026-05-30T10:00:00Z",
      },
      {
        requestId: "request-2",
        toolApiNames: ["get_weather", "search_web"],
        estimatedCost: 0.06,
        inputTokens: 3000,
        outputTokens: 1000,
        totalTime: 240,
        success: true,
        model: "gpt-4o",
        agent: "CODING",
        provider: PROVIDERS.OPENAI,
        timestamp: "2026-05-30T10:05:00Z",
      },
    ];

    const mockDb = {
      collection: () => ({
        aggregate: (pipeline: any[]) => ({
          toArray: async () => runAggregation(mockDocuments, pipeline),
        }),
      }),
    };

    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  it("calculates proportional cost and tokens correctly for multiple tool requests", async () => {
    const apiResponse = await request(app)
      .get("/admin/stats/tools")
      .set("x-gateway-secret", "test-secret")
      .expect(200);

    const getWeatherData = apiResponse.body.find((item: any) => item.tool === "get_weather");
    const searchWebData = apiResponse.body.find((item: any) => item.tool === "search_web");

    expect(getWeatherData).toBeDefined();
    expect(searchWebData).toBeDefined();

    // get_weather:
    // Request 1: 1 tool, full cost = 0.02, input = 1000, output = 500
    // Request 2: 2 tools, shared cost = 0.06 / 2 = 0.03, input = 3000 / 2 = 1500, output = 1000 / 2 = 500
    // Expected: cost = 0.05, input = 2500, output = 1000
    expect(getWeatherData.totalCalls).toBe(2);
    expect(getWeatherData.totalRequests).toBe(2);
    expect(getWeatherData.totalCost).toBeCloseTo(0.05);
    expect(getWeatherData.totalInputTokens).toBe(2500);
    expect(getWeatherData.totalOutputTokens).toBe(1000);

    // search_web:
    // Request 2: 2 tools, shared cost = 0.06 / 2 = 0.03, input = 3000 / 2 = 1500, output = 1000 / 2 = 500
    // Expected: cost = 0.03, input = 1500, output = 500
    expect(searchWebData.totalCalls).toBe(1);
    expect(searchWebData.totalRequests).toBe(1);
    expect(searchWebData.totalCost).toBeCloseTo(0.03);
    expect(searchWebData.totalInputTokens).toBe(1500);
    expect(searchWebData.totalOutputTokens).toBe(500);
  });

  describe("GET /admin/stats with advanced filters", () => {
    let mockRequests: any[] = [];
    let mockModelConvs: any[] = [];
    let mockAgentConvs: any[] = [];

    beforeEach(() => {
      mockRequests = [
        {
          requestId: "req-1",
          conversationId: "conv-1",
          project: "project-a",
          agent: "agent-a",
          provider: PROVIDERS.OPENAI,
          model: "gpt-4o",
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 0.01,
          totalTime: 5,
          success: true,
          timestamp: "2026-05-30T10:00:00Z"
        },
        {
          requestId: "req-2",
          agentConversationId: "session-2",
          project: "project-b",
          agent: "agent-b",
          provider: PROVIDERS.ANTHROPIC,
          model: "claude-3",
          inputTokens: 200,
          outputTokens: 100,
          estimatedCost: 0.02,
          totalTime: 10,
          success: true,
          timestamp: "2026-05-30T10:05:00Z"
        }
      ];

      mockModelConvs = [
        { id: "conv-1", workspaceRoot: "/workspace/a" }
      ];

      mockAgentConvs = [
        { id: "session-2", workspaceRoot: "/workspace/b" }
      ];

      const mockDb = {
        collection: (name: string) => {
          if (name === COLLECTIONS.REQUESTS) {
            return {
              aggregate: (pipeline: any[]) => {
                return {
                  toArray: async () => {
                    const matchStage = pipeline.find(stage => stage.$match)?.$match || {};
                    let filtered = [...mockRequests];
                    if (matchStage) {
                      filtered = filtered.filter(doc => {
                        if (matchStage.project && doc.project !== matchStage.project) return false;
                        if (matchStage.agent) {
                          if (matchStage.agent.$in) {
                            if (!matchStage.agent.$in.includes(doc.agent)) return false;
                          } else if (doc.agent !== matchStage.agent) return false;
                        }
                        if (matchStage.provider) {
                          if (matchStage.provider.$in) {
                            if (!matchStage.provider.$in.includes(doc.provider)) return false;
                          } else if (doc.provider !== matchStage.provider) return false;
                        }
                        if (matchStage.model) {
                          if (matchStage.model.$in) {
                            if (!matchStage.model.$in.includes(doc.model)) return false;
                          } else if (doc.model !== matchStage.model) return false;
                        }
                        if (matchStage.$or) {
                          const orMatch = matchStage.$or.some((clause: any) => {
                            if (clause.conversationId && clause.conversationId.$in) {
                              return clause.conversationId.$in.includes(doc.conversationId);
                            }
                            if (clause.agentConversationId && clause.agentConversationId.$in) {
                              return clause.agentConversationId.$in.includes(doc.agentConversationId);
                            }
                            return false;
                          });
                          if (!orMatch) return false;
                        }
                        return true;
                      });
                    }

                    const groupStage = pipeline.find(stage => stage.$group)?.$group;
                    if (groupStage) {
                      if (groupStage._id === null) {
                        return [{
                          totalRequests: filtered.length,
                          totalInputTokens: filtered.reduce((sum, d) => sum + d.inputTokens, 0),
                          totalOutputTokens: filtered.reduce((sum, d) => sum + d.outputTokens, 0),
                          totalCost: filtered.reduce((sum, d) => sum + d.estimatedCost, 0),
                          avgLatency: filtered.length ? filtered.reduce((sum, d) => sum + d.totalTime, 0) / filtered.length : 0,
                          successCount: filtered.filter(d => d.success).length,
                          errorCount: filtered.filter(d => !d.success).length,
                        }];
                      }
                    }
                    return filtered;
                  }
                };
              },
              countDocuments: async () => mockRequests.length
            };
          } else if (name === COLLECTIONS.MODEL_CONVERSATIONS) {
            return {
              find: (query: any) => {
                const filtered = mockModelConvs.filter(c => c.workspaceRoot === query.workspaceRoot);
                return {
                  project: () => ({
                    toArray: async () => filtered
                  })
                };
              },
              countDocuments: async (query: any) => {
                let filtered = [...mockModelConvs];
                if (query.project) filtered = filtered.filter(c => c.project === query.project);
                if (query.workspaceRoot) filtered = filtered.filter(c => c.workspaceRoot === query.workspaceRoot);
                return filtered.length;
              }
            };
          } else if (name === COLLECTIONS.AGENT_CONVERSATIONS) {
            return {
              find: (query: any) => {
                const filtered = mockAgentConvs.filter(c => c.workspaceRoot === query.workspaceRoot);
                return {
                  project: () => ({
                    toArray: async () => filtered
                  })
                };
              },
              countDocuments: async (query: any) => {
                let filtered = [...mockAgentConvs];
                if (query.project) filtered = filtered.filter(c => c.project === query.project);
                if (query.workspaceRoot) filtered = filtered.filter(c => c.workspaceRoot === query.workspaceRoot);
                return filtered.length;
              }
            };
          }
          return {
            find: () => ({ toArray: async () => [] }),
            countDocuments: async () => 0
          };
        }
      };

      vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
    });

    it("filters stats by provider and model", async () => {
      const resOpenai = await request(app)
        .get("/admin/stats?provider=" + PROVIDERS.OPENAI)
        .set("x-gateway-secret", "test-secret")
        .expect(200);
      expect(resOpenai.body.totalRequests).toBe(1);

      const resAnthropic = await request(app)
        .get("/admin/stats?provider=" + PROVIDERS.ANTHROPIC)
        .set("x-gateway-secret", "test-secret")
        .expect(200);
      expect(resAnthropic.body.totalRequests).toBe(1);

      const resGpt = await request(app)
        .get("/admin/stats?model=gpt-4o")
        .set("x-gateway-secret", "test-secret")
        .expect(200);
      expect(resGpt.body.totalRequests).toBe(1);
    });

    it("filters stats by workspace", async () => {
      const resWorkspaceA = await request(app)
        .get("/admin/stats?workspace=%2Fworkspace%2Fa")
        .set("x-gateway-secret", "test-secret")
        .expect(200);
      expect(resWorkspaceA.body.totalRequests).toBe(1);

      const resWorkspaceB = await request(app)
        .get("/admin/stats?workspace=%2Fworkspace%2Fb")
        .set("x-gateway-secret", "test-secret")
        .expect(200);
      expect(resWorkspaceB.body.totalRequests).toBe(1);
    });
  });
});

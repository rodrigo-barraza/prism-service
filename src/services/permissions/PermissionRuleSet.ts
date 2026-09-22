import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { DEFAULT_PROFILE_ID } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import { evaluateRules, type CompiledPermissionRule, type RulesEvaluation } from "./PermissionEvaluator.ts";
import { loadRules, peekRules, type PermissionIdentity } from "./PermissionRuleStore.ts";
import type { MatchableCall } from "./PermissionMatcher.ts";
import type { Capability, PermissionContext, PermissionVerdict } from "./types.ts";

/**
 * PermissionRuleSet — the rules one agentic run is checked against.
 *
 * Built by AgenticLoopService for every entry point (chat route, scheduled
 * task, conversation timer, sub-agent, auto-response) and carried on the
 * loop options as `_permissionRules`, next to the persona `policies`, through
 * every path that builds an AutoApprovalEngine.
 *
 * The run's identity (whose rules) and context (which of them apply) are
 * fixed; the rules themselves are read through the store's cache on each
 * evaluation, so a rule saved mid-turn applies to the next call.
 */
export default class PermissionRuleSet {
  readonly identity: PermissionIdentity;
  readonly context: PermissionContext;
  private readonly snapshot: CompiledPermissionRule[];
  private readonly live: boolean;

  /**
   * `live: false` pins the set to exactly `rules` — for the rules page's
   * tester, which evaluates an unsaved draft beside the stored rules.
   */
  constructor(
    identity: PermissionIdentity,
    context: PermissionContext,
    rules: CompiledPermissionRule[],
    { live = true }: { live?: boolean } = {},
  ) {
    this.identity = identity;
    this.context = context;
    this.snapshot = rules;
    this.live = live;
  }

  /** Live rules for this identity (falls back to the construction snapshot). */
  get rules(): CompiledPermissionRule[] {
    return (this.live && peekRules(this.identity)) || this.snapshot;
  }

  explain(call: MatchableCall, capabilities: readonly Capability[]): RulesEvaluation {
    return evaluateRules(this.rules, call, capabilities, this.context);
  }

  evaluate(call: MatchableCall, capabilities: readonly Capability[]): PermissionVerdict | null {
    return this.explain(call, capabilities).verdict;
  }

  /**
   * The rule set a sub-agent inherits: same identity, its own agent, and the
   * parent's conversations PLUS its own — a rule saved for "this
   * conversation" keeps holding inside the sub-agents it spawns.
   */
  forSubAgent({ agent, conversationId }: { agent?: string | null; conversationId?: string | null }): PermissionRuleSet {
    const conversationIds = conversationId && !this.context.conversationIds.includes(conversationId)
      ? [...this.context.conversationIds, conversationId]
      : this.context.conversationIds;
    return new PermissionRuleSet(
      this.identity,
      { ...this.context, agent: agent ?? this.context.agent, conversationIds },
      this.snapshot,
      { live: this.live },
    );
  }

  /** Load the rule set for a run. Never throws. */
  static async load(scope: {
    username?: string | null;
    profileId?: string | null;
    project?: string | null;
    agent?: string | null;
    conversationId?: string | null;
    workspaceRoot?: string | null;
  }): Promise<PermissionRuleSet> {
    const identity: PermissionIdentity = {
      username: scope.username || "any",
      profileId: scope.profileId || getRequestContext().profileId || DEFAULT_PROFILE_ID,
    };
    const context: PermissionContext = {
      project: scope.project || "any",
      agent: scope.agent ?? null,
      conversationIds: scope.conversationId ? [scope.conversationId] : [],
      workspaceRoot: scope.workspaceRoot ?? null,
    };
    let rules: CompiledPermissionRule[] = [];
    try {
      const [{ default: MongoWrapper }, { MONGO_DB_NAME }] = await Promise.all([
        import("#src/wrappers/MongoWrapper"),
        import("#config"),
      ]);
      rules = await loadRules(MongoWrapper.getDb(MONGO_DB_NAME), identity);
    } catch (error: unknown) {
      logger.warn(`[Permissions] Rule set load failed (continuing without rules): ${errorMessage(error)}`);
    }
    return new PermissionRuleSet(identity, context, rules);
  }
}

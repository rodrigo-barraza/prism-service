import { z } from "zod";
import { parsePermissionRule } from "./PermissionRuleSyntax.ts";
import {
  PERMISSION_DECISIONS,
  PERMISSION_RULE_ORIGINS,
  PERMISSION_SCOPES,
} from "./types.ts";

/**
 * Request schemas for `/permissions`. Kept beside the rule syntax rather than
 * in `src/types/schemas.ts` because the rule-text check IS the parser: a rule
 * is valid exactly when `parsePermissionRule` accepts it and its regex (if
 * any) compiles, so the route refuses anything that would only fail closed.
 */

const ruleText = z
  .string()
  .trim()
  .min(1, "Rule is empty.")
  .max(1_000)
  .superRefine((text, context) => {
    const parsed = parsePermissionRule(text);
    if (!parsed.ok) {
      context.addIssue({ code: "custom", message: parsed.error });
      return;
    }
    if (parsed.rule.kind === "tool" && parsed.rule.argument?.error) {
      context.addIssue({ code: "custom", message: parsed.rule.argument.error });
    }
  });

const identifier = z.string().trim().min(1).max(200);

const ruleFields = {
  rule: ruleText,
  decision: z.enum(PERMISSION_DECISIONS),
  scope: z.enum(PERMISSION_SCOPES),
  conversationId: identifier.nullable().optional(),
  agent: identifier.nullable().optional(),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().optional(),
};

/** A conversation-scoped rule must name its conversation; no other scope may. */
function conversationMatchesScope(
  value: { scope?: string; conversationId?: string | null },
  context: z.RefinementCtx,
): void {
  if (value.scope === "conversation" && !value.conversationId) {
    context.addIssue({
      code: "custom",
      path: ["conversationId"],
      message: "A conversation-scoped rule needs a conversationId.",
    });
  }
}

export const PostPermissionRuleSchema = z
  .object({
    ...ruleFields,
    origin: z.enum(PERMISSION_RULE_ORIGINS).default("user"),
  })
  .strict()
  .superRefine(conversationMatchesScope);

export const PutPermissionRuleSchema = z
  .object({
    rule: ruleFields.rule.optional(),
    decision: ruleFields.decision.optional(),
    scope: ruleFields.scope.optional(),
    conversationId: ruleFields.conversationId,
    agent: ruleFields.agent,
    description: ruleFields.description,
    enabled: ruleFields.enabled,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update.");

const toolCallFields = {
  toolName: z.string().trim().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
  workspaceRoot: z.string().max(4_096).nullable().optional(),
};

/** "Would this call be allowed?" — optionally with an unsaved draft rule. */
export const PostPermissionTestSchema = z
  .object({
    ...toolCallFields,
    conversationId: identifier.nullable().optional(),
    agent: identifier.nullable().optional(),
    autoApprove: z.boolean().optional(),
    draft: z
      .object({ rule: ruleText, decision: z.enum(PERMISSION_DECISIONS) })
      .strict()
      .optional(),
  })
  .strict();

/** The rule "Always allow" would write for one call. */
export const PostPermissionProposeSchema = z.object(toolCallFields).strict();

export type PostPermissionRuleInput = z.infer<typeof PostPermissionRuleSchema>;
export type PutPermissionRuleInput = z.infer<typeof PutPermissionRuleSchema>;

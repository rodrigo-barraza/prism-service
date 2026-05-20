import logger from "../../utils/logger.js";
export default {
    name: "brief",
    schema: {
        name: "brief",
        description: "Produce a compressed summary of the current conversation context. " +
            "Use this tool when the conversation is getting long and you need to " +
            "consolidate your understanding before continuing. The summary you write " +
            "is stored and can be referenced in future turns to recover context. " +
            "This is NOT shown to the user — it is your private working memory.",
        parameters: {
            type: "object",
            properties: {
                summary: {
                    type: "string",
                    description: "Your compressed summary of the conversation so far. Include: " +
                        "key decisions made, files modified, current task state, and what remains to be done.",
                },
                keyFiles: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: list of key file paths relevant to the current work.",
                },
                openQuestions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional: unresolved questions or ambiguities.",
                },
            },
            required: ["summary"],
        },
    },
    domain: "Reasoning",
    labels: ["coding"],
    async execute(args, context) {
        const { summary, keyFiles, openQuestions } = args;
        if (!summary || typeof summary !== "string") {
            return { error: "'summary' is required and must be a non-empty string" };
        }
        const brief = {
            summary,
            keyFiles: keyFiles || [],
            openQuestions: openQuestions || [],
            timestamp: new Date().toISOString(),
        };
        logger.info(`[Brief] ${summary.length} chars, ${(keyFiles || []).length} files, ${(openQuestions || []).length} questions`);
        if (context._emit) {
            context._emit({ type: "brief_update", brief });
        }
        return { acknowledged: true, brief };
    },
};
//# sourceMappingURL=BriefTool.js.map
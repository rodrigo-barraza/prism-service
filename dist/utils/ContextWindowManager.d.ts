export default class ContextWindowManager {
    /**
     * Enforce context window limits on a messages array.
     *
     * Applies truncation strategies in order of aggressiveness until
     * the estimated token count fits within the model's context window.
     *
  
  
     * @returns {{ messages: Array, truncated: boolean, strategy: string|null, estimatedTokens: number }}
     */
    static enforce(messages: any, options?: any): {
        messages: any;
        truncated: boolean;
        strategy: null;
        estimatedTokens: any;
    } | {
        messages: any;
        truncated: boolean;
        strategy: string;
        estimatedTokens: any;
    };
    /**
     * Estimate token count for messages (exposed for diagnostics).
  
  
     */
    static estimateTokens(messages: any): any;
    /**
     * Estimate tokens for a single message (exposed for diagnostics).
  
  
     */
    static estimateMessageTokens(message: string): number;
}
//# sourceMappingURL=ContextWindowManager.d.ts.map
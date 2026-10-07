/**
 * Every unit test runs with prism-service's two credentials configured
 * (vitest.config.ts `setupFiles`): AuthMiddleware fails closed without
 * them, and tests sign in with these values (tests/helpers/auth.ts). Set
 * unconditionally — a real secret in the shell never reaches a test. The
 * tools-service secret is left unset; the tests about it set their own.
 */
export const TEST_USER_TOKEN_SECRET = "test-user-token-secret";
export const TEST_SERVICE_API_SECRET = "test-service-api-secret";

process.env.PRISM_USER_TOKEN_SECRET = TEST_USER_TOKEN_SECRET;
process.env.PRISM_SERVICE_API_SECRET = TEST_SERVICE_API_SECRET;
delete process.env.TOOLS_SERVICE_API_SECRET;
delete process.env.PRISM_ACCESS_TOKEN;

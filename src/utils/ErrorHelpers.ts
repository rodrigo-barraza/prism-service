/**
 * Safely extract an error message from an unknown value.
 * Replaces the ubiquitous `getErrorMessage(error)` pattern.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

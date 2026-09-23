/**
 * Cases — reading a suite case's input.
 */
import type { CaseMessage, SuiteCase } from "#src/types/benchmark";

/** The conversation a case sends: its input as messages. */
export function caseMessages(datasetCase: SuiteCase): CaseMessage[] {
  if (typeof datasetCase.input === "string") return [{ role: "user", content: datasetCase.input }];
  return datasetCase.input.map((message) => ({ role: message.role, content: message.content }));
}

/** The user's last message — the task a judge sees. */
export function caseTask(datasetCase: SuiteCase): string {
  const messages = caseMessages(datasetCase);
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return lastUser?.content ?? "";
}

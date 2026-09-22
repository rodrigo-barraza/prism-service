/**
 * A small line-based unified diff, for approval-card previews of file writes.
 *
 * No dependency: common leading and trailing lines are trimmed first (a
 * write usually changes one region), then the middle is diffed with a
 * longest-common-subsequence table. When the middle is too large for the
 * table the whole middle is shown as removed-then-added, which is still a
 * correct — just less minimal — diff.
 */

const DEFAULT_CONTEXT_LINES = 3;
/** LCS cells (old × new middle lines) above which the table is skipped. */
const MAXIMUM_TABLE_CELLS = 4_000_000;

type Operation = { kind: " " | "-" | "+"; text: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffMiddle(oldLines: string[], newLines: string[]): Operation[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  if (rows === 0) return newLines.map((text) => ({ kind: "+", text }));
  if (columns === 0) return oldLines.map((text) => ({ kind: "-", text }));
  if (rows * columns > MAXIMUM_TABLE_CELLS) {
    return [
      ...oldLines.map((text): Operation => ({ kind: "-", text })),
      ...newLines.map((text): Operation => ({ kind: "+", text })),
    ];
  }

  // lengths[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const lengths: Uint32Array[] = [];
  for (let row = 0; row <= rows; row++) lengths.push(new Uint32Array(columns + 1));
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[row][column] =
        oldLines[row] === newLines[column]
          ? lengths[row + 1][column + 1] + 1
          : Math.max(lengths[row + 1][column], lengths[row][column + 1]);
    }
  }

  const operations: Operation[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldLines[row] === newLines[column]) {
      operations.push({ kind: " ", text: oldLines[row] });
      row++;
      column++;
    } else if (lengths[row + 1][column] >= lengths[row][column + 1]) {
      operations.push({ kind: "-", text: oldLines[row++] });
    } else {
      operations.push({ kind: "+", text: newLines[column++] });
    }
  }
  while (row < rows) operations.push({ kind: "-", text: oldLines[row++] });
  while (column < columns) operations.push({ kind: "+", text: newLines[column++] });
  return operations;
}

/**
 * Unified diff of `oldText` → `newText`, with `--- a/<path>` / `+++ b/<path>`
 * headers and `@@` hunks. Returns "" when the texts are line-identical.
 * `oldText === null` means the file does not exist yet (`--- /dev/null`).
 */
export function createUnifiedDiff(
  filePath: string,
  oldText: string | null,
  newText: string,
  { contextLines = DEFAULT_CONTEXT_LINES }: { contextLines?: number } = {},
): string {
  const oldLines = splitLines(oldText ?? "");
  const newLines = splitLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const operations: Operation[] = [
    ...oldLines.slice(0, prefix).map((text): Operation => ({ kind: " ", text })),
    ...diffMiddle(
      oldLines.slice(prefix, oldLines.length - suffix),
      newLines.slice(prefix, newLines.length - suffix),
    ),
    ...oldLines
      .slice(oldLines.length - suffix)
      .map((text): Operation => ({ kind: " ", text })),
  ];

  const changedIndexes = operations
    .map((operation, index) => (operation.kind === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) return "";

  // Group changes into hunks whose context windows touch or overlap.
  const hunkRanges: Array<[number, number]> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length - 1, index + contextLines);
    const last = hunkRanges[hunkRanges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunkRanges.push([start, end]);
  }

  // Line numbers before each operation (1-based) on each side.
  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const operation of operations) {
    oldLineAt.push(oldLine);
    newLineAt.push(newLine);
    if (operation.kind !== "+") oldLine++;
    if (operation.kind !== "-") newLine++;
  }

  const headerPath = filePath.replace(/^\/+/, "");
  const output = [
    oldText === null ? "--- /dev/null" : `--- a/${headerPath}`,
    `+++ b/${headerPath}`,
  ];
  for (const [start, end] of hunkRanges) {
    const slice = operations.slice(start, end + 1);
    const oldCount = slice.filter((operation) => operation.kind !== "+").length;
    const newCount = slice.filter((operation) => operation.kind !== "-").length;
    const oldStart = oldCount === 0 ? oldLineAt[start] - 1 : oldLineAt[start];
    const newStart = newCount === 0 ? newLineAt[start] - 1 : newLineAt[start];
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const operation of slice) output.push(`${operation.kind}${operation.text}`);
  }
  return output.join("\n");
}

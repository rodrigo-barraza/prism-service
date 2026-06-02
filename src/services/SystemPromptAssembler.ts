// ─── Legacy Facade for SystemPromptAssembler ──────────────────────
// This file delegates everything to the decomposed module in `./system-prompt/`
// to maintain backward compatibility with imports throughout the project.

import SystemPromptAssembler from "./system-prompt/index.ts";

export default SystemPromptAssembler;
export { SystemPromptAssembler };

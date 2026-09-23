/**
 * AgentProcess — how an external ACP agent process is started and ended:
 * its own process group (so what it started ends with it), stop escalating
 * from stdin EOF to SIGTERM to SIGKILL, and every live agent ended when
 * prism-service exits.
 */
import { describe, it, expect } from "vitest";
import { AgentProcess } from "../client/AgentProcess.ts";

const env = { PATH: process.env.PATH ?? "" };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A node process that prints its child's pid, then waits (ignoring stdin). */
function parentOfSleeper(extraCode = ""): AgentProcess {
  const script = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stderr.write("child:" + child.pid + "\\n");
    ${extraCode}
    setInterval(() => {}, 1000);
  `;
  return new AgentProcess({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env });
}

async function childPid(agent: AgentProcess): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const match = /child:(\d+)/.exec(agent.stderr);
    if (match) return Number(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the test process never reported its child");
}

describe.skipIf(process.platform === "win32")("AgentProcess", () => {
  it("stop ends the agent and everything it started (its process group)", async () => {
    const agent = parentOfSleeper();
    const grandchild = await childPid(agent);
    expect(isAlive(grandchild)).toBe(true);
    const exit = await agent.stop({ exitGraceMilliseconds: 100, terminateGraceMilliseconds: 1_000 });
    expect(exit.signal).toBe("SIGTERM");
    await expect.poll(() => isAlive(grandchild), { timeout: 2_000 }).toBe(false);
  });

  it("an agent that ignores SIGTERM is killed", async () => {
    const agent = parentOfSleeper(`process.on("SIGTERM", () => {});`);
    const grandchild = await childPid(agent);
    const exit = await agent.stop({ exitGraceMilliseconds: 50, terminateGraceMilliseconds: 150 });
    expect(exit.signal).toBe("SIGKILL");
    await expect.poll(() => isAlive(grandchild), { timeout: 2_000 }).toBe(false);
  });

  it("an agent that exits when its stdin closes needs no signal", async () => {
    const agent = new AgentProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      cwd: process.cwd(),
      env,
    });
    expect(await agent.stop()).toEqual({ code: 0, signal: null });
    expect(agent.describeExit()).toBe("exited with code 0");
  });

  it("prism-service's exit ends every agent still running", async () => {
    const agent = parentOfSleeper();
    const grandchild = await childPid(agent);
    expect(AgentProcess.terminateAll()).toBeGreaterThanOrEqual(1);
    expect((await agent.exited).signal).toBe("SIGTERM");
    await expect.poll(() => isAlive(grandchild), { timeout: 2_000 }).toBe(false);
  });

  it("a command that does not exist reports it could not be started", async () => {
    const agent = new AgentProcess({ command: "/nonexistent/acp-agent", args: [], cwd: process.cwd(), env });
    const exit = await agent.exited;
    expect(agent.describeExit(exit)).toMatch(/^could not be started \(ENOENT\)/);
  });
});

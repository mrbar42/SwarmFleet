import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { executeHermesCommand } from "../services/chatCli.ts";

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });
}

let hermesHome: string;

async function writeHermesSession(
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const sessionsDir = join(hermesHome, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `session_${sessionId}.json`),
    JSON.stringify({ session_id: sessionId, messages }),
    "utf-8",
  );
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), "swarmfleet-hermes-test-"));
  vi.stubEnv("HERMES_HOME", hermesHome);
  spawnMock.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(hermesHome, { recursive: true, force: true });
});

describe("executeHermesCommand", () => {
  it("replays from the start when a resumed Hermes turn rolls to a new session file", async () => {
    await writeHermesSession(
      "old",
      Array.from({ length: 5 }, (_, index) => ({
        role: "assistant",
        content: `old ${index}`,
      })),
    );

    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const stream = executeHermesCommand(
      "continue",
      "req-1",
      "/workspace/example",
      "hermes:codex:gpt-5.5",
      "old",
    );

    const init = await stream.next();
    expect(init.value).toMatchObject({
      type: "claude_json",
      data: { type: "system", session_id: "old" },
    });

    await writeHermesSession("new", [
      { role: "user", content: "continue" },
      { role: "assistant", content: "rolled over answer" },
    ]);
    child.stderr.emit("data", Buffer.from("session_id: new\n"));
    child.exitCode = 0;
    child.emit("exit", 0, null);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_json",
          data: expect.objectContaining({
            type: "assistant",
            session_id: "new",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "rolled over answer" }],
            },
          }),
        }),
        expect.objectContaining({
          type: "claude_json",
          data: expect.objectContaining({
            type: "result",
            session_id: "new",
            result: "rolled over answer",
          }),
        }),
        { type: "done" },
      ]),
    );
  });

  it("surfaces a zero-exit Hermes run that produces no visible output", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const stream = executeHermesCommand(
      "continue",
      "req-2",
      "/workspace/example",
      "hermes:codex:gpt-5.5",
    );

    await stream.next();
    child.exitCode = 0;
    child.emit("exit", 0, null);

    const next = await stream.next();
    expect(next.value).toEqual({
      type: "error",
      error: "Hermes CLI exited successfully without emitting assistant output",
    });
  });

  it("does not turn Hermes CLI stdout prompts into assistant replies after visible log events", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    await writeHermesSession("active", []);

    const stream = executeHermesCommand(
      "continue",
      "req-3",
      "/workspace/example",
      "hermes:codex:gpt-5.5",
      "active",
    );

    await stream.next();
    await writeHermesSession("active", [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-terminal",
            function: {
              name: "terminal",
              arguments: JSON.stringify({ command: "node -e 'danger'" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-terminal",
        content: JSON.stringify({ output: "denied", exit_code: 1 }),
      },
    ]);
    child.stdout.emit(
      "data",
      Buffer.from(
        "⚠️  DANGEROUS COMMAND: script execution via -e/-c flag\nChoice [o/s/a/D]:\n✗ Denied\n",
      ),
    );
    child.exitCode = 0;
    child.emit("exit", 0, null);

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_json",
          data: expect.objectContaining({
            type: "assistant",
            message: expect.objectContaining({
              content: [
                expect.objectContaining({
                  type: "tool_use",
                  id: "call-terminal",
                  name: "Bash",
                }),
              ],
            }),
          }),
        }),
        expect.objectContaining({
          type: "claude_json",
          data: expect.objectContaining({ type: "result" }),
        }),
        { type: "done" },
      ]),
    );
    expect(JSON.stringify(chunks)).not.toContain("DANGEROUS COMMAND");
  });

  it("passes --yolo to Hermes when SwarmFleet is bypassing permissions", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const stream = executeHermesCommand(
      "continue",
      "req-4",
      "/workspace/example",
      "hermes:codex:gpt-5.5",
      undefined,
      "bypassPermissions",
    );

    await stream.next();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stream.next();

    expect(spawnMock).toHaveBeenCalledWith(
      "hermes",
      expect.arrayContaining(["--yolo"]),
      expect.any(Object),
    );
  });

  it("passes generic Hermes provider ids through to Hermes CLI", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const stream = executeHermesCommand(
      "continue",
      "req-5",
      "/workspace/example",
      "hermes:lmstudio:local-model",
    );

    await stream.next();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stream.next();

    expect(spawnMock).toHaveBeenCalledWith(
      "hermes",
      expect.arrayContaining(["--provider", "lmstudio", "--model", "local-model"]),
      expect.any(Object),
    );
  });
});

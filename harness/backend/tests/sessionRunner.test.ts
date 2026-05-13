import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChatSessionStore } from "../services/chatSessionStore.ts";

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const startedAt = Date.now();
  let last: T | null | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for condition; last=${String(last)}`);
}

describe("session-runner", () => {
  it("marks the turn idle at Claude result while preserving later task notifications", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarmfleet-session-runner-"));
    const projectPath = await mkdtemp(join(tmpdir(), "swarmfleet-project-"));
    const fakeClaudePath = join(root, "fake-claude.js");
    await writeFile(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, session_id: 'provider-1' }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'provider-1' }));",
        "setTimeout(() => console.log(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', session_id: 'provider-1' })), 250);",
        "setTimeout(() => process.exit(0), 500);",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeClaudePath, 0o755);

    const store = new ChatSessionStore(root, {
      skipLegacyImport: true,
      skipActiveSessionReconcile: true,
    });
    const session = await store.createSession({
      projectPath,
      model: "claude-sonnet-4-6",
      title: "runner test",
    });
    const requestId = "req-1";
    await store.writePendingRequest(session.sessionId, requestId, {
      requestId,
      message: "go",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowedTools: [],
    });
    await store.markRunStarted(session.sessionId, requestId);

    const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
    const runner = spawn(
      tsxPath,
      [
        "cli/session-runner.ts",
        "--session-id",
        session.sessionId,
        "--request-id",
        requestId,
        "--cli-path",
        fakeClaudePath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SWARMFLEET_CHAT_SESSION_ROOT: root,
          SWARMFLEET_BACKEND_URL: "",
          SWARMFLEET_INTERNAL_TOKEN: "",
        },
      },
    );

    await waitFor(async () => {
      const current = await store.getSession(session.sessionId);
      return current?.status === "idle" && current.activeRequestId === null
        ? current
        : null;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);

    const events = await readFile(
      join(root, "sessions", session.sessionId, "events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"subtype":"task_notification"');
    expect(events).toContain('"status":"idle"');
  });

  it("tells Claude when a managed preview service is already available", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarmfleet-session-runner-"));
    const projectPath = await mkdtemp(join(tmpdir(), "swarmfleet-project-"));
    await mkdir(join(projectPath, ".swarmfleet"), { recursive: true });
    await writeFile(
      join(projectPath, ".swarmfleet", "settings.json"),
      JSON.stringify({
        features: {
          preview: {
            enabled: true,
            devServer: {
              enabled: true,
              publishToHost: true,
              port: 42001,
            },
          },
        },
      }),
      "utf8",
    );
    const argvPath = join(root, "argv.json");
    const fakeClaudePath = join(root, "fake-claude.cjs");
    await writeFile(
      fakeClaudePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
        "console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, session_id: 'provider-1' }));",
        "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'provider-1' }));",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeClaudePath, 0o755);

    const store = new ChatSessionStore(root, {
      skipLegacyImport: true,
      skipActiveSessionReconcile: true,
    });
    const session = await store.createSession({
      projectPath,
      model: "claude-sonnet-4-6",
      title: "preview prompt test",
    });
    const requestId = "req-preview";
    await store.writePendingRequest(session.sessionId, requestId, {
      requestId,
      message: "check the app",
      model: "claude-sonnet-4-6",
      permissionMode: "bypassPermissions",
      allowedTools: [],
    });
    await store.markRunStarted(session.sessionId, requestId);

    const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
    const runner = spawn(
      tsxPath,
      [
        "cli/session-runner.ts",
        "--session-id",
        session.sessionId,
        "--request-id",
        requestId,
        "--cli-path",
        fakeClaudePath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SWARMFLEET_CHAT_SESSION_ROOT: root,
          SWARMFLEET_BACKEND_URL: "",
          SWARMFLEET_INTERNAL_TOKEN: "",
        },
      },
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);

    const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    expect(prompt).toContain(
      "Preview service is already enabled for this project.",
    );
    expect(prompt).toContain("Already-managed dev server port: 42001.");
    expect(prompt).toContain(
      "Do not start another dev server unless the user explicitly asks you to restart or replace the preview service.",
    );
  }, 10000);

  it("includes managed preview context for Hermes agent runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "swarmfleet-session-runner-"));
    const projectPath = await mkdtemp(join(tmpdir(), "swarmfleet-project-"));
    await mkdir(join(projectPath, ".swarmfleet"), { recursive: true });
    await writeFile(
      join(projectPath, ".swarmfleet", "settings.json"),
      JSON.stringify({
        features: {
          preview: {
            enabled: true,
            devServer: {
              enabled: true,
              publishToHost: true,
              port: 42002,
            },
          },
        },
      }),
      "utf8",
    );
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin, { recursive: true });
    const argvPath = join(root, "hermes-argv.json");
    const fakeHermesPath = join(fakeBin, "hermes");
    await writeFile(
      fakeHermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
        "console.log('done');",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeHermesPath, 0o755);

    const store = new ChatSessionStore(root, {
      skipLegacyImport: true,
      skipActiveSessionReconcile: true,
    });
    const session = await store.createSession({
      projectPath,
      model: "hermes:gpt-5.5",
      title: "hermes preview prompt test",
    });
    const requestId = "req-hermes-preview";
    await store.writePendingRequest(session.sessionId, requestId, {
      requestId,
      message: "check the app",
      model: "hermes:gpt-5.5",
      permissionMode: "bypassPermissions",
      allowedTools: [],
    });
    await store.markRunStarted(session.sessionId, requestId);

    const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
    const runner = spawn(
      tsxPath,
      [
        "cli/session-runner.ts",
        "--session-id",
        session.sessionId,
        "--request-id",
        requestId,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          SWARMFLEET_CHAT_SESSION_ROOT: root,
          SWARMFLEET_BACKEND_URL: "",
          SWARMFLEET_INTERNAL_TOKEN: "",
        },
      },
    );

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      runner.once("error", reject);
      runner.once("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);

    const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    const query = argv[argv.indexOf("--query") + 1] ?? "";
    expect(query).toContain(
      "Preview service is already enabled for this project.",
    );
    expect(query).toContain("Already-managed dev server port: 42002.");
    expect(query).toContain(
      "Do not start another dev server unless the user explicitly asks you to restart or replace the preview service.",
    );
  });
});

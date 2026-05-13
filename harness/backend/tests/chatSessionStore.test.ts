import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSessionStore } from "../services/chatSessionStore.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<ChatSessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "swarmfleet-chat-store-"));
  tempDirs.push(dir);
  const store = new ChatSessionStore(dir, { skipLegacyImport: true });
  await store.ensureInitialized();
  return store;
}

describe("ChatSessionStore", () => {
  it("defaults new sessions to default permissions", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    expect(session.permissionMode).toBe("default");
  });

  it("normalizes obsolete stored session kinds to chat", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });
    const metadataPath = join(
      rootDir,
      "sessions",
      session.sessionId,
      "metadata.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8")) as Record<
      string,
      unknown
    >;
    metadata.kind = "swarm-head";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const loaded = await store.getSession(session.sessionId);
    const summaries = await store.listSessionsByProject("/tmp/project");

    expect(loaded?.kind).toBe("chat");
    expect(summaries[0]?.kind).toBe("chat");
  });

  it("hides provider context compaction references from loaded conversations", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.appendMessage(session.sessionId, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.\n## Active Task\nNone.",
          },
        ],
      },
    });
    await store.appendMessage(session.sessionId, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
      },
    });

    const conversation = await store.getConversation(session.sessionId);

    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.messages[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
      },
    });
  });

  it("keeps short first turns visible when metadata counts drift near the page boundary", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    for (let i = 0; i < 84; i += 1) {
      await store.appendMessage(session.sessionId, {
        type: "user",
        timestamp: new Date(1_700_000_000_000 + i).toISOString(),
        message: { role: "user", content: `message-${i}` },
      });
    }

    const metadataPath = join(
      rootDir,
      "sessions",
      session.sessionId,
      "metadata.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8")) as Record<
      string,
      unknown
    >;
    metadata.messageCount = 83;
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const conversation = await store.getConversation(session.sessionId, {
      limit: 80,
    });
    const correctedMetadata = JSON.parse(
      await readFile(metadataPath, "utf-8"),
    ) as Record<string, unknown>;

    expect(conversation?.page).toMatchObject({
      startIndex: 0,
      endIndex: 84,
      hasMoreBefore: false,
    });
    expect(conversation?.metadata.messageCount).toBe(84);
    expect(correctedMetadata.messageCount).toBe(84);
    expect(conversation?.messages[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: "message-0" },
    });
    expect(conversation?.messages).toHaveLength(84);
  });

  it("marks recent stale running sessions with tool activity for backend wakeup resume", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.writePendingRequest(session.sessionId, "req-1", {
      message: "keep going",
      requestId: "req-1",
    });
    await store.appendMessage(session.sessionId, {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "sleep 30" },
          },
        ],
      },
    });
    await store.markRunStarted(session.sessionId, "req-1");
    await store.updateRunnerPid(session.sessionId, 999_999);
    await store.reconcileActiveSessions();

    const recovered = await store.getSession(session.sessionId);
    const pending = await store.readPendingRequest(session.sessionId, "req-1");

    expect(recovered?.status).toBe("backend_wakeup");
    expect(recovered?.runnerPid).toBeNull();
    expect(recovered?.activeRequestId).toBe("req-1");
    expect(pending).toMatchObject({
      message: "keep going",
      requestId: "req-1",
    });
  });

  it("records runner-missing reason when startup reconcile cannot resume", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.markRunStarted(session.sessionId, "req-missing");
    await store.updateRunnerPid(session.sessionId, 999_999);
    await store.reconcileActiveSessions();

    const recovered = await store.getSession(session.sessionId);
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.lastInterruptionReason).toBe("runner_missing");
    expect(recovered?.lastInterruptionDetail).toContain("Startup reconcile");
  });

  it("preserves an explicit interruption intent when runner finalizes interrupted", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.markRunStarted(session.sessionId, "req-1");
    await store.recordInterruptionIntent(
      session.sessionId,
      "user_abort",
      "Session stop requested by client",
    );
    await store.updateStatus(session.sessionId, "interrupted", {
      clearActiveRequest: true,
      clearRunnerPid: true,
    });

    const interrupted = await store.getSession(session.sessionId);
    expect(interrupted?.lastInterruptionReason).toBe("user_abort");
    expect(interrupted?.lastInterruptionDetail).toBe(
      "Session stop requested by client",
    );
  });

  it("clears stale interruption details when a new run starts", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.updateStatus(session.sessionId, "interrupted", {
      interruptionReason: "runner_exited",
      interruptionDetail: "runner died",
    });
    await store.markRunStarted(session.sessionId, "req-2");

    const running = await store.getSession(session.sessionId);
    expect(running?.status).toBe("running");
    expect(running?.lastInterruptionReason).toBeNull();
    expect(running?.lastInterruptionDetail).toBeNull();
  });

  it("marks stale running sessions without tool activity for backend wakeup resume", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.writePendingRequest(session.sessionId, "req-1", {
      message: "keep going",
      requestId: "req-1",
    });
    await store.markRunStarted(session.sessionId, "req-1");
    await store.updateRunnerPid(session.sessionId, 999_999);
    await store.reconcileActiveSessions();

    const recovered = await store.getSession(session.sessionId);
    const pending = await store.readPendingRequest(session.sessionId, "req-1");

    expect(recovered?.status).toBe("backend_wakeup");
    expect(recovered?.runnerPid).toBeNull();
    expect(recovered?.activeRequestId).toBe("req-1");
    expect(pending).toMatchObject({
      message: "keep going",
      requestId: "req-1",
    });
  });

  it("can skip active-session startup reconcile for detached runners", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.writePendingRequest(session.sessionId, "req-1", {
      message: "keep going",
      requestId: "req-1",
    });
    await store.markRunStarted(session.sessionId, "req-1");
    await store.updateRunnerPid(session.sessionId, 999_999);

    const runnerStore = new ChatSessionStore(rootDir, {
      skipLegacyImport: true,
      skipActiveSessionReconcile: true,
    });
    await runnerStore.ensureInitialized();

    const current = await runnerStore.getSession(session.sessionId);
    const pending = await runnerStore.readPendingRequest(
      session.sessionId,
      "req-1",
    );

    expect(current?.status).toBe("running");
    expect(current?.runnerPid).toBe(999_999);
    expect(current?.activeRequestId).toBe("req-1");
    expect(pending).toMatchObject({
      message: "keep going",
      requestId: "req-1",
    });
  });

  it("marks old stale running sessions for backend wakeup resume", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.writePendingRequest(session.sessionId, "req-1", {
      message: "keep going",
      requestId: "req-1",
    });
    await store.appendMessage(session.sessionId, {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "sleep 30" },
          },
        ],
      },
    });
    await store.markRunStarted(session.sessionId, "req-1");
    await store.updateRunnerPid(session.sessionId, 999_999);

    const metadataPath = join(
      rootDir,
      "sessions",
      session.sessionId,
      "metadata.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8")) as {
      updatedAt: number;
    };
    metadata.updatedAt = Date.now() - 25 * 60 * 60 * 1000;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    await store.reconcileActiveSessions();

    const recovered = await store.getSession(session.sessionId);
    const pending = await store.readPendingRequest(session.sessionId, "req-1");

    expect(recovered?.status).toBe("backend_wakeup");
    expect(recovered?.activeRequestId).toBe("req-1");
    expect(pending).toMatchObject({
      message: "keep going",
      requestId: "req-1",
    });
  });

  it("keeps awaiting-input sessions awaiting input on recovery when the runner is gone", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.updateStatus(session.sessionId, "awaiting_input");
    await store.updateRunnerPid(session.sessionId, 999_999);
    await store.reconcileActiveSessions();

    const recovered = await store.getSession(session.sessionId);

    expect(recovered?.status).toBe("awaiting_input");
    expect(recovered?.runnerPid).toBeNull();
    expect(recovered?.cliPid).toBeNull();
  });

  it("rebuilds the session index from metadata if the index file is missing", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
      title: "Recovered session",
    });

    await rm(join(rootDir, "index.json"), { force: true });

    const restarted = new ChatSessionStore(rootDir, { skipLegacyImport: true });
    await restarted.ensureInitialized();
    const sessions = await restarted.listSessionsByProject("/tmp/project");

    expect(sessions.map((entry) => entry.sessionId)).toContain(
      session.sessionId,
    );
    expect(sessions[0]?.title).toBe("Recovered session");
  });

  it("rebuilds the session index from metadata if the index file is invalid", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
      title: "Recovered from invalid index",
    });

    await writeFile(join(rootDir, "index.json"), "{", "utf-8");

    const restarted = new ChatSessionStore(rootDir, { skipLegacyImport: true });
    await restarted.ensureInitialized();
    const sessions = await restarted.listSessionsByProject("/tmp/project");

    expect(sessions.map((entry) => entry.sessionId)).toContain(
      session.sessionId,
    );
    expect(sessions[0]?.title).toBe("Recovered from invalid index");
  });

  it("does not derive session titles from tool payloads", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.appendMessage(session.sessionId, {
      type: "user",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: '{"sessionId":"abc","status":"running"}',
          },
        ],
      },
    });

    const updated = await store.getSession(session.sessionId);
    expect(updated?.title).toBe("New conversation");
    expect(updated?.lastMessagePreview).toBe("No preview available");
  });

  it("does not mark sessions unread when the latest message is human-authored", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.appendMessage(session.sessionId, {
      type: "assistant",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: {
        role: "assistant",
        content: "Background response",
      },
    });

    const unread = await store.listSessionsByProject("/tmp/project");
    expect(unread[0]?.unreadBoundary).toBe(session.lastReadAt);

    await store.appendMessage(session.sessionId, {
      type: "user",
      timestamp: new Date(Date.now() + 2_000).toISOString(),
      message: {
        role: "user",
        content: "Follow-up from me",
      },
    });

    const read = await store.listSessionsByProject("/tmp/project");
    expect(read[0]?.unreadBoundary).toBeNull();
    const updated = await store.getSession(session.sessionId);
    expect(updated?.lastReadAt).toBe(updated?.updatedAt);
  });

  it("reconciles old unread sessions whose latest message is human-authored", async () => {
    const store = await createStore();
    const rootDir = tempDirs[tempDirs.length - 1];
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });

    await store.appendMessage(session.sessionId, {
      type: "user",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      message: {
        role: "user",
        content: "No assistant reply after this",
      },
    });

    const metadataPath = join(
      rootDir,
      "sessions",
      session.sessionId,
      "metadata.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8")) as {
      lastReadAt: number;
    };
    metadata.lastReadAt = session.lastReadAt;
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

    const restarted = new ChatSessionStore(rootDir, { skipLegacyImport: true });
    await restarted.ensureInitialized();

    const reconciled = await restarted.listSessionsByProject("/tmp/project");
    expect(reconciled[0]?.unreadBoundary).toBeNull();
  });

  it("derives pi as a provider and allows pi-to-pi model switches", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
      model: "pi:profile-a:openrouter/example:model",
    });

    expect(session.provider).toBe("pi");

    await store.markRunStarted(session.sessionId, "req-1", {
      model: "pi:profile-b:openrouter/other:model",
    });
    const updated = await store.getSession(session.sessionId);
    expect(updated?.model).toBe("pi:profile-b:openrouter/other:model");

    await expect(
      store.markRunStarted(session.sessionId, "req-2", {
        model: "codex:gpt-5.4",
      }),
    ).rejects.toThrow(/Cannot switch provider/);
  });

  it("lists image assets saved by descendant subagent sessions", async () => {
    const store = await createStore();
    const parent = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
    });
    const child = await store.createSession({
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
      kind: "subagent",
      parentSessionId: parent.sessionId,
      parentToolUseId: "toolu_spawn",
    });

    const parentAsset = await store.saveImageAsset(parent.sessionId, {
      bytes: Buffer.from("parent-image"),
      mimeType: "image/png",
      sourceToolName: "parent_screenshot",
    });
    await setTimeout(1);
    const childAsset = await store.saveImageAsset(child.sessionId, {
      bytes: Buffer.from("child-image"),
      mimeType: "image/png",
      sourceToolName: "screenshot",
    });

    const images = await store.listImageAssetsIncludingDescendants(
      parent.sessionId,
    );

    expect(images.map((asset) => asset.assetId)).toEqual([
      parentAsset.assetId,
      childAsset.assetId,
    ]);
    expect(images.at(-1)?.url).toContain(
      `/api/sessions/${encodeURIComponent(child.sessionId)}/assets/`,
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSessionStore } from "../services/chatSessionStore.ts";
import { WakeScheduler } from "../services/wakeScheduler.ts";

const roots: string[] = [];

async function createScheduler(): Promise<WakeScheduler> {
  const root = await mkdtemp(join(tmpdir(), "swarmfleet-wake-test-"));
  roots.push(root);
  return new WakeScheduler(new ChatSessionStore(root, { skipLegacyImport: true }));
}

async function createStore(): Promise<ChatSessionStore> {
  const root = await mkdtemp(join(tmpdir(), "swarmfleet-wake-test-"));
  roots.push(root);
  const store = new ChatSessionStore(root, { skipLegacyImport: true });
  await store.ensureInitialized();
  return store;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WakeScheduler", () => {
  it("persists relative scheduled wakeups with a 15 minute missed-wake grace", async () => {
    const scheduler = await createScheduler();
    const before = Date.now();

    const wake = await scheduler.scheduleWakeup({
      sessionId: "session-1",
      delay: "30s",
      reason: "check work",
      prompt: "resume and check work",
    });

    expect(wake.kind).toBe("scheduled_wakeup");
    expect(wake.status).toBe("pending");
    expect(wake.dueAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(wake.expireAt).toBe(wake.dueAt + 15 * 60_000);
  });

  it("caps wait_until timeouts at 15 minutes", async () => {
    const scheduler = await createScheduler();

    await expect(
      scheduler.waitUntil({
        sessionId: "session-1",
        conditions: [{ type: "subagent_completed", subagent_id: "child-1" }],
        timeout: "16m",
        prompt: "resume",
      }),
    ).rejects.toThrow("timeout cannot be more than 15m");
  });

  it("normalizes wait_until mode and conditions", async () => {
    const scheduler = await createScheduler();

    const wake = await scheduler.waitUntil({
      sessionId: "session-1",
      conditions: [
        { type: "subagent_completed", subagent_id: "child-1" },
        { type: "background_task_completed", task_id: "task-1" },
      ],
      mode: "any",
      timeout: "5m",
      reason: "wait for workers",
      prompt: "inspect results",
    });

    expect(wake.kind).toBe("wait_until");
    expect(wake.mode).toBe("any");
    expect(wake.conditions).toEqual([
      { type: "subagent_completed", subagentId: "child-1" },
      { type: "background_task_completed", taskId: "task-1" },
    ]);
  });

  it("fires a due scheduled wake without writing a synthetic user message", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/workspace/example",
      model: "claude-sonnet-4-6",
      title: "Wake test",
    });
    const resumed: Array<{ sessionId: string; message: string }> = [];
    const scheduler = new WakeScheduler(store, async (sessionId, message) => {
      resumed.push({ sessionId, message });
    });

    await scheduler.scheduleWakeup({
      sessionId: session.sessionId,
      delay: "1ms",
      reason: "test wake",
      prompt: "continue now",
    });
    const armedSession = await store.getSession(session.sessionId);
    expect(armedSession?.armedWakeup).toMatchObject({
      kind: "scheduled_wakeup",
      reason: "test wake",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.runPendingWakeupsForTests();

    expect(resumed).toEqual([
      {
        sessionId: session.sessionId,
        message: "continue now",
      },
    ]);

    const conversation = await store.getConversation(session.sessionId);
    expect(conversation?.messages).toMatchObject([
      {
        type: "system",
        subtype: "wakeup_armed",
        wakeup_kind: "scheduled_wakeup",
        reason: "test wake",
        trigger_source: "hook",
      },
      {
        type: "system",
        subtype: "wakeup_trigger",
        wakeup_kind: "scheduled_wakeup",
        reason: "test wake",
        prompt: "continue now",
        trigger_source: "hook",
      },
    ]);
    const firedSession = await store.getSession(session.sessionId);
    expect(firedSession?.armedWakeup).toBeNull();
    expect(conversation?.messages.some((message) => {
      return (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "user"
      );
    })).toBe(false);
  });

  it("does not let one synthetic wake trigger cancel a sibling wait_until", async () => {
    const store = await createStore();
    const session = await store.createSession({
      projectPath: "/workspace/example",
      model: "claude-sonnet-4-6",
      title: "Wake sibling test",
    });
    const resumed: Array<{ sessionId: string; message: string }> = [];
    const scheduler = new WakeScheduler(store, async (sessionId, message) => {
      resumed.push({ sessionId, message });
    });

    await scheduler.scheduleWakeup({
      sessionId: session.sessionId,
      delay: "1ms",
      reason: "first wake",
      prompt: "first prompt",
    });
    await scheduler.waitUntil({
      sessionId: session.sessionId,
      conditions: [{ type: "background_task_completed", task_id: "missing-task" }],
      mode: "any",
      timeout: "100ms",
      reason: "timeout wake",
      prompt: "timeout prompt",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await scheduler.runPendingWakeupsForTests();
    const afterFirstWake = await store.getSession(session.sessionId);
    expect(afterFirstWake?.armedWakeup).toMatchObject({
      kind: "wait_until",
      reason: "timeout wake",
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await scheduler.runPendingWakeupsForTests();

    expect(resumed).toEqual([
      { sessionId: session.sessionId, message: "first prompt" },
      { sessionId: session.sessionId, message: "timeout prompt" },
    ]);
  });
});

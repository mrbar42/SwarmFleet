import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSessionStore } from "../services/chatSessionStore.ts";
import type { QueuedMessage } from "../../shared/types.ts";
import { MAX_QUEUED_MESSAGES } from "../../shared/types.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createStore(): Promise<ChatSessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "swarmfleet-queue-test-"));
  tempDirs.push(dir);
  const store = new ChatSessionStore(dir, { skipLegacyImport: true });
  await store.ensureInitialized();
  return store;
}

function makeEntry(id: string, message = "hello"): QueuedMessage {
  return {
    id,
    message,
    createdAt: Date.now(),
    requestId: `req-${id}`,
  };
}

async function createSession(store: ChatSessionStore): Promise<string> {
  const session = await store.createSession({
    projectPath: "/tmp/project",
    encodedProjectName: "tmp-project",
  });
  return session.sessionId;
}

describe("message queue store methods", () => {
  it("starts empty", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    expect(await store.readQueue(sessionId)).toEqual([]);
  });

  it("enqueues and reads back", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    const entry = makeEntry("a", "first message");
    await store.enqueueMessage(sessionId, entry);
    const queue = await store.readQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("a");
    expect(queue[0].message).toBe("first message");
  });

  it("preserves FIFO order", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    await store.enqueueMessage(sessionId, makeEntry("a"));
    await store.enqueueMessage(sessionId, makeEntry("b"));
    await store.enqueueMessage(sessionId, makeEntry("c"));
    const queue = await store.readQueue(sessionId);
    expect(queue.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects enqueueing beyond the limit", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
      await store.enqueueMessage(sessionId, makeEntry(`e${i}`));
    }
    await expect(
      store.enqueueMessage(sessionId, makeEntry("overflow")),
    ).rejects.toThrow("Queue is full");
  });

  it("popFirstFromQueue returns head and shrinks queue", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    await store.enqueueMessage(sessionId, makeEntry("x"));
    await store.enqueueMessage(sessionId, makeEntry("y"));
    const popped = await store.popFirstFromQueue(sessionId);
    expect(popped?.id).toBe("x");
    expect(await store.readQueue(sessionId)).toHaveLength(1);
    expect((await store.readQueue(sessionId))[0].id).toBe("y");
  });

  it("popFirstFromQueue returns null on empty queue", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    expect(await store.popFirstFromQueue(sessionId)).toBeNull();
  });

  it("removeFromQueue deletes by id", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    await store.enqueueMessage(sessionId, makeEntry("1"));
    await store.enqueueMessage(sessionId, makeEntry("2"));
    await store.enqueueMessage(sessionId, makeEntry("3"));
    const removed = await store.removeFromQueue(sessionId, "2");
    expect(removed?.id).toBe("2");
    expect((await store.readQueue(sessionId)).map((e) => e.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("removeFromQueue returns null for unknown id", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);
    await store.enqueueMessage(sessionId, makeEntry("a"));
    expect(await store.removeFromQueue(sessionId, "nonexistent")).toBeNull();
  });

  it("broadcasts queue SSE event after each mutation", async () => {
    const store = await createStore();
    const sessionId = await createSession(store);

    // Flush the seed status events so our cursor starts fresh.
    const before = (await store.readEventsSince(sessionId, -1)) ?? [];
    const lastId = before.at(-1)?.id ?? -1;

    await store.enqueueMessage(sessionId, makeEntry("m1"));
    const events = (await store.readEventsSince(sessionId, lastId)) ?? [];
    const queueEvent = events.find((e) => e.channel === "queue");
    expect(queueEvent).toBeDefined();
    expect(queueEvent?.data).toMatchObject({
      sessionId,
      queued: [{ id: "m1" }],
    });
  });

  it("queue persists after store is reconstructed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarmfleet-queue-persist-"));
    tempDirs.push(dir);

    const store1 = new ChatSessionStore(dir, { skipLegacyImport: true });
    await store1.ensureInitialized();
    const sessionId = (
      await store1.createSession({
        projectPath: "/tmp/project",
        encodedProjectName: "tmp-project",
      })
    ).sessionId;
    await store1.enqueueMessage(sessionId, makeEntry("persist1"));

    // Reconstruct without writing again.
    const store2 = new ChatSessionStore(dir, { skipLegacyImport: true });
    await store2.ensureInitialized();
    const queue = await store2.readQueue(sessionId);
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("persist1");
  });
});

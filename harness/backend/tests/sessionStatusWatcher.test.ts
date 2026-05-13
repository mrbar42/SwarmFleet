import { afterEach, describe, expect, it } from "vitest";
import type { SessionMetadata } from "../../shared/types.ts";
import { sessionStatusWatcher } from "../services/sessionStatusWatcher.ts";

type WatcherInternals = {
  store: { getSession: (sessionId: string) => Promise<SessionMetadata | null> } | null;
  tracked: Set<string>;
  lastStatus: Map<string, SessionMetadata["status"]>;
  tick: () => Promise<void>;
};

function resetWatcher(): void {
  sessionStatusWatcher.stop();
  sessionStatusWatcher.setOnIdleTransition(null);
  const internals = sessionStatusWatcher as unknown as WatcherInternals;
  internals.store = null;
  internals.tracked.clear();
  internals.lastStatus.clear();
}

afterEach(() => {
  resetWatcher();
});

describe("sessionStatusWatcher queue recovery", () => {
  it("keeps tracking when idle auto-dispatch immediately starts the next run", async () => {
    const metadata: SessionMetadata = {
      sessionId: "s1",
      projectPath: "/tmp/project",
      encodedProjectName: "tmp-project",
      provider: "claude",
      providerSessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "idle",
      title: "Test session",
      lastMessagePreview: "done",
      model: "claude-sonnet-4-6",
      effort: "auto",
      permissionMode: "bypassPermissions",
      allowedTools: [],
      activeRequestId: null,
      runnerPid: null,
      cliPid: null,
      sourceKind: "native",
      kind: "chat",
      latestEventId: 0,
      retainedEventId: 0,
      messageCount: 0,
      lastReadAt: Date.now(),
    };

    const internals = sessionStatusWatcher as unknown as WatcherInternals;
    internals.store = {
      getSession: async () => metadata,
    };
    internals.tracked.add(metadata.sessionId);
    internals.lastStatus.set(metadata.sessionId, "running");

    sessionStatusWatcher.setOnIdleTransition(async () => {
      metadata.status = "running";
      metadata.runnerPid = 12345;
      metadata.updatedAt = Date.now();
    });

    await internals.tick();

    expect(internals.tracked.has(metadata.sessionId)).toBe(true);
    expect(internals.lastStatus.get(metadata.sessionId)).toBe("running");
  });
});

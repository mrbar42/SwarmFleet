import { describe, expect, it } from "vitest";
import type { SessionMetadata } from "../../shared/types.ts";
import { canAutoDispatchQueuedMessage } from "../services/sessionManager.ts";

function session(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    sessionId: "s1",
    projectPath: "/tmp/project",
    encodedProjectName: "tmp-project",
    provider: "codex",
    providerSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    title: "Test",
    lastMessagePreview: "",
    model: "default",
    effort: "default",
    permissionMode: "default",
    activeRequestId: null,
    runnerPid: null,
    cliPid: null,
    sourceKind: "native",
    kind: "chat",
    latestEventId: 0,
    retainedEventId: 0,
    messageCount: 0,
    lastReadAt: 0,
    armedWakeup: null,
    ...overrides,
  };
}

describe("queued message dispatch eligibility", () => {
  it("allows auto-dispatch only when idle and no wakeup is armed", () => {
    expect(canAutoDispatchQueuedMessage(session({ status: "idle" }))).toBe(true);
  });

  it("does not auto-dispatch while a wakeup is armed", () => {
    expect(
      canAutoDispatchQueuedMessage(
        session({
          status: "idle",
          armedWakeup: {
            id: "w1",
            kind: "wait_until",
            reason: "subagent completion",
            dueAt: 10,
            createdAt: 1,
            mode: "all",
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not auto-dispatch for non-idle sessions", () => {
    expect(canAutoDispatchQueuedMessage(session({ status: "running" }))).toBe(false);
    expect(canAutoDispatchQueuedMessage(session({ status: "backend_wakeup" }))).toBe(false);
  });
});

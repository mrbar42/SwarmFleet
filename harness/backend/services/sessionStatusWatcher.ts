import type { SessionMetadata, SessionStatus } from "../../shared/types.ts";
import { sessionIndexBus } from "./sessionIndexBus.ts";
import type { ChatSessionStore } from "./chatSessionStore.ts";
import { buildNotificationEvent } from "./sessionNotifications.ts";
import { logger } from "../utils/logger.ts";

/**
 * Hook the watcher can call on transitions that complete a turn. Injected by
 * the main backend at startup to avoid a circular import with sessionManager.
 */
type IdleTransitionHandler = (sessionId: string) => Promise<void> | void;

function getUnreadBoundary(metadata: SessionMetadata): number | null {
  if (metadata.status === "running" || metadata.status === "backend_wakeup") {
    return null;
  }
  if (metadata.armedWakeup) {
    return null;
  }
  return metadata.updatedAt > metadata.lastReadAt ? metadata.lastReadAt : null;
}

/**
 * Polls tracked sessions as a crash-recovery fallback and publishes rare
 * divergences on `sessionIndexBus` so every connected sidebar can render the
 * correct indicator (spinner while running, idle / awaiting_input / error when
 * the runner finishes).
 *
 * Normal status writes publish directly to the in-process bus. This watcher is
 * intentionally slow and should be quiet in steady state; it only republishes
 * when disk truth diverges from the last status published by the backend.
 */

const POLL_INTERVAL_MS = 15000;

class SessionStatusWatcher {
  private store: ChatSessionStore | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly tracked = new Set<string>();
  private readonly lastStatus = new Map<string, SessionStatus>();
  private onIdleTransition: IdleTransitionHandler | null = null;

  setOnIdleTransition(handler: IdleTransitionHandler | null): void {
    this.onIdleTransition = handler;
  }

  /**
   * Start the watcher. Scans existing sessions for any whose metadata still
   * says running/awaiting_input (possible if the backend restarted while a
   * detached runner was live) and begins tracking them.
   */
  async start(store: ChatSessionStore): Promise<void> {
    this.store = store;
    if (this.interval) return;

    try {
      const all = await store.listAllActiveMetadata();
      for (const metadata of all) {
        this.lastStatus.set(metadata.sessionId, metadata.status);
        if (isActiveStatus(metadata.status) || metadata.runnerPid != null) {
          this.tracked.add(metadata.sessionId);
        }
      }
    } catch (error) {
      logger.app.warn("SessionStatusWatcher initial scan failed: {error}", {
        error,
      });
    }

    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Register a session as running so the watcher begins polling it. Called
   * right after `markRunStarted` so completion transitions aren't missed
   * even when the runner exits quickly.
   */
  track(sessionId: string, initialStatus: SessionStatus): void {
    this.tracked.add(sessionId);
    this.lastStatus.set(sessionId, initialStatus);
  }

  notePublished(sessionId: string, status: SessionStatus): void {
    this.lastStatus.set(sessionId, status);
    if (isActiveStatus(status)) {
      this.tracked.add(sessionId);
    }
  }

  getLastPublishedStatus(sessionId: string): SessionStatus | undefined {
    return this.lastStatus.get(sessionId);
  }

  private async tick(): Promise<void> {
    const store = this.store;
    if (!store || this.tracked.size === 0) return;

    const toCheck = Array.from(this.tracked);
    for (const sessionId of toCheck) {
      let metadata: SessionMetadata | null = null;
      try {
        metadata = await store.getSession(sessionId);
      } catch (error) {
        logger.app.warn(
          "SessionStatusWatcher failed to read {sessionId}: {error}",
          { sessionId, error },
        );
        continue;
      }

      if (!metadata) {
        this.tracked.delete(sessionId);
        this.lastStatus.delete(sessionId);
        continue;
      }

      if (
        metadata.runnerPid != null &&
        !(await store.isRecordedRunnerAlive(sessionId, metadata.runnerPid))
      ) {
        try {
          metadata = await store.reconcileUnexpectedRunnerExit(sessionId);
        } catch (error) {
          logger.app.warn(
            "SessionStatusWatcher failed to reconcile stale runner for {sessionId}: {error}",
            { sessionId, error },
          );
        }
        if (!metadata) {
          this.tracked.delete(sessionId);
          this.lastStatus.delete(sessionId);
          continue;
        }
      }

      const published = this.lastStatus.get(sessionId);
      const diverged = published !== metadata.status;
      if (diverged) {
        const notification = buildNotificationEvent(published, metadata);
        this.lastStatus.set(sessionId, metadata.status);
        sessionIndexBus.publish({
          type: "session-status",
          projectPath: metadata.projectPath,
          encodedProjectName: metadata.encodedProjectName,
          sessionId: metadata.sessionId,
          status: metadata.status,
          updatedAt: metadata.updatedAt,
          lastMessagePreview: metadata.lastMessagePreview,
          unreadBoundary: getUnreadBoundary(metadata),
          armedWakeup: metadata.armedWakeup ?? null,
          blockedOnHuman: metadata.blockedOnHuman,
          interruptionReason: metadata.lastInterruptionReason ?? undefined,
          interruptionDetail: metadata.lastInterruptionDetail ?? undefined,
        });
        if (notification) {
          sessionIndexBus.publish(notification);
        }
      }

      // When a session is observed idle, give the pending-queue dispatcher a
      // chance to auto-send the next queued message. We intentionally don't
      // restrict this to transition edges only: if the watcher ever missed the
      // precise running -> idle flip, the next poll still recovers.
      //
      // Important: re-read metadata after the handler runs. The dispatcher can
      // synchronously start the next run, and if we keep using the stale idle
      // snapshot below we'd immediately untrack the fresh run and break the
      // queue chain.
      if (metadata.status === "idle" && this.onIdleTransition) {
        try {
          await this.onIdleTransition(sessionId);
          const refreshed = await store.getSession(sessionId);
          if (refreshed) {
            metadata = refreshed;
            this.lastStatus.set(sessionId, refreshed.status);
          }
        } catch (error) {
          logger.app.warn(
            "onIdleTransition handler failed for {sessionId}: {error}",
            { sessionId, error },
          );
        }
      }

      // Stop polling once the session is at rest. We'll start again on the
      // next `track()` call (i.e. when sendMessage fires a new run).
      if (!isActiveStatus(metadata.status) && metadata.runnerPid == null) {
        this.tracked.delete(sessionId);
      }
    }
  }
}

function isActiveStatus(status: SessionStatus): boolean {
  return (
    status === "running" ||
    status === "awaiting_input" ||
    status === "backend_wakeup"
  );
}

export const sessionStatusWatcher = new SessionStatusWatcher();

import type {
  ConversationSummary,
  SessionIndexDeltaEvent,
  SessionIndexEvent,
  SessionMetadata,
} from "../../shared/types.ts";

type Listener = (event: SessionIndexEvent) => void;
type BufferedEvent = { event: SessionIndexEvent; createdAt: number };

const MAX_BUFFERED_EVENTS = 500;
const MAX_BUFFER_AGE_MS = 10 * 60 * 1000;

/**
 * In-process pub/sub for session-index changes (create / rename / archive).
 * The `/api/sessions/index/stream` SSE endpoint subscribes here and fans
 * events out to every connected client, so sidebars across devices stay in
 * sync without polling.
 */
class SessionIndexBus {
  private readonly listeners = new Set<Listener>();
  private readonly buffer: BufferedEvent[] = [];
  private version = 0;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getCurrentVersion(): number {
    return this.version;
  }

  getEventsSince(lastEventId: string): SessionIndexEvent[] | null {
    const parsed = Number.parseInt(lastEventId, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > this.version) {
      return null;
    }

    this.pruneBuffer();

    if (parsed === this.version) {
      return [];
    }

    const first = this.buffer[0]?.event.version;
    if (first === undefined || first > parsed + 1) {
      return null;
    }

    return this.buffer
      .filter((entry) => entry.event.version > parsed)
      .map((entry) => entry.event);
  }

  publish(event: SessionIndexDeltaEvent): void {
    const version = this.version + 1;
    this.version = version;
    const versioned = {
      ...event,
      version,
      eventId: String(version),
    } as SessionIndexEvent;
    this.buffer.push({ event: versioned, createdAt: Date.now() });
    this.pruneBuffer();

    // Copy to a snapshot so listeners unsubscribing during dispatch don't
    // mutate the iteration target.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(versioned);
      } catch {
        // A misbehaving subscriber shouldn't break the fan-out.
      }
    }
  }

  private pruneBuffer(): void {
    const cutoff = Date.now() - MAX_BUFFER_AGE_MS;
    while (
      this.buffer.length > 0 &&
      (this.buffer.length > MAX_BUFFERED_EVENTS ||
        this.buffer[0].createdAt < cutoff)
    ) {
      this.buffer.shift();
    }
  }
}

export const sessionIndexBus = new SessionIndexBus();

function getUnreadBoundary(metadata: SessionMetadata): number | null {
  if (metadata.status === "running" || metadata.status === "backend_wakeup") {
    return null;
  }
  if (metadata.armedWakeup) {
    return null;
  }
  return metadata.updatedAt > metadata.lastReadAt ? metadata.lastReadAt : null;
}

export function metadataToSummary(metadata: SessionMetadata): ConversationSummary {
  return {
    sessionId: metadata.sessionId,
    title: metadata.title,
    startTime: new Date(metadata.createdAt).toISOString(),
    lastTime: new Date(metadata.updatedAt).toISOString(),
    provider: metadata.provider,
    messageCount: metadata.messageCount,
    lastMessagePreview: metadata.lastMessagePreview || "No preview available",
    status: metadata.status,
    sourceKind: metadata.sourceKind,
    kind: metadata.kind ?? "chat",
    parentSessionId: metadata.parentSessionId ?? null,
    parentToolUseId: metadata.parentToolUseId ?? null,
    unreadBoundary: getUnreadBoundary(metadata),
    armedWakeup: metadata.armedWakeup ?? null,
    activeLoop: metadata.activeLoop ?? null,
  };
}

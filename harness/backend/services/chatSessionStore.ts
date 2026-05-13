import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BlockedOnHumanInfo,
  ConversationHistory,
  ConversationImageAsset,
  ConversationSummary,
  CreateSessionRequest,
  QueuedMessage,
  QueueSnapshot,
  SessionEvent,
  SessionInterruptionReason,
  SessionMetadata,
  SessionMessageRequest,
  SessionReadyEvent,
  SessionSourceKind,
  SessionStatus,
  SessionStatusSnapshot,
  StreamResponse,
} from "../../shared/types.ts";
import { MAX_QUEUED_MESSAGES } from "../../shared/types.ts";
import {
  parseAllHistoryFiles,
  type ConversationFile,
} from "../history/parser.ts";
import { processConversationMessages } from "../history/timestampRestore.ts";
import { exists } from "../utils/fs.ts";
import { logger } from "../utils/logger.ts";
import { getHomeDir } from "../utils/os.ts";
import {
  isProviderInternalDiagnosticAssistant,
  isProviderInternalDiagnosticResult,
} from "../cli/providerTranscriptNoise.ts";

const STORAGE_VERSION = 1;
const INDEX_FILE_NAME = "index.json";
const SESSIONS_DIR_NAME = "sessions";
const METADATA_FILE_NAME = "metadata.json";
const MESSAGES_FILE_NAME = "messages.jsonl";
const EVENTS_FILE_NAME = "events.jsonl";
const REQUESTS_DIR_NAME = "requests";
const ASSETS_DIR_NAME = "assets";
const ASSET_INDEX_FILE_NAME = "index.json";
const QUEUE_FILE_NAME = "queue.json";
const MAX_EVENT_LOG_SIZE = 2000;
const DEFAULT_TITLE = "New conversation";
const DEFAULT_PREVIEW = "No preview available";

type EventChannel = "stream" | "session" | "status" | "queue";

export interface StoredSessionEvent {
  id: number;
  version: number;
  eventId: string;
  timestamp: number;
  channel: EventChannel;
  data: StreamResponse | SessionEvent | SessionStatusSnapshot | QueueSnapshot;
}

interface StoredSessionMetadata extends SessionMetadata {
  nextEventId: number;
  titleCustomized: boolean;
}

interface SessionIndexRecord {
  sessionId: string;
  projectPath: string;
  encodedProjectName: string | null;
  archivedAt: string | null;
}

interface SessionIndexFile {
  version: number;
  importedLegacyAt: string | null;
  sessions: SessionIndexRecord[];
}

export interface ConversationPageOptions {
  limit?: number;
  before?: number;
}

interface SessionAssetIndex {
  version: number;
  images: ConversationImageAsset[];
}

export interface SessionImageAssetData {
  asset: ConversationImageAsset;
  bytes: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInternalProviderDiagnosticMessage(message: unknown): boolean {
  return (
    isProviderInternalDiagnosticAssistant(message) ||
    isProviderInternalDiagnosticResult(message)
  );
}

function normalizeSessionKind(kind: unknown): SessionMetadata["kind"] {
  return kind === "subagent" ? "subagent" : "chat";
}

export function deriveProvider(
  model?: string | null,
): SessionMetadata["provider"] {
  if (model?.startsWith("codex")) return "codex";
  if (model?.startsWith("pi:")) return "pi";
  if (model?.startsWith("openrouter-claude:")) return "openrouter-claude";
  if (model?.startsWith("hermes:")) return "hermes";
  return "claude";
}

function normalizeTimestamp(
  value: string | number | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function summarizeContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (!isRecord(item)) continue;
    if (
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      return item.text.trim();
    }
  }

  return null;
}

function extractSummaryText(message: unknown): string | null {
  if (!isRecord(message)) {
    return null;
  }

  if (message.type === "user" || message.type === "assistant") {
    const inner = isRecord(message.message) ? message.message : null;
    if (!inner) return null;
    return summarizeContent(inner.content);
  }

  if (message.type === "result") {
    return null;
  }

  if (message.type === "image") {
    return typeof message.caption === "string" && message.caption.trim()
      ? message.caption.trim()
      : "Image";
  }

  if (message.type === "system" && typeof message.message === "string") {
    return message.message.trim() || null;
  }

  return null;
}

function extractTitleCandidate(message: unknown): string | null {
  const text = extractSummaryText(message);
  if (!text) return null;
  const title = text.split("\n")[0]?.trim().slice(0, 120);
  return title || null;
}

function isHumanAuthoredUserMessage(message: unknown): boolean {
  if (!isRecord(message) || message.type !== "user") return false;
  const inner = isRecord(message.message) ? message.message : null;
  if (!inner || inner.role !== "user") return false;
  const content = inner.content;
  if (!Array.isArray(content)) return true;
  return !content.some((item) => isRecord(item) && item.type === "tool_result");
}

function isWakeupArmedMessage(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.type === "system" &&
    message.subtype === "wakeup_armed"
  );
}

function extractTimestampFromMessage(
  message: unknown,
  fallback: number,
): number {
  if (!isRecord(message)) {
    return fallback;
  }
  return normalizeTimestamp(
    typeof message.timestamp === "string" ||
      typeof message.timestamp === "number"
      ? message.timestamp
      : undefined,
    fallback,
  );
}

function buildConversationSummary(
  metadata: SessionMetadata,
): ConversationSummary {
  return {
    sessionId: metadata.sessionId,
    title: metadata.title,
    startTime: new Date(metadata.createdAt).toISOString(),
    lastTime: new Date(metadata.updatedAt).toISOString(),
    provider: metadata.provider,
    messageCount: metadata.messageCount,
    lastMessagePreview: metadata.lastMessagePreview || DEFAULT_PREVIEW,
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

function getUnreadBoundary(metadata: SessionMetadata): number | null {
  if (metadata.status === "running" || metadata.status === "backend_wakeup") {
    return null;
  }
  if (metadata.armedWakeup) {
    return null;
  }
  return metadata.updatedAt > metadata.lastReadAt ? metadata.lastReadAt : null;
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);

  try {
    const dirHandle = await open(dirname(path), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is not available on every platform; the atomic rename
    // remains the important durability boundary for readers.
  }
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  if (!(await exists(path))) {
    return [];
  }

  const raw = await readFile(path, "utf-8");
  return parseJsonLines<T>(raw, path);
}

function parseJsonLines<T>(raw: string, path: string): T[] {
  if (!raw.trim()) {
    return [];
  }

  const parsed: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed) as T);
    } catch (error) {
      logger.chat.warn("Failed to parse JSONL entry from {path}: {error}", {
        path,
        error,
      });
    }
  }
  return parsed;
}

async function countJsonLines(path: string): Promise<number> {
  if (!(await exists(path))) return 0;

  return await new Promise<number>((resolve, reject) => {
    let count = 0;
    let hasNonNewlineBytes = false;
    let lastByteWasNewline = false;
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of buffer) {
        if (byte === 10) {
          count += 1;
          lastByteWasNewline = true;
        } else if (byte !== 13) {
          hasNonNewlineBytes = true;
          lastByteWasNewline = false;
        }
      }
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(count + (hasNonNewlineBytes && !lastByteWasNewline ? 1 : 0));
    });
  });
}

async function readTailJsonLines<T>(path: string, limit: number): Promise<T[]> {
  if (limit <= 0 || !(await exists(path))) return [];

  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return [];

    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    let position = stat.size;
    let newlineCount = 0;

    while (position > 0 && newlineCount <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (let i = 0; i < chunk.length; i += 1) {
        if (chunk[i] === 10) newlineCount += 1;
      }
    }

    const raw = Buffer.concat(chunks).toString("utf-8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);
    return parseJsonLines<T>(lines.join("\n"), path);
  } finally {
    await handle.close();
  }
}

const ORPHAN_PREFIX_PAGE_THRESHOLD = 20;

async function readJsonLinesPage<T>(
  path: string,
  totalCount: number,
  options: ConversationPageOptions = {},
): Promise<{ messages: T[]; startIndex: number; endIndex: number }> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 80), 1), 200);
  const before =
    typeof options.before === "number" && Number.isFinite(options.before)
      ? Math.max(0, Math.min(Math.floor(options.before), totalCount))
      : totalCount;
  const omittedPrefixCount = before - limit;
  const startIndex =
    before === totalCount &&
    omittedPrefixCount > 0 &&
    omittedPrefixCount <= ORPHAN_PREFIX_PAGE_THRESHOLD
      ? 0
      : Math.max(0, omittedPrefixCount);
  const endIndex = before;

  if (endIndex === totalCount) {
    const messages = await readTailJsonLines<T>(path, endIndex - startIndex);
    return { messages, startIndex, endIndex };
  }

  const all = await readJsonLines<T>(path);
  return { messages: all.slice(startIndex, endIndex), startIndex, endIndex };
}

async function readLastJsonLine<T>(path: string): Promise<T | null> {
  if (!(await exists(path))) {
    return null;
  }

  const raw = await readFile(path, "utf-8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last) as T;
  } catch (error) {
    logger.chat.warn("Failed to parse final JSONL entry from {path}: {error}", {
      path,
      error,
    });
    return null;
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf-8");
}

async function saveJsonLines(path: string, values: unknown[]): Promise<void> {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(path, body ? `${body}\n` : "", "utf-8");
}

async function loadCustomTitles(
  historyDir: string,
): Promise<Record<string, string>> {
  return await loadJson<Record<string, string>>(
    join(historyDir, "_titles.json"),
    {},
  );
}

export class ChatSessionStore {
  private readonly rootDir: string;

  private readonly skipLegacyImport: boolean;

  private readonly skipActiveSessionReconcile: boolean;

  private initializePromise: Promise<void> | null = null;

  constructor(
    rootDir?: string,
    options?: {
      skipLegacyImport?: boolean;
      skipActiveSessionReconcile?: boolean;
    },
  ) {
    const homeDir = getHomeDir();
    if (!homeDir && !rootDir) {
      throw new Error("Home directory not found");
    }

    this.rootDir = rootDir ?? join(homeDir!, ".swarmfleet", "chat-sessions");
    this.skipLegacyImport = options?.skipLegacyImport ?? false;
    this.skipActiveSessionReconcile =
      options?.skipActiveSessionReconcile ?? false;
  }

  get storageRoot(): string {
    return this.rootDir;
  }

  async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initializeInternal();
    }
    await this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    await mkdir(this.sessionsRootPath(), { recursive: true });
    const index = await this.loadIndex();
    if (!this.skipLegacyImport && !index.importedLegacyAt) {
      await this.importLegacyHistories(index);
    } else if (this.skipLegacyImport && !index.importedLegacyAt) {
      index.importedLegacyAt = new Date().toISOString();
      await this.saveIndex(index);
    }
    await this.reconcileHumanAuthoredReadState();
    if (!this.skipActiveSessionReconcile) {
      await this.reconcileActiveSessions();
    }
  }

  private sessionsRootPath(): string {
    return join(this.rootDir, SESSIONS_DIR_NAME);
  }

  private indexPath(): string {
    return join(this.rootDir, INDEX_FILE_NAME);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsRootPath(), sessionId);
  }

  private metadataPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), METADATA_FILE_NAME);
  }

  private messagesPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), MESSAGES_FILE_NAME);
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), EVENTS_FILE_NAME);
  }

  private requestsDirPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), REQUESTS_DIR_NAME);
  }

  private assetsDirPath(sessionId: string): string {
    return join(this.sessionPath(sessionId), ASSETS_DIR_NAME);
  }

  private assetIndexPath(sessionId: string): string {
    return join(this.assetsDirPath(sessionId), ASSET_INDEX_FILE_NAME);
  }

  private assetFilePath(sessionId: string, assetId: string): string {
    return join(this.assetsDirPath(sessionId), `${assetId}.bin`);
  }

  private requestPath(sessionId: string, requestId: string): string {
    return join(this.requestsDirPath(sessionId), `${requestId}.json`);
  }

  private async loadIndex(): Promise<SessionIndexFile> {
    await mkdir(this.sessionsRootPath(), { recursive: true });
    const index = await loadJson<SessionIndexFile>(this.indexPath(), {
      version: STORAGE_VERSION,
      importedLegacyAt: null,
      sessions: [],
    });
    return await this.repairIndexFromSessionMetadata(index);
  }

  private async saveIndex(index: SessionIndexFile): Promise<void> {
    index.version = STORAGE_VERSION;
    await writeJsonAtomic(this.indexPath(), index);
  }

  private async repairIndexFromSessionMetadata(
    index: SessionIndexFile,
  ): Promise<SessionIndexFile> {
    const byId = new Map(
      index.sessions.map((entry) => [entry.sessionId, entry]),
    );
    let changed = false;

    let entries: Dirent[];
    try {
      entries = await readdir(this.sessionsRootPath(), { withFileTypes: true });
    } catch {
      return index;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await this.loadStoredMetadata(entry.name);
      if (!metadata) continue;

      const existing = byId.get(metadata.sessionId);
      const archivedAt = metadata.archivedAt ?? null;
      if (existing) {
        if (
          existing.projectPath !== metadata.projectPath ||
          existing.encodedProjectName !== metadata.encodedProjectName ||
          existing.archivedAt !== archivedAt
        ) {
          existing.projectPath = metadata.projectPath;
          existing.encodedProjectName = metadata.encodedProjectName;
          existing.archivedAt = archivedAt;
          changed = true;
        }
        continue;
      }

      index.sessions.push({
        sessionId: metadata.sessionId,
        projectPath: metadata.projectPath,
        encodedProjectName: metadata.encodedProjectName,
        archivedAt,
      });
      changed = true;
    }

    if (changed && !index.importedLegacyAt && index.sessions.length > 0) {
      index.importedLegacyAt = new Date().toISOString();
    }
    if (changed) {
      await this.saveIndex(index);
    }

    return index;
  }

  private toPublicMetadata(metadata: StoredSessionMetadata): SessionMetadata {
    const {
      nextEventId: _nextEventId,
      titleCustomized: _titleCustomized,
      ...publicMetadata
    } = metadata;
    // Sessions stored before `kind` was introduced lack the field; sessions
    // from removed legacy systems may contain obsolete kinds. Treat anything
    // other than the current explicit child-session kind as a normal chat.
    return {
      ...publicMetadata,
      kind: normalizeSessionKind(publicMetadata.kind),
      cliPid: publicMetadata.cliPid ?? null,
      parentSessionId: publicMetadata.parentSessionId ?? null,
      parentToolUseId: publicMetadata.parentToolUseId ?? null,
      lastReadAt: publicMetadata.lastReadAt ?? publicMetadata.updatedAt,
      blockedOnHuman: publicMetadata.blockedOnHuman,
      lastInterruptionReason: publicMetadata.lastInterruptionReason ?? null,
      lastInterruptionDetail: publicMetadata.lastInterruptionDetail ?? null,
      armedWakeup: publicMetadata.armedWakeup ?? null,
    };
  }

  private async loadStoredMetadata(
    sessionId: string,
  ): Promise<StoredSessionMetadata | null> {
    const metadataPath = this.metadataPath(sessionId);
    if (!(await exists(metadataPath))) {
      return null;
    }
    const metadata = await loadJson<StoredSessionMetadata | null>(
      metadataPath,
      null,
    );
    return metadata;
  }

  private async saveStoredMetadata(
    sessionId: string,
    metadata: StoredSessionMetadata,
  ): Promise<void> {
    await writeJsonAtomic(this.metadataPath(sessionId), metadata);
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    await mkdir(this.sessionPath(sessionId), { recursive: true });
    await mkdir(this.requestsDirPath(sessionId), { recursive: true });
  }

  private async addIndexRecord(metadata: StoredSessionMetadata): Promise<void> {
    const index = await this.loadIndex();
    const existing = index.sessions.find(
      (entry) => entry.sessionId === metadata.sessionId,
    );
    if (existing) {
      existing.projectPath = metadata.projectPath;
      existing.encodedProjectName = metadata.encodedProjectName;
      existing.archivedAt = metadata.archivedAt ?? null;
    } else {
      index.sessions.push({
        sessionId: metadata.sessionId,
        projectPath: metadata.projectPath,
        encodedProjectName: metadata.encodedProjectName,
        archivedAt: metadata.archivedAt ?? null,
      });
    }
    await this.saveIndex(index);
  }

  private async updateIndexArchiveState(
    sessionId: string,
    archivedAt: string | null,
  ): Promise<void> {
    const index = await this.loadIndex();
    const existing = index.sessions.find(
      (entry) => entry.sessionId === sessionId,
    );
    if (existing) {
      existing.archivedAt = archivedAt;
      await this.saveIndex(index);
    }
  }

  private async updateMetadata(
    sessionId: string,
    updater: (metadata: StoredSessionMetadata) => void,
  ): Promise<SessionMetadata> {
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }
    updater(metadata);
    await this.saveStoredMetadata(sessionId, metadata);
    return this.toPublicMetadata(metadata);
  }

  async createSession(request: CreateSessionRequest): Promise<SessionMetadata> {
    await this.ensureInitialized();

    const now = Date.now();
    const sessionId = request.sessionId?.trim() || crypto.randomUUID();
    const metadata: StoredSessionMetadata = {
      sessionId,
      projectPath: request.projectPath,
      encodedProjectName: request.encodedProjectName ?? null,
      provider: deriveProvider(request.model),
      providerSessionId: request.providerSessionId ?? null,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      title: request.title?.trim() || DEFAULT_TITLE,
      lastMessagePreview: DEFAULT_PREVIEW,
      model: request.model ?? "claude-sonnet-4-6",
      effort: request.effort ?? "auto",
      permissionMode: request.permissionMode ?? "default",
      allowedTools: request.allowedTools
        ? [...request.allowedTools]
        : undefined,
      activeRequestId: null,
      runnerPid: null,
      cliPid: null,
      sourceKind: "native",
      kind: request.kind ?? "chat",
      latestEventId: -1,
      retainedEventId: 0,
      messageCount: 0,
      lastReadAt: now,
      archivedAt: null,
      parentSessionId: request.parentSessionId ?? null,
      parentToolUseId: request.parentToolUseId ?? null,
      lastInterruptionReason: null,
      lastInterruptionDetail: null,
      nextEventId: 0,
      titleCustomized: Boolean(request.title?.trim()),
    };

    await this.ensureSessionDirectory(sessionId);
    await this.saveStoredMetadata(sessionId, metadata);
    await saveJsonLines(this.messagesPath(sessionId), []);
    await saveJsonLines(this.eventsPath(sessionId), []);
    await this.addIndexRecord(metadata);
    return this.toPublicMetadata(metadata);
  }

  async getSession(sessionId: string): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    return metadata ? this.toPublicMetadata(metadata) : null;
  }

  /**
   * Returns public metadata for every non-archived session. Used by the
   * session-status watcher to (a) rediscover still-running detached runners
   * after a backend restart and (b) poll for status transitions on tracked
   * sessions. Cross-project — there's intentionally no filter.
   */
  async listAllActiveMetadata(): Promise<SessionMetadata[]> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    const results: SessionMetadata[] = [];
    for (const entry of index.sessions) {
      if (entry.archivedAt) continue;
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (!metadata || metadata.archivedAt) continue;
      results.push(this.toPublicMetadata(metadata));
    }
    return results;
  }

  async listSessionsByProject(
    projectPath: string,
  ): Promise<ConversationSummary[]> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    const matches = index.sessions
      .filter((entry) => entry.projectPath === projectPath && !entry.archivedAt)
      .map((entry) => entry.sessionId);

    const summaries: ConversationSummary[] = [];
    for (const sessionId of matches) {
      const metadata = await this.loadStoredMetadata(sessionId);
      if (!metadata || metadata.archivedAt) continue;
      const publicMetadata = this.toPublicMetadata(metadata);
      summaries.push(buildConversationSummary(publicMetadata));
    }

    summaries.sort((a, b) => Date.parse(b.lastTime) - Date.parse(a.lastTime));

    return summaries;
  }

  async listSessionsByEncodedProjectName(
    encodedProjectName: string,
  ): Promise<ConversationSummary[]> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    const matches = index.sessions
      .filter(
        (entry) =>
          entry.encodedProjectName === encodedProjectName && !entry.archivedAt,
      )
      .map((entry) => entry.sessionId);

    const summaries: ConversationSummary[] = [];
    for (const sessionId of matches) {
      const metadata = await this.loadStoredMetadata(sessionId);
      if (!metadata || metadata.archivedAt) continue;
      const publicMetadata = this.toPublicMetadata(metadata);
      summaries.push(buildConversationSummary(publicMetadata));
    }

    summaries.sort((a, b) => Date.parse(b.lastTime) - Date.parse(a.lastTime));

    return summaries;
  }

  async getConversation(
    sessionId: string,
    options?: ConversationPageOptions,
  ): Promise<ConversationHistory | null> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata || metadata.archivedAt) {
      return null;
    }

    const messagesPath = this.messagesPath(sessionId);
    const actualMessageCount = await countJsonLines(messagesPath);
    if (actualMessageCount !== metadata.messageCount) {
      metadata.messageCount = actualMessageCount;
      await this.saveStoredMetadata(sessionId, metadata);
    }

    const page = await readJsonLinesPage<unknown>(
      messagesPath,
      actualMessageCount,
      options,
    );

    const visibleMessages = page.messages.filter(
      (message) => !isInternalProviderDiagnosticMessage(message),
    );

    return {
      sessionId,
      messages: visibleMessages,
      metadata: {
        startTime: new Date(metadata.createdAt).toISOString(),
        endTime: new Date(metadata.updatedAt).toISOString(),
        messageCount: actualMessageCount,
      },
      page: {
        startIndex: page.startIndex,
        endIndex: page.endIndex,
        hasMoreBefore: page.startIndex > 0,
      },
    };
  }

  async appendMessage(sessionId: string, message: unknown): Promise<void> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }

    if (isInternalProviderDiagnosticMessage(message)) {
      return;
    }

    await appendJsonLine(this.messagesPath(sessionId), message);

    const timestamp = extractTimestampFromMessage(message, Date.now());
    metadata.updatedAt = Math.max(metadata.updatedAt, timestamp);
    if (isHumanAuthoredUserMessage(message)) {
      metadata.lastReadAt = Math.max(metadata.lastReadAt ?? 0, timestamp);
      metadata.armedWakeup = null;
    } else if (isWakeupArmedMessage(message)) {
      metadata.lastReadAt = Math.max(metadata.lastReadAt ?? 0, timestamp);
    }
    metadata.messageCount += 1;

    const preview = extractSummaryText(message);
    if (preview) {
      metadata.lastMessagePreview = preview.slice(0, 200);
    }

    if (!metadata.titleCustomized) {
      const titleCandidate = extractTitleCandidate(message);
      if (titleCandidate) {
        metadata.title = titleCandidate;
      }
    }

    await this.saveStoredMetadata(sessionId, metadata);
  }

  private async reconcileHumanAuthoredReadState(): Promise<void> {
    const index = await this.loadIndex();
    for (const entry of index.sessions) {
      if (entry.archivedAt) continue;
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (
        !metadata ||
        metadata.archivedAt ||
        metadata.updatedAt <= (metadata.lastReadAt ?? 0)
      ) {
        continue;
      }

      const lastMessage = await readLastJsonLine<unknown>(
        this.messagesPath(entry.sessionId),
      );
      if (!isHumanAuthoredUserMessage(lastMessage)) {
        continue;
      }

      metadata.lastReadAt = Math.max(
        metadata.lastReadAt ?? 0,
        metadata.updatedAt,
      );
      await this.saveStoredMetadata(entry.sessionId, metadata);
    }
  }

  async saveImageAsset(
    sessionId: string,
    input: {
      bytes: Buffer;
      mimeType: ConversationImageAsset["mimeType"];
      sourceToolName?: string;
    },
  ): Promise<ConversationImageAsset> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }

    await mkdir(this.assetsDirPath(sessionId), { recursive: true });
    const assetId = crypto.randomUUID();
    await writeFile(this.assetFilePath(sessionId, assetId), input.bytes);

    const asset: ConversationImageAsset = {
      assetId,
      mimeType: input.mimeType,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`,
      thumbnailUrl: `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}?thumbnail=1`,
      createdAt: Date.now(),
      ...(input.sourceToolName ? { sourceToolName: input.sourceToolName } : {}),
    };

    const index = await loadJson<SessionAssetIndex>(
      this.assetIndexPath(sessionId),
      { version: 1, images: [] },
    );
    index.version = 1;
    index.images.push(asset);
    await writeJson(this.assetIndexPath(sessionId), index);
    return asset;
  }

  async listImageAssets(sessionId: string): Promise<ConversationImageAsset[]> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata || metadata.archivedAt) return [];
    const index = await loadJson<SessionAssetIndex>(
      this.assetIndexPath(sessionId),
      { version: 1, images: [] },
    );
    return [...index.images];
  }

  async listImageAssetsIncludingDescendants(
    sessionId: string,
  ): Promise<ConversationImageAsset[]> {
    await this.ensureInitialized();
    const root = await this.loadStoredMetadata(sessionId);
    if (!root || root.archivedAt) return [];

    const index = await this.loadIndex();
    const childrenByParent = new Map<string, string[]>();

    for (const entry of index.sessions) {
      if (entry.archivedAt || entry.sessionId === sessionId) continue;
      if (entry.projectPath !== root.projectPath) continue;

      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (!metadata || metadata.archivedAt) continue;
      if (metadata.projectPath !== root.projectPath) continue;

      const parentSessionId = metadata.parentSessionId ?? null;
      if (!parentSessionId) continue;

      const children = childrenByParent.get(parentSessionId) ?? [];
      children.push(metadata.sessionId);
      childrenByParent.set(parentSessionId, children);
    }

    const sessionIds: string[] = [];
    const seen = new Set<string>();
    const queue = [sessionId];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      sessionIds.push(current);

      for (const childId of childrenByParent.get(current) ?? []) {
        queue.push(childId);
      }
    }

    const images: ConversationImageAsset[] = [];
    for (const id of sessionIds) {
      images.push(...(await this.listImageAssets(id)));
    }

    return images.sort((left, right) => left.createdAt - right.createdAt);
  }

  async readImageAsset(
    sessionId: string,
    assetId: string,
  ): Promise<SessionImageAssetData | null> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata || metadata.archivedAt) return null;
    const images = await this.listImageAssets(sessionId);
    const asset = images.find((candidate) => candidate.assetId === assetId);
    if (!asset) return null;
    try {
      const bytes = await readFile(this.assetFilePath(sessionId, assetId));
      return { asset, bytes };
    } catch {
      return null;
    }
  }

  async replaceMessages(sessionId: string, messages: unknown[]): Promise<void> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }

    await saveJsonLines(this.messagesPath(sessionId), messages);

    metadata.messageCount = messages.length;
    const first = messages[0];
    const last = messages[messages.length - 1];
    metadata.createdAt = extractTimestampFromMessage(first, metadata.createdAt);
    metadata.updatedAt = extractTimestampFromMessage(last, metadata.updatedAt);

    const preview = [...messages]
      .reverse()
      .map((message) => extractSummaryText(message))
      .find((text): text is string => Boolean(text));
    metadata.lastMessagePreview = preview?.slice(0, 200) ?? DEFAULT_PREVIEW;

    if (!metadata.titleCustomized) {
      const titleCandidate = messages
        .map((message) => extractTitleCandidate(message))
        .find((text): text is string => Boolean(text));
      if (titleCandidate) {
        metadata.title = titleCandidate;
      }
    }

    await this.saveStoredMetadata(sessionId, metadata);
  }

  async appendEvent(
    sessionId: string,
    channel: EventChannel,
    data: StreamResponse | SessionEvent | SessionStatusSnapshot | QueueSnapshot,
  ): Promise<StoredSessionEvent> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }

    const event: StoredSessionEvent = {
      id: metadata.nextEventId,
      version: metadata.nextEventId,
      eventId: String(metadata.nextEventId),
      timestamp: Date.now(),
      channel,
      data,
    };

    await appendJsonLine(this.eventsPath(sessionId), event);

    metadata.nextEventId += 1;
    metadata.latestEventId = event.id;
    metadata.updatedAt = event.timestamp;

    const events = await readJsonLines<StoredSessionEvent>(
      this.eventsPath(sessionId),
    );
    if (events.length > MAX_EVENT_LOG_SIZE) {
      const retained = events.slice(-MAX_EVENT_LOG_SIZE);
      metadata.retainedEventId = retained[0]?.id ?? metadata.retainedEventId;
      await saveJsonLines(this.eventsPath(sessionId), retained);
    }

    await this.saveStoredMetadata(sessionId, metadata);
    return event;
  }

  async readEventsSince(
    sessionId: string,
    lastEventId: number,
  ): Promise<StoredSessionEvent[] | null> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      throw new Error("Session not found");
    }

    const events = await readJsonLines<StoredSessionEvent>(
      this.eventsPath(sessionId),
    );
    const normalized = events.map((event) => ({
      ...event,
      version: event.version ?? event.id,
      eventId: event.eventId ?? String(event.id),
    }));
    const firstRetainedId = normalized[0]?.id;
    if (
      lastEventId >= 0 &&
      metadata.latestEventId > lastEventId &&
      (firstRetainedId === undefined || firstRetainedId > lastEventId + 1)
    ) {
      return null;
    }
    if (lastEventId > metadata.latestEventId) {
      return null;
    }
    return normalized.filter((event) => event.id > lastEventId);
  }

  async markRunStarted(
    sessionId: string,
    requestId: string,
    overrides: {
      model?: string;
      effort?: string;
      permissionMode?: SessionMetadata["permissionMode"];
      allowedTools?: string[];
    } = {},
  ): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      if (overrides.model) {
        const requestedProvider = deriveProvider(overrides.model);
        if (requestedProvider !== current.provider) {
          // Provider is locked at session creation. Switching providers mid-session
          // would leak transcript format and silently mutate session metadata.
          // Reject instead.
          throw new Error(
            `Cannot switch provider mid-session: session is locked to "${current.provider}", ` +
              `but model "${overrides.model}" requires provider "${requestedProvider}". ` +
              `Start a new session to use a different provider.`,
          );
        }
        current.model = overrides.model;
      }
      current.status = "running";
      current.activeRequestId = requestId;
      current.runnerPid = null;
      current.cliPid = null;
      current.lastInterruptionReason = null;
      current.lastInterruptionDetail = null;
      current.updatedAt = Date.now();
      if (overrides.effort) {
        current.effort = overrides.effort;
      }
      if (overrides.permissionMode) {
        current.permissionMode = overrides.permissionMode;
      }
      if (overrides.allowedTools) {
        current.allowedTools = [...overrides.allowedTools];
      }
    });

    await this.appendEvent(sessionId, "status", {
      sessionId,
      status: "running",
    });

    return metadata;
  }

  async updateRunnerPid(
    sessionId: string,
    runnerPid: number | null,
  ): Promise<SessionMetadata> {
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.runnerPid = runnerPid;
      metadata.updatedAt = Date.now();
    });
  }

  async updateCliPid(
    sessionId: string,
    cliPid: number | null,
  ): Promise<SessionMetadata> {
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.cliPid = cliPid;
      metadata.updatedAt = Date.now();
    });
  }

  async updateProviderSessionId(
    sessionId: string,
    providerSessionId: string,
  ): Promise<SessionMetadata> {
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.providerSessionId = providerSessionId;
      metadata.updatedAt = Date.now();
    });
  }

  async recordInterruptionIntent(
    sessionId: string,
    reason: SessionInterruptionReason,
    detail?: string,
  ): Promise<SessionMetadata> {
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.lastInterruptionReason = reason;
      metadata.lastInterruptionDetail = detail ?? null;
      metadata.updatedAt = Date.now();
    });
  }

  async updateStatus(
    sessionId: string,
    status: SessionStatus,
    options: {
      clearActiveRequest?: boolean;
      clearRunnerPid?: boolean;
      interruptionReason?: SessionInterruptionReason;
      interruptionDetail?: string;
    } = {},
  ): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.status = status;
      current.updatedAt = Date.now();
      if (status === "interrupted") {
        current.lastInterruptionReason =
          options.interruptionReason ??
          current.lastInterruptionReason ??
          "unknown";
        current.lastInterruptionDetail =
          options.interruptionDetail ?? current.lastInterruptionDetail ?? null;
      } else if (status === "running" || status === "idle") {
        current.lastInterruptionReason = null;
        current.lastInterruptionDetail = null;
      }
      if (options.clearActiveRequest) {
        current.activeRequestId = null;
      }
      if (options.clearRunnerPid) {
        current.runnerPid = null;
        current.cliPid = null;
      }
    });

    await this.appendEvent(sessionId, "status", {
      sessionId,
      status,
      ...(metadata.lastInterruptionReason
        ? { interruptionReason: metadata.lastInterruptionReason }
        : {}),
      ...(metadata.lastInterruptionDetail
        ? { interruptionDetail: metadata.lastInterruptionDetail }
        : {}),
    });
    return metadata;
  }

  async setBlockedOnHuman(
    sessionId: string,
    info: BlockedOnHumanInfo,
  ): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.status = "blocked_on_human";
      current.blockedOnHuman = info;
      current.updatedAt = Date.now();
    });
    await this.appendEvent(sessionId, "status", {
      sessionId,
      status: "blocked_on_human",
    });
    return metadata;
  }

  async clearBlockedOnHuman(sessionId: string): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.status = "idle";
      delete current.blockedOnHuman;
      current.updatedAt = Date.now();
    });
    await this.appendEvent(sessionId, "status", {
      sessionId,
      status: "idle",
    });
    return metadata;
  }

  async reconcileUnexpectedRunnerExit(
    sessionId: string,
    detail?: string,
    reason: SessionInterruptionReason = "runner_exited",
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const metadata = await this.loadStoredMetadata(sessionId);
    if (!metadata) {
      return null;
    }

    const hadActiveRequest = metadata.activeRequestId;
    const wasRunning = metadata.status === "running";
    const nextStatus = wasRunning ? "interrupted" : metadata.status;

    const updated = await this.updateStatus(sessionId, nextStatus, {
      clearActiveRequest:
        metadata.status === "running" || metadata.status === "awaiting_input",
      clearRunnerPid: true,
      interruptionReason: wasRunning ? reason : undefined,
      interruptionDetail: wasRunning ? detail : undefined,
    });

    if (hadActiveRequest) {
      await this.deletePendingRequest(sessionId, hadActiveRequest).catch(() => {
        // Best effort — stale request files should not block recovery.
      });
    }

    if (wasRunning) {
      const interruptionMessage = {
        type: "system",
        subtype: "runner_interrupted",
        timestamp: new Date().toISOString(),
        reason,
        message: detail?.trim() || "Session runner stopped unexpectedly",
      };
      await this.appendMessage(sessionId, interruptionMessage);
      await this.appendEvent(sessionId, "stream", {
        type: "claude_json",
        data: interruptionMessage,
      });
    }

    return updated;
  }

  private queuePath(sessionId: string): string {
    return join(this.sessionPath(sessionId), QUEUE_FILE_NAME);
  }

  async readQueue(sessionId: string): Promise<QueuedMessage[]> {
    await this.ensureInitialized();
    return await loadJson<QueuedMessage[]>(this.queuePath(sessionId), []);
  }

  /**
   * Persist the full queue for a session and broadcast a `queue` SSE event.
   * Always write — even on a no-op — so callers don't need to diff; the SSE
   * event is the primary signal we want every listener to see.
   */
  private async writeQueueAndBroadcast(
    sessionId: string,
    queue: QueuedMessage[],
  ): Promise<void> {
    await this.ensureSessionDirectory(sessionId);
    await writeJson(this.queuePath(sessionId), queue);
    const snapshot: QueueSnapshot = { sessionId, queued: queue };
    await this.appendEvent(sessionId, "queue", snapshot);
  }

  /**
   * Append a message to the end of the queue. Rejects when the queue is full
   * so the caller (HTTP handler) can surface a 409 to the client instead of
   * silently dropping the user's input.
   */
  async enqueueMessage(
    sessionId: string,
    queued: QueuedMessage,
  ): Promise<QueuedMessage> {
    const current = await this.readQueue(sessionId);
    if (current.length >= MAX_QUEUED_MESSAGES) {
      throw new Error(
        `Queue is full (max ${MAX_QUEUED_MESSAGES} pending messages)`,
      );
    }
    const next = [...current, queued];
    await this.writeQueueAndBroadcast(sessionId, next);
    return queued;
  }

  async removeFromQueue(
    sessionId: string,
    queuedId: string,
  ): Promise<QueuedMessage | null> {
    const current = await this.readQueue(sessionId);
    const idx = current.findIndex((entry) => entry.id === queuedId);
    if (idx === -1) return null;
    const [removed] = current.splice(idx, 1);
    await this.writeQueueAndBroadcast(sessionId, current);
    return removed;
  }

  /** Pops and returns the head of the queue, or null if empty. */
  async popFirstFromQueue(sessionId: string): Promise<QueuedMessage | null> {
    const current = await this.readQueue(sessionId);
    if (current.length === 0) return null;
    const [first, ...rest] = current;
    await this.writeQueueAndBroadcast(sessionId, rest);
    return first;
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.title = title;
      current.titleCustomized = true;
      current.updatedAt = Date.now();
    });
    return metadata;
  }

  async markSessionRead(
    sessionId: string,
    readAt = Date.now(),
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const existing = await this.loadStoredMetadata(sessionId);
    if (!existing || existing.archivedAt) return null;
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.lastReadAt = Math.max(metadata.lastReadAt ?? 0, readAt);
    });
  }

  async setArmedWakeup(
    sessionId: string,
    armedWakeup: NonNullable<SessionMetadata["armedWakeup"]>,
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const existing = await this.loadStoredMetadata(sessionId);
    if (!existing || existing.archivedAt) return null;
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.armedWakeup = armedWakeup;
    });
  }

  async clearArmedWakeup(
    sessionId: string,
    wakeupId?: string,
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const existing = await this.loadStoredMetadata(sessionId);
    if (!existing || existing.archivedAt || !existing.armedWakeup) return null;
    if (wakeupId && existing.armedWakeup.id !== wakeupId) return null;
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.armedWakeup = null;
    });
  }

  async setActiveLoop(
    sessionId: string,
    activeLoop: NonNullable<SessionMetadata["activeLoop"]>,
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const existing = await this.loadStoredMetadata(sessionId);
    if (!existing || existing.archivedAt) return null;
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.activeLoop = activeLoop;
    });
  }

  async clearActiveLoop(sessionId: string): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const existing = await this.loadStoredMetadata(sessionId);
    if (!existing || existing.archivedAt || !existing.activeLoop) return null;
    return await this.updateMetadata(sessionId, (metadata) => {
      metadata.activeLoop = null;
    });
  }

  async demoteSessionToChat(
    sessionId: string,
    title?: string,
  ): Promise<SessionMetadata> {
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.kind = "chat";
      if (title?.trim()) {
        current.title = title.trim().slice(0, 120);
        current.titleCustomized = true;
      }
      current.updatedAt = Date.now();
    });
    return metadata;
  }

  async archiveSession(sessionId: string): Promise<SessionMetadata> {
    const archivedAt = new Date().toISOString();
    const metadata = await this.updateMetadata(sessionId, (current) => {
      current.archivedAt = archivedAt;
      current.updatedAt = Date.now();
      if (current.status === "running" || current.status === "backend_wakeup") {
        current.status = "interrupted";
        current.lastInterruptionReason = "archive";
        current.lastInterruptionDetail = "Session was archived while active";
      }
    });
    await this.updateIndexArchiveState(sessionId, archivedAt);
    return metadata;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    await rm(this.sessionPath(sessionId), { recursive: true, force: true });
    const index = await this.loadIndex();
    index.sessions = index.sessions.filter(
      (entry) => entry.sessionId !== sessionId,
    );
    await this.saveIndex(index);
  }

  async findSessionByProviderSessionId(
    providerSessionId: string,
    projectPath?: string,
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    for (const entry of index.sessions) {
      if (entry.archivedAt) continue;
      if (projectPath && entry.projectPath !== projectPath) continue;
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (!metadata || metadata.archivedAt) continue;
      if (metadata.providerSessionId === providerSessionId) {
        return this.toPublicMetadata(metadata);
      }
    }
    return null;
  }

  async findSessionByRequestId(
    requestId: string,
  ): Promise<SessionMetadata | null> {
    await this.ensureInitialized();
    const index = await this.loadIndex();
    for (const entry of index.sessions) {
      if (entry.archivedAt) continue;
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (!metadata || metadata.archivedAt) continue;
      if (metadata.activeRequestId === requestId) {
        return this.toPublicMetadata(metadata);
      }
    }
    return null;
  }

  async reconcileActiveSessions(): Promise<void> {
    const index = await this.loadIndex();
    const now = Date.now();
    for (const entry of index.sessions) {
      if (entry.archivedAt) continue;
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (!metadata) continue;

      if (
        metadata.runnerPid &&
        (await this.isRecordedRunnerAlive(entry.sessionId, metadata.runnerPid))
      ) {
        continue;
      }

      if (metadata.status === "running") {
        // Cannot call reconcileUnexpectedRunnerExit here: it calls ensureInitialized
        // which awaits initializePromise — the same promise currently executing this
        // method — causing a permanent deadlock. Use private helpers directly instead.
        // Events/messages are skipped; no SSE listeners exist during startup reconcile.
        const requestId = metadata.activeRequestId;
        const requestStillExists = requestId
          ? await exists(this.requestPath(entry.sessionId, requestId))
          : false;
        const shouldAutoResume = Boolean(requestId) && requestStillExists;

        metadata.status = shouldAutoResume ? "backend_wakeup" : "interrupted";
        metadata.runnerPid = null;
        metadata.cliPid = null;
        metadata.lastInterruptionReason = shouldAutoResume
          ? null
          : "runner_missing";
        metadata.lastInterruptionDetail = shouldAutoResume
          ? null
          : "Startup reconcile found no live runner and no pending request to resume";
        if (!shouldAutoResume) {
          if (requestId) {
            await rm(this.requestPath(entry.sessionId, requestId), {
              force: true,
            });
          }
          metadata.activeRequestId = null;
        }
        metadata.updatedAt = now;
        await this.saveStoredMetadata(entry.sessionId, metadata);
        continue;
      }

      if (metadata.status === "awaiting_input") {
        metadata.runnerPid = null;
        metadata.cliPid = null;
        metadata.updatedAt = now;
        await this.saveStoredMetadata(entry.sessionId, metadata);
        continue;
      }

      if (metadata.runnerPid || metadata.cliPid) {
        metadata.runnerPid = null;
        metadata.cliPid = null;
        metadata.updatedAt = Date.now();
        await this.saveStoredMetadata(entry.sessionId, metadata);
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async isRecordedRunnerAlive(
    sessionId: string,
    pid: number,
  ): Promise<boolean> {
    if (!this.isProcessAlive(pid)) return false;
    if (process.platform !== "linux") return true;

    try {
      const environ = await readFile(`/proc/${pid}/environ`, "utf-8");
      if (environ.includes(`SWARMFLEET_SESSION_ID=${sessionId}`)) return true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      if (code === "EACCES" || code === "EPERM") return true;
    }

    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf-8");
      return cmdline.includes("session-runner") && cmdline.includes(sessionId);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : null;
      return code === "EACCES" || code === "EPERM";
    }
  }

  private async importLegacyHistories(index: SessionIndexFile): Promise<void> {
    const homeDir = getHomeDir();
    if (!homeDir) {
      index.importedLegacyAt = new Date().toISOString();
      await this.saveIndex(index);
      return;
    }

    const projectsRoot = join(homeDir, ".claude", "projects");
    if (!(await exists(projectsRoot))) {
      index.importedLegacyAt = new Date().toISOString();
      await this.saveIndex(index);
      return;
    }

    const existingProviderIds = new Set<string>();
    for (const entry of index.sessions) {
      const metadata = await this.loadStoredMetadata(entry.sessionId);
      if (metadata?.providerSessionId) {
        existingProviderIds.add(metadata.providerSessionId);
      }
    }

    const projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;

      const encodedProjectName = projectEntry.name;
      const historyDir = join(projectsRoot, encodedProjectName);
      const customTitles = await loadCustomTitles(historyDir);
      const conversations = await parseAllHistoryFiles(historyDir);

      for (const conversation of conversations) {
        if (existingProviderIds.has(conversation.sessionId)) {
          continue;
        }

        const projectPath = this.resolveLegacyProjectPath(conversation);
        if (!projectPath) {
          logger.history.debug(
            "Skipping legacy import for {sessionId}; cwd missing",
            { sessionId: conversation.sessionId },
          );
          continue;
        }

        const processed = processConversationMessages(
          conversation.messages,
          conversation.sessionId,
        );
        const now = Date.now();
        const createdAt = normalizeTimestamp(processed.metadata.startTime, now);
        const updatedAt = normalizeTimestamp(
          processed.metadata.endTime,
          createdAt,
        );
        const title =
          customTitles[conversation.sessionId] ||
          conversation.title ||
          DEFAULT_TITLE;
        const sessionId = crypto.randomUUID();
        const metadata: StoredSessionMetadata = {
          sessionId,
          projectPath,
          encodedProjectName,
          provider: "claude",
          providerSessionId: conversation.sessionId,
          createdAt,
          updatedAt,
          status: "idle",
          title,
          lastMessagePreview:
            conversation.lastMessagePreview || DEFAULT_PREVIEW,
          model: "claude-sonnet-4-6",
          effort: "auto",
          permissionMode: "bypassPermissions",
          allowedTools: undefined,
          activeRequestId: null,
          runnerPid: null,
          cliPid: null,
          sourceKind: "imported",
          kind: "chat",
          latestEventId: -1,
          retainedEventId: 0,
          messageCount: processed.metadata.messageCount,
          lastReadAt: updatedAt,
          archivedAt: null,
          nextEventId: 0,
          titleCustomized: Boolean(customTitles[conversation.sessionId]),
        };

        await this.ensureSessionDirectory(sessionId);
        await this.saveStoredMetadata(sessionId, metadata);
        await saveJsonLines(this.messagesPath(sessionId), processed.messages);
        await saveJsonLines(this.eventsPath(sessionId), []);
        index.sessions.push({
          sessionId,
          projectPath,
          encodedProjectName,
          archivedAt: null,
        });
        existingProviderIds.add(conversation.sessionId);
      }
    }

    index.importedLegacyAt = new Date().toISOString();
    await this.saveIndex(index);
  }

  private resolveLegacyProjectPath(
    conversation: ConversationFile,
  ): string | null {
    for (const message of conversation.messages) {
      if (typeof message.cwd === "string" && message.cwd.trim()) {
        return message.cwd;
      }
    }
    return null;
  }

  async writePendingRequest(
    sessionId: string,
    requestId: string,
    request: SessionMessageRequest,
  ): Promise<void> {
    await this.ensureInitialized();
    await this.ensureSessionDirectory(sessionId);
    await writeJson(this.requestPath(sessionId, requestId), request);
  }

  async readPendingRequest(
    sessionId: string,
    requestId: string,
  ): Promise<SessionMessageRequest | null> {
    await this.ensureInitialized();
    return await loadJson<SessionMessageRequest | null>(
      this.requestPath(sessionId, requestId),
      null,
    );
  }

  async deletePendingRequest(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    await this.ensureInitialized();
    await rm(this.requestPath(sessionId, requestId), { force: true });
  }
}

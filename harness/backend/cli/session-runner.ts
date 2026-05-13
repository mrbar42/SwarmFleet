#!/usr/bin/env node

import type {
  ConversationImageAsset,
  SessionInterruptionReason,
  SessionMessageRequest,
  SessionStatus,
} from "../../shared/types.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  detectAwaitingInput,
  executeClaudeCommand,
  executeCodexCommand,
  executeHermesCommand,
  extractClaudeStructuredError,
  extractProviderSessionId,
  isClaudeTerminalResult,
  removeCodexInstructionsFile,
  writeCodexInstructionsFile,
  sanitizeMessage,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_SUBAGENT_ALLOWED_TOOLS,
  writeSubagentMcpConfig,
  removeSubagentMcpConfig,
} from "../services/chatCli.ts";
import { ChatSessionStore } from "../services/chatSessionStore.ts";
import { executePiAgentCommand } from "../services/piAgent.ts";
import {
  parseOpenRouterClaudeModelId,
  providerProfileStore,
} from "../services/providerProfiles.ts";
import { isLoggerConfigured, logger, setupLogger } from "../utils/logger.ts";
import {
  isProviderInternalDiagnosticAssistant,
  removeProviderResumeDiagnosticResult,
} from "./providerTranscriptNoise.ts";

function parseArgs(argv: string[]): {
  sessionId: string;
  requestId: string;
  cliPath: string;
} {
  let sessionId = "";
  let requestId = "";
  let cliPath = "claude";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--session-id") {
      sessionId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--request-id") {
      requestId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (value === "--cli-path") {
      cliPath = argv[index + 1] ?? "claude";
      index += 1;
    }
  }

  if (!sessionId || !requestId) {
    throw new Error("session-runner requires --session-id and --request-id");
  }

  return { sessionId, requestId, cliPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function buildPreviewSystemPrompt(
  projectPath: string,
): Promise<string | null> {
  try {
    const raw = await readFile(
      join(projectPath, ".swarmfleet", "settings.json"),
      "utf-8",
    );
    const settings = JSON.parse(raw) as {
      features?: {
        preview?: {
          enabled?: unknown;
          devServer?: {
            enabled?: unknown;
            publishToHost?: unknown;
            port?: unknown;
          };
        };
      };
    };
    const preview = settings.features?.preview;
    const devServer = preview?.devServer;
    if (preview?.enabled !== true) return null;
    const devServerEnabled =
      devServer?.enabled === false ? false : preview.enabled === true;
    if (!devServerEnabled) return null;
    if (
      devServer?.publishToHost !== true ||
      typeof devServer.port !== "number"
    ) {
      return [
        "Preview service is already enabled for this project.",
        "SwarmFleet manages the project dev server for the Preview tab.",
        "Do not start another dev server unless the user explicitly asks you to restart or replace the preview service.",
        "The dev server is not published to a host port; use the Preview tab unless the user enables host publishing.",
      ].join("\n");
    }
    const port = devServer.port;
    return [
      "Preview service is already enabled for this project.",
      "SwarmFleet manages the project dev server for the Preview tab.",
      `Already-managed dev server port: ${port}.`,
      `Use http://localhost:${port}/ for browser checks when host publishing is enabled.`,
      "Do not start another dev server unless the user explicitly asks you to restart or replace the preview service.",
    ].join("\n");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function appendPrompt(base: string | undefined, addition: string | null) {
  if (!addition) return base;
  return base ? `${base}\n\n${addition}` : addition;
}

function normalizeImageMimeType(
  value: unknown,
): ConversationImageAsset["mimeType"] | null {
  if (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/gif" ||
    value === "image/webp"
  ) {
    return value;
  }
  return null;
}

function extractBase64Image(block: unknown): {
  base64: string;
  mimeType: ConversationImageAsset["mimeType"];
} | null {
  if (!isRecord(block) || block.type !== "image") return null;
  const source = isRecord(block.source) ? block.source : null;
  const base64 =
    typeof block.data === "string"
      ? block.data
      : source && typeof source.data === "string"
        ? source.data
        : "";
  const mimeType =
    normalizeImageMimeType(block.mimeType) ??
    normalizeImageMimeType(block.mime_type) ??
    normalizeImageMimeType(block.media_type) ??
    normalizeImageMimeType(source?.media_type) ??
    normalizeImageMimeType(source?.mime_type) ??
    normalizeImageMimeType(source?.mimeType);
  if (!base64 || !mimeType) return null;
  return { base64, mimeType };
}

async function persistToolResultImages(
  store: ChatSessionStore,
  sessionId: string,
  chunkData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (chunkData.type !== "user") return chunkData;
  const message = isRecord(chunkData.message) ? chunkData.message : null;
  if (!message || !Array.isArray(message.content)) return chunkData;

  let changed = false;
  const nextContent = await Promise.all(
    message.content.map(async (item) => {
      if (!isRecord(item) || item.type !== "tool_result") return item;
      const rawContent = item.content;
      if (!Array.isArray(rawContent)) return item;

      const assets: ConversationImageAsset[] = [];
      const nextBlocks: unknown[] = [];
      for (const block of rawContent) {
        const image = extractBase64Image(block);
        if (!image) {
          nextBlocks.push(block);
          continue;
        }
        const asset = await store.saveImageAsset(sessionId, {
          bytes: Buffer.from(image.base64, "base64"),
          mimeType: image.mimeType,
          sourceToolName: "screenshot",
        });
        assets.push(asset);
        changed = true;
      }

      if (assets.length === 0) return item;
      const textBlocks =
        nextBlocks.length > 0
          ? nextBlocks
          : [
              {
                type: "text",
                text: `${assets.length} screenshot${assets.length === 1 ? "" : "s"} captured`,
              },
            ];
      return {
        ...item,
        content: textBlocks,
        swarmfleetAssets: [
          ...((Array.isArray(item.swarmfleetAssets)
            ? item.swarmfleetAssets
            : []) as unknown[]),
          ...assets,
        ],
      };
    }),
  );

  if (!changed) return chunkData;
  return {
    ...chunkData,
    message: {
      ...message,
      content: nextContent,
    },
  };
}

function ensureTimestamp(data: unknown): unknown {
  if (!isRecord(data)) {
    return data;
  }

  if (
    typeof data.timestamp === "string" ||
    typeof data.timestamp === "number"
  ) {
    return data;
  }

  return {
    ...data,
    timestamp: new Date().toISOString(),
  };
}

function isUserPromptEcho(data: unknown, prompt: string): boolean {
  if (!isRecord(data) || data.type !== "user") {
    return false;
  }

  const message = isRecord(data.message) ? data.message : null;
  if (!message) return false;
  const content = message.content;

  if (typeof content === "string") {
    return content.trim() === prompt.trim();
  }

  if (!Array.isArray(content)) {
    return false;
  }

  const textItem = content.find(
    (item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  return isRecord(textItem) && typeof textItem.text === "string"
    ? textItem.text.trim() === prompt.trim()
    : false;
}

function stripInternalStreamFlags(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const {
    swarmfleetTransient: _transient,
    swarmfleetHistoryOnly: _historyOnly,
    ...rest
  } = data;
  return rest;
}

function extractAssistantText(data: unknown): string | null {
  if (!isRecord(data) || data.type !== "assistant") return null;
  const message = isRecord(data.message) ? data.message : null;
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .map((item) =>
      isRecord(item) && item.type === "text" && typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("");
  const trimmed = text.trim();
  return trimmed ? text : null;
}

function backfillEmptyResultText(
  data: Record<string, unknown>,
  fallbackText: string | null,
): Record<string, unknown> {
  if (data.type !== "result" || !fallbackText?.trim()) return data;
  if (typeof data.result === "string" && data.result.trim()) return data;
  return {
    ...data,
    result: fallbackText,
  };
}

function buildErrorResultMessage(args: {
  error: string;
  sessionId: string | null | undefined;
}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    session_id: args.sessionId,
    result: args.error,
    duration_ms: 0,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
    timestamp: new Date().toISOString(),
  };
}

async function resolveOpenRouterClaudeRuntime(
  model: string,
  projectPath: string,
): Promise<{
  rawModel: string;
  env: Record<string, string>;
}> {
  const parsed = parseOpenRouterClaudeModelId(model);
  if (!parsed) {
    throw new Error(`Invalid OpenRouterClaude model id: ${model}`);
  }
  const profile = await providerProfileStore.getOpenRouterClaudeProfile(
    parsed.profileId,
  );
  if (!profile?.apiKey) {
    throw new Error(
      "OpenRouterClaude profile is missing an OpenRouter API key",
    );
  }
  const settings = await providerProfileStore.getSettings();
  const proxyEnabled = settings.openRouterClaudeProxyEnabled;
  const backendUrl = (process.env.SWARMFLEET_BACKEND_URL ?? "").replace(
    /\/+$/,
    "",
  );
  const internalToken = process.env.SWARMFLEET_INTERNAL_TOKEN ?? "";
  const proxyHeaders = [
    `x-swarmfleet-internal-token: ${internalToken}`,
    `x-swarmfleet-openrouter-profile-id: ${profile.id}`,
  ].join("\n");
  const proxyEnv = proxyEnabled
    ? (() => {
        if (!backendUrl || !internalToken) {
          throw new Error(
            "OpenRouterClaude proxy is enabled but backend URL or internal token is missing",
          );
        }
        return {
          ANTHROPIC_BASE_URL: `${backendUrl}/internal/openrouter-claude-proxy`,
          ANTHROPIC_AUTH_TOKEN: "swarmfleet-openrouter-proxy",
          ANTHROPIC_CUSTOM_HEADERS: proxyHeaders,
        };
      })()
    : null;
  const configuredBaseUrl = (
    profile.baseUrl || "https://openrouter.ai/api"
  ).replace(/\/+$/, "");
  const baseUrl = configuredBaseUrl.endsWith("/api/v1")
    ? configuredBaseUrl.slice(0, -3)
    : configuredBaseUrl;
  return {
    rawModel: parsed.rawModelId,
    env: {
      ...(proxyEnv
        ? {}
        : {
            OPENROUTER_API_KEY: profile.apiKey,
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: profile.apiKey,
          }),
      ...(proxyEnv ?? {}),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: parsed.rawModelId,
      ANTHROPIC_DEFAULT_SONNET_MODEL: parsed.rawModelId,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: parsed.rawModelId,
      CLAUDE_CODE_SUBAGENT_MODEL: parsed.rawModelId,
      CLAUDE_CONFIG_DIR: join(
        projectPath,
        ".swarmfleet",
        "claude-openrouter",
        profile.id,
      ),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
}

async function publishStatusToBackend(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  const backendUrl = process.env.SWARMFLEET_BACKEND_URL ?? "";
  const internalToken = process.env.SWARMFLEET_INTERNAL_TOKEN ?? "";
  if (!backendUrl || !internalToken) {
    throw new Error("backend URL or internal token is missing");
  }

  const response = await fetch(
    `${backendUrl}/internal/sessions/${encodeURIComponent(sessionId)}/status-published`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-swarmfleet-internal-token": internalToken,
      },
      body: JSON.stringify({ status }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Status publish failed for ${sessionId}: ${response.status}${body ? ` ${body}` : ""}`,
    );
  }
}

async function notifyStatusTransition(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  try {
    await publishStatusToBackend(sessionId, status);
  } catch (error) {
    logger.chat.warn(
      "Failed to publish status transition for {sessionId}: {error}",
      { sessionId, error },
    );
  }
}

async function main(): Promise<void> {
  if (!isLoggerConfigured()) {
    await setupLogger(false);
  }

  const { sessionId, requestId, cliPath } = parseArgs(process.argv.slice(2));
  const store = new ChatSessionStore(process.env.SWARMFLEET_CHAT_SESSION_ROOT, {
    skipActiveSessionReconcile: true,
  });
  await store.ensureInitialized();

  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const request = await store.readPendingRequest(sessionId, requestId);
  if (!request) {
    throw new Error(`Pending request ${requestId} not found for ${sessionId}`);
  }

  let cliChildKilled = false;
  let finalized = false;
  let finalStatus: SessionStatus = "idle";
  let receivedSignal: NodeJS.Signals | null = null;
  let finalInterruptionReason: SessionInterruptionReason | undefined;
  let finalInterruptionDetail: string | undefined;
  let turnSettled = false;
  // Hoisted so the outer catch can clean up the per-run MCP config even when
  // the try block throws before reaching its own cleanup at the happy-path
  // exit.
  let mcpConfigPath: string | undefined;
  let codexInstructionsFilePath: string | undefined;

  const stopCurrentChild = (signal?: NodeJS.Signals) => {
    cliChildKilled = true;
    if (signal) {
      receivedSignal ??= signal;
    }
  };

  const terminateAndExit = async (status: SessionStatus) => {
    if (finalized) {
      return;
    }
    finalized = true;
    finalStatus = status;
    try {
      const current = turnSettled ? await store.getSession(sessionId) : null;
      const anotherTurnStarted =
        turnSettled &&
        !!current?.activeRequestId &&
        current.activeRequestId !== requestId;
      if (!anotherTurnStarted) {
        const shouldClearRunnerPid =
          !turnSettled || current?.runnerPid === process.pid;
        const updated = await store.updateStatus(sessionId, status, {
          clearActiveRequest:
            !turnSettled || current?.activeRequestId === requestId,
          clearRunnerPid: shouldClearRunnerPid,
          interruptionReason:
            status === "interrupted" ? finalInterruptionReason : undefined,
          interruptionDetail:
            status === "interrupted" ? finalInterruptionDetail : undefined,
        });
        if (!turnSettled || updated.status !== current?.status) {
          await notifyStatusTransition(sessionId, status);
        }
      }
      await store.deletePendingRequest(sessionId, requestId);
    } catch {
      // Store cleanup failed; exit 1 so the parent reconciles via its exit
      // handler rather than leaving the session stuck in "running" state.
      process.exit(1);
    }
    process.exit(status === "error" ? 1 : 0);
  };

  process.on("SIGTERM", () => {
    stopCurrentChild("SIGTERM");
  });
  process.on("SIGINT", () => {
    stopCurrentChild("SIGINT");
  });

  try {
    const normalizedMessage = sanitizeMessage(request.message);
    const hasAttachments = (request.attachments?.length ?? 0) > 0;
    if (!normalizedMessage && !hasAttachments) {
      throw new Error("Message cannot be empty");
    }
    if (session.provider === "hermes" && hasAttachments) {
      throw new Error("Hermes sessions do not support image attachments yet");
    }

    let appendSystemPrompt: string | undefined;
    let allowedTools = request.allowedTools ?? session.allowedTools;

    if (
      session.provider === "claude" ||
      session.provider === "openrouter-claude"
    ) {
      if (!allowedTools || allowedTools.length === 0) {
        // Regular chat + subagent sessions fall through to a default allowlist
        // that includes our MCP subagent tools but excludes the native Task /
        // Agent tool. Subagents can't spawn further subagents (v1 — no
        // recursion). Without this branch the CLI would run with no
        // --allowedTools and expose every native tool, including Task.
        allowedTools =
          session.kind === "subagent"
            ? [...DEFAULT_SUBAGENT_ALLOWED_TOOLS]
            : [...DEFAULT_ALLOWED_TOOLS];
      }
    }
    if (
      session.provider === "claude" ||
      session.provider === "codex" ||
      session.provider === "hermes" ||
      session.provider === "pi" ||
      session.provider === "openrouter-claude"
    ) {
      appendSystemPrompt = appendPrompt(
        appendSystemPrompt,
        await buildPreviewSystemPrompt(session.projectPath),
      );
    }
    if (session.provider === "codex" && appendSystemPrompt) {
      codexInstructionsFilePath =
        await writeCodexInstructionsFile(appendSystemPrompt);
    }

    let liveProcessKilled = false;
    let awaitingInput = false;
    let codexSwarmFleetMcpConfig:
      | {
          parentSessionId: string;
          backendUrl: string;
          internalToken: string;
        }
      | undefined;

    // Write a per-run MCP config that mounts the SwarmFleet subagent server.
    const canUseSubagents =
      (session.provider === "claude" ||
        session.provider === "codex" ||
        session.provider === "hermes" ||
        session.provider === "openrouter-claude") &&
      (session.kind === "chat" || session.kind === "subagent");
    if (canUseSubagents) {
      const internalToken = process.env.SWARMFLEET_INTERNAL_TOKEN ?? "";
      const backendUrl = process.env.SWARMFLEET_BACKEND_URL ?? "";
      if (internalToken && backendUrl) {
        if (session.provider === "codex" || session.provider === "hermes") {
          codexSwarmFleetMcpConfig = {
            parentSessionId: session.sessionId,
            backendUrl,
            internalToken,
          };
        } else {
          try {
            mcpConfigPath = await writeSubagentMcpConfig({
              parentSessionId: session.sessionId,
              requestId,
              backendUrl,
              internalToken,
            });
          } catch (error) {
            logger.chat.warn(
              "Failed to write MCP subagent config; subagent tools disabled for this run: {error}",
              { error },
            );
          }
        }
      } else {
        logger.chat.debug(
          "SWARMFLEET_INTERNAL_TOKEN or SWARMFLEET_BACKEND_URL missing in runner env; skipping MCP subagent mount",
        );
      }
    }

    const transcript = (await store.getConversation(sessionId))?.messages ?? [];
    let currentProviderSessionId = session.providerSessionId;
    let lastAssistantText: string | null = null;
    let abortPiAgent: (() => void) | null = null;
    const requestedModel = request.model ?? session.model;
    const openRouterClaudeRuntime =
      session.provider === "openrouter-claude"
        ? await resolveOpenRouterClaudeRuntime(
            requestedModel,
            session.projectPath,
          )
        : null;
    process.on("SIGTERM", () => {
      abortPiAgent?.();
    });

    const generator =
      session.provider === "pi"
        ? executePiAgentCommand({
            message: normalizedMessage,
            requestId,
            sessionId: session.sessionId,
            providerSessionId: session.providerSessionId,
            model: requestedModel,
            workingDirectory: session.projectPath,
            permissionMode: request.permissionMode ?? session.permissionMode,
            effort: request.effort ?? session.effort,
            transcript,
            attachments: request.attachments,
            appendSystemPrompt,
            sessionKind: session.kind,
            wasAborted: () => cliChildKilled,
            onAbort: (abort) => {
              abortPiAgent = abort;
            },
          })
        : session.provider === "codex"
          ? executeCodexCommand(
              normalizedMessage,
              requestId,
              session.projectPath,
              requestedModel,
              session.providerSessionId ?? undefined,
              request.permissionMode ?? session.permissionMode,
              codexInstructionsFilePath,
              codexSwarmFleetMcpConfig,
              () => cliChildKilled,
              (processHandle) => {
                if (processHandle.pid != null) {
                  void store.updateCliPid(sessionId, processHandle.pid);
                }
                process.on("SIGTERM", () => {
                  if (processHandle.exitCode === null) {
                    try {
                      processHandle.kill("SIGTERM");
                    } catch {
                      // Best effort.
                    }
                  }
                });
              },
            )
          : session.provider === "hermes"
            ? executeHermesCommand(
                normalizedMessage,
                requestId,
                session.projectPath,
                requestedModel,
                session.providerSessionId ?? undefined,
                request.permissionMode ?? session.permissionMode,
                codexSwarmFleetMcpConfig,
                appendSystemPrompt,
                () => cliChildKilled,
                (processHandle) => {
                  if (processHandle.pid != null) {
                    void store.updateCliPid(sessionId, processHandle.pid);
                  }
                  process.on("SIGTERM", () => {
                    if (processHandle.exitCode === null) {
                      try {
                        processHandle.kill("SIGTERM");
                      } catch {
                        // Best effort.
                      }
                    }
                  });
                },
              )
            : executeClaudeCommand(
                normalizedMessage,
                cliPath,
                session.providerSessionId ?? undefined,
                allowedTools,
                session.projectPath,
                request.permissionMode ?? session.permissionMode,
                request.attachments,
                openRouterClaudeRuntime?.rawModel ?? requestedModel,
                appendSystemPrompt,
                request.effort ?? session.effort,
                () => cliChildKilled,
                (processHandle) => {
                  if (processHandle.pid != null) {
                    void store.updateCliPid(sessionId, processHandle.pid);
                  }
                  process.on("SIGTERM", () => {
                    if (processHandle.exitCode === null) {
                      try {
                        processHandle.kill("SIGTERM");
                        liveProcessKilled = true;
                      } catch {
                        // Best effort.
                      }
                    }
                  });
                },
                mcpConfigPath,
                openRouterClaudeRuntime?.env,
              );

    const settleTurn = async (status: SessionStatus) => {
      if (turnSettled) return;
      turnSettled = true;
      finalStatus = status;
      await store.updateStatus(sessionId, status, {
        clearActiveRequest: true,
        clearRunnerPid: false,
      });
      await notifyStatusTransition(sessionId, status);
      await store.deletePendingRequest(sessionId, requestId);
    };

    for await (const chunk of generator) {
      const providerSessionId = extractProviderSessionId(chunk);
      if (providerSessionId && providerSessionId !== currentProviderSessionId) {
        currentProviderSessionId = providerSessionId;
        await store.updateProviderSessionId(sessionId, providerSessionId);
      }

      const assistantText = extractAssistantText(chunk.data);
      const internalProviderNoise = isProviderInternalDiagnosticAssistant(
        chunk.data,
      );
      if (assistantText && !internalProviderNoise) {
        lastAssistantText = assistantText;
      }
      const rawChunkData = isRecord(chunk.data)
        ? removeProviderResumeDiagnosticResult(
            backfillEmptyResultText(chunk.data, lastAssistantText),
          )
        : null;
      const chunkData = rawChunkData
        ? {
            ...(await persistToolResultImages(store, sessionId, rawChunkData)),
            ...(internalProviderNoise
              ? {
                  swarmfleetTransient: true,
                  swarmfleetHistoryOnly: true,
                }
              : {}),
          }
        : null;
      const chunkForStorage = chunkData ? { ...chunk, data: chunkData } : chunk;
      const transient = chunkData?.swarmfleetTransient === true;
      const historyOnly = chunkData?.swarmfleetHistoryOnly === true;

      if (
        chunkForStorage.type === "claude_json" &&
        !transient &&
        !isUserPromptEcho(chunkForStorage.data, normalizedMessage)
      ) {
        await store.appendMessage(
          sessionId,
          ensureTimestamp(stripInternalStreamFlags(chunkForStorage.data)),
        );
      }

      if (!historyOnly) {
        await store.appendEvent(sessionId, "stream", chunkForStorage);
      }

      if (
        chunkForStorage.type === "claude_json" &&
        isClaudeTerminalResult(chunkForStorage.data)
      ) {
        const resultError = extractClaudeStructuredError(chunkForStorage.data);
        await settleTurn(
          resultError ? "error" : awaitingInput ? "awaiting_input" : "idle",
        );
      }

      const awaitingSignal = detectAwaitingInput(chunkForStorage);
      if (awaitingSignal && !awaitingInput) {
        awaitingInput = true;
        await store.updateStatus(sessionId, "awaiting_input");
        await notifyStatusTransition(sessionId, "awaiting_input");
      }

      if (chunk.type === "done") {
        finalStatus = awaitingInput ? "awaiting_input" : "idle";
        break;
      }

      if (chunk.type === "aborted") {
        finalStatus = "interrupted";
        if (receivedSignal) {
          finalInterruptionReason = "runner_signal";
          finalInterruptionDetail = `Session runner received ${receivedSignal}`;
        }
        break;
      }

      if (chunk.type === "error") {
        await store.appendMessage(
          sessionId,
          buildErrorResultMessage({
            error: chunk.error ?? "Provider command failed",
            sessionId: currentProviderSessionId,
          }),
        );
        finalStatus = awaitingInput ? "awaiting_input" : "error";
        break;
      }
    }

    if (cliChildKilled && liveProcessKilled) {
      finalStatus = awaitingInput ? "awaiting_input" : "idle";
    }

    if (mcpConfigPath) {
      await removeSubagentMcpConfig(mcpConfigPath);
    }
    if (codexInstructionsFilePath) {
      await removeCodexInstructionsFile(codexInstructionsFilePath);
    }

    await terminateAndExit(finalStatus);
  } catch (error) {
    logger.chat.error("Detached session runner failed: {error}", { error });
    await store.appendEvent(sessionId, "stream", {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    if (mcpConfigPath) {
      await removeSubagentMcpConfig(mcpConfigPath);
    }
    if (codexInstructionsFilePath) {
      await removeCodexInstructionsFile(codexInstructionsFilePath);
    }
    await terminateAndExit("error");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

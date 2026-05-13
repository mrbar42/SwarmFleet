import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PermissionMode,
  PiProviderProfileRequest,
  SessionKind,
  StreamResponse,
} from "../../shared/types.ts";

const piMock = vi.hoisted(() => ({
  mode: "text" as "text" | "tool" | "tool-no-final" | "tool-no-final-recovery" | "plan",
  promptCalls: [] as unknown[],
  followUpCalls: [] as unknown[],
  continueCalls: 0,
  agentModels: [] as unknown[],
  agentMessages: [] as unknown[][],
}));

vi.mock("@mariozechner/pi-ai", () => ({
  Type: {
    Any: () => ({ type: "any" }),
    Array: (items: unknown) => ({ type: "array", items }),
    Boolean: (options?: unknown) => ({ type: "boolean", options }),
    Number: (options?: unknown) => ({ type: "number", options }),
    Object: (properties: unknown) => ({ type: "object", properties }),
    Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
    String: (options?: unknown) => ({ type: "string", options }),
  },
  getProviders: () => ["openrouter"],
  getModels: (provider: string) => [
    {
      id: "openai/gpt-4o",
      name: "GPT-4o",
      provider,
      api: "chat",
      input: ["text"],
      contextWindow: 128_000,
      reasoning: false,
    },
  ],
  getModel: (provider: string, id: string) => ({
    id,
    name: id,
    provider,
    api: "chat",
    input: ["text"],
    contextWindow: 128_000,
    reasoning: false,
  }),
}));

vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: class MockAgent {
    state: {
      tools: Array<{ name: string }>;
      messages: unknown[];
    };
    private subscribers: Array<(event: unknown) => void> = [];

    constructor(options: {
      initialState: {
        model?: unknown;
        tools?: Array<{ name: string }>;
        messages?: unknown[];
      };
    }) {
      piMock.agentModels.push(options.initialState.model);
      piMock.agentMessages.push(options.initialState.messages ?? []);
      this.state = {
        tools: options.initialState.tools ?? [],
        messages: options.initialState.messages ?? [],
      };
    }

    subscribe(callback: (event: unknown) => void) {
      this.subscribers.push(callback);
      return () => {
        this.subscribers = this.subscribers.filter((candidate) => candidate !== callback);
      };
    }

    abort() {}

    followUp(message: unknown) {
      piMock.followUpCalls.push(message);
      if (piMock.mode === "tool-no-final-recovery") {
        this.emit({
          type: "message_start",
          message: { role: "assistant" },
        });
        this.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Recovered final" }],
          },
        });
        this.emit({ type: "agent_end" });
      }
    }

    async prompt(message: unknown) {
      piMock.promptCalls.push(message);
      this.emitScenario();
    }

    async continue() {
      piMock.continueCalls += 1;
      this.emitScenario();
    }

    private emit(event: unknown) {
      for (const subscriber of this.subscribers) subscriber(event);
    }

    private emitScenario() {
      if (piMock.mode === "tool") {
        this.emit({
          type: "message_start",
          message: { role: "assistant" },
        });
        this.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "Read",
                arguments: { file_path: "src/app.ts" },
              },
            ],
          },
        });
        this.emit({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          isError: false,
          result: {
            content: [{ type: "text", text: "file contents" }],
            details: { path: "src/app.ts" },
          },
        });
        this.emit({
          type: "message_start",
          message: { role: "assistant" },
        });
        this.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          },
        });
        this.emit({ type: "agent_end" });
        return;
      }

      if (piMock.mode === "tool-no-final") {
        this.emitToolNoFinalScenario();
        return;
      }

      if (piMock.mode === "tool-no-final-recovery") {
        this.emitToolNoFinalScenario();
        return;
      }

      this.emit({
        type: "message_start",
        message: { role: "assistant" },
      });
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: piMock.mode === "plan" ? "Plan" : "Hel",
        },
      });
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: piMock.mode === "plan" ? " text" : "lo",
        },
      });
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: piMock.mode === "plan" ? "Plan text" : "Hello",
            },
          ],
        },
      });
      this.emit({ type: "agent_end" });
    }

    private emitToolNoFinalScenario() {
      this.emit({
        type: "message_start",
        message: { role: "assistant" },
      });
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "Read",
              arguments: { file_path: "src/app.ts" },
            },
          ],
        },
      });
      this.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        isError: false,
        result: {
          content: [{ type: "text", text: "file contents" }],
          details: { path: "src/app.ts" },
        },
      });
      this.emit({
        type: "message_start",
        message: { role: "assistant" },
      });
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
        },
      });
      this.emit({ type: "agent_end" });
    }
  },
}));

const tempHomes: string[] = [];
const originalHome = process.env.HOME;
const originalBackendUrl = process.env.SWARMFLEET_BACKEND_URL;
const originalInternalToken = process.env.SWARMFLEET_INTERNAL_TOKEN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(async () => {
  vi.resetModules();
  piMock.mode = "text";
  piMock.promptCalls = [];
  piMock.followUpCalls = [];
  piMock.continueCalls = 0;
  piMock.agentModels = [];
  piMock.agentMessages = [];
  const home = await mkdtemp(join(tmpdir(), "swarmfleet-pi-agent-home-"));
  tempHomes.push(home);
  process.env.HOME = home;
  delete process.env.SWARMFLEET_BACKEND_URL;
  delete process.env.SWARMFLEET_INTERNAL_TOKEN;
});

afterEach(async () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("SWARMFLEET_BACKEND_URL", originalBackendUrl);
  restoreEnv("SWARMFLEET_INTERNAL_TOKEN", originalInternalToken);
  await Promise.all(
    tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createProfileAndRunner(
  input: Partial<PiProviderProfileRequest> = {},
) {
  const [{ providerProfileStore }, { executePiAgentCommand }] = await Promise.all([
    import("../services/providerProfiles.ts"),
    import("../services/piAgent.ts"),
  ]);
  const profile = await providerProfileStore.createPiProfile({
    name: "OpenRouter",
    provider: "openrouter",
    apiKey: "sk-test",
    ...input,
  });
  return { executePiAgentCommand, profile };
}

async function collectPiChunks(args?: {
  permissionMode?: PermissionMode;
  sessionKind?: SessionKind;
  transcript?: unknown[];
  profile?: Partial<PiProviderProfileRequest>;
}): Promise<StreamResponse[]> {
  const { executePiAgentCommand, profile } = await createProfileAndRunner(args?.profile);
  const chunks: StreamResponse[] = [];
  for await (const chunk of executePiAgentCommand({
    message: "Do the thing",
    requestId: "req-1",
    sessionId: "session-1",
    model: `pi:${profile.id}:vendor/model:beta`,
    workingDirectory: process.cwd(),
    permissionMode: args?.permissionMode,
    transcript: args?.transcript ?? [],
    sessionKind: args?.sessionKind ?? "chat",
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function claudeData(chunk: StreamResponse): Record<string, unknown> | null {
  return chunk.type === "claude_json" && typeof chunk.data === "object" && chunk.data !== null
    ? chunk.data as Record<string, unknown>
    : null;
}

describe("executePiAgentCommand", () => {
  it("streams text deltas and emits one history-only final assistant message", async () => {
    const chunks = await collectPiChunks();

    const transientText = chunks
      .map(claudeData)
      .filter((data) => data?.swarmfleetTransient === true);
    expect(transientText).toHaveLength(2);
    expect(
      transientText
        .map((data) => data?.message)
        .map((message) => (message as { content: Array<{ text: string }> }).content[0].text)
        .join(""),
    ).toBe("Hello");

    const historyOnly = chunks
      .map(claudeData)
      .find((data) => data?.swarmfleetHistoryOnly === true);
    expect(
      (historyOnly?.message as { content: Array<{ text: string }> }).content[0].text,
    ).toBe("Hello");
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("emits Claude-compatible tool-use and tool-result chunks", async () => {
    piMock.mode = "tool";
    const chunks = await collectPiChunks();

    const toolUse = chunks
      .map(claudeData)
      .find((data) => {
        const message = data?.message as { content?: Array<{ type: string }> } | undefined;
        return message?.content?.[0]?.type === "tool_use";
      });
    expect(
      (toolUse?.message as { content: Array<{ name: string; input: unknown }> }).content[0],
    ).toMatchObject({
      name: "Read",
      input: { file_path: "src/app.ts" },
    });

    const toolResult = chunks
      .map(claudeData)
      .find((data) => {
        const message = data?.message as { content?: Array<{ type: string }> } | undefined;
        return message?.content?.[0]?.type === "tool_result";
      });
    expect(
      (toolResult?.message as { content: Array<{ content: string }> }).content[0].content,
    ).toBe("file contents");
    expect(toolResult?.toolUseResult).toEqual({ path: "src/app.ts" });
  });

  it("shows a neutral notice when Pi ends after tool use without a final assistant message", async () => {
    piMock.mode = "tool-no-final";
    const chunks = await collectPiChunks();

    expect(piMock.followUpCalls).toHaveLength(1);
    const notice = chunks.map(claudeData).find((data) => data?.subtype === "model_no_final_message");
    expect(notice).toMatchObject({
      type: "system",
      subtype: "model_no_final_message",
      message: "model didn't provide final message",
    });
    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("recovers once when Pi returns an empty assistant message after tool results", async () => {
    piMock.mode = "tool-no-final-recovery";
    const chunks = await collectPiChunks();

    expect(piMock.followUpCalls).toHaveLength(1);
    expect(chunks.map(claudeData).some((data) => data?.subtype === "model_no_final_message")).toBe(false);

    const final = chunks
      .map(claudeData)
      .find((data) => {
        const message = data?.message as { content?: Array<{ text?: string }> } | undefined;
        return message?.content?.[0]?.text === "Recovered final";
      });
    expect(
      (final?.message as { content: Array<{ text: string }> }).content[0].text,
    ).toBe("Recovered final");
    expect(chunks.at(-1)?.type).toBe("done");
  });

  it("coalesces stored Pi tool-use chunks before replay", async () => {
    await collectPiChunks({
      transcript: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "b.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "a" }],
          },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-2", content: "b" }],
          },
        },
        {
          type: "user",
          message: { role: "user", content: "continue" },
        },
      ],
    });

    const replayedMessages = piMock.agentMessages[0] as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
    }>;
    const assistantToolMessages = replayedMessages.filter(
      (message) =>
        message.role === "assistant" &&
        message.content?.every((item) => item.type === "toolCall"),
    );
    expect(assistantToolMessages).toHaveLength(1);
    expect(assistantToolMessages[0].content?.map((item) => item.id)).toEqual(["tool-1", "tool-2"]);
  });

  it("turns plan mode output into an ExitPlanMode tool-use chunk", async () => {
    piMock.mode = "plan";
    const chunks = await collectPiChunks({ permissionMode: "plan" });

    const init = chunks.map(claudeData).find((data) => data?.type === "system");
    expect(init?.tools).toEqual(["Read", "Glob", "Grep"]);

    const exitPlan = chunks
      .map(claudeData)
      .find((data) => {
        const message = data?.message as { content?: Array<{ name: string }> } | undefined;
        return message?.content?.[0]?.name === "ExitPlanMode";
      });
    expect(
      (exitPlan?.message as { content: Array<{ input: { plan: string } }> }).content[0].input.plan,
    ).toBe("Plan text");
  });

  it("exposes SwarmFleet subagent tools only for parent sessions", async () => {
    process.env.SWARMFLEET_BACKEND_URL = "http://127.0.0.1:4567";
    process.env.SWARMFLEET_INTERNAL_TOKEN = "internal-token";

    const parentChunks = await collectPiChunks({ sessionKind: "chat" });
    const childChunks = await collectPiChunks({ sessionKind: "subagent" });

    const parentInit = parentChunks.map(claudeData).find((data) => data?.type === "system");
    const childInit = childChunks.map(claudeData).find((data) => data?.type === "system");
    expect(parentInit?.tools).toContain("mcp__swarmfleet__spawn_subagent");
    expect(parentInit?.tools).toContain("mcp__swarmfleet__monitor_subagent");
    expect(childInit?.tools).not.toContain("mcp__swarmfleet__spawn_subagent");
    expect(childInit?.tools).not.toContain("mcp__swarmfleet__monitor_subagent");
  });

  it("sets OpenRouter data collection denial on Pi models by default", async () => {
    await collectPiChunks();

    expect(piMock.agentModels[0]).toMatchObject({
      compat: {
        openRouterRouting: {
          data_collection: "deny",
        },
      },
    });
  });

  it("respects the Pi profile OpenRouter data collection toggle", async () => {
    await collectPiChunks({
      profile: { denyOpenRouterDataCollection: false },
    });

    expect(piMock.agentModels[0]).not.toMatchObject({
      compat: {
        openRouterRouting: {
          data_collection: "deny",
        },
      },
    });
  });
});

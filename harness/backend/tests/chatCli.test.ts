import { readFile, rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildCodexPlanPrompt,
  detectAwaitingInput,
  extractClaudeStructuredError,
  isClaudeTerminalResult,
  resolveSubagentMcpEntry,
  resolveCodexTurnUsage,
  writeSubagentMcpConfig,
} from "../services/chatCli.ts";

describe("buildClaudeArgs", () => {
  it("disables native multi-agent tools while keeping SwarmFleet MCP tools available", () => {
    const args = buildClaudeArgs({
      message: "do the work",
      model: "claude-opus-4-7",
      permissionMode: "bypassPermissions",
      allowedTools: [
        "Bash",
        "Read",
        "mcp__swarmfleet__spawn_subagent",
        "mcp__swarmfleet__monitor_subagent",
      ],
      mcpConfigPath: "/tmp/swarmfleet-mcp.json",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--disallowedTools",
        "Task,Agent,ScheduleWakeup",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--allowedTools",
        "Bash,Read,mcp__swarmfleet__spawn_subagent,mcp__swarmfleet__monitor_subagent",
      ]),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--mcp-config", "/tmp/swarmfleet-mcp.json"]),
    );
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config"]));
    expect(args[args.length - 1]).toBe("do the work");
  });

  it("writes a strict-owned MCP config with SwarmFleet and Chrome DevTools only", async () => {
    const path = await writeSubagentMcpConfig({
      parentSessionId: "parent-session",
      requestId: "request-id",
      backendUrl: "http://127.0.0.1:3000",
      internalToken: "token",
    });

    try {
      const config = JSON.parse(await readFile(path, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };

      expect(Object.keys(config.mcpServers).sort()).toEqual([
        "chrome-devtools",
        "swarmfleet",
      ]);
      expect(config.mcpServers).not.toHaveProperty("claude.ai Figma");
      expect(config.mcpServers).not.toHaveProperty("claude.ai Google Drive");
      expect(config.mcpServers["chrome-devtools"]).toMatchObject({
        command: "npx",
        args: expect.arrayContaining([
          "chrome-devtools-mcp@latest",
          "--headless",
          "--executablePath=/usr/bin/chromium",
        ]),
      });
    } finally {
      await rm(path, { force: true });
    }
  });
});

describe("extractClaudeStructuredError", () => {
  it("extracts provider result errors from Claude stream JSON", () => {
    expect(
      extractClaudeStructuredError({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 404,
        result:
          "There's an issue with the selected model. Run --model to pick a different model.",
      }),
    ).toBe(
      "There's an issue with the selected model. Run --model to pick a different model.",
    );
  });

  it("extracts synthetic assistant provider errors", () => {
    expect(
      extractClaudeStructuredError({
        type: "assistant",
        error: "invalid_request",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Model is unavailable" }],
        },
      }),
    ).toBe("Model is unavailable");
  });

  it("ignores ordinary assistant text", () => {
    expect(
      extractClaudeStructuredError({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Normal response" }],
        },
      }),
    ).toBeNull();
  });
});

describe("isClaudeTerminalResult", () => {
  it("detects Claude result events as terminal", () => {
    expect(
      isClaudeTerminalResult({
        type: "result",
        subtype: "success",
        is_error: false,
      }),
    ).toBe(true);
  });

  it("ignores non-result events", () => {
    expect(
      isClaudeTerminalResult({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Still working" }],
        },
      }),
    ).toBe(false);
  });
});

describe("buildCodexArgs", () => {
  it("uses tsx for the source-mode SwarmFleet MCP server", () => {
    const entry = resolveSubagentMcpEntry();

    expect(entry.command).toBe("tsx");
    expect(entry.args.at(-1)).toContain("/mcp/bin.ts");
  });

  it("launches Codex in yolo mode and persists the session", () => {
    const args = buildCodexArgs(
      "do the work",
      "/workspace/example",
      "codex:gpt-5.4",
    );

    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toEqual(expect.arrayContaining(["--disable", "multi_agent"]));
    expect(args).not.toContain("--full-auto");
    // `--ephemeral` would disable on-disk session persistence, which breaks
    // `codex exec resume` on follow-up turns. We must not pass it.
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("resume");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "-C",
        "/workspace/example",
        "do the work",
      ]),
    );
    // Message must be the final positional argument.
    expect(args[args.length - 1]).toBe("do the work");
  });

  it("resumes an existing Codex session when a session id is provided", () => {
    const args = buildCodexArgs(
      "keep going",
      "/workspace/example",
      "codex:gpt-5.4",
      "018f9c3e-1234-7abc-9def-012345678900",
    );

    // `codex exec resume <SESSION_ID> <PROMPT>` is the documented form.
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    // Positionals must appear after the flags, session id before prompt.
    const sessionIndex = args.indexOf("018f9c3e-1234-7abc-9def-012345678900");
    const separatorIndex = args.indexOf("--");
    const promptIndex = args.indexOf("keep going");
    expect(sessionIndex).toBeGreaterThan(1);
    expect(separatorIndex).toBe(sessionIndex + 1);
    expect(promptIndex).toBe(separatorIndex + 1);
    expect(promptIndex).toBe(args.length - 1);

    // `-C` is not supported by `codex exec resume`; cwd is set via spawn().
    expect(args).not.toContain("-C");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toEqual(expect.arrayContaining(["--disable", "multi_agent"]));
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
  });

  it("separates resumed prompts that start with hyphens from CLI flags", () => {
    const args = buildCodexArgs(
      "- bullet one\n- bullet two",
      "/workspace/example",
      "codex:gpt-5.4",
      "018f9c3e-1234-7abc-9def-012345678900",
    );

    const sessionIndex = args.indexOf("018f9c3e-1234-7abc-9def-012345678900");
    const separatorIndex = args.indexOf("--");
    const promptIndex = args.indexOf("- bullet one\n- bullet two");

    expect(sessionIndex).toBeGreaterThan(1);
    expect(separatorIndex).toBe(sessionIndex + 1);
    expect(promptIndex).toBe(separatorIndex + 1);
  });

  it("separates first-turn prompts that start with hyphens from CLI flags", () => {
    const args = buildCodexArgs(
      "- bullet one\n- bullet two",
      "/workspace/example",
      "codex:gpt-5.4",
    );

    const cdIndex = args.indexOf("-C");
    const separatorIndex = args.indexOf("--");
    const promptIndex = args.indexOf("- bullet one\n- bullet two");

    expect(cdIndex).toBeGreaterThan(1);
    expect(separatorIndex).toBe(cdIndex + 2);
    expect(promptIndex).toBe(separatorIndex + 1);
    expect(promptIndex).toBe(args.length - 1);
  });

  it("passes model_instructions_file when provided", () => {
    const args = buildCodexArgs(
      "status",
      "/workspace/example",
      "codex:gpt-5.4",
      undefined,
      "/tmp/swarmfleet-system.md",
    );

    expect(args).toContain("--config");
    const configIndex = args.indexOf("--config");
    expect(configIndex).toBeGreaterThan(-1);
    expect(args[configIndex + 1]).toBe(
      'model_instructions_file="/tmp/swarmfleet-system.md"',
    );
  });

  it("mounts the SwarmFleet MCP server for Codex when configured", () => {
    const args = buildCodexArgs(
      "status",
      "/workspace/example",
      "codex:gpt-5.4",
      undefined,
      undefined,
      {
        parentSessionId: "session-1",
        backendUrl: "http://127.0.0.1:3000",
        internalToken: "token-1",
      },
    );

    expect(args).toContain("--config");
    expect(args).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mcp_servers.swarmfleet.command="),
        expect.stringContaining("mcp_servers.swarmfleet.args="),
        expect.stringContaining("mcp_servers.swarmfleet.env="),
      ]),
    );
    expect(args.join("\n")).toContain("session-1");
    expect(args.join("\n")).toContain("token-1");
  });
});

describe("buildCodexPlanPrompt", () => {
  it("wraps a user request with plan-mode instructions", () => {
    const prompt = buildCodexPlanPrompt("change the button color");

    expect(prompt).toContain("You are in plan mode.");
    expect(prompt).toContain("Do not modify files or implement changes.");
    expect(prompt).toContain("inspect the relevant project files");
    expect(prompt).toContain("Produce a concise planning plan");
    expect(prompt).toContain("known files to edit");
    expect(prompt).toContain("validated assumptions");
    expect(prompt).toContain("change the button color");
  });
});

describe("detectAwaitingInput", () => {
  it("does not treat generic tool errors as awaiting input", () => {
    const signal = detectAwaitingInput({
      type: "claude_json",
      data: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              is_error: true,
              content: "EISDIR: illegal operation on a directory",
            },
          ],
        },
      },
    });

    expect(signal).toBeNull();
  });

  it("detects explicit plan approval waits", () => {
    const signal = detectAwaitingInput({
      type: "claude_json",
      data: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_456",
              name: "ExitPlanMode",
              input: { plan: "Example plan" },
            },
          ],
        },
      },
    });

    expect(signal).toEqual({
      kind: "plan",
      toolName: "ExitPlanMode",
    });
  });
});

describe("resolveCodexTurnUsage", () => {
  it("prefers turn.completed usage over token_count snapshots", () => {
    expect(
      resolveCodexTurnUsage(
        { input_tokens: 52341, output_tokens: 912 },
        { input_tokens: 1464000, output_tokens: 18200 },
      ),
    ).toEqual({
      input_tokens: 1464000,
      output_tokens: 18200,
    });
  });

  it("falls back to turn.completed usage when token_count data is absent", () => {
    expect(
      resolveCodexTurnUsage(
        { input_tokens: 0, output_tokens: 0 },
        { input_tokens: 1234, output_tokens: 56 },
      ),
    ).toEqual({
      input_tokens: 1234,
      output_tokens: 56,
    });
  });

  it("falls back to the latest token_count snapshot when turn.completed usage is absent", () => {
    const latestObservedUsage = { input_tokens: 15456, output_tokens: 321 };

    expect(resolveCodexTurnUsage(latestObservedUsage, null)).toEqual(
      latestObservedUsage,
    );
  });
});

import { TOOL_CONSTANTS } from "./constants";

export function extractToolInfo(
  toolName?: string,
  input?: Record<string, unknown>,
): { toolName: string; commands: string[] } {
  const extractedToolName = toolName || TOOL_CONSTANTS.DEFAULT_TOOL_NAME;
  let commands: string[] = [];

  if (
    extractedToolName === "Bash" &&
    input?.command &&
    typeof input.command === "string"
  ) {
    commands = extractBashCommands(input.command);
  } else if (extractedToolName === "ExitPlanMode") {
    commands = ["ExitPlanMode"];
  } else {
    commands = [TOOL_CONSTANTS.WILDCARD_COMMAND];
  }

  if (extractedToolName !== "Bash" && commands.length === 0) {
    commands = [TOOL_CONSTANTS.WILDCARD_COMMAND];
  }

  return { toolName: extractedToolName, commands };
}

function extractBashCommands(commandString: string): string[] {
  const commandParts = splitCompoundCommand(commandString);
  const rawCommands = commandParts
    .map((part) => extractSingleBashCommand(part.trim()))
    .filter(Boolean);

  const filteredCommands = rawCommands.filter((cmd) => {
    return !(TOOL_CONSTANTS.BASH_BUILTINS as readonly string[]).includes(cmd);
  });

  const finalCommands =
    filteredCommands.length > 0 ? filteredCommands : rawCommands;
  return [...new Set(finalCommands)];
}

function splitCompoundCommand(commandString: string): string[] {
  const separatorPattern = TOOL_CONSTANTS.COMMAND_SEPARATORS.map((sep) =>
    sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|");

  const regex = new RegExp(`\\s*(${separatorPattern})\\s*`);
  return commandString.split(regex).filter((part, index) => {
    return index % 2 === 0 && part.trim() !== "";
  });
}

function extractSingleBashCommand(commandPart: string): string {
  const cmdParts = commandPart.split(/\s+/);

  if (
    cmdParts.length >= 2 &&
    TOOL_CONSTANTS.MULTI_WORD_COMMANDS.includes(
      cmdParts[0] as (typeof TOOL_CONSTANTS.MULTI_WORD_COMMANDS)[number],
    )
  ) {
    return cmdParts.slice(0, 2).join(" ");
  }

  return cmdParts[0] || "";
}

export function generateToolPatterns(
  toolName: string,
  commands: string[],
): string[] {
  if (toolName !== "Bash") {
    return [toolName];
  }
  return commands.map((command) =>
    command !== TOOL_CONSTANTS.WILDCARD_COMMAND
      ? `${toolName}(${command}:*)`
      : toolName,
  );
}

export function generateToolPattern(toolName: string, command: string): string {
  return toolName === "Bash" && command !== TOOL_CONSTANTS.WILDCARD_COMMAND
    ? `${toolName}(${command}:*)`
    : toolName;
}

export function formatToolArguments(input?: Record<string, unknown>): string {
  if (!input) return "";

  if (input.path) return `(${input.path})`;
  if (input.file_path) return `(${input.file_path})`;
  if (input.command) return `(${input.command})`;
  if (input.pattern) return `(${input.pattern})`;
  if (input.url) return `(${input.url})`;

  const keys = Object.keys(input);
  if (keys.length > 0) {
    const firstKey = keys[0];
    const value = input[firstKey];
    if (typeof value === "string" && value.length < 50) {
      return `(${value})`;
    } else {
      return `(${keys.length} ${keys.length === 1 ? "arg" : "args"})`;
    }
  }

  return "";
}

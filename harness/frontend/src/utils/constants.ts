// UI Constants
export const UI_CONSTANTS = {
  NEAR_BOTTOM_THRESHOLD_PX: 100,
  TEXTAREA_MAX_HEIGHT: 200,
} as const;

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS = {
  ABORT: "Escape",
  SUBMIT: "Enter",
  PERMISSION_MODE_TOGGLE: "M",
} as const;

// Message display constants
export const MESSAGE_CONSTANTS = {
  MAX_DISPLAY_WIDTH: {
    MOBILE: "85%",
    DESKTOP: "70%",
  },
  SUMMARY_MAX_LENGTH: 50,
  SESSION_ID_DISPLAY_LENGTH: 8,
} as const;

// Tool-related constants
export const TOOL_CONSTANTS = {
  MULTI_WORD_COMMANDS: ["cargo", "git", "npm", "yarn", "docker"],
  WILDCARD_COMMAND: "*",
  DEFAULT_TOOL_NAME: "Unknown",
  BASH_BUILTINS: [
    "cd",
    "pwd",
    "export",
    "unset",
    "alias",
    "unalias",
    "history",
    "jobs",
    "bg",
    "fg",
    "exit",
    "return",
    "shift",
    "break",
    "continue",
    "which",
  ],
  COMMAND_SEPARATORS: ["&&", "||", ";", "|"],
} as const;

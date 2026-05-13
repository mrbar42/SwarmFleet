export function formatProviderLabel(provider: string): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "pi") return "Pi";
  if (provider === "openrouter-claude") return "OpenRouterClaude";
  if (provider === "hermes") return "Hermes";
  return provider;
}

export function providerTextColorClass(provider: string): string {
  if (provider === "claude" || provider === "anthropic") return "text-[rgb(217_119_87)]";
  if (provider === "codex" || provider === "openai" || provider === "openai-codex") return "text-[#b8c1ff]";
  if (provider === "pi") return "text-[#8fa1b8]";
  if (provider === "openrouter" || provider === "openrouter-claude") return "text-[#7dd3fc]";
  if (provider === "lmstudio" || provider === "lm-studio") return "text-[#a7f3d0]";
  if (provider === "custom") return "text-[#f0abfc]";
  if (provider === "hermes") return "text-[#d9a8ff]";
  return "text-[#8b949e]";
}

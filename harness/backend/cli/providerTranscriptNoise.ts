function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractAssistantText(data: Record<string, unknown>): string | null {
  if (data.type !== "assistant") return null;
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

const CONTEXT_COMPACTION_REFERENCE_PREFIX =
  "[CONTEXT COMPACTION — REFERENCE ONLY]";

export function isProviderResumeDiagnosticText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("↻ Resumed session ") &&
    (trimmed.includes("\n  ┊ review diff") ||
      trimmed.includes("\r\n  ┊ review diff") ||
      trimmed.includes("⟳ compacting context"))
  );
}

export function isProviderContextCompactionReferenceText(
  text: string,
): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith(CONTEXT_COMPACTION_REFERENCE_PREFIX) ||
    trimmed.startsWith("⟳ compacting context")
  );
}

export function isProviderInternalDiagnosticText(text: string): boolean {
  return (
    isProviderResumeDiagnosticText(text) ||
    isProviderContextCompactionReferenceText(text)
  );
}

export function isProviderInternalDiagnosticAssistant(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const text = extractAssistantText(data);
  return text ? isProviderInternalDiagnosticText(text) : false;
}

export function isProviderInternalDiagnosticResult(data: unknown): boolean {
  return (
    isRecord(data) &&
    data.type === "result" &&
    typeof data.result === "string" &&
    isProviderInternalDiagnosticText(data.result)
  );
}

export function isProviderResumeDiagnosticAssistant(data: unknown): boolean {
  return isProviderInternalDiagnosticAssistant(data);
}

export function removeProviderResumeDiagnosticResult(
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!isProviderInternalDiagnosticResult(data)) return data;
  const { result: _result, ...rest } = data;
  return rest;
}

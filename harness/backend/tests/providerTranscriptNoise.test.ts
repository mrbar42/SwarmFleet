import { describe, expect, it } from "vitest";
import {
  isProviderContextCompactionReferenceText,
  isProviderResumeDiagnosticAssistant,
  isProviderResumeDiagnosticText,
  removeProviderResumeDiagnosticResult,
} from "../cli/providerTranscriptNoise.ts";

const diagnostic =
  "↻ Resumed session 20260430_025604_5793e2 (5 user messages, 99 total messages)\r\n" +
  "  ┊ review diff\r\n" +
  "a/src/lib/ui/onboarding/DomainScareCarousel.svelte → b/src/lib/ui/onboarding/DomainScareCarousel.svelte\r\n" +
  "  ⟳ compacting context…";

const compactionReference =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.\n" +
  "## Active Task\nNone.";

describe("provider transcript noise filters", () => {
  it("detects resume diff diagnostics", () => {
    expect(isProviderResumeDiagnosticText(diagnostic)).toBe(true);
  });

  it("detects context compaction references", () => {
    expect(isProviderContextCompactionReferenceText(compactionReference)).toBe(
      true,
    );
    expect(
      isProviderContextCompactionReferenceText("⟳ compacting context…"),
    ).toBe(true);
  });

  it("does not treat ordinary resume text as noise", () => {
    expect(
      isProviderResumeDiagnosticText(
        "↻ Resumed session abc\nThe previous task is complete.",
      ),
    ).toBe(false);
  });

  it("detects assistant messages that only carry resume diagnostics", () => {
    expect(
      isProviderResumeDiagnosticAssistant({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: diagnostic }],
        },
      }),
    ).toBe(true);
  });

  it("detects assistant messages that only carry compaction references", () => {
    expect(
      isProviderResumeDiagnosticAssistant({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: compactionReference }],
        },
      }),
    ).toBe(true);
  });

  it("removes diagnostic text from final result messages", () => {
    expect(
      removeProviderResumeDiagnosticResult({
        type: "result",
        result: diagnostic,
        duration_ms: 10,
      }),
    ).toEqual({
      type: "result",
      duration_ms: 10,
    });
  });
});

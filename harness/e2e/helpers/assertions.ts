import { expect, type Page } from "@playwright/test";

export interface FrontendDiagnostics {
  consoleMessages: Array<{ type: string; text: string }>;
  networkResponses: Array<{ url: string; status: number; ok: boolean }>;
  networkErrors: Array<{ url: string; failure: string | undefined }>;
  pageErrors: string[];
  pageCrashes: string[];
}

const STREAM_REQUEST_ALLOWLIST = [
  /\/api\/sessions\/[^/]+\/stream/i,
  /\/api\/terminal\/sessions\/[^/]+\/stream/i,
];

function isAllowedConsoleError(message: {
  type: string;
  text: string;
}): boolean {
  if (
    /favicon\.ico/i.test(message.text) &&
    /failed to load resource/i.test(message.text)
  ) {
    return true;
  }

  return false;
}

function isAllowedRequestFailure(error: {
  url: string;
  failure: string | undefined;
}): boolean {
  if (!STREAM_REQUEST_ALLOWLIST.some((pattern) => pattern.test(error.url))) {
    return false;
  }

  const failure = (error.failure ?? "").toLowerCase();
  return (
    failure.includes("aborted") ||
    failure.includes("err_abort") ||
    failure.includes("incomplete_chunked_encoding")
  );
}

function isAllowedResponse(response: {
  url: string;
  status: number;
}): boolean {
  return response.status === 404 && /favicon\.ico$/i.test(response.url);
}

export function installPageDiagnostics(page: Page): FrontendDiagnostics {
  const diagnostics: FrontendDiagnostics = {
    consoleMessages: [],
    networkResponses: [],
    networkErrors: [],
    pageErrors: [],
    pageCrashes: [],
  };

  page.on("console", (message) => {
    diagnostics.consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });

  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  page.on("crash", () => {
    diagnostics.pageCrashes.push("Page crashed");
  });

  page.on("response", (response) => {
    diagnostics.networkResponses.push({
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
    });
  });

  page.on("requestfailed", (request) => {
    diagnostics.networkErrors.push({
      url: request.url(),
      failure: request.failure()?.errorText,
    });
  });

  return diagnostics;
}

export async function assertNoFrontendErrors(
  diagnostics: FrontendDiagnostics,
): Promise<void> {
  const consoleErrors = diagnostics.consoleMessages.filter(
    (message) =>
      message.type === "error" && !isAllowedConsoleError(message),
  );
  const networkErrors = diagnostics.networkErrors.filter(
    (error) => !isAllowedRequestFailure(error),
  );
  const badResponses = diagnostics.networkResponses.filter(
    (response) => response.status >= 400 && !isAllowedResponse(response),
  );

  expect(consoleErrors).toEqual([]);
  expect(networkErrors).toEqual([]);
  expect(badResponses).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.pageCrashes).toEqual([]);
}

import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { waitForAppReady, waitForChatToFinish, waitForChatToStart } from "./wait";
import { WORKSPACE_ROOT } from "./projects";

export async function openProjectTab(
  page: Page,
  projectName: string,
  tab: string = "chat",
  options?: { sessionId?: string },
): Promise<void> {
  const search = options?.sessionId
    ? `?sessionId=${encodeURIComponent(options.sessionId)}`
    : "";
  await page.goto(`/${tab}/${projectName}${search}`);
  await waitForAppReady(page);
}

export async function selectModel(page: Page, modelId: string): Promise<void> {
  const modelSelector = page.getByTestId("model-selector");
  await modelSelector.click();
  const providerId = modelId.startsWith("pi:")
    ? `pi:${modelId.split(":")[1]}`
    : modelId.startsWith("codex")
      ? "codex"
      : "claude";
  await page
    .locator(`[data-testid="model-provider-tab"][data-provider-id="${providerId}"]`)
    .click();
  await page
    .locator(`[data-testid="model-option"][data-model-id="${modelId}"]`)
    .click();
  await expect(modelSelector).toHaveAttribute("data-model-id", modelId);
}

export async function sendChatPrompt(page: Page, message: string): Promise<void> {
  await page.getByTestId("chat-input").fill(message);
  await page.getByTestId("chat-send").click();
}

export async function sendChatPromptAndWait(
  page: Page,
  message: string,
  timeout = 120_000,
): Promise<void> {
  const userMessageCountBefore = await page
    .locator('[data-testid="chat-message-user"]')
    .count();
  await sendChatPrompt(page, message);
  await expect
    .poll(
      async () => await page.locator('[data-testid="chat-message-user"]').count(),
      {
        timeout: 10_000,
        intervals: [250, 500, 1_000],
      },
    )
    .toBeGreaterThan(userMessageCountBefore);
  await waitForChatToFinish(page, timeout);
}

export async function waitForChatSessionId(
  page: Page,
  timeout = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const sessionId = await page.evaluate(() => {
      const url = new URL(window.location.href);
      return url.searchParams.get("sessionId");
    });
    if (sessionId) return sessionId;
    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for chat sessionId in URL");
}

export async function fetchConversation(
  page: Page,
  sessionId: string,
): Promise<{
  sessionId: string;
  messages: unknown[];
  metadata: { startTime: string; endTime: string; messageCount: number };
}> {
  const response = await page.request.get(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    sessionId: string;
    messages: unknown[];
    metadata: { startTime: string; endTime: string; messageCount: number };
  };
}

export async function readWorkspaceFile(
  page: Page,
  relativePath: string,
): Promise<{ content: string }> {
  const response = await page.request.get(
    `/api/files/read?path=${encodeURIComponent(relativePath)}`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as { content: string };
}

export async function getProjectSessions(
  page: Page,
  projectName: string,
): Promise<
  Array<{
    sessionId: string;
    title: string;
    startTime: string;
    lastTime: string;
    messageCount: number;
    lastMessagePreview: string;
  }>
> {
  const projectPath = join(WORKSPACE_ROOT, projectName);
  const response = await page.request.get(
    `/api/sessions?project=${encodeURIComponent(projectPath)}`,
  );
  expect(response.ok()).toBeTruthy();
  const data = (await response.json()) as {
    conversations: Array<{
      sessionId: string;
      title: string;
      startTime: string;
      lastTime: string;
      messageCount: number;
      lastMessagePreview: string;
    }>;
  };
  return data.conversations;
}

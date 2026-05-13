import { test, expect } from "../fixtures/app.fixture";
import {
  fetchConversation,
  getProjectSessions,
  openProjectTab,
  readWorkspaceFile,
  selectModel,
  sendChatPrompt,
  sendChatPromptAndWait,
} from "../helpers/chat";
import { PROJECTS, resetProjectDir } from "../helpers/projects";
import { loadProviderState, PROVIDER_CONFIG } from "../helpers/providers";
import { waitForChatToFinish, waitForChatToStart } from "../helpers/wait";

const providers = loadProviderState();
const BASIC_PROMPT =
  "Create a single HTML file called index.html that shows the text 'it works!' in rainbow colors. Use inline CSS only. Write it to the current directory.";

async function retryOnTransientProviderError(page: import("@playwright/test").Page) {
  const toolCallCount = await page.locator('[data-testid="tool-call"]').count();
  if (toolCallCount > 0) return;

  const providerErrorCount = await page
    .getByText(/API Error: 500|Claude CLI exited with code 1/)
    .count();
  if (providerErrorCount === 0) return;

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("new-chat-session"));
  });
  await sendChatPromptAndWait(page, BASIC_PROMPT);
}

test.describe("Chat — Anthropic", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !providers.anthropic.available,
    providers.anthropic.reason ?? PROVIDER_CONFIG.anthropic.skipMessage,
  );

  test.beforeAll(async () => {
    await resetProjectDir(PROJECTS.anthropic);
  });

  test("basic chat round-trip", async ({ page }) => {
    await openProjectTab(page, PROJECTS.anthropic, "chat");
    await selectModel(page, PROVIDER_CONFIG.anthropic.modelId);

    await sendChatPromptAndWait(page, BASIC_PROMPT);
    await retryOnTransientProviderError(page);

    await expect
      .poll(async () => await page.locator('[data-testid="chat-message-assistant"]').count())
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await page.locator('[data-testid="tool-call"]').count())
      .toBeGreaterThan(0);

    const file = await readWorkspaceFile(page, `${PROJECTS.anthropic}/index.html`);
    expect(file.content).toContain("it works!");
  });

  test("sub-agent rendering", async ({ page }) => {
    const sessions = await getProjectSessions(page, PROJECTS.anthropic);
    const sessionId = sessions[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    await openProjectTab(page, PROJECTS.anthropic, "chat", { sessionId });
    const initialLaneCount = await page.locator('[data-testid="subagent-lane"]').count();

    await sendChatPromptAndWait(
      page,
      "Use a sub-agent to check if index.html exists and another sub-agent to count the words in it. Report both results.",
    );

    await expect
      .poll(async () => await page.locator('[data-testid="subagent-group"]').count())
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await page.locator('[data-testid="subagent-lane"]').count())
      .toBeGreaterThan(initialLaneCount);
    await expect
      .poll(async () => await page.locator('[data-testid="subagent-lane"][data-state="complete"]').count())
      .toBeGreaterThan(0);
  });

  test("resume session after abort", async ({ page }) => {
    const sessions = await getProjectSessions(page, PROJECTS.anthropic);
    const sessionId = sessions[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    await openProjectTab(page, PROJECTS.anthropic, "chat", { sessionId });
    const assistantCountBefore = await page.locator('[data-testid="chat-message-assistant"]').count();

    await sendChatPrompt(
      page,
      "List all files in /usr directory recursively and describe each one",
    );
    await waitForChatToStart(page, 20_000);
    await page.waitForTimeout(2_000);
    await page.getByTestId("chat-abort").click();
    await page.getByTestId("chat-send").waitFor({ state: "visible", timeout: 10_000 });

    await sendChatPromptAndWait(page, "Just say hello");

    await expect
      .poll(async () => await page.locator('[data-testid="chat-message-assistant"]').count())
      .toBeGreaterThan(assistantCountBefore);

    const conversation = await fetchConversation(page, sessionId!);
    expect(conversation.messages.length).toBeGreaterThan(0);
  });
});

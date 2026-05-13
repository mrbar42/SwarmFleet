import { test, expect } from "../fixtures/app.fixture";
import {
  getProjectSessions,
  openProjectTab,
  readWorkspaceFile,
  selectModel,
  sendChatPromptAndWait,
} from "../helpers/chat";
import { PROJECTS, resetProjectDir } from "../helpers/projects";
import { loadProviderState, PROVIDER_CONFIG } from "../helpers/providers";

const providers = loadProviderState();

test.describe("Chat — OpenAI", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !providers.openai.available,
    providers.openai.reason ?? PROVIDER_CONFIG.openai.skipMessage,
  );

  test.beforeAll(async () => {
    await resetProjectDir(PROJECTS.openai);
  });

  test("basic chat round-trip", async ({ page }) => {
    await openProjectTab(page, PROJECTS.openai, "chat");
    await selectModel(page, PROVIDER_CONFIG.openai.modelId);

    await sendChatPromptAndWait(
      page,
      "Create a single HTML file called index.html that shows 'it works!' with each letter in a different rainbow color. Use inline CSS.",
    );

    await expect
      .poll(async () => await page.locator('[data-testid="chat-message-assistant"]').count())
      .toBeGreaterThan(0);
    await expect
      .poll(async () => await page.locator('[data-testid="tool-call"]').count())
      .toBeGreaterThan(0);

    const file = await readWorkspaceFile(page, `${PROJECTS.openai}/index.html`);
    expect(file.content).toMatch(/i[\s\S]*t[\s\S]*w[\s\S]*o[\s\S]*r[\s\S]*k[\s\S]*s[\s\S]*!/i);
  });

  test("tool call rendering", async ({ page }) => {
    const sessions = await getProjectSessions(page, PROJECTS.openai);
    const sessionId = sessions[0]?.sessionId;
    expect(sessionId).toBeTruthy();

    await openProjectTab(page, PROJECTS.openai, "chat", { sessionId });
    const toolCallCountBefore = await page.locator('[data-testid="tool-call"]').count();
    const toolResultCountBefore = await page.locator('[data-testid="tool-result"]').count();

    await sendChatPromptAndWait(
      page,
      "Create a text file named note.txt with the content 'openai tool rendering test' and then read it back.",
    );

    await expect
      .poll(async () => await page.locator('[data-testid="tool-call"]').count())
      .toBeGreaterThan(toolCallCountBefore);
    await expect
      .poll(async () => await page.locator('[data-testid="tool-result"]').count())
      .toBeGreaterThan(toolResultCountBefore);
    await expect(
      page.locator('[data-testid="tool-call"]').first(),
    ).toHaveAttribute("data-tool-name", /.+/);
  });
});

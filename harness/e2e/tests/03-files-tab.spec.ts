import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/app.fixture";
import { openProjectTab, selectModel } from "../helpers/chat";
import {
  PROJECTS,
  projectPath,
  seedFilesProject,
} from "../helpers/projects";
import {
  chooseAnyAvailableProvider,
  loadProviderState,
  PROVIDER_CONFIG,
} from "../helpers/providers";
import { waitForChatToFinish, waitForChatToStart } from "../helpers/wait";

const providers = loadProviderState();

async function prepareAgentCommitModel(page: Page) {
  const providerKey = chooseAnyAvailableProvider(providers);
  if (!providerKey) return false;

  await openProjectTab(page, PROJECTS.files, "chat");
  await selectModel(page, PROVIDER_CONFIG[providerKey].modelId);
  await openProjectTab(page, PROJECTS.files, "files");
  return true;
}

test.describe("Files Tab", () => {
  test.beforeEach(async () => {
    await seedFilesProject();
  });

  test("file explorer directory expand/collapse", async ({ page }) => {
    await openProjectTab(page, PROJECTS.files, "files");
    const fileEntry = (name: RegExp | string) =>
      page.locator('[data-testid="file-entry"]').filter({ hasText: name }).first();

    await expect(fileEntry(/^src$/)).toBeVisible();
    await expect(fileEntry(/^README\.md/)).toBeVisible();
    await expect(fileEntry(/^package\.json/)).toBeVisible();

    // Expand src
    await fileEntry(/^src$/).click();
    await expect(fileEntry(/^main\.ts/)).toBeVisible();
    await expect(fileEntry(/^utils\.ts/)).toBeVisible();

    // src remains visible (tree view — no navigation)
    await expect(fileEntry(/^src$/)).toBeVisible();

    // Collapse src — children become hidden
    await fileEntry(/^src$/).click();
    await expect(fileEntry(/^main\.ts/)).not.toBeVisible();
  });

  test("file viewer shows file content and tabs", async ({ page }) => {
    await openProjectTab(page, PROJECTS.files, "files");
    const fileEntry = (name: RegExp | string) =>
      page.locator('[data-testid="file-entry"]').filter({ hasText: name }).first();
    const fileTab = (name: RegExp | string) =>
      page.locator('[data-testid="file-tab"]').filter({ hasText: name }).first();

    await fileEntry(/^README\.md/).click();
    await expect(page.getByTestId("file-viewer")).toContainText("# e2e-files");
    await expect(fileTab(/README\.md/)).toBeVisible();

    await page.getByTestId("files-panel-tab").click();
    await fileEntry(/^src$/).click();
    await fileEntry(/^main\.ts/).click();

    await expect(page.getByTestId("file-viewer")).toContainText('console.log("main");');
    await expect(fileTab(/main\.ts/)).toBeVisible();
    await expect(fileTab(/README\.md/)).toBeVisible();
  });

  test("desktop keeps file explorer visible while viewing files", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openProjectTab(page, PROJECTS.files, "files");
    const readme = page
      .locator('[data-testid="file-entry"]')
      .filter({ hasText: /^README\.md/ })
      .first();

    await readme.click();

    await expect(page.getByTestId("file-viewer")).toContainText("# e2e-files");
    await expect(page.getByTestId("file-explorer")).toBeVisible();
    await expect(page.getByTestId("file-explorer")).toHaveAttribute(
      "data-variant",
      "docked",
    );
    await expect(readme).toBeVisible();
  });

  test("SVG preview scales the image to fit instead of clipping natural-size SVGs", async ({ page }) => {
    await openProjectTab(page, PROJECTS.files, "files");
    const fileEntry = page
      .locator('[data-testid="file-entry"]')
      .filter({ hasText: /^wide-natural-size\.svg/ })
      .first();

    await fileEntry.click();
    await page.getByTestId("svg-view-mode-preview").click();

    const previewImage = page.getByTestId("svg-preview-image");
    await expect(previewImage).toBeVisible();
    await expect(previewImage).toHaveCSS("object-fit", "contain");
    await expect(page.locator("iframe[title='wide-natural-size.svg']")).toHaveCount(0);
  });

  test("git status auto-inits a new repository", async ({ page }) => {
    await openProjectTab(page, PROJECTS.files, "files");
    await page.getByTestId("git-panel-tab").click();

    await expect(page.getByTestId("git-view")).toBeVisible();
    await expect(page.getByTestId("git-branch-bar")).toContainText(/.+/);
    await expect(
      page.locator('[data-testid="git-file"][data-path="README.md"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="git-file"][data-path="package.json"]'),
    ).toBeVisible();

    const response = await page.request.get(
      `/api/git/status?project=${encodeURIComponent(projectPath(PROJECTS.files))}`,
    );
    expect(response.ok()).toBeTruthy();
    const data = (await response.json()) as { branch: string };
    expect(data.branch).not.toBe("unknown");
  });

  test("agent commit opens chat and creates a commit", async ({ page }) => {
    test.skip(!chooseAnyAvailableProvider(providers), "No authenticated provider available");

    const configured = await prepareAgentCommitModel(page);
    test.skip(!configured, "No authenticated provider available");

    await page.getByTestId("git-panel-tab").click();
    await page.getByTestId("agent-commit").click();

    await expect(page).toHaveURL(new RegExp(`/chat/${PROJECTS.files}`));
    await expect(page.getByTestId("chat-message-user")).toContainText(
      "Review the current git changes",
    );

    await waitForChatToStart(page, 20_000);
    await waitForChatToFinish(page, 120_000);

    await openProjectTab(page, PROJECTS.files, "files");
    await page.getByTestId("git-panel-tab").click();
    await expect(page.getByText("Working tree clean")).toBeVisible();

    const logResponse = await page.request.get(
      `/api/git/log?project=${encodeURIComponent(projectPath(PROJECTS.files))}`,
    );
    expect(logResponse.ok()).toBeTruthy();
    const logData = (await logResponse.json()) as {
      commits: Array<{ message: string }>;
    };
    expect(logData.commits.length).toBeGreaterThan(0);
    expect(logData.commits[0]?.message ?? "").toMatch(
      /^[a-z]+(\(.+\))?!?: .+/i,
    );
  });
});

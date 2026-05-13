import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/app.fixture";
import { openProjectTab } from "../helpers/chat";
import { PROJECTS, projectPath, resetProjectDir } from "../helpers/projects";
import {
  measureReloadToReady,
  waitForNonEmptyText,
  waitForTerminalText,
} from "../helpers/wait";

async function getActiveTerminalSessionId(page: Page) {
  const sessionId = await page
    .getByTestId("terminal-tab")
    .getAttribute("data-active-session-id");
  expect(sessionId).toMatch(/^term-/);
  return sessionId!;
}

async function runTerminalCommand(
  page: Page,
  command: string,
) {
  await page.getByTestId("terminal-surface").click();
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
}

async function createTerminalSession(page: Page) {
  await waitForNonEmptyText(page.getByTestId("terminal-surface"));
  await getActiveTerminalSessionId(page);
}

async function createManualTerminalSession(page: Page) {
  await page.getByTestId("terminal-new-session").last().click();
  await getActiveTerminalSessionId(page);
  await waitForNonEmptyText(page.getByTestId("terminal-surface"));
}

async function clearProjectTerminalSessions(page: Page) {
  const q = `?project=${encodeURIComponent(projectPath(PROJECTS.terminal))}`;
  const response = await page.request.get(`/api/terminal/sessions${q}`);
  if (!response.ok()) return;
  const data = await response.json();
  await Promise.all(
    ((data.sessions ?? []) as Array<{ id: string }>).map((session) =>
      page.request.delete(`/api/terminal/sessions/${session.id}`),
    ),
  );
}

test.describe("Terminal Tab", () => {
  test.beforeEach(async ({ page }) => {
    await resetProjectDir(PROJECTS.terminal);
    await clearProjectTerminalSessions(page);
  });

  test("starts a default terminal automatically", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");

    await expect(page.getByTestId("terminal-tab")).toBeVisible();
    await createTerminalSession(page);
  });

  test("runs a command and shows output", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createTerminalSession(page);

    await runTerminalCommand(page, 'echo "hello e2e"');
    await waitForTerminalText(page, "hello e2e");
  });

  test("preserves environment variables within a session", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createManualTerminalSession(page);

    await runTerminalCommand(page, 'export E2E_VAR="test_value_123"');
    await runTerminalCommand(page, "echo $E2E_VAR");
    await waitForTerminalText(page, "test_value_123");
  });

  test("preserves the active terminal when navigating away and back", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createManualTerminalSession(page);

    await runTerminalCommand(page, 'export E2E_VAR="test_value_123"');
    await runTerminalCommand(page, "echo $E2E_VAR");
    await waitForTerminalText(page, "test_value_123");

    const sessionIdBefore = await getActiveTerminalSessionId(page);

    await page.getByTestId("tab-chat").click();
    await page.getByTestId("tab-terminal").click();

    await expect(page.getByTestId("terminal-tab")).toHaveAttribute(
      "data-active-session-id",
      sessionIdBefore,
    );

    await runTerminalCommand(page, "echo $E2E_VAR");
    await waitForTerminalText(page, "test_value_123");
  });

  test("survives browser reload in under three seconds", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createManualTerminalSession(page);

    await runTerminalCommand(page, 'export E2E_VAR="test_value_123"');
    await runTerminalCommand(page, 'echo "before_refresh"');
    await waitForTerminalText(page, "before_refresh");

    const sessionIdBefore = await getActiveTerminalSessionId(page);
    const elapsed = await measureReloadToReady(page);
    expect(elapsed).toBeLessThan(3_000);

    await expect(page.getByTestId("terminal-tab")).toHaveAttribute(
      "data-active-session-id",
      sessionIdBefore,
    );

    await runTerminalCommand(page, "echo $E2E_VAR");
    await waitForTerminalText(page, "test_value_123");
  });

  test("default terminal survives browser reload", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createTerminalSession(page);

    await runTerminalCommand(page, 'export DEFAULT_RELOAD_E2E_VAR="default_alive"');
    await runTerminalCommand(page, 'echo "before_default_refresh"');
    await waitForTerminalText(page, "before_default_refresh");

    const sessionIdBefore = await getActiveTerminalSessionId(page);
    const elapsed = await measureReloadToReady(page);
    expect(elapsed).toBeLessThan(3_000);

    await expect(page.getByTestId("terminal-tab")).toHaveAttribute(
      "data-active-session-id",
      sessionIdBefore,
    );

    await runTerminalCommand(page, "echo $DEFAULT_RELOAD_E2E_VAR");
    await waitForTerminalText(page, "default_alive");
  });

  test("toggles wrap lines mode", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createTerminalSession(page);

    const terminalTab = page.getByTestId("terminal-tab");
    const surface = page.getByTestId("terminal-surface");
    const wrapToggle = page.getByTestId("terminal-wrap-lines");

    await expect(terminalTab).toHaveAttribute("data-wrap-lines", "false");
    await expect(surface).toHaveAttribute("data-wrap-lines", "false");

    await wrapToggle.check();

    await expect(terminalTab).toHaveAttribute("data-wrap-lines", "true");
    await expect(surface).toHaveAttribute("data-wrap-lines", "true");

    await wrapToggle.uncheck();

    await expect(terminalTab).toHaveAttribute("data-wrap-lines", "false");
    await expect(surface).toHaveAttribute("data-wrap-lines", "false");
  });

  test("preserves the default session when reopening terminal", async ({ page }) => {
    await openProjectTab(page, PROJECTS.terminal, "terminal");
    await createTerminalSession(page);

    await runTerminalCommand(page, 'export DEFAULT_E2E_VAR="still_running"');
    await runTerminalCommand(page, 'echo "before navigation"');
    await waitForTerminalText(page, "before navigation");
    const sessionIdBefore = await getActiveTerminalSessionId(page);

    await page.getByTestId("tab-chat").click();
    await page.getByTestId("tab-terminal").click();

    await expect(page.getByTestId("terminal-tab")).toHaveAttribute(
      "data-active-session-id",
      sessionIdBefore,
    );

    await runTerminalCommand(page, "echo $DEFAULT_E2E_VAR");
    await waitForTerminalText(page, "still_running");
  });
});

import { expect, type Locator, type Page } from "@playwright/test";

export async function waitForAppReady(
  page: Page,
  timeout = 3_000,
): Promise<void> {
  await page.waitForSelector('[data-testid="app-ready"]', { timeout });
}

export async function waitForChatToStart(
  page: Page,
  timeout = 10_000,
): Promise<void> {
  await page.getByTestId("chat-abort").waitFor({ state: "visible", timeout });
}

export async function waitForChatToFinish(
  page: Page,
  timeout = 120_000,
): Promise<void> {
  await expect
    .poll(
      async () => ({
        abortVisible: await page.getByTestId("chat-abort").isVisible().catch(() => false),
        sendVisible: await page.getByTestId("chat-send").isVisible().catch(() => false),
      }),
      {
        timeout,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toEqual({ abortVisible: false, sendVisible: true });
}

export async function measureReloadToReady(page: Page): Promise<number> {
  const startedAt = Date.now();
  await page.reload();
  await waitForAppReady(page);
  return Date.now() - startedAt;
}

export async function waitForNonEmptyText(
  locator: Locator,
  timeout = 10_000,
): Promise<void> {
  await expect
    .poll(async () => (await locator.textContent())?.trim() ?? "", {
      timeout,
      intervals: [250, 500, 1_000],
    })
    .not.toBe("");
}

export async function waitForTerminalText(
  page: Page,
  text: string,
  timeout = 10_000,
): Promise<void> {
  const surface = page.getByTestId("terminal-surface");
  await expect
    .poll(async () => (await surface.textContent()) ?? "", {
      timeout,
      intervals: [250, 500, 1_000],
    })
    .toContain(text);
}

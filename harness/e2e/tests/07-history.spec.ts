import { test, expect } from "../fixtures/app.fixture";
import { readSessionFixture } from "../helpers/sessionFixture";
import { chooseAnyAvailableProvider, loadProviderState } from "../helpers/providers";

const providers = loadProviderState();

test.describe("History View", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !chooseAnyAvailableProvider(providers),
    "No authenticated provider available",
  );

  test("lists prior conversations", async ({ page }) => {
    await page.goto("/chat/e2e-sessions?view=history");
    await page.waitForSelector('[data-testid="app-ready"]');

    await expect
      .poll(async () => await page.locator('[data-testid="history-entry"]').count())
      .toBeGreaterThan(0);
    await expect(page.locator('[data-testid="history-entry"]').first()).toContainText(
      /messages?/i,
    );
  });

  test("loads a conversation from history", async ({ page }) => {
    const { sessionThreeId } = await readSessionFixture();

    await page.goto("/chat/e2e-sessions?view=history");
    await page.waitForSelector('[data-testid="app-ready"]');

    const entry = page.locator(
      `[data-testid="history-entry"][data-session-id="${sessionThreeId}"]`,
    );
    await expect(entry).toBeVisible();
    await entry.click();

    await expect(page).toHaveURL(/sessionId=/);
    await expect(page.getByTestId("session-title-button")).toContainText("Session Alpha");
    await expect(page.locator('[data-testid="chat-message-user"]')).toHaveCount(
      1,
    );
  });
});

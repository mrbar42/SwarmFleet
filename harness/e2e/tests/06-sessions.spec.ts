import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/app.fixture";
import {
  openProjectTab,
  selectModel,
  sendChatPromptAndWait,
  waitForChatSessionId,
} from "../helpers/chat";
import { BASE_URL, PROJECTS, projectPath, resetProjectDir } from "../helpers/projects";
import { readSessionFixture, writeSessionFixture } from "../helpers/sessionFixture";
import {
  chooseAnyAvailableProvider,
  loadProviderState,
  PROVIDER_CONFIG,
} from "../helpers/providers";
import { measureReloadToReady, waitForAppReady } from "../helpers/wait";

const providers = loadProviderState();
const providerKey = chooseAnyAvailableProvider(providers);
const ACTIVE_SESSION_STORAGE_KEY = "swarmfleet-active-session";
const LAST_PROJECT_STORAGE_KEY = "swarmfleet-last-project";

async function configureAvailableModel(page: Page) {
  if (!providerKey) return;
  await selectModel(page, PROVIDER_CONFIG[providerKey].modelId);
}

function sessionItemsForProject(page: Page) {
  return page
    .locator(
      `[data-testid="project-group"][data-project-path$="${PROJECTS.sessions}"]`,
    )
    .locator('[data-testid^="session-item-"]');
}

test.describe("Default session routing", () => {
  test("opens bare UI at a new session in the first listed project", async ({ page }) => {
    const projectsResponse = await page.request.get(`${BASE_URL}/api/projects`);
    expect(projectsResponse.ok()).toBeTruthy();
    const { projects } = (await projectsResponse.json()) as {
      projects: Array<{ name: string; path: string; encodedName?: string }>;
    };
    expect(projects.length).toBeGreaterThan(0);

    const firstProject = projects[0];
    const secondProject = projects[1] ?? firstProject;
    const createResponse = await page.request.post(`${BASE_URL}/api/sessions`, {
      data: {
        projectPath: firstProject.path,
        encodedProjectName: firstProject.encodedName ?? firstProject.name,
        title: "Remembered session",
        provider: "claude",
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = (await createResponse.json()) as { sessionId: string };

    await page.addInitScript(
      ({ lastProjectKey, activeSessionKey, lastProjectName, sessionId }) => {
        window.localStorage.setItem(lastProjectKey, lastProjectName);
        window.sessionStorage.setItem(activeSessionKey, sessionId);
      },
      {
        lastProjectKey: LAST_PROJECT_STORAGE_KEY,
        activeSessionKey: ACTIVE_SESSION_STORAGE_KEY,
        lastProjectName: secondProject.name,
        sessionId: created.sessionId,
      },
    );

    await page.goto("/");
    await waitForAppReady(page);

    await expect(page).toHaveURL(new RegExp(`/chat/${firstProject.name}$`));
    await expect
      .poll(() =>
        page.evaluate((key) => window.sessionStorage.getItem(key), ACTIVE_SESSION_STORAGE_KEY),
      )
      .toBeNull();
  });

  test("keeps an explicit project URL without sessionId as a new session", async ({ page }) => {
    const projectsResponse = await page.request.get(`${BASE_URL}/api/projects`);
    expect(projectsResponse.ok()).toBeTruthy();
    const { projects } = (await projectsResponse.json()) as {
      projects: Array<{ name: string; path: string; encodedName?: string }>;
    };
    expect(projects.length).toBeGreaterThan(0);

    const firstProject = projects[0];
    const createResponse = await page.request.post(`${BASE_URL}/api/sessions`, {
      data: {
        projectPath: firstProject.path,
        encodedProjectName: firstProject.encodedName ?? firstProject.name,
        title: "Remembered explicit project session",
        provider: "claude",
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = (await createResponse.json()) as { sessionId: string };

    await page.addInitScript(
      ({ activeSessionKey, sessionId }) => {
        window.sessionStorage.setItem(activeSessionKey, sessionId);
      },
      {
        activeSessionKey: ACTIVE_SESSION_STORAGE_KEY,
        sessionId: created.sessionId,
      },
    );

    await openProjectTab(page, firstProject.name, "chat");

    await expect(page).toHaveURL(new RegExp(`/chat/${firstProject.name}$`));
    await expect
      .poll(() =>
        page.evaluate((key) => window.sessionStorage.getItem(key), ACTIVE_SESSION_STORAGE_KEY),
      )
      .toBeNull();
  });
});

test.describe("Session Management", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!providerKey, "No authenticated provider available");

  test.beforeAll(async () => {
    await resetProjectDir(PROJECTS.sessions);
  });

  test("creates multiple sessions", async ({ page }) => {
    await openProjectTab(page, PROJECTS.sessions, "chat");
    await configureAvailableModel(page);

    await sendChatPromptAndWait(page, "Say: session one");
    const sessionOneId = await waitForChatSessionId(page);
    await expect(sessionItemsForProject(page)).toHaveCount(1);

    const sidebarNewSession = page
      .locator(`[data-testid="new-session"][data-project-path$="${PROJECTS.sessions}"]`)
      .first();

    await sidebarNewSession.click();
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await sendChatPromptAndWait(page, "Say: session two");
    const sessionTwoId = await waitForChatSessionId(page);
    await expect(sessionItemsForProject(page)).toHaveCount(2);

    await sidebarNewSession.click();
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await sendChatPromptAndWait(page, "Say: session three");
    const sessionThreeId = await waitForChatSessionId(page);
    await expect(sessionItemsForProject(page)).toHaveCount(3);

    await writeSessionFixture({ sessionOneId, sessionTwoId, sessionThreeId });
  });

  test("switches between persisted sessions", async ({ page }) => {
    const { sessionOneId, sessionTwoId } = await readSessionFixture();

    await openProjectTab(page, PROJECTS.sessions, "chat", {
      sessionId: sessionOneId,
    });
    await expect(page.getByText("Say: session one")).toBeVisible();

    await page.getByTestId(`session-item-${sessionTwoId}`).click({
      position: { x: 24, y: 12 },
    });
    await expect(page).toHaveURL(new RegExp(`sessionId=${sessionTwoId}`));
    await expect(page.getByText("Say: session two")).toBeVisible();
    await expect(page.getByText("Say: session one")).toHaveCount(0);

    await page.getByTestId(`session-item-${sessionOneId}`).click({
      position: { x: 24, y: 12 },
    });
    await expect(page).toHaveURL(new RegExp(`sessionId=${sessionOneId}`));
    await expect(page.getByText("Say: session one")).toBeVisible();
  });

  test("survives browser refresh in under three seconds", async ({ page }) => {
    const { sessionOneId } = await readSessionFixture();

    await openProjectTab(page, PROJECTS.sessions, "chat", {
      sessionId: sessionOneId,
    });
    await expect(page.getByText("Say: session one")).toBeVisible();

    const elapsed = await measureReloadToReady(page);
    expect(elapsed).toBeLessThan(3_000);
    await expect(page).toHaveURL(
      new RegExp(`sessionId=${sessionOneId}`),
    );
    await expect(page.getByText("Say: session one")).toBeVisible();
  });

  test("renames a session and persists the title", async ({ page }) => {
    const { sessionThreeId } = await readSessionFixture();

    await openProjectTab(page, PROJECTS.sessions, "chat", {
      sessionId: sessionThreeId,
    });

    await page.getByTestId("session-title-button").click();
    await page.getByTestId("session-title-input").fill("Session Alpha");
    await page.getByTestId("session-title-input").press("Enter");

    await expect(page.getByTestId("session-title-button")).toContainText("Session Alpha");
    await expect(page.getByTestId(`session-item-${sessionThreeId}`)).toContainText(
      "Session Alpha",
    );

    await page.reload();
    await expect(page.getByTestId("session-title-button")).toContainText("Session Alpha");
  });

  test("clicking new session for another project navigates without flicker", async ({ page }) => {
    // Regression: clicking the sidebar new-session button for a *different*
    // project while a session is active used to push the new URL and then
    // immediately revert to the current session's URL. Caused by React Router's
    // location updates being wrapped in startTransition, leaving useLocation
    // stale for a tick after click handlers that also touch zustand stores.
    //
    // This test is self-contained (creates its own session via API) so it
    // runs even when no provider is authenticated.
    const sessionsProjectPath = projectPath(PROJECTS.sessions);
    const createResponse = await page.request.post(`${BASE_URL}/api/sessions`, {
      data: {
        projectPath: sessionsProjectPath,
        encodedProjectName: PROJECTS.sessions,
        title: "Flicker test",
        provider: "claude",
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = (await createResponse.json()) as { sessionId: string };
    const sessionId = created.sessionId;

    await openProjectTab(page, PROJECTS.sessions, "chat", { sessionId });
    await expect(page).toHaveURL(new RegExp(`sessionId=${sessionId}`));
    // Wait until the sidebar has discovered both projects so the click target
    // exists. PROJECTS.files is seeded by global setup and visible in the list.
    // Two elements share the new-session testid for empty-sessions projects
    // (the compose icon in the project header AND the empty-state placeholder
    // button); .first() picks the header button which is always rendered.
    await expect(
      page
        .locator(
          `[data-testid="new-session"][data-project-path$="${PROJECTS.files}"]`,
        )
        .first(),
    ).toBeVisible();

    // Capture every URL change between click and settle so a flicker is fatal,
    // not just an eventual-consistency check.
    const urlLog = await page.evaluate(
      async ({ targetSelector }) => {
        const log: string[] = [window.location.href];
        let last = window.location.href;
        let stop = false;
        const tick = () => {
          if (stop) return;
          const u = window.location.href;
          if (u !== last) {
            log.push(u);
            last = u;
          }
          setTimeout(tick, 1);
        };
        tick();
        // Pick the first match (compose icon in the project header row).
        const target = document.querySelector(targetSelector) as HTMLElement | null;
        if (!target) {
          stop = true;
          throw new Error(`new-session button not found: ${targetSelector}`);
        }
        target.click();
        await new Promise((r) => setTimeout(r, 800));
        stop = true;
        return log;
      },
      {
        targetSelector: `[data-testid="new-session"][data-project-path$="${PROJECTS.files}"]`,
      },
    );

    // The URL should transition exactly once: from the sessions project's
    // active session to /chat/files (no sessionId, no revert).
    expect(urlLog.length).toBe(2);
    expect(urlLog[0]).toMatch(
      new RegExp(`/chat/${PROJECTS.sessions}\\?sessionId=${sessionId}`),
    );
    expect(urlLog[1]).toMatch(new RegExp(`/chat/${PROJECTS.files}$`));

    // Belt-and-suspenders: after a brief settle, the URL still points at the
    // new project and never went back.
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`/chat/${PROJECTS.files}$`));
  });
});

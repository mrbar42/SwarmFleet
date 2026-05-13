import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;

beforeEach(async () => {
  vi.resetModules();
  const home = await mkdtemp(join(tmpdir(), "swarmfleet-telegram-home-"));
  tempDirs.push(home);
  process.env.HOME = home;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("sendTelegramOperatorNotification", () => {
  it("sends through Telegram when configured and enabled", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { providerProfileStore } = await import(
      "../services/providerProfiles.ts"
    );
    const { sendTelegramOperatorNotification } = await import(
      "../services/telegramNotifications.ts"
    );

    await providerProfileStore.updateSettings({
      telegramOperatorNotificationsEnabled: true,
      telegramBotToken: "123456:secret",
      telegramChatId: "987654321",
    });

    await expect(
      sendTelegramOperatorNotification("Operator attention needed"),
    ).resolves.toEqual({ ok: true });

    expect(requests).toEqual([
      {
        url: "https://api.telegram.org/bot123456:secret/sendMessage",
        body: {
          chat_id: "987654321",
          text: "Operator attention needed",
          disable_web_page_preview: true,
        },
      },
    ]);
  });

  it("fails before calling Telegram when disabled", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { sendTelegramOperatorNotification } = await import(
      "../services/telegramNotifications.ts"
    );

    await expect(sendTelegramOperatorNotification("Ping")).resolves.toEqual({
      ok: false,
      error: "Telegram operator notifications are disabled.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

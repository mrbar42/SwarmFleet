import type { ProviderGlobalSettings } from "../../shared/types.ts";
import { providerProfileStore } from "./providerProfiles.ts";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramNotificationResult {
  ok: boolean;
  error?: string;
}

function truncateMessage(message: string): string {
  const trimmed = message.replace(/\s+$/g, "");
  if (trimmed.length <= TELEGRAM_MESSAGE_LIMIT) return trimmed;
  return `${trimmed.slice(0, TELEGRAM_MESSAGE_LIMIT - 3)}...`;
}

function validateSettings(
  settings: ProviderGlobalSettings,
): { botToken: string; chatId: string } | { error: string } {
  if (!settings.telegramOperatorNotificationsEnabled) {
    return { error: "Telegram operator notifications are disabled." };
  }
  const botToken = settings.telegramBotToken?.trim();
  if (!botToken) return { error: "Telegram bot token is not configured." };
  const chatId = settings.telegramChatId?.trim();
  if (!chatId) return { error: "Telegram chat ID is not configured." };
  return { botToken, chatId };
}

export async function sendTelegramOperatorNotification(
  message: string,
): Promise<TelegramNotificationResult> {
  const text = truncateMessage(message.trim());
  if (!text) return { ok: false, error: "Message is required." };

  const settings = await providerProfileStore.getSettings();
  const validated = validateSettings(settings);
  if ("error" in validated) return { ok: false, error: validated.error };

  const response = await fetch(
    `https://api.telegram.org/bot${validated.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: validated.chatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  if (response.ok) return { ok: true };

  const body = (await response.json().catch(() => ({}))) as {
    description?: string;
  };
  return {
    ok: false,
    error: body.description || `Telegram API returned ${response.status}.`,
  };
}

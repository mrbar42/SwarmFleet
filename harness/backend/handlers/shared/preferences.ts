import type { Context } from "hono";
import {
  userPreferenceStore,
  type UserPreferenceUpdates,
} from "../../services/userPreferences.ts";
import { logger } from "../../utils/logger.ts";

export async function handleUserPreferencesRequest(c: Context) {
  try {
    return c.json(await userPreferenceStore.read());
  } catch (error) {
    logger.api.error("Error reading user preferences: {error}", { error });
    return c.json({ error: "Failed to read user preferences" }, 500);
  }
}

export async function handleUpdateUserPreferencesRequest(c: Context) {
  try {
    const body = await c.req.json<UserPreferenceUpdates>();
    return c.json(await userPreferenceStore.update(body));
  } catch (error) {
    logger.api.error("Error updating user preferences: {error}", { error });
    return c.json({ error: "Failed to update user preferences" }, 500);
  }
}

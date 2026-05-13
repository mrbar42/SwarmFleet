import { setTimeout as delay } from "node:timers/promises";
import {
  cleanupChatSessionStore,
  cleanupWorkspaceRoot,
  clearRuntimeState,
  readServerState,
} from "../helpers/projects";

async function stopServer(): Promise<void> {
  const state = readServerState();
  if (!state) return;

  for (const pid of [state.frontendPid, state.backendPid]) {
    if (pid <= 0) continue;

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }

    await delay(1_000);

    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already stopped.
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  await stopServer();
  await cleanupWorkspaceRoot();
  await cleanupChatSessionStore();
  await clearRuntimeState();
}

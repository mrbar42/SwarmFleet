import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_DIR, ensureRuntimeDir } from "./projects";

const SESSION_FIXTURE_PATH = join(RUNTIME_DIR, "session-fixture.json");

export interface SessionFixture {
  sessionOneId: string;
  sessionTwoId: string;
  sessionThreeId: string;
}

export async function writeSessionFixture(fixture: SessionFixture): Promise<void> {
  await ensureRuntimeDir();
  await writeFile(SESSION_FIXTURE_PATH, JSON.stringify(fixture, null, 2), "utf8");
}

export async function readSessionFixture(): Promise<SessionFixture> {
  const raw = await readFile(SESSION_FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as SessionFixture;
}

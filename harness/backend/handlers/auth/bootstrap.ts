import {
  listCredentials,
  mintEnrollmentToken,
} from "../../services/authStore.ts";

export async function bootstrapFirstDevice(log: {
  warn: (msg: string) => void;
}): Promise<void> {
  const creds = await listCredentials();
  if (creds.length > 0) return;

  await mintEnrollmentToken("bootstrap");
  const banner = "═".repeat(70);
  log.warn(banner);
  log.warn(" No passkeys registered. First-device enrollment is waiting. ");
  log.warn(" Open the SwarmFleet UI locally to enroll the first device.     ");
  log.warn(" Enrollment token expires in 5 minutes and is single-use.       ");
  log.warn(banner);
}

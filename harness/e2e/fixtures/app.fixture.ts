import { test as base, expect } from "@playwright/test";
import {
  assertNoFrontendErrors,
  installPageDiagnostics,
  type FrontendDiagnostics,
} from "../helpers/assertions";

type AppFixtures = {
  diagnostics: FrontendDiagnostics;
};

export const test = base.extend<AppFixtures>({
  diagnostics: async ({ page }, use) => {
    const diagnostics = installPageDiagnostics(page);
    await use(diagnostics);
    await assertNoFrontendErrors(diagnostics);
  },
});

export { expect };

/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Playwright config for the Family Chat network-allowlist test (unicornops/familychat-web#8). It is
 * separate from the upstream config on purpose: no homeserver containers, one browser, and it
 * needs only a built `webapp/`. See "Network capture" in the repository README.
 */

import { defineConfig, devices } from "@playwright/test";

const port = process.env["PRIVACY_TEST_PORT"] ?? "8089";
const baseURL = `http://localhost:${port}`;

export default defineConfig({
    testDir: "playwright/privacy",
    outputDir: "playwright/privacy-results",
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
    timeout: 120_000,
    use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        baseURL,
        trace: "retain-on-failure",
    },
    webServer: {
        command: `pnpm exec serve -p ${port} -L ./webapp`,
        url: `${baseURL}/version`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: "pipe",
    },
});

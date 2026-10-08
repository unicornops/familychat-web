/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Network capture for unicornops/familychat-web#8: load the built app with the Family Chat config,
 * go through the signed-out pages, sign in against a mocked homeserver, open a room, send a message
 * and visit the settings, recording every request the page (and its service worker) makes.
 *
 * Every request is intercepted, so nothing reaches the real network. Requests to our own hosts are
 * answered by the mock homeserver or a stub page. Anything else is aborted and fails the test.
 *
 * How to run it, and the baseline itself: "Third-party services" in the repository README.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { handleHomeserverRequest, sentMessages } from "./mock-homeserver.ts";

const CONFIG_PATH = path.join(import.meta.dirname, "..", "..", "familychat", "config.json");
const FAMILYCHAT_CONFIG = readFileSync(CONFIG_PATH, "utf-8");
const HOMESERVER_HOST = new URL(JSON.parse(FAMILYCHAT_CONFIG)["default_server_config"]["m.homeserver"]["base_url"])
    .host;

/**
 * The baseline: the only hosts the app may contact. Keep this in sync with the README and the CSP.
 * - the app itself (served from localhost in this test);
 * - the configured homeserver and its server name (`.well-known`);
 * - our own domains.
 */
function isAllowedHost(host: string): boolean {
    const hostname = host.replace(/:\d+$/, "");
    return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        host === HOMESERVER_HOST ||
        hostname === "safechat.family" ||
        hostname.endsWith(".safechat.family") ||
        hostname === "familychat.dev" ||
        hostname.endsWith(".familychat.dev")
    );
}

interface Capture {
    /** Every http(s)/ws(s) URL requested, in order. */
    requests: string[];
    /** Requests to hosts outside the allowlist. */
    violations: string[];
}

async function startCapture(context: BrowserContext, page: Page): Promise<Capture> {
    const capture: Capture = { requests: [], violations: [] };

    const record = (rawUrl: string): URL | null => {
        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            return null;
        }
        if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null; // data:, blob:, ...
        capture.requests.push(rawUrl);
        if (!isAllowedHost(url.host)) capture.violations.push(rawUrl);
        return url;
    };

    await context.route("**/*", async (route) => {
        const url = record(route.request().url());
        if (!url) return route.continue();
        if (!isAllowedHost(url.host)) return route.abort("blockedbyclient");

        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
            // Always serve the Family Chat config, whatever config the build was made with.
            if (/^\/config(\.[^/]+)?\.json$/.test(url.pathname)) {
                return route.fulfill({ status: 200, contentType: "application/json", body: FAMILYCHAT_CONFIG });
            }
            return route.continue();
        }
        if (url.host === HOMESERVER_HOST || url.pathname.startsWith("/.well-known/matrix/")) {
            return handleHomeserverRequest(route, url);
        }
        // Our own websites (help, privacy policy, panel): a stub page, never the real site.
        return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>stub</body></html>" });
    });

    // WebSockets are not routed; record them so one to a third party still fails the test.
    page.on("websocket", (ws) => void record(ws.url()));
    return capture;
}

/**
 * Give lazy loads (images, previews, widgets) time to fire. A signed-in client always has a sync
 * long-poll open, so Playwright's "networkidle" never happens.
 */
const settle = (page: Page): Promise<void> => page.waitForTimeout(2500);

/**
 * Close the toasts a fresh session shows (notifications, key backup, ...), which cover the room list.
 * The analytics prompt (if a build ever re-enables analytics) is answered "Yes", so the test sees it.
 */
async function dismissToasts(page: Page): Promise<void> {
    const toastButton = page
        .locator(".mx_ToastContainer")
        .getByRole("button", { name: /^(Later|Dismiss|Not now|Close|OK|Yes)$/ });
    for (let i = 0; i < 10; i++) {
        const button = toastButton.first();
        if (!(await button.isVisible())) return;
        await button.click().catch(() => {});
        await page.waitForTimeout(200);
    }
}

function report(capture: Capture): string {
    const hosts = [...new Set(capture.requests.map((u) => new URL(u).host))].sort();
    return `Hosts contacted: ${hosts.join(", ")}\nViolations:\n${[...new Set(capture.violations)].join("\n")}`;
}

test.describe("Family Chat network allowlist", () => {
    test("signed-out pages only contact our own hosts", async ({ context, page }) => {
        const capture = await startCapture(context, page);

        await page.goto("/");
        await expect(
            page.getByRole("link", { name: "Sign in" }).or(page.getByRole("button", { name: "Sign in" })),
        ).toBeVisible({ timeout: 30_000 });

        await page.goto("/#/login");
        await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();

        await page.goto("/#/forgot_password");
        await page.waitForLoadState("networkidle");

        // The static fallback pages are shipped too.
        await page.goto("/static/incompatible-browser.html");
        await page.goto("/static/unable-to-load.html");
        await page.waitForLoadState("networkidle");

        // Self-check: a request to a third party must be caught (and blocked).
        const canary = "https://canary.invalid/privacy-self-check";
        await page.evaluate((url) => fetch(url).catch(() => undefined), canary);
        expect(capture.violations).toContain(canary);
        capture.violations = capture.violations.filter((u) => u !== canary);
        capture.requests = capture.requests.filter((u) => u !== canary);

        console.log(report(capture));
        expect(capture.violations, report(capture)).toEqual([]);
    });

    test("signing in, a room, sending a message and settings only contact our own hosts", async ({ context, page }) => {
        const capture = await startCapture(context, page);
        if (process.env.PRIVACY_TEST_DEBUG) page.on("console", (m) => console.log(`console.${m.type()}: ${m.text()}`));

        await page.goto("/#/login");
        await page.getByRole("textbox", { name: "Username" }).fill("kid");
        await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
        await page.getByRole("button", { name: "Sign in" }).click();

        // A fresh device sets up cross-signing and key backup against the mock, then lands on Home.
        const room = page.getByRole("option", { name: "Open room Family" });
        await expect(room).toBeVisible({ timeout: 60_000 });
        await page.keyboard.press("Escape"); // release announcements
        await dismissToasts(page);
        await room.click();

        await expect(page.getByText("Welcome to Family Chat!")).toBeVisible();
        await settle(page);

        // Send a message with a link (URL previews go through the homeserver, never the site itself).
        const composer = page.getByRole("textbox", { name: /Send a message|Send an unencrypted message/ });
        await composer.fill("Hello from the privacy test https://www.example.com/");
        await composer.press("Enter");
        await expect.poll(() => sentMessages.length).toBeGreaterThan(0);

        // Room info, then every user settings tab.
        await page.getByRole("button", { name: "Room info" }).last().click();
        await settle(page);
        // The room has a Jitsi widget pointing at meet.element.io; listing it must not load it.
        const extensions = page.getByRole("menuitem", { name: "Extensions" });
        if (await extensions.isVisible()) {
            await extensions.click();
            await settle(page);
        }
        await page.getByRole("button", { name: "User menu" }).click();
        await page.getByRole("menuitem", { name: "All settings" }).click();
        const dialog = page.getByRole("dialog");
        for (const tab of await dialog.getByRole("tab").all()) {
            await tab.click();
            await page.waitForTimeout(300);
        }
        await settle(page);

        console.log(report(capture));
        expect(capture.violations, report(capture)).toEqual([]);
        // Sanity check that the capture actually saw the app talking to the homeserver.
        expect(capture.requests.some((u) => new URL(u).host === HOMESERVER_HOST)).toBe(true);
    });
});

/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * Family Chat sign-in links: `https://app.safechat.family/?loginToken=<token>&hs=<host>` (see docs/config.md and
 * `docs/client-login-links.md` in unicornops/family-chat). The website's fallback page emits this for a control-panel
 * sign-in code; the client must redeem the token with `m.login.token` against `https://<hs>`.
 *
 * The family's homeserver is stood in for by routing `https://<FAMILY_HOST>/**` to the Synapse test container, so the
 * client really does select the host named by the link. The login token itself is a real one, minted through
 * Synapse's `POST /_matrix/client/v1/login/get_token` (`login_via_existing_session`), so a replay is really refused.
 */

import { type Page, type Route } from "@playwright/test";
import { type Config } from "@element-hq/element-web-playwright-common";
import { type SynapseConfig } from "@element-hq/element-web-playwright-common/lib/testcontainers/index.js";

import { expect, test } from "../../element-web-test";
import { isDendrite } from "../../plugins/homeserver/dendrite";

const FAMILY_HOST = "smith.family.test";

test.use({
    displayName: "Ana",
    config: {
        homeserver_allowlist: ["*.family.test"],
    } as Partial<Config>,
    synapseConfig: {
        login_via_existing_session: { enabled: true, require_ui_auth: false },
    } as Partial<SynapseConfig>,
});

/** Serve `https://<host>/**` from the homeserver container, so the link can name a host the way production does. */
async function impersonateHomeserver(page: Page, host: string, homeserverBaseUrl: string): Promise<void> {
    await page.route(`https://${host}/**`, async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const response = await page.request.fetch(`${homeserverBaseUrl}${url.pathname}${url.search}`, {
            method: request.method(),
            headers: Object.fromEntries(
                Object.entries(request.headers()).filter(([name]) => !["host", "origin"].includes(name.toLowerCase())),
            ),
            data: request.postDataBuffer() ?? undefined,
            timeout: 60_000, // /sync long-polls for 30s
            maxRedirects: 0,
        });
        await route.fulfill({ response });
    });
}

test.describe("Sign-in link with a login token", () => {
    test.skip(isDendrite, "needs Synapse's login_via_existing_session to mint a login token");

    test.beforeEach(async ({ page, homeserver }) => {
        await impersonateHomeserver(page, FAMILY_HOST, homeserver.baseUrl);
    });

    test("signs in against the homeserver named by hs, strips the token and refuses a replay", async ({
        page,
        credentials,
        request,
    }) => {
        // A one-time login token for the account, as the control panel would mint one
        const minted = await request.post(`${credentials.homeserverBaseUrl}/_matrix/client/v1/login/get_token`, {
            headers: { Authorization: `Bearer ${credentials.accessToken}` },
            data: {},
        });
        expect(minted.ok()).toBe(true);
        const { login_token: loginToken } = await minted.json();

        const loginRequests: string[] = [];
        page.on("request", (req) => {
            if (req.method() === "POST" && req.url().endsWith("/_matrix/client/v3/login"))
                loginRequests.push(req.url());
        });

        await page.goto(`/?loginToken=${encodeURIComponent(loginToken)}&hs=${FAMILY_HOST}`);

        // Straight into the app, no password prompt
        await expect(page.getByRole("heading", { name: `Welcome ${credentials.displayName}` })).toBeVisible({
            timeout: 30_000,
        });
        // The token went to the link's homeserver, nowhere else
        expect(loginRequests).toEqual([`https://${FAMILY_HOST}/_matrix/client/v3/login`]);
        // Both parameters are gone from the address bar
        const url = new URL(page.url());
        expect(url.searchParams.has("loginToken")).toBe(false);
        expect(url.searchParams.has("hs")).toBe(false);
        // The session is bound to the family's homeserver
        expect(await page.evaluate(() => window.mxMatrixClientPeg.get().getHomeserverUrl())).toBe(
            `https://${FAMILY_HOST}`,
        );

        // Replaying the same code (a fresh browser context, as another device would be) is refused
        const replay = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
        const replayPage = await replay.newPage();
        try {
            await impersonateHomeserver(replayPage, FAMILY_HOST, credentials.homeserverBaseUrl);
            await replayPage.goto(`/?loginToken=${encodeURIComponent(loginToken)}&hs=${FAMILY_HOST}`);

            const dialog = replayPage.getByRole("dialog");
            await expect(dialog.getByText("already been used or has expired")).toBeVisible({ timeout: 30_000 });
            await dialog.getByRole("button", { name: "OK" }).click();

            // and falls back to the password form on the family's homeserver, not the default one
            await replayPage.goto("/#/login");
            await expect(replayPage.getByText(FAMILY_HOST)).toBeVisible();
        } finally {
            await replay.close();
        }
    });

    test("does not send the token to a homeserver outside the allowlist", async ({ page }) => {
        const loginRequests: string[] = [];
        page.on("request", (req) => {
            if (req.method() === "POST" && req.url().endsWith("/_matrix/client/v3/login"))
                loginRequests.push(req.url());
        });
        await page.route("https://evil.example/**", (route) => route.abort());

        await page.goto("/?loginToken=not-for-you&hs=evil.example");

        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("This sign-in link is not valid")).toBeVisible({ timeout: 30_000 });
        expect(loginRequests).toEqual([]);
        expect(new URL(page.url()).searchParams.has("loginToken")).toBe(false);
    });
});

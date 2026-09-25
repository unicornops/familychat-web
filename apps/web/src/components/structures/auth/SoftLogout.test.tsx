/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "test-utils-rtl";
import fetchMock from "@fetch-mock/vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SoftLogout from "./SoftLogout";
import SdkConfig from "../../../SdkConfig";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import * as Lifecycle from "../../../Lifecycle";
import { type URLParams } from "../../../vector/url_utils";

describe("<SoftLogout /> with a Family Chat sign-in link", () => {
    const sessionHost = "smith.safechat.family";
    const sessionHsUrl = `https://${sessionHost}`;
    const sessionUserId = "@ana:smith.safechat.family";
    const loginToken = "test-login-token";
    const loginUrl = (host: string) => `https://${host}/_matrix/client/v3/login`;

    const client = {
        getHomeserverUrl: vi.fn().mockReturnValue(sessionHsUrl),
        getIdentityServerUrl: vi.fn().mockReturnValue(undefined),
        getUserId: vi.fn().mockReturnValue(sessionUserId),
        getDeviceId: vi.fn().mockReturnValue("SOFTDEVICE"),
        loginFlows: vi.fn().mockResolvedValue({ flows: [{ type: "m.login.password" }] }),
    } as unknown as MatrixClient;

    const renderSoftLogout = (legacySso: URLParams["legacy_sso"]) => {
        const onTokenLoginCompleted = vi.fn();
        render(
            <SoftLogout
                urlParams={{ legacy_sso: legacySso }}
                fragmentAfterLogin=""
                onTokenLoginCompleted={onTokenLoginCompleted}
            />,
        );
        return onTokenLoginCompleted;
    };

    const tokenLoginRequests = () => fetchMock.callHistory.calls("end:/_matrix/client/v3/login", { method: "POST" });

    beforeEach(() => {
        localStorage.setItem("mx_soft_logout", "true");
        // a stale SSO homeserver that a sign-in link must never be redeemed against
        localStorage.setItem("mx_sso_hs_url", "https://stale.sso.example");
        SdkConfig.put({ brand: "Family Chat", homeserver_allowlist: ["*.safechat.family"] });
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(client);
        vi.spyOn(Lifecycle, "hydrateSession").mockResolvedValue(client);
        fetchMock.clearHistory();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        SdkConfig.reset();
        localStorage.clear();
        fetchMock.removeRoutes();
    });

    it("redeems the token against the session's own homeserver and strips the params", async () => {
        fetchMock.postOnce(loginUrl(sessionHost), {
            user_id: sessionUserId,
            device_id: "SOFTDEVICE",
            access_token: "new-token",
        });

        const onTokenLoginCompleted = renderSoftLogout({ loginToken, hs: sessionHost });

        await waitFor(() => expect(Lifecycle.hydrateSession).toHaveBeenCalled());
        expect(tokenLoginRequests()).toHaveLength(1);
        expect(tokenLoginRequests()[0].url).toBe(loginUrl(sessionHost));
        expect(onTokenLoginCompleted).toHaveBeenCalled();
    });

    it.each([
        ["another allowlisted homeserver", { hs: "jones.safechat.family" }],
        ["a host outside the allowlist", { hs: "evil.example" }],
        ["a malformed hs", { hs: "https://smith.safechat.family" }],
        ["a login_hint for a different account", { hs: sessionHost, login_hint: "mxid:@bob:smith.safechat.family" }],
        ["a malformed login_hint", { hs: sessionHost, login_hint: "@ana:smith.safechat.family" }],
    ])("never sends the token when the link names %s, and strips the params", async (_label, params) => {
        const onTokenLoginCompleted = renderSoftLogout({ loginToken, ...params });

        await waitFor(() => expect(onTokenLoginCompleted).toHaveBeenCalled());
        expect(tokenLoginRequests()).toHaveLength(0);
        expect(Lifecycle.hydrateSession).not.toHaveBeenCalled();
        await expect(screen.findByText("This sign-in link is not valid.", { exact: false })).resolves.toBeVisible();
    });

    it("strips the params and offers the password form when the code is rejected", async () => {
        fetchMock.postOnce(loginUrl(sessionHost), {
            status: 403,
            body: { errcode: "M_FORBIDDEN", error: "Invalid login token" },
        });

        const onTokenLoginCompleted = renderSoftLogout({ loginToken, hs: sessionHost });

        await waitFor(() => expect(onTokenLoginCompleted).toHaveBeenCalled());
        expect(Lifecycle.hydrateSession).not.toHaveBeenCalled();
        await expect(
            screen.findByText("That sign-in code has already been used or has expired.", { exact: false }),
        ).resolves.toBeVisible();
        expect(screen.getByLabelText("Password")).toBeInTheDocument();
    });

    it("discards a session for a different account instead of wiping this one", async () => {
        fetchMock.postOnce(loginUrl(sessionHost), {
            user_id: "@bob:smith.safechat.family",
            device_id: "NEWDEVICE",
            access_token: "bobs-token",
        });
        fetchMock.postOnce(`${sessionHsUrl}/_matrix/client/v3/logout`, {});

        const onTokenLoginCompleted = renderSoftLogout({ loginToken, hs: sessionHost });

        await waitFor(() => expect(onTokenLoginCompleted).toHaveBeenCalled());
        expect(Lifecycle.hydrateSession).not.toHaveBeenCalled();
        expect(fetchMock.callHistory.calls(`${sessionHsUrl}/_matrix/client/v3/logout`)).toHaveLength(1);
        await expect(
            screen.findByText(`You're already signed in as ${sessionUserId} on this device.`, { exact: false }),
        ).resolves.toBeVisible();
    });
});

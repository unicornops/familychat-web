/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { describe, it, expect, afterEach } from "vitest";

import SdkConfig from "../SdkConfig";
import { parseLoginLinkHomeserver } from "./LoginLink";

describe("parseLoginLinkHomeserver", () => {
    afterEach(() => {
        SdkConfig.reset();
    });

    it("turns a bare host into an https base URL", () => {
        expect(parseLoginLinkHomeserver("smith.safechat.family")).toEqual({
            ok: true,
            host: "smith.safechat.family",
            url: "https://smith.safechat.family",
        });
    });

    it("lower-cases the host and keeps an explicit port", () => {
        expect(parseLoginLinkHomeserver(" Smith.SafeChat.Family:8448 ")).toEqual({
            ok: true,
            host: "smith.safechat.family",
            url: "https://smith.safechat.family:8448",
        });
    });

    it.each([
        undefined,
        null,
        "",
        "https://smith.safechat.family",
        "smith.safechat.family/path",
        "smith.safechat.family?x=1",
        "user@smith.safechat.family",
        "smith.safechat.family:0",
        "smith.safechat.family:70000",
        "smith.safechat.family:abc",
        "-smith.safechat.family",
        "smith safechat family",
        "smith.safechat.family\\evil",
    ])("rejects %j as malformed", (hs) => {
        expect(parseLoginLinkHomeserver(hs)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects hosts outside the configured allowlist", () => {
        SdkConfig.put({ homeserver_allowlist: ["*.safechat.family"] });
        expect(parseLoginLinkHomeserver("evil.example")).toEqual({ ok: false, reason: "not_allowed" });
        expect(parseLoginLinkHomeserver("safechat.family")).toEqual({ ok: false, reason: "not_allowed" });
        expect(parseLoginLinkHomeserver("smith.safechat.family").ok).toBe(true);
    });
});

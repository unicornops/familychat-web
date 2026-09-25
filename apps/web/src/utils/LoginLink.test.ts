/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { describe, it, expect, afterEach } from "vitest";

import SdkConfig from "../SdkConfig";
import { parseLoginLinkHint, parseLoginLinkHomeserver } from "./LoginLink";

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
        // a trailing dot names the same host in DNS but would slip past exact allowlist matching
        "smith.safechat.family.",
        "smith.safechat.family.:8448",
        // IDNs must arrive in their punycode (xn--) form
        "smíth.safechat.family",
        // IPv6 literals, bracketed or not
        "[::1]",
        "[::1]:8448",
        "::1",
        "[2001:db8::1]",
    ])("rejects %j as malformed", (hs) => {
        expect(parseLoginLinkHomeserver(hs)).toEqual({ ok: false, reason: "malformed" });
    });

    it("rejects hosts outside the configured allowlist", () => {
        SdkConfig.put({ homeserver_allowlist: ["*.safechat.family"] });
        expect(parseLoginLinkHomeserver("evil.example")).toEqual({ ok: false, reason: "not_allowed" });
        expect(parseLoginLinkHomeserver("safechat.family")).toEqual({ ok: false, reason: "not_allowed" });
        expect(parseLoginLinkHomeserver("smith.safechat.family").ok).toBe(true);
    });

    it("accepts the punycode form of an IDN under an allowlisted suffix", () => {
        SdkConfig.put({ homeserver_allowlist: ["*.safechat.family"] });
        expect(parseLoginLinkHomeserver("xn--smth-4na.safechat.family")).toEqual({
            ok: true,
            host: "xn--smth-4na.safechat.family",
            url: "https://xn--smth-4na.safechat.family",
        });
    });

    it("rejects an IPv4 address when an allowlist is configured", () => {
        SdkConfig.put({ homeserver_allowlist: ["*.safechat.family"] });
        expect(parseLoginLinkHomeserver("127.0.0.1")).toEqual({ ok: false, reason: "not_allowed" });
    });
});

describe("parseLoginLinkHint", () => {
    it("returns undefined when there is no hint", () => {
        expect(parseLoginLinkHint(undefined)).toBeUndefined();
        expect(parseLoginLinkHint(null)).toBeUndefined();
    });

    it.each([
        ["mxid:@ana:smith.safechat.family", "@ana:smith.safechat.family"],
        [" mxid:@ana:smith.example:8448 ", "@ana:smith.example:8448"],
    ])("parses %j", (hint, expected) => {
        expect(parseLoginLinkHint(hint)).toBe(expected);
    });

    it.each([
        "",
        "@ana:smith.safechat.family",
        "mxid:",
        "mxid:ana:smith.safechat.family",
        "mxid:@ana",
        "mxid:@a b:x",
        "email:a@b.c",
    ])("treats %j as malformed", (hint) => {
        expect(parseLoginLinkHint(hint)).toBeNull();
    });
});

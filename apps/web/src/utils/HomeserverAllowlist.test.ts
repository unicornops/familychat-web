/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { describe, it, expect, afterEach } from "vitest";

import SdkConfig from "../SdkConfig";
import {
    hostFromServerInput,
    hostMatchesPattern,
    homeserverNotAllowedMessage,
    isAllowedHomeserverHost,
    isAllowedHomeserverUrl,
    isValidHostname,
} from "./HomeserverAllowlist";

describe("HomeserverAllowlist", () => {
    afterEach(() => {
        SdkConfig.reset();
    });

    describe("isValidHostname", () => {
        it.each(["smith.safechat.family", "localhost", "a-b.c", "SMITH.SafeChat.Family"])("accepts %s", (host) => {
            expect(isValidHostname(host)).toBe(true);
        });

        it.each([
            "",
            "-smith.safechat.family",
            "smith_.safechat.family",
            "smith.safechat.family/",
            "a b",
            "x:8448",
            "@evil",
        ])("rejects %j", (host) => {
            expect(isValidHostname(host)).toBe(false);
        });
    });

    describe("hostMatchesPattern", () => {
        it("matches an exact host, ignoring case", () => {
            expect(hostMatchesPattern("Smith.safechat.family", "smith.SAFECHAT.family")).toBe(true);
            expect(hostMatchesPattern("smith.safechat.family", "jones.safechat.family")).toBe(false);
        });

        it("matches any subdomain for a wildcard, but not the bare suffix or a look-alike", () => {
            expect(hostMatchesPattern("smith.safechat.family", "*.safechat.family")).toBe(true);
            expect(hostMatchesPattern("deep.smith.safechat.family", "*.safechat.family")).toBe(true);
            expect(hostMatchesPattern("safechat.family", "*.safechat.family")).toBe(false);
            expect(hostMatchesPattern("evilsafechat.family", "*.safechat.family")).toBe(false);
            expect(hostMatchesPattern("smith.safechat.family.evil.example", "*.safechat.family")).toBe(false);
        });
    });

    describe("isAllowedHomeserverHost", () => {
        it("allows everything when no allowlist is configured", () => {
            expect(isAllowedHomeserverHost("matrix.org")).toBe(true);
            SdkConfig.put({ homeserver_allowlist: [] });
            expect(isAllowedHomeserverHost("matrix.org")).toBe(true);
        });

        it("only allows hosts matching an entry", () => {
            SdkConfig.put({ homeserver_allowlist: ["*.safechat.family", "matrix.example"] });
            expect(isAllowedHomeserverHost("smith.safechat.family")).toBe(true);
            expect(isAllowedHomeserverHost("matrix.example")).toBe(true);
            expect(isAllowedHomeserverHost("matrix.org")).toBe(false);
            expect(isAllowedHomeserverHost("safechat.family")).toBe(false);
        });

        it("ignores malformed allowlist entries", () => {
            SdkConfig.put({ homeserver_allowlist: [42, "", null, "*.safechat.family"] as unknown as string[] });
            expect(isAllowedHomeserverHost("smith.safechat.family")).toBe(true);
            expect(isAllowedHomeserverHost("matrix.org")).toBe(false);
        });
    });

    describe("isAllowedHomeserverUrl", () => {
        it("allows any URL when no allowlist is configured", () => {
            expect(isAllowedHomeserverUrl("http://matrix.org")).toBe(true);
            expect(isAllowedHomeserverUrl("not a url")).toBe(true);
        });

        it.each([
            ["https://smith.safechat.family", true],
            ["https://smith.safechat.family:8448/", true],
            ["https://SMITH.safechat.family", true],
            ["http://smith.safechat.family", false],
            ["https://smith.safechat.family.", false],
            ["https://matrix.org", false],
            ["https://smith.safechat.family.evil.example", false],
            ["https://[::1]", false],
            ["not a url", false],
            ["", false],
            [undefined, false],
        ])("with an allowlist, %j -> %j", (url, expected) => {
            SdkConfig.put({ homeserver_allowlist: ["*.safechat.family"] });
            expect(isAllowedHomeserverUrl(url)).toBe(expected);
        });
    });

    describe("hostFromServerInput", () => {
        it.each([
            ["smith.safechat.family", "smith.safechat.family"],
            ["  Smith.SafeChat.Family ", "smith.safechat.family"],
            ["smith.safechat.family:8448", "smith.safechat.family"],
            ["https://smith.safechat.family/", "smith.safechat.family"],
            ["http://user@evil.example/path?x=1", "evil.example"],
            ["", undefined],
            ["   ", undefined],
            ["https://", undefined],
        ])("%j -> %j", (input, expected) => {
            expect(hostFromServerInput(input)).toBe(expected);
        });
    });

    describe("homeserverNotAllowedMessage", () => {
        it("derives the example from a wildcard entry", () => {
            SdkConfig.put({ brand: "Family Chat", homeserver_allowlist: ["*.safechat.family"] });
            expect(homeserverNotAllowedMessage()).toBe(
                "Family Chat can only sign in to your family's own server, for example yourfamily.safechat.family.",
            );
        });

        it("uses an exact entry as the example", () => {
            SdkConfig.put({ brand: "Family Chat", homeserver_allowlist: ["matrix.example"] });
            expect(homeserverNotAllowedMessage()).toContain("for example matrix.example.");
        });
    });
});

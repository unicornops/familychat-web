/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import { type IClientWellKnown } from "matrix-js-sdk/src/matrix";

import { Jitsi } from "./Jitsi";
import SdkConfig from "../SdkConfig";
import { stubClient } from "test-utils";

describe("Jitsi", () => {
    afterEach(() => {
        SdkConfig.reset();
    });

    const start = (wellKnown: IClientWellKnown = {}): Jitsi => {
        const client = stubClient();
        client.getClientWellKnown = () => wellKnown;
        const jitsi = new Jitsi();
        jitsi.start();
        return jitsi;
    };

    it("has no default domain: never falls back to meet.element.io", async () => {
        const jitsi = start();
        await Promise.resolve();
        expect(jitsi.preferredDomain).toBe("");
        expect(await jitsi.getJitsiAuth()).toBeNull();
    });

    it("uses the domain from config.json", async () => {
        SdkConfig.put({ jitsi: { preferred_domain: "meet.safechat.family" } });
        const jitsi = start();
        await Promise.resolve();
        expect(jitsi.preferredDomain).toBe("meet.safechat.family");
    });

    it("prefers the homeserver's .well-known", async () => {
        SdkConfig.put({ jitsi: { preferred_domain: "meet.safechat.family" } });
        const jitsi = start({ "io.element.jitsi": { preferredDomain: "jitsi.example.safechat.family" } });
        await Promise.resolve();
        expect(jitsi.preferredDomain).toBe("jitsi.example.safechat.family");
    });
});

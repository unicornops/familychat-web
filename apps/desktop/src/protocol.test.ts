/*
Copyright 2026 Element Creations Ltd.
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { expect, describe, it, beforeEach, vi } from "vitest";
import { fs as memfs, vol } from "memfs";
import EventEmitter from "node:events";
import { app } from "electron";

import ProtocolHandler, { redactUrlForLog } from "./protocol.js";

const TEST_PROTOCOL = "test.proto";
const TEST_SESSION_ID = "test_session_id";
const USER_DATA_DIR = "/Users/name/Library/Application Support/Element";

vi.mock("node:fs", () => ({ default: memfs }));
vi.mock("electron", () => {
    const emitter = new EventEmitter();

    return {
        app: {
            isPackaged: true,
            getPath: vi.fn().mockReturnValue("/Users/name/Library/Application Support/Element"),
            getAppPath: vi.fn().mockReturnValue("/bin/element-desktop"),
            setAsDefaultProtocolClient: vi.fn(),
            on: emitter.on.bind(emitter),
            emit: emitter.emit.bind(emitter),
            removeAllListeners: emitter.removeAllListeners.bind(emitter),
        },
        ipcMain: {
            handle: vi.fn(),
        },
    };
});

beforeEach(() => {
    // Reset the state of the in-memory fs
    vol.reset();
    // Clear the event emitter
    app.removeAllListeners();
});

describe("ProtocolHandler", () => {
    beforeEach(() => {
        vol.fromJSON(
            {
                "./sso-sessions.json": JSON.stringify({ [TEST_SESSION_ID]: USER_DATA_DIR }),
            },
            USER_DATA_DIR,
        );
    });

    describe("getProfileFromDeeplink", () => {
        const handler = new ProtocolHandler(TEST_PROTOCOL);

        it("should handle legacy SSO URIs", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `element://vector/webapp/?element-desktop-ssoid=${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle OIDC URIs with response_mode=query", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true&code=DEADBEEF&state=foobar:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle OIDC URIs with response_mode=fragment", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true#code=DEADBEEF&state=foobar:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBe(USER_DATA_DIR);
        });

        it("should handle malformed OIDC URIs gracefully", () => {
            expect(
                handler.getProfileFromDeeplink([
                    "Element.app",
                    `${TEST_PROTOCOL}:/vector/webapp/?no_universal_links=true#code=DEADBEEF:element-desktop-ssoid:${TEST_SESSION_ID}`,
                ]),
            ).toBeUndefined();
        });

        it("should handle unrelated URIs gracefully", () => {
            expect(handler.getProfileFromDeeplink(["Element.app", `${TEST_PROTOCOL}:/vector/webapp/`])).toBeUndefined();
            expect(handler.getProfileFromDeeplink(["Element.app", `test.unrelated:/vector/webapp/`])).toBeUndefined();
        });
    });

    it.each(["darwin", "linux", "win32"] as const)("should handle deeplink on %s", (platform) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        vi.stubGlobal("mainWindow", {
            loadURL: vi.fn(),
        });

        const handler = new ProtocolHandler(TEST_PROTOCOL);
        expect(handler).toBeTruthy();

        const incomingUri = "test.proto:/#/room/#matrix:matrix.org";
        const expectedUri = "vector://vector/webapp/#/room/#matrix:matrix.org";

        if (platform === "darwin") {
            app.emit("open-url", new Event("test"), incomingUri);
        } else {
            app.emit("second-instance", new Event("test"), ["/path/to/app", incomingUri]);
        }

        expect(global.mainWindow!.loadURL).toHaveBeenCalledWith(expectedUri);
    });

    it("should safely deal with wrong protocol deeplinks", () => {
        vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
        vi.stubGlobal("mainWindow", {
            loadURL: vi.fn(),
        });

        const handler = new ProtocolHandler(TEST_PROTOCOL);
        expect(handler).toBeTruthy();

        app.emit("open-url", new Event("test"), "random.proto:/#/room/#matrix:matrix.org");

        expect(global.mainWindow!.loadURL).not.toHaveBeenCalled();
    });

    describe("initialise", () => {
        beforeEach(() => {
            vi.spyOn(process, "execPath", "get").mockReturnValue("/bin/element-desktop");
        });

        it("should set as default protocol client", () => {
            const handler = new ProtocolHandler(TEST_PROTOCOL);
            handler.initialise({
                userDataPath: USER_DATA_DIR,
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/bin/element-desktop"],
            });

            const args = ["--no-update"];
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith(TEST_PROTOCOL, "/bin/element-desktop", args);
            expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("element", "/bin/element-desktop", args);
        });

        it("should handle deeplink", () => {
            vi.stubGlobal("mainWindow", {
                loadURL: vi.fn(),
            });

            const handler = new ProtocolHandler(TEST_PROTOCOL);
            handler.initialise({
                userDataPath: "/data",
                devtools: false,
                update: false,
                hidden: false,
                positional: ["/bin/element-desktop", "test.proto:/#/room/#matrix:matrix.org"],
            });

            expect(global.mainWindow!.loadURL).toHaveBeenCalledWith("vector://vector/webapp/#/room/#matrix:matrix.org");
        });
    });

    describe("logging", () => {
        it("never logs a sign-in link's login token", () => {
            vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
            vi.stubGlobal("mainWindow", { loadURL: vi.fn() });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

            new ProtocolHandler(TEST_PROTOCOL);
            app.emit("open-url", new Event("test"), `${TEST_PROTOCOL}://vector/webapp/?loginToken=SECRET&hs=a.example`);

            expect(global.mainWindow!.loadURL).toHaveBeenCalledWith(
                "vector://vector/webapp/?loginToken=SECRET&hs=a.example",
            );
            for (const call of logSpy.mock.calls) {
                expect(JSON.stringify(call)).not.toContain("SECRET");
            }
            logSpy.mockRestore();
        });

        it.each([
            [
                "vector://vector/webapp/?loginToken=SECRET&hs=a.example",
                "vector://vector/webapp/?loginToken=%3Credacted%3E&hs=%3Credacted%3E",
            ],
            ["vector://vector/webapp/?code=SECRET#/home", "vector://vector/webapp/?code=%3Credacted%3E#/home"],
            [
                "vector://vector/webapp/?x=1#code=SECRET&state=s",
                "vector://vector/webapp/?x=%3Credacted%3E#%3Credacted%3E",
            ],
            ["vector://vector/webapp/#/room/!r:example.org", "vector://vector/webapp/#/room/!r:example.org"],
        ])("redacts %s", (input, expected) => {
            expect(redactUrlForLog(new URL(input))).toBe(expected);
        });
    });
});

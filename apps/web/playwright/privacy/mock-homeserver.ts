/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * A tiny in-process fake of the parts of the Matrix client-server API that Family Chat needs to sign
 * in, sync one room and send a message. It is served through Playwright's request interception, so the
 * network-allowlist test never needs Docker or a real homeserver and never touches the real network.
 */

import type { Route } from "@playwright/test";

export const USER_ID = "@kid:safechat.family";
export const PARENT_ID = "@parent:safechat.family";
export const ROOM_ID = "!family:safechat.family";
const ACCESS_TOKEN = "syt_privacy_test_token";
const DEVICE_ID = "PRIVACYTEST";

/** A 1x1 transparent PNG, served for every media download and thumbnail. */
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
);

let eventCounter = 0;

/** The client's own keys, so that a fresh sign-in can set up cross-signing and key backup. */
const accountData = new Map<string, unknown>();
const crypto: { deviceKeys?: object; crossSigning: Record<string, object>; backup?: object } = { crossSigning: {} };
const ts = Date.now() - 60_000;

function stateEvent(type: string, stateKey: string, content: object, sender = PARENT_ID): object {
    eventCounter++;
    return {
        type,
        state_key: stateKey,
        content,
        sender,
        event_id: `$state${eventCounter}`,
        origin_server_ts: ts + eventCounter,
    };
}

function timelineEvent(type: string, content: object, sender = PARENT_ID): object {
    eventCounter++;
    return { type, content, sender, event_id: `$event${eventCounter}`, origin_server_ts: ts + eventCounter };
}

/**
 * The first sync. Besides the basics, the room deliberately carries content that would make a stock
 * Element client reach third parties: a Jitsi widget pointing at meet.element.io (added by a family
 * member on another client), a location share (map tiles), an image (media) and a link (URL preview).
 */
function initialSync(): object {
    const state = [
        stateEvent("m.room.create", "", { creator: PARENT_ID, room_version: "10" }),
        stateEvent("m.room.member", PARENT_ID, { membership: "join", displayname: "Parent" }),
        stateEvent("m.room.member", USER_ID, { membership: "join", displayname: "Kid" }, USER_ID),
        stateEvent("m.room.power_levels", "", {
            users: { [PARENT_ID]: 100, [USER_ID]: 50 },
            users_default: 0,
            events_default: 0,
            state_default: 50,
        }),
        stateEvent("m.room.join_rules", "", { join_rule: "invite" }),
        stateEvent("m.room.history_visibility", "", { history_visibility: "shared" }),
        stateEvent("m.room.name", "", { name: "Family" }),
        stateEvent("im.vector.modular.widgets", "jitsi_privacy_test", {
            type: "jitsi",
            url: "https://meet.element.io/#/FamilyCall?conferenceDomain=meet.element.io",
            name: "Jitsi",
            data: { conferenceId: "FamilyCall", domain: "meet.element.io", isAudioOnly: false },
        }),
        stateEvent("io.element.widgets.layout", "", {
            widgets: { jitsi_privacy_test: { container: "top", index: 0, width: 100, height: 40 } },
        }),
    ];
    const timeline = [
        timelineEvent("m.room.message", { msgtype: "m.text", body: "Welcome to Family Chat!" }),
        timelineEvent("m.room.message", {
            msgtype: "m.text",
            body: "Look at this https://www.example.org/holiday-photos",
        }),
        timelineEvent("m.room.message", {
            msgtype: "m.image",
            body: "photo.png",
            url: "mxc://safechat.family/photo",
            info: { mimetype: "image/png", w: 1, h: 1, size: PNG.length },
        }),
        timelineEvent("m.room.message", {
            "msgtype": "m.location",
            "body": "Location geo:51.5008,0.1247",
            "geo_uri": "geo:51.5008,0.1247",
            "org.matrix.msc3488.location": { uri: "geo:51.5008,0.1247" },
            "org.matrix.msc3488.asset": { type: "m.self" },
            "org.matrix.msc1767.text": "Location geo:51.5008,0.1247",
            "org.matrix.msc3488.ts": ts,
        }),
    ];
    return {
        next_batch: "s1",
        account_data: { events: [] },
        presence: { events: [] },
        to_device: { events: [] },
        device_lists: { changed: [], left: [] },
        device_one_time_keys_count: { signed_curve25519: 50 },
        rooms: {
            join: {
                [ROOM_ID]: {
                    summary: { "m.joined_member_count": 2, "m.invited_member_count": 0 },
                    state: { events: state },
                    timeline: { events: timeline, limited: false, prev_batch: "p0" },
                    ephemeral: { events: [] },
                    account_data: { events: [] },
                    unread_notifications: { notification_count: 0, highlight_count: 0 },
                },
            },
            invite: {},
            leave: {},
        },
    };
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
    return route.fulfill({
        status,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(body),
    });
}

const notFound = (route: Route): Promise<void> => json(route, { errcode: "M_NOT_FOUND", error: "Not found" }, 404);
const unrecognised = (route: Route): Promise<void> =>
    json(route, { errcode: "M_UNRECOGNIZED", error: "Unrecognized request" }, 404);

/** Messages the test sent, so it can check that sending works end to end. */
export const sentMessages: unknown[] = [];

/**
 * Answer one request addressed to the homeserver. Anything not listed gets `M_UNRECOGNIZED`, which
 * the client treats as "the server does not support this".
 */
export async function handleHomeserverRequest(route: Route, url: URL): Promise<void> {
    const request = route.request();
    const method = request.method();
    const path = url.pathname;

    if (method === "OPTIONS") {
        return route.fulfill({
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            },
        });
    }

    if (path === "/.well-known/matrix/client") {
        return json(route, { "m.homeserver": { base_url: "https://matrix.safechat.family" } });
    }
    if (path === "/_matrix/client/versions") {
        return json(route, {
            versions: [
                "v1.1",
                "v1.2",
                "v1.3",
                "v1.4",
                "v1.5",
                "v1.6",
                "v1.7",
                "v1.8",
                "v1.9",
                "v1.10",
                "v1.11",
                "v1.12",
            ],
            unstable_features: {},
        });
    }
    if (path.endsWith("/login") && method === "GET") {
        return json(route, { flows: [{ type: "m.login.password" }] });
    }
    if (path.endsWith("/login") && method === "POST") {
        return json(route, {
            user_id: USER_ID,
            access_token: ACCESS_TOKEN,
            device_id: DEVICE_ID,
            home_server: "safechat.family",
        });
    }
    if (path.endsWith("/account/whoami")) {
        return json(route, { user_id: USER_ID, device_id: DEVICE_ID });
    }
    if (path.endsWith("/capabilities")) {
        return json(route, { capabilities: { "m.change_password": { enabled: true } } });
    }
    if (path.endsWith("/pushrules/")) {
        return json(route, { global: { override: [], content: [], room: [], sender: [], underride: [] } });
    }
    if (/\/user\/[^/]+\/filter$/.test(path)) {
        return json(route, { filter_id: "1" });
    }
    if (/\/user\/[^/]+\/filter\/[^/]+$/.test(path)) {
        return json(route, {});
    }
    if (path.endsWith("/sync")) {
        const since = url.searchParams.get("since");
        if (!since) return json(route, initialSync());
        // Behave like a long poll so the client does not spin.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return json(route, { next_batch: since });
    }
    if (path.endsWith("/keys/upload")) {
        const body = request.postDataJSON() ?? {};
        if (body.device_keys) crypto.deviceKeys = body.device_keys;
        return json(route, { one_time_key_counts: { signed_curve25519: 50 } });
    }
    if (path.endsWith("/keys/query")) {
        const forUser = <T>(value: T | undefined): Record<string, T> => (value ? { [USER_ID]: value } : {});
        return json(route, {
            device_keys: forUser(crypto.deviceKeys ? { [DEVICE_ID]: crypto.deviceKeys } : undefined),
            master_keys: forUser(crypto.crossSigning["master_key"]),
            self_signing_keys: forUser(crypto.crossSigning["self_signing_key"]),
            user_signing_keys: forUser(crypto.crossSigning["user_signing_key"]),
            failures: {},
        });
    }
    if (path.endsWith("/keys/claim")) {
        return json(route, { one_time_keys: {}, failures: {} });
    }
    if (path.endsWith("/keys/device_signing/upload")) {
        Object.assign(crypto.crossSigning, request.postDataJSON() ?? {});
        return json(route, {});
    }
    if (path.endsWith("/keys/signatures/upload")) {
        return json(route, { failures: {} });
    }
    if (path.endsWith("/room_keys/version") && method === "POST") {
        crypto.backup = { ...request.postDataJSON(), version: "1", count: 0, etag: "0" };
        return json(route, { version: "1" });
    }
    if (path.includes("/room_keys/version")) {
        return crypto.backup ? json(route, crypto.backup) : notFound(route);
    }
    if (path.includes("/room_keys/keys")) {
        return json(route, method === "PUT" ? { count: 0, etag: "0" } : { rooms: {} });
    }
    if (/\/user\/[^/]+\/(rooms\/[^/]+\/)?account_data\//.test(path)) {
        if (method === "PUT") {
            accountData.set(path, request.postDataJSON());
            return json(route, {});
        }
        return accountData.has(path) ? json(route, accountData.get(path)) : notFound(route);
    }
    if (/\/profile\/[^/]+/.test(path)) {
        const userId = decodeURIComponent(path.split("/profile/")[1].split("/")[0]);
        return json(route, { displayname: userId === USER_ID ? "Kid" : "Parent" });
    }
    if (path.endsWith("/devices")) {
        return json(route, { devices: [{ device_id: DEVICE_ID, display_name: "Family Chat Web" }] });
    }
    if (path.endsWith("/joined_rooms")) {
        return json(route, { joined_rooms: [ROOM_ID] });
    }
    if (/\/rooms\/[^/]+\/members$/.test(path) || /\/rooms\/[^/]+\/joined_members$/.test(path)) {
        return json(route, { chunk: [], joined: {} });
    }
    if (/\/rooms\/[^/]+\/messages$/.test(path)) {
        return json(route, { chunk: [], start: "p0" });
    }
    if (/\/rooms\/[^/]+\/send\/[^/]+\/[^/]+$/.test(path)) {
        sentMessages.push(request.postDataJSON());
        eventCounter++;
        return json(route, { event_id: `$sent${eventCounter}` });
    }
    if (/\/rooms\/[^/]+\/(read_markers|receipt\/.+|typing\/.+)$/.test(path)) {
        return json(route, {});
    }
    if (path.includes("/media/") && (path.includes("/download/") || path.includes("/thumbnail/"))) {
        return route.fulfill({
            status: 200,
            contentType: "image/png",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: PNG,
        });
    }
    if (path.includes("/media/preview_url")) {
        return json(route, { "og:title": "Holiday photos" });
    }
    if (path.includes("/media/config")) {
        return json(route, { "m.upload.size": 50_000_000 });
    }
    if (path.endsWith("/voip/turnServer")) {
        return json(route, {});
    }
    if (path.endsWith("/thirdparty/protocols")) {
        return json(route, {});
    }
    if (path.endsWith("/presence/" + encodeURIComponent(USER_ID) + "/status")) {
        return json(route, method === "GET" ? { presence: "online" } : {});
    }
    if (path.endsWith("/logout")) {
        return json(route, {});
    }
    if (process.env.PRIVACY_TEST_DEBUG) console.log("mock homeserver: unhandled", method, path);
    return unrecognised(route);
}

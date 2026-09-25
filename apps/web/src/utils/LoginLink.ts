/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { createClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { isAllowedHomeserverHost, isValidHostname } from "./HomeserverAllowlist";

/**
 * The `hs` parameter of a Family Chat sign-in link (`docs/client-login-links.md` in unicornops/family-chat).
 *
 * The control panel's QR code opens `https://safechat.family/app/login?…&hs=<host>&token=<login token>`;
 * the website's fallback page forwards a browser to this app as `/?loginToken=<token>&hs=<host>`. `hs` is
 * the bare hostname (optionally `:port`) that answers the client-server API for the family's homeserver,
 * and the token must be redeemed against `https://<hs>` with `m.login.token`.
 */
export type LoginLinkHomeserver =
    | { ok: true; host: string; url: string }
    | { ok: false; reason: "malformed" | "not_allowed" };

const HOST_PORT_RE = /^([^\s:/?#@\\]+)(?::(\d{1,5}))?$/;

/**
 * Validate the `hs` parameter of a sign-in link and turn it into the homeserver base URL. The scheme is
 * always https: a link can name a host, never a URL, so it cannot downgrade the transport or add a path.
 * The host must also pass the configured `homeserver_allowlist`.
 */
export function parseLoginLinkHomeserver(hs: string | undefined | null): LoginLinkHomeserver {
    const match = (hs ?? "").trim().match(HOST_PORT_RE);
    if (!match) return { ok: false, reason: "malformed" };

    const host = match[1].toLowerCase();
    const port = match[2];
    if (!isValidHostname(host)) return { ok: false, reason: "malformed" };
    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return { ok: false, reason: "malformed" };
    if (!isAllowedHomeserverHost(host)) return { ok: false, reason: "not_allowed" };

    return { ok: true, host, url: `https://${host}${port ? `:${port}` : ""}` };
}

/** A full Matrix user ID: `@localpart:server`, where server may carry a port or be an IPv6 literal. */
const MXID_RE = /^@[^\s:]+:[^\s/?#@\\]+$/;

/**
 * The optional `login_hint` of a sign-in link, in the contract's `mxid:<full Matrix ID>` form. Returns the
 * Matrix ID, `undefined` when the link has no hint, or `null` when a hint is present but malformed (the link
 * is then treated as invalid rather than redeemed without the check the hint asks for).
 */
export function parseLoginLinkHint(hint: string | undefined | null): string | undefined | null {
    if (hint === undefined || hint === null) return undefined;
    const value = hint.trim();
    if (!value.startsWith("mxid:")) return null;
    const mxid = value.slice("mxid:".length);
    return MXID_RE.test(mxid) ? mxid : null;
}

/**
 * Log out a session a sign-in link created but that must not be used (it signed in to a different account from
 * the one expected), so it does not linger as a device on that account. Best effort: failures are only logged.
 */
export async function discardLoginLinkSession(hsUrl: string, accessToken: string): Promise<void> {
    try {
        await createClient({ baseUrl: hsUrl, accessToken }).logout(true);
    } catch (e) {
        logger.warn("Failed to discard the sign-in link's session:", (e as { errcode?: string })?.errcode ?? e);
    }
}

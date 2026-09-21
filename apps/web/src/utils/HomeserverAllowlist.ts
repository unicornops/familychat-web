/*
Copyright 2026 Unicorn Operations Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import SdkConfig from "../SdkConfig";
import { _t } from "../languageHandler";

/**
 * Family Chat runs one homeserver per family under `<slug>.safechat.family`. The `homeserver_allowlist`
 * config option restricts which hosts this client will sign in to, both through the server picker and
 * through the `hs` parameter of a sign-in link, so that a typo or a crafted link cannot send a password or
 * a one-time sign-in code to a server we do not run.
 *
 * Each entry is a hostname. A leading `*.` matches any subdomain (one or more labels). Matching ignores
 * case. An empty or absent list allows every host, which is upstream Element's behaviour.
 */

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${HOSTNAME_LABEL}\\.)*${HOSTNAME_LABEL}$`, "i");

/** Whether `host` is a syntactically valid DNS hostname (no scheme, port, path or userinfo). */
export function isValidHostname(host: string): boolean {
    return host.length > 0 && host.length <= 253 && HOSTNAME_RE.test(host);
}

/** Whether `host` matches one allowlist entry: an exact host, or `*.suffix` for any subdomain of `suffix`. */
export function hostMatchesPattern(host: string, pattern: string): boolean {
    const h = host.toLowerCase();
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) {
        const suffix = p.slice(1); // keep the leading dot so `evilsafechat.family` does not match
        return h.length > suffix.length && h.endsWith(suffix);
    }
    return h === p;
}

/** The configured allowlist, with anything that is not a non-empty string dropped. */
export function getHomeserverAllowlist(): string[] {
    const list: unknown = SdkConfig.get("homeserver_allowlist");
    if (!Array.isArray(list)) return [];
    return list.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/** Whether this client may sign in to `host` (a bare hostname). True when no allowlist is configured. */
export function isAllowedHomeserverHost(host: string): boolean {
    const allowlist = getHomeserverAllowlist();
    if (allowlist.length === 0) return true;
    return allowlist.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * The hostname of whatever was typed into the server picker: a server name, a `host:port`, or a full URL.
 * Returns undefined when it cannot be parsed, in which case the picker's own validation reports it.
 */
export function hostFromServerInput(input: string): string | undefined {
    const value = input.trim();
    if (!value) return undefined;
    try {
        const url = new URL(value.includes("://") ? value : `https://${value}`);
        return url.hostname ? url.hostname.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * User-facing explanation for a rejected host, with an example built from the first allowlist entry
 * (`*.safechat.family` becomes `yourfamily.safechat.family`).
 */
export function homeserverNotAllowedMessage(): string {
    const [first] = getHomeserverAllowlist();
    const example = first?.startsWith("*.") ? `yourfamily${first.slice(1)}` : first;
    return _t("auth|server_picker_not_allowed", { brand: SdkConfig.get().brand, example });
}

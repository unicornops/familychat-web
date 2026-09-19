/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2022 The Matrix.org Foundation C.I.C.
Copyright 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { mergeWith } from "lodash";
import { type DeepReadonly } from "shared-types";

import { SnakedObject } from "./utils/SnakedObject";
import { type IConfigOptions, type ConfigOptions } from "./IConfigOptions";
import { isObject, objectClone } from "./utils/objects";
import ElementDesktopLogoSvg from "../res/img/element-desktop-logo.svg";

// see element-web config.md for docs, or the IConfigOptions interface for dev docs
export const DEFAULTS = {
    brand: "Family Chat",
    branding: {
        logo_link_url: "https://safechat.family",
        auth_header_logo_url: "themes/element/img/logos/element-logo.svg",
        welcome_background_url: "themes/element/img/backgrounds/welcome.jpg",
    },
    help_url: "https://safechat.family/docs/",
    help_encryption_url: "https://safechat.family/docs/faq/",
    help_key_storage_url: "https://safechat.family/docs/faq/",
    // Integration managers are disabled for Family Chat: no default is set, and config.json sets
    // integrations_ui_url/integrations_rest_url to null, so no third-party service is contacted.
    show_labs_settings: false,
    force_verification: false,
    enable_client_well_known_lookups: true,

    jitsi: {
        // Jitsi conferencing is disabled for Family Chat (see UIFeature.voip in config.json).
        preferred_domain: "",
    },
    // Element Call is disabled in config.json (`element_call.disable`); the brand string is only
    // used if something re-enables it.
    element_call: {
        brand: "Element Call",
    },

    // @ts-ignore - we deliberately use the camelCase version here so we trigger
    // the fallback behaviour. If we used the snake_case version then we'd break
    // everyone's config which has the camelCase property because our default would
    // be preferred over their config.
    desktopBuilds: {
        available: false,
        logo: ElementDesktopLogoSvg,
        url: "https://safechat.family/docs/guides/matrix-client-setup/",
    },

    feedback: {
        existing_issues_url: "https://safechat.family/docs/faq/",
        new_issue_url: "https://safechat.family/docs/faq/",
    },

    desktop_builds: {
        available: false,
        logo: "vector-icons/1024.png",
        url: "https://safechat.family/docs/guides/matrix-client-setup/",
    },
    // Family Chat has no published mobile apps yet, so no download URLs are defaulted here and
    // config.json sets them to null. See unicornops/family-chat#233 and #234.
} satisfies ConfigOptions;

export type { ConfigOptions };

function mergeConfig(
    config: DeepReadonly<IConfigOptions>,
    changes: DeepReadonly<ConfigOptions>,
): DeepReadonly<IConfigOptions> {
    // return { ...config, ...changes };
    return mergeWith(objectClone(config), changes, (objValue, srcValue) => {
        // Don't merge arrays, prefer values from newer object
        if (Array.isArray(objValue)) {
            return srcValue;
        }

        // Don't allow objects to get nulled out, this will break our types
        if (isObject(objValue) && !isObject(srcValue)) {
            return objValue;
        }
    });
}

type ObjectType<K extends keyof IConfigOptions> = IConfigOptions[K] extends object
    ? SnakedObject<NonNullable<IConfigOptions[K]>>
    : SnakedObject<NonNullable<IConfigOptions[K]>> | null | undefined;

// oxlint-disable-next-line typescript/no-extraneous-class
export default class SdkConfig {
    private static instance: DeepReadonly<IConfigOptions>;
    private static fallback: SnakedObject<DeepReadonly<IConfigOptions>>;

    private static setInstance(i: DeepReadonly<IConfigOptions>): void {
        SdkConfig.instance = i;
        SdkConfig.fallback = new SnakedObject(i);

        // For debugging purposes
        window.mxReactSdkConfig = i;
    }

    public static get(): IConfigOptions;
    public static get<K extends keyof IConfigOptions>(key: K, altCaseName?: string): IConfigOptions[K];
    public static get<K extends keyof IConfigOptions = never>(
        key?: K,
        altCaseName?: string,
    ): DeepReadonly<IConfigOptions> | DeepReadonly<IConfigOptions>[K] {
        if (key === undefined) {
            // safe to cast as a fallback - we want to break the runtime contract in this case
            return SdkConfig.instance || <IConfigOptions>{};
        }
        return SdkConfig.fallback.get(key, altCaseName);
    }

    public static getObject<K extends keyof IConfigOptions>(key: K, altCaseName?: string): ObjectType<K> {
        const val = SdkConfig.get(key, altCaseName);
        if (isObject(val)) {
            return new SnakedObject(val);
        }

        // return the same type for sensitive callers (some want `undefined` specifically)
        return (val === undefined ? undefined : null) as ObjectType<K>;
    }

    public static put(cfg: DeepReadonly<ConfigOptions>): void {
        SdkConfig.setInstance(mergeConfig(DEFAULTS, cfg));
    }

    /**
     * Resets the config.
     */
    public static reset(): void {
        SdkConfig.setInstance(mergeConfig(DEFAULTS, {})); // safe to cast - defaults will be applied
    }

    public static add(cfg: DeepReadonly<ConfigOptions>): void {
        SdkConfig.put(mergeConfig(SdkConfig.get(), cfg));
    }
}

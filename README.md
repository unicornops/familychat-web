![Build](https://github.com/unicornops/familychat-web/actions/workflows/build.yml/badge.svg?branch=familychat)
![Tests](https://github.com/unicornops/familychat-web/actions/workflows/tests.yml/badge.svg?branch=familychat)
![Static Analysis](https://github.com/unicornops/familychat-web/actions/workflows/static_analysis.yaml/badge.svg?branch=familychat)

# Family Chat (web & desktop)

Family Chat is the web and desktop client for [Family Chat](https://safechat.family), a managed
[Matrix](https://matrix.org) service that gives each family its own private homeserver.

It is a fork of [Element Web](https://github.com/element-hq/element-web) by Element, used and
distributed under the AGPL-3.0. Everything that makes it a Matrix client is Element's work; what
this repository adds is the Family Chat branding, configuration and packaging.

- Web client: <https://app.safechat.family> (hosted on Cloudflare Pages)
- Desktop app: Windows, macOS and Linux via Electron, in [`apps/desktop`](https://github.com/unicornops/familychat-web/tree/familychat/apps/desktop)
- Marketing site and docs: <https://safechat.family>
- Control panel: <https://panel.safechat.family>
- Issues and planning live in [unicornops/family-chat](https://github.com/unicornops/family-chat), not here.

## Provenance

|                |                                                                     |
| -------------- | ------------------------------------------------------------------- |
| Upstream       | [element-hq/element-web](https://github.com/element-hq/element-web) |
| Forked at      | tag `v1.12.28`                                                      |
| Default branch | `familychat`                                                        |
| Licence        | AGPL-3.0-only (see [Copyright & licence](#copyright--licence))      |

`element-hq/element-desktop` was archived in March 2026 and merged into `element-web`, so this one
repository builds the browser app and all three desktop platforms.

## What we changed

- **Branding.** Name, logo, favicon, PWA icons, desktop icons, welcome page and colours are Family
  Chat's. No Element logo, wordmark or marketing copy is shipped.
- **Configuration.** `apps/web/familychat/config.json` and `apps/desktop/familychat/config.json`
  replace upstream's `element.io/` config directories.
- **Third-party services removed.** No PostHog, no Sentry, no rageshake endpoint, no MapTiler, no
  integration manager, no Jitsi, no Element Call, no `mobile.element.io` redirect. See
  [Third-party services](#third-party-services).
- **Packaging.** Application id `family.safechat.desktop`, product name "Family Chat", executable
  and Debian package `familychat`, protocol handler `familychat://`.

The diff against upstream is kept deliberately small so that merging upstream releases stays cheap.
Prefer `config.json`, [skinning](docs/skinning.md) and [theming](docs/theming.md) over code changes.

## Building

Node is pinned in [`.node-version`](https://github.com/unicornops/familychat-web/blob/familychat/.node-version) and pnpm in `devEngines` in
[`package.json`](https://github.com/unicornops/familychat-web/blob/familychat/package.json).

```sh
pnpm install

# Web app -> apps/web/webapp
cp apps/web/familychat/config.json apps/web/config.json
pnpm --filter familychat-web build
```

Serve `apps/web/webapp` with any static file host. Deployment notes are in
[docs/install.md](docs/install.md); the Cloudflare Pages setup for `app.safechat.family` is tracked
in [unicornops/family-chat#235](https://github.com/unicornops/family-chat/issues/235).

### Desktop

The desktop app wraps a built web app. Build the web app first, then:

```sh
cd apps/desktop
cp -r ../web/webapp ./webapp
pnpm run asar-webapp
mkdir -p .hak/hakModules      # skip the native modules (no encrypted search / secure storage)
pnpm run build -- -l tar.gz deb --publish never
```

Artifacts land in `apps/desktop/dist`. `VARIANT_PATH` selects the electron-builder variant and
defaults to [`apps/desktop/familychat/build.json`](https://github.com/unicornops/familychat-web/blob/familychat/apps/desktop/familychat/build.json).

Do **not** use `pnpm run fetch`: it still downloads Element's release tarball from
`github.com/element-hq`. Build the web app in-tree instead.

Optionally [build the native modules](docs/native-node-modules.md) (`matrix-seshat` for encrypted
search, sqlcipher for secure storage). CI does not, so CI artifacts are built without them.

## Keeping up with upstream

Upstream ships roughly weekly. We merge upstream release tags into `familychat` on a **fortnightly**
cadence, so we are at most one release behind.

```sh
# one-off
git remote add upstream https://github.com/element-hq/element-web.git
git remote set-url --push upstream DISABLED   # never push to element-hq

# each cycle
git fetch upstream --tags
git switch familychat && git pull
git switch -c chore/merge-upstream-vX.Y.Z
git merge vX.Y.Z
# resolve conflicts, then
pnpm install && pnpm lint && pnpm test:unit
pnpm --filter familychat-web build
```

Conflicts cluster in a small, predictable set of files:

| File                                                  | Why it conflicts                                |
| ----------------------------------------------------- | ----------------------------------------------- |
| `apps/web/src/SdkConfig.ts`                           | our `DEFAULTS` replace Element's hosts          |
| `apps/web/src/vector/index.html`, `res/manifest.json` | title, icons, theme colour                      |
| `apps/web/webpack.config.ts`                          | `welcome/**` copy pattern, removed mobile guide |
| `apps/desktop/electron-builder.ts`                    | variant path, deb recommends                    |
| `apps/web/src/i18n/strings/en_EN.json`                | rebranded English strings                       |
| `.github/workflows/**`                                | we deleted most upstream workflows              |
| `package.json`, `apps/*/package.json`                 | names, homepage, licence                        |

Open the merge as a PR against `familychat`; never push to `element-hq`.

## Third-party services

Family Chat must not send family content or metadata to anyone but us. This build contacts:

- the family's own homeserver (`<slug>.safechat.family`, or their custom domain),
- `safechat.family` / `panel.safechat.family` for help, legal and control-panel links,
- `matrix.org` only for the "Powered by Matrix" link in the login footer (a link, not a request).

Removed or disabled relative to upstream: PostHog analytics, Sentry, the rageshake bug-report
endpoint, MapTiler map tiles and location sharing, the Scalar integration manager, Jitsi, Element
Call, the `mobile.element.io` mobile guide and its redirect, and the `packages.element.io` /
`element.io` download links. A full audit is tracked in
[unicornops/family-chat#235](https://github.com/unicornops/family-chat/issues/235) §2 and §7.

## Placeholders

These are not yet real and must be settled before the client is handed to families:

- `default_server_config` in both `config.json` files points at `https://matrix.safechat.family`,
  which **does not exist**. Every family has its own homeserver (`<slug>.safechat.family`), and
  `safechat.family` does not serve `/.well-known/matrix/client`. Combined with
  `disable_custom_urls: true`, nobody can sign in until either a real default homeserver exists or
  QR/link login ([unicornops/family-chat#236](https://github.com/unicornops/family-chat/issues/236))
  lands and carries the homeserver in the link.
- `update_base_url` points at `https://packages.safechat.family/desktop/update/`, which is not
  hosted yet.
- Icons are generated from the website favicon and are "good enough for now", not a designed icon set.
- Nothing is code-signed. macOS notarisation and Windows Azure Artifact Signing are tracked in
  [unicornops/family-chat#235](https://github.com/unicornops/family-chat/issues/235) §8.

## Development

1. [Developer guide](./developer_guide.md)
2. [Code style](./code_style.md)
3. [Contribution guide](./CONTRIBUTING.md)

Commits follow Conventional Commits. Pull requests target `familychat`.

Translations are not wired up: Localazy is Element's, and our `localazy.json` was removed. Change the
English source strings in `apps/web/src/i18n/strings/en_EN.json` and
`apps/desktop/src/i18n/strings/en_EN.json`; the other locales are inherited from upstream.

## Monorepo

This repository is a monorepo. The structure is described in [docs/monorepo.md](docs/monorepo.md);
the branch model there is Element's, ours is `familychat` plus feature branches.

- `apps/web` — the browser app ([README](apps/web/README.md))
- `apps/desktop` — the Electron app ([README](apps/desktop/README.md))
- `packages`, `modules` — libraries and optional modules maintained upstream

## Copyright & licence

Copyright (c) 2014-2017 OpenMarket Ltd
Copyright (c) 2017 Vector Creations Ltd
Copyright (c) 2017-2026 New Vector Ltd / Element Creations Ltd
Copyright (c) 2026 Unicorn Operations Ltd

Upstream Element Web is multi-licensed by Element under AGPL-3.0, GPL-3.0 or a paid Element
Commercial Licence, and the source files keep their original
`SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial` headers.

**Family Chat takes the AGPL-3.0 option and distributes this fork under AGPL-3.0-only.** Element's
commercial licence is Element's offer to make, not ours, so `LICENSE-COMMERCIAL` has been removed
from this repository; if you want a commercial licence for the upstream code, talk to Element.

Unless required by applicable law or agreed to in writing, software distributed under the Licences
is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied. See [LICENSE-AGPL-3.0](https://github.com/unicornops/familychat-web/blob/familychat/LICENSE-AGPL-3.0) for the specific language governing permissions
and limitations.

Element, Element X, the Element logo and the Element name are trademarks of Element; this project is
not affiliated with or endorsed by Element.

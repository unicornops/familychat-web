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
| Last merged    | tag `v1.12.30`                                                      |
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
pnpm run build -l tar.gz deb --publish never
```

Artifacts land in `apps/desktop/dist`. `VARIANT_PATH` selects the electron-builder variant and
defaults to [`apps/desktop/familychat/build.json`](https://github.com/unicornops/familychat-web/blob/familychat/apps/desktop/familychat/build.json).

Upstream's `pnpm run fetch`, which downloaded Element's release tarball from `github.com/element-hq`,
has been removed. Always build the web app in-tree.

Encrypted search uses the prebuilt [`@matrix-org/seshat`](docs/native-node-modules.md) binaries,
which `pnpm install` fetches; there is no native build step any more.

## Keeping up with upstream

Upstream ships roughly weekly, and we merge every **stable** release tag (`vX.Y.Z`; not `-rc` tags, not
`module/*` or other package tags) into `familychat`. Merge the tag, never rebase: `familychat` is public, and
every release must map to a tag. Merge the pull request with a merge commit, never squash.

### Automated sync

[`.github/workflows/upstream-sync.yml`](https://github.com/unicornops/familychat-web/blob/familychat/.github/workflows/upstream-sync.yml) runs daily (and on manual
dispatch) and does the merge below for the newest stable upstream release, using
[`upstream-sync.sh`](https://github.com/unicornops/familychat-web/blob/familychat/.github/workflows/scripts/upstream-sync.sh):

- A merge that is clean, or that only hits the conflicts the fork's fixed rules settle, is pushed to
  `upstream/vX.Y.Z` with a pull request titled `chore(upstream): merge element-hq/element-web vX.Y.Z`. It
  lists what was resolved automatically and the files both sides changed, and carries the per-merge
  checklist. It is never merged automatically.
- The fixed rules: upstream edits to files the fork deleted (workflows, `labels.yml`, the mobile guide,
  `element.io/` configs, …) keep the deletion; `CODEOWNERS`, this README and the branding images and
  favicon baselines keep ours; conflict hunks in `package.json` files and `pnpm-workspace.yaml` are merged
  line by line when each line changed on one side only (our name next to upstream's version bump, our
  extra dependency next to upstream's bumped one), by
  [`upstream-sync-resolve.py`](https://github.com/unicornops/familychat-web/blob/familychat/.github/workflows/scripts/upstream-sync-resolve.py); and `pnpm-lock.yaml`
  is regenerated with `pnpm install --lockfile-only --ignore-scripts`. Workflows new in the release are
  dropped in a second commit.
- Any other conflict pushes nothing: the workflow opens or updates an issue labelled `upstream-sync`
  with the conflicting paths, what it would have resolved, and the commands to reproduce the merge.
- When the release notes mention a security fix, or an upstream GHSA advisory is patched in that
  release, the pull request or issue is also labelled `security` and pings the CODEOWNERS.

It runs in the `upstream-sync` environment (deployments from `familychat` only), which holds
`UPSTREAM_SYNC_TOKEN`: a fine-grained token for this repository only, with read and write access to
contents, pull requests and issues. `GITHUB_TOKEN` cannot be used, because its pushes do not trigger
CI on the pull request. A manual dispatch defaults to a dry run, which writes the pull request or
issue it would open to the job summary. The script also runs locally from a clean checkout (it needs
`gh` logged in, `jq`, `python3`, and `pnpm` to regenerate the lockfile; it switches the checkout to
the merge branch):

```sh
GITHUB_REPOSITORY=unicornops/familychat-web DRY_RUN=true TAG=vX.Y.Z \
  .github/workflows/scripts/upstream-sync.sh
```

### Merging by hand

When the sync opens an issue instead of a pull request, or to merge a release yourself:

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

Conflicts cluster in a small, predictable set of files. Keep this list current after every merge
(it mirrors [#4](https://github.com/unicornops/familychat-web/issues/4)). Always keep our values, and read
upstream's diff for _new_ configuration keys or code paths that need a Family Chat answer.

| File                                                                                                  | Why it conflicts                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/familychat/config.json`, `apps/desktop/familychat/`                                         | our config; upstream edits `element.io/` instead, so check it for new keys                                                                                                        |
| `apps/web/src/SdkConfig.ts`, `IConfigOptions.ts`                                                      | our `DEFAULTS` replace Element's hosts; `homeserver_allowlist`                                                                                                                    |
| `apps/web/src/Lifecycle.ts`, `Login.ts`, `MatrixChat.tsx`, `SoftLogout.tsx`, `Login.tsx`              | sign-in link redemption (`attemptLoginLinkTokenLogin`); upstream refactors the imports and token storage here                                                                     |
| `ServerPickerDialog.tsx`, `utils/HomeserverAllowlist.ts`, `utils/LoginLink.ts`, `vector/url_utils.ts` | the homeserver allowlist and sign-in links                                                                                                                                        |
| `apps/desktop/src/protocol.ts`                                                                        | `familychat://` and deeplink log redaction                                                                                                                                        |
| `apps/desktop/electron-builder.ts`, `apps/desktop/package.json`                                       | variant path, `publish: null`, deb `recommends`, names                                                                                                                            |
| `apps/web/src/vector/index.html`, `res/manifest.json`, `webpack.config.ts`                            | title, icons, theme colour, `welcome/**`, removed mobile guide                                                                                                                    |
| Branding images and favicon screenshot baselines                                                      | binary conflicts: keep ours (`git checkout --ours`); upstream's vitest/vite bumps can still move the favicon baselines                                                            |
| `apps/web/src/i18n/strings/en_EN.json`                                                                | rebranded English strings. Localazy is off; the other locales are upstream's                                                                                                      |
| `.github/workflows/**`, `.github/CODEOWNERS`, `.github/labels.yml`                                    | we deleted most upstream workflows: modify/delete conflicts keep the deletion, new upstream workflows are dropped (see the list below)                                            |
| `package.json`, `apps/*/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`                        | names, homepage, licence; `@matrix-org/matrix-sdk-crypto-wasm` and `matrix-widget-api ^1.19.0` that the released js-sdk needs. Take upstream's lockfile and re-run `pnpm install` |
| Test files we extended (`Lifecycle.test.ts`, `MatrixChat.test.tsx`, …)                                | take upstream's file and re-apply our cases; never union-merge them                                                                                                               |
| `docs/generated/[id].paths.ts`                                                                        | upstream graphs the linked js-sdk's workflows, we don't                                                                                                                           |
| `AGENTS.md`                                                                                           | upstream's agent guide, with our overrides block at the top                                                                                                                       |

`matrix-js-sdk` is pinned to the released version each upstream release tag uses (upstream's `develop`
links a js-sdk checkout via `scripts/layered.sh`; CI here never runs that). Since `v1.12.30` all unit tests
are vitest (`jest` is gone), and desktop encrypted search comes from prebuilt seshat binaries (`hak` is gone).

Open the merge as a PR against `familychat`; never push to `element-hq`.

### Deleted upstream workflows

These upstream workflows are intentionally absent: they need Element's secrets, accounts or
infrastructure, or enforce Element's own triage and PR rules: `backport`, `build-and-test-netlify`, `build-and-test`, `build_debian`, `build_desktop_and_deploy`, `build_desktop_macos`, `build_desktop_prepare`, `build_desktop_test`, `build_desktop_windows`, `build_develop`, `cd`, `deploy`, `docker`, `docs`, `issue_closed`, `localazy_download`, `localazy_upload`, `merge-queue`, `netlify`, `npm-publish`, `pull_request`, `release-drafter`, `release-gitflow`, `release-module`, `release`, `release_prepare`, `shared-component-storybook-build`, `shared-component-storybook-netlify`, `shared-component-storybook-publish`, `sync-labels`, `tests-netlify`, `triage-assigned`, `triage-incoming`, `triage-labelled`, `triage-move-review-requests`, `triage-priority`, `triage-stale`, `triage-unlabelled`, `update-jitsi`, `update-topics`.
Workflows that run on `pull_request_target`, `workflow_run`, `issues` or `schedule` execute from the
default branch, so if a merge re-adds one, delete it again **and** check it is still disabled at repo
level (`gh workflow list --all`). We keep and adapt `build`, `build_desktop_linux` (unsigned, Linux
only), `static_analysis`, `tests`, `pull_request_base_branch` and our own `conventional_commits`.

## Third-party services

Family Chat must not send family content or metadata to anyone but us. This is the network
baseline. The client may contact only:

| Host                                          | Why                                                       |
| --------------------------------------------- | --------------------------------------------------------- |
| the family's homeserver and its `.well-known` | `<slug>.safechat.family`, or the family's custom domain   |
| `app.safechat.family`                         | the web app itself                                        |
| `safechat.family`                             | help, privacy policy, terms (links), `.well-known` lookup |
| `panel.safechat.family`                       | control-panel link                                        |
| `packages.safechat.family`                    | desktop updates, and Linux spellcheck dictionaries        |

`matrix.org`, `github.com` and the browser download links on the unsupported-browser page are
links the user can click, not requests the app makes.

Removed or disabled relative to upstream: PostHog analytics, Sentry, the rageshake bug-report
endpoint, MapTiler map tiles and location sharing, the Scalar integration manager, widgets, Jitsi
(including upstream's `meet.element.io` fallback), Element Call, reCAPTCHA (and its CSP entry), the
`mobile.element.io` mobile guide and its redirect, the Element app-store links and banners, the
`packages.element.io` / `element.io` download links, `pnpm run fetch`, and (desktop) Electron's
default Hunspell dictionary download from Google's CDN.

### Network capture

`apps/web/playwright/privacy/network-allowlist.spec.ts` loads the built app with
`apps/web/familychat/config.json`, goes through the signed-out pages, signs in against a mocked
homeserver, opens a room (with an image, a link, a location share and a `meet.element.io` Jitsi
widget added by another client), sends a message and opens every settings tab. It intercepts every
request, so nothing reaches the real network, and fails on any host outside the baseline above.
CI runs it in the **Build** workflow. Locally:

```sh
cd apps/web
cp familychat/config.json config.json && pnpm run build
pnpm exec playwright install chromium   # once
pnpm exec playwright test -c playwright-privacy.config.ts
```

Set `PRIVACY_TEST_DEBUG=1` to print the browser console and the API calls the mock does not handle.
The desktop app is not covered by this test: capture it through a proxy (for example mitmproxy) on a
real install.

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

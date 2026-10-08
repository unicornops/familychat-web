# Releasing Family Chat for the web and desktop

- [What a release produces](#what-a-release-produces)
- [Version numbers](#version-numbers)
- [One-time setup](#one-time-setup)
- [Cutting a release](#cutting-a-release)
- [Promoting and rolling back](#promoting-and-rolling-back)
- [Rotating credentials](#rotating-credentials)
- [Not done yet](#not-done-yet)

## What a release produces

Pushing a tag `v<upstream version>-fc.<n>` on `familychat` runs `.github/workflows/release.yml`:

| Job                                                | Environment              | Does                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check the release tag                              | none (no secrets)        | The tag format; the tagged commit is on `familychat`; the tag's upstream version is the `version` of both `apps/web/package.json` and `apps/desktop/package.json`; the latest **push** runs of Build, Tests, Static Analysis and Build Desktop (Linux) succeeded on that commit.                          |
| Build the web app                                  | none                     | Production build with `apps/web/familychat/config.json`, packed as `familychat-web-<tag>.tar.gz` with Cloudflare Pages' `_headers` (from `.github/cfp_headers`).                                                                                                                                          |
| Deploy the web app to staging                      | `release` (Rob approves) | Only once the repository variable `CLOUDFLARE_PAGES_PROJECT` is set: deploys that tarball to the `staging` branch of the Pages project.                                                                                                                                                                   |
| Build the desktop app for Linux                    | none                     | deb, AppImage and tar.gz (x64) from the same web app, with `apps/desktop/familychat/config.json`. Not signed: checksummed and attested.                                                                                                                                                                   |
| Build, sign and notarise the desktop app for macOS | `release`                | Universal dmg + zip, signed with the Developer ID Application certificate, hardened runtime, notarised and stapled. A later step refuses the build unless `codesign`, `stapler` and `spctl` all accept it.                                                                                                |
| Build and sign the desktop app for Windows         | `release`                | Only once the repository variable `WINDOWS_SIGNING` is `enabled`: Squirrel installer + MSI (x64), signed through Azure Artifact Signing (`win.azureSignOptions`), logged in with GitHub OIDC. A later step refuses any file whose Authenticode signature is not valid and from `AZURE_SIGNING_PUBLISHER`. |
| Publish the GitHub pre-release                     | none                     | All of the above, a CycloneDX SBOM of `pnpm-lock.yaml`, `SHA256SUMS`, build provenance attestations for every file, and notes made of the pull requests merged since the previous release tag.                                                                                                            |

The staging, macOS and Windows jobs all wait for the `release` environment at the same moment (after the web build),
so **one approval covers the whole release**. Every release has a public tag with its exact source, which keeps the
AGPL promise of family-chat#232 decision 2.

**Missing secrets fail, they never downgrade.** macOS is always built: its secrets already exist (below), and if any is
empty the job stops with an `::error::` naming it. Windows and the Pages deploy are switched on by repository
variables, because their accounts do not exist yet; once switched on, a missing secret is an `::error::` too, never an
unsigned installer or a silent skip.

`.github/workflows/promote.yml` (run by hand) puts a tested release in production; see
[Promoting and rolling back](#promoting-and-rolling-back).

## Version numbers

Release tags are `v<upstream version>-fc.<n>`, e.g. `v1.12.28-fc.1`: the Element Web release it is based on (the
`version` in `apps/web/package.json` and `apps/desktop/package.json`, which upstream merges bring in), and our release
number on top of it.

- **Web:** the version shown in the app is `1.12.28-fc.1`.
- **Desktop:** the app version is `1.12.28-fc.1` too (deb version, Squirrel package `1.12.28-fc1`). The macOS build
  version (`CFBundleVersion`) is `1.12.28.1` and the Windows file version `1.12.28.1`.

`n` goes from 1 to 9: Squirrel.Windows compares the pre-release part as text, so `fc10` would sort before `fc9` and
never be offered as an update. The gate refuses a tenth release on one upstream version; the next upstream merge
starts again at `fc.1`.

## One-time setup

### The release environment

All release credentials are secrets of the GitHub environment **`release`** of this repository. Create it (with
Terragrunt in `unicornops/gitops-environments`, as for the other client repositories, gitops-environments#31) with:

- **required reviewer:** Rob;
- **deployment policy:** only tags matching `v*-fc.*` and the `familychat` branch (for runs by hand);
- a **tag ruleset** restricting the creation, update and deletion of `v*-fc.*` tags to admins, and **branch
  protection** on `familychat`.

Create it **before the first tag**: a job naming a missing environment creates it without any protection. The gate
job is not a security boundary on its own (it runs from the tagged commit); the approval, the deployment policy and
the tag ruleset are.

### macOS: already in place

The organisation secrets used by the Shuffleboard macOS releases are reused as they are:

| Secret                       | What                                                                   | electron-builder reads it as  |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| `APPLE_CERTIFICATE_BASE64`   | the **Developer ID Application** certificate and key, `.p12` in base64 | `CSC_LINK`                    |
| `APPLE_CERTIFICATE_PASSWORD` | its password                                                           | `CSC_KEY_PASSWORD`            |
| `APPLE_DEVELOPER_ID`         | the Apple ID (email) used for notarisation                             | `APPLE_ID`                    |
| `APPLE_APP_PASSWORD`         | an app-specific password of that Apple ID                              | `APPLE_APP_SPECIFIC_PASSWORD` |
| `APPLE_TEAM_ID`              | the Team ID                                                            | `APPLE_TEAM_ID`               |

They are organisation secrets, so any workflow of this repository could read them; only release.yml does, and only in
the `release` environment. To keep them to this environment alone, create **environment** secrets with the same names
in `release` (they take precedence) and stop sharing the organisation ones with this repository.

If the certificate turns out to be an Apple Distribution one rather than Developer ID Application, the "Check the
signature and the notarisation" step fails: create a Developer ID Application certificate (Certificates, Identifiers &
Profiles, needs the Account Holder) and export it as a `.p12`.

### Windows: Azure Artifact Signing

Until this is done, leave the repository variable `WINDOWS_SIGNING` unset: releases then have no Windows build, and
their notes say so.

1. In the existing Azure subscription, create an **Artifact Signing account** (resource provider
   `Microsoft.CodeSigning`) in a region close to us, e.g. West Europe; its endpoint is then
   `https://weu.codesigning.azure.net/`.
2. Complete **identity validation** for Unicorn Operations Ltd (organisation, public trust), then create a **public
   trust certificate profile** from it. The certificate subject's CN is the validated organisation name: that exact
   string is `AZURE_SIGNING_PUBLISHER`.
3. Create an Entra ID **app registration** (no client secret) with a **federated credential**: issuer
   `https://token.actions.githubusercontent.com`, subject `repo:unicornops/familychat-web:environment:release`, audience
   `api://AzureADTokenExchange`. Give its service principal the role **Artifact Signing Certificate Profile Signer**
   on the certificate profile (or the account). Manage all of this in gitops-environments if we add an Azure stack
   there.
4. Add the secrets below to the `release` environment, then set the **repository variable** `WINDOWS_SIGNING` to
   `enabled`.

| Secret                    | Value                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| `AZURE_CLIENT_ID`         | the app registration's application (client) ID                    |
| `AZURE_TENANT_ID`         | the Entra ID tenant ID                                            |
| `AZURE_SUBSCRIPTION_ID`   | the subscription holding the signing account                      |
| `AZURE_SIGNING_ENDPOINT`  | the account's endpoint, e.g. `https://weu.codesigning.azure.net/` |
| `AZURE_SIGNING_ACCOUNT`   | the Artifact Signing account name                                 |
| `AZURE_SIGNING_PROFILE`   | the certificate profile name                                      |
| `AZURE_SIGNING_PUBLISHER` | the certificate subject CN, e.g. `Unicorn Operations Ltd`         |

The workflow logs in with `azure/login` (OIDC, no secret), and electron-builder's `win.azureSignOptions` (set from
`ED_AZURE_SIGN_*` in `apps/desktop/electron-builder.ts`) runs `Invoke-TrustedSigning`, which uses that Azure CLI
session. `AZURE_SIGNING_PUBLISHER` also seeds the Windows tray icon GUID, so do not change it lightly.

### Web: Cloudflare Pages

Until this is done, leave the repository variable `CLOUDFLARE_PAGES_PROJECT` unset: releases then deploy nothing.

1. In gitops-environments `cloudflare`, create a **Direct Upload** Pages project (e.g. `familychat-web`) with
   **production branch `production`**, the custom domain `app.safechat.family` on production and
   `staging.app.safechat.family` on the `staging` branch alias (`staging.<project>.pages.dev`).
2. Create an API token with **Account → Cloudflare Pages → Edit** on that account only.
3. Add the secrets to the `release` environment and set the **repository variable** `CLOUDFLARE_PAGES_PROJECT` to the
   project name.

| Secret                  | Value                     |
| ----------------------- | ------------------------- |
| `CLOUDFLARE_API_TOKEN`  | the Pages deploy token    |
| `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare account ID |

Deploys run `npx wrangler@<exact version> pages deploy` on the tarball from the release, with `_headers` from
`.github/cfp_headers` (upstream's security headers for its own Pages deploys).

## Cutting a release

1. Merge everything into `familychat` and wait for Build, Tests, Static Analysis and Build Desktop (Linux) to pass on
   the merge commit.
2. If the release is based on a new upstream version, the upstream merge PR (#4) has its checklist done. For a build
   that goes to users, tick the security review on the release issue (family-chat#232).
3. `git tag -s v1.12.28-fc.1 -m "Family Chat v1.12.28-fc.1" && git push origin v1.12.28-fc.1`
4. Approve the `release` environment when GitHub asks (once).
5. Test the staging web app and the desktop builds from the pre-release.

To build a tag again (a new secret, a flaky notarisation), run the Release workflow by hand with that tag: it replaces
the files of the existing pre-release.

## Promoting and rolling back

- **Promote:** run **Promote a release** (`promote.yml`) by hand with the tag, and approve the `release` environment.
  It downloads the web tarball from the GitHub release, checks it against `SHA256SUMS` and its attestation (made by
  release.yml), deploys it to the `production` branch of the Pages project (app.safechat.family), then
  turns the pre-release into the latest full release.
- **Roll back the web app:** in the Pages dashboard, "Rollback to this deployment" on the previous production
  deployment (instant), or run Promote again with the previous tag.
- **Roll back a desktop build:** there is no update feed yet, so nothing is pushed to installed apps. Mark the GitHub
  release as withdrawn in its notes, and promote the previous tag so that it is the latest again.

## Rotating credentials

- **Developer ID certificate:** it expires after five years. Create a new one, replace `APPLE_CERTIFICATE_BASE64` and
  `APPLE_CERTIFICATE_PASSWORD`. Apps already notarised keep working.
- **Apple app-specific password:** revoke it at account.apple.com, create a new one, replace `APPLE_APP_PASSWORD`.
- **Azure:** there is no client secret to rotate. Artifact Signing renews its short-lived certificates itself; if the
  organisation name changes, identity validation and the profile are redone and `AZURE_SIGNING_PUBLISHER` updated.
- **Cloudflare token:** roll it in the Cloudflare dashboard (or gitops-environments) and replace `CLOUDFLARE_API_TOKEN`.

## Not done yet

These are part of #5 but need infrastructure that does not exist yet; each is a follow-up:

- **Update feeds and `packages.safechat.family`:** the desktop config (`apps/desktop/familychat/config.json`) already
  points `update_base_url` at `https://packages.safechat.family/desktop/update/`, so builds released now will update
  themselves once the feed exists (`macos/releases.json` + zip for Squirrel.Mac, `win32/x64/RELEASES` + nupkg for
  Squirrel.Windows). Publishing those to R2 is not done: until then, the apps' hourly update check fails harmlessly
  and nothing points at Element. electron-builder's own `publish` stays `null`.
- **Signed apt repository** on `packages.safechat.family` (GPG key in the `release` environment).
- **Native modules** (`pnpm run hak`: Seshat encrypted search). The desktop builds have no search in encrypted rooms
  until they are built in CI.
- **arm64** Linux and Windows builds.

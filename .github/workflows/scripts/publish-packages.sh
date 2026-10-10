#!/usr/bin/env bash
# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial.
# Please see LICENSE files in the repository root for full details.

# Publishes the desktop update feeds and the Linux spellcheck dictionaries of a release to the R2 bucket behind
# packages.safechat.family (#5, docs/RELEASING.md "Promoting and rolling back"). Run by promote.yml.
#
# - desktop/update/macos/: the notarised zip of the release, then releases.json (Squirrel.Mac, serverType json);
# - desktop/update/win32/x64/: the Squirrel package and RELEASES, when the release has a Windows build;
# - desktop/hunspell/: the .bdic files of the release's Electron version (electron-main.ts), never deleted, since
#   older apps keep asking for theirs.
# Every file from the GitHub release is checked against SHA256SUMS and its release.yml attestation first. The packages
# are uploaded before the feeds that point at them, and only the current and the previous package of each feed are
# kept.
#
# Environment: TAG, REPO, GH_TOKEN, BUCKET, CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (an R2 API
# token with Object Read & Write on BUCKET only), and optionally PUBLIC_URL and AWS (the S3 client, for tests).

set -euo pipefail

: "${TAG:?}" "${REPO:?}" "${BUCKET:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
public_url="${PUBLIC_URL:-https://packages.safechat.family}/desktop"
aws_cmd="${AWS:-aws}"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-fc\.[1-9]$ ]]; then
    echo "::error::$TAG is not a release tag"
    exit 1
fi
version="${TAG#v}"

# R2 accepts the checksums of recent AWS CLIs, but only asks for what it needs.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
s3() { "$aws_cmd" --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" --region auto "$@"; }
immutable="public, max-age=31536000, immutable"

work="$(mktemp -d)"
cd "$work"

# A file of the GitHub release, checked against SHA256SUMS and its attestation.
verify() {
    local file="$1" line
    line="$(awk -v f="$file" '$2 == f || $2 == "*" f' SHA256SUMS)"
    if [ -z "$line" ]; then
        echo "::error::$file is not in the SHA256SUMS of $TAG"
        exit 1
    fi
    sha256sum --check --strict <<< "$line"
    # Signed by release.yml; not pinned to the tag's ref, since a rebuild by hand runs from familychat.
    gh attestation verify "$file" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml" > /dev/null
}

# Deletes the objects under a prefix except the given keys and the most recent other one (the previous release, so
# that an app downloading it while the feed changes still gets it).
prune() {
    local prefix="$1" kept_previous="" key
    shift
    s3 s3api list-objects-v2 --bucket "$BUCKET" --prefix "$prefix" --query 'Contents[].[LastModified, Key]' \
        --output text | sort -r | while read -r _ key; do
        if [ -z "$key" ] || [ "$key" = None ] || [[ "$key" != "$prefix"* ]]; then continue; fi
        for keep in "$@"; do [ "$key" = "$keep" ] && continue 2; done
        if [ -z "$kept_previous" ]; then
            kept_previous=1
            continue
        fi
        echo "Deleting $key"
        s3 s3 rm "s3://$BUCKET/$key"
    done
}

assets="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
mac_zip="familychat-desktop-$TAG-macos-universal.zip"
win_releases="familychat-desktop-$TAG-windows-x64-RELEASES"
if ! grep -qxF "$mac_zip" <<< "$assets"; then
    echo "::error::$TAG has no $mac_zip"
    exit 1
fi
patterns=(--pattern SHA256SUMS --pattern "$mac_zip")
if grep -qxF "$win_releases" <<< "$assets"; then
    patterns+=(--pattern "$win_releases" --pattern "*-full.nupkg")
fi
gh release download "$TAG" --repo "$REPO" "${patterns[@]}"
verify "$mac_zip"

# Windows: RELEASES is "<SHA1> <file name> <size>" for each package; this build has a single full one.
win_nupkg=""
if [ -f "$win_releases" ]; then
    verify "$win_releases"
    if [ "$(grep -c . "$win_releases")" != 1 ]; then
        echo "::error::$win_releases should list exactly one package"
        exit 1
    fi
    read -r sha1 win_nupkg size < <(tr -d '\r\357\273\277' < "$win_releases")
    if [[ ! "$win_nupkg" =~ ^[A-Za-z0-9._-]+-full\.nupkg$ ]] || [ ! -f "$win_nupkg" ]; then
        echo "::error::$win_releases names $win_nupkg, which is not a package of $TAG"
        exit 1
    fi
    verify "$win_nupkg"
    if [ "$(sha1sum "$win_nupkg" | cut -d' ' -f1)" != "${sha1,,}" ] || [ "$(stat -c %s "$win_nupkg")" != "$size" ]; then
        echo "::error::$win_nupkg does not match $win_releases"
        exit 1
    fi
else
    echo "::notice::$TAG has no Windows build: the Windows update feed is left as it is"
fi

# The dictionaries of the Electron version this release is built with, checked against Electron's SHASUMS256.txt.
electron="$(gh api "repos/$REPO/contents/apps/desktop/package.json?ref=$TAG" -H "Accept: application/vnd.github.raw" \
    | jq -r '.devDependencies.electron')"
if [[ ! "$electron" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "::error::cannot tell the Electron version of $TAG (got '$electron')"
    exit 1
fi
mkdir electron
gh release download "v$electron" --repo electron/electron --pattern hunspell_dictionaries.zip \
    --pattern SHASUMS256.txt --dir electron
(cd electron && awk '$2 == "*hunspell_dictionaries.zip" { print $1 "  hunspell_dictionaries.zip" }' SHASUMS256.txt \
    | grep . | sha256sum --check --strict)
if unzip -Z1 electron/hunspell_dictionaries.zip | grep -qvE '^[A-Za-z0-9_-]+\.bdic$'; then
    echo "::error::hunspell_dictionaries.zip of Electron $electron holds something other than .bdic files"
    exit 1
fi
unzip -q electron/hunspell_dictionaries.zip -d hunspell

# Packages and dictionaries first, the feeds that point at them last.
s3 s3 sync hunspell/ "s3://$BUCKET/desktop/hunspell/" --size-only --no-progress \
    --content-type application/octet-stream --cache-control "$immutable"
s3 s3 cp "$mac_zip" "s3://$BUCKET/desktop/update/macos/$mac_zip" --no-progress \
    --content-type application/zip --cache-control "$immutable"
if [ -n "$win_nupkg" ]; then
    s3 s3 cp "$win_nupkg" "s3://$BUCKET/desktop/update/win32/x64/$win_nupkg" --no-progress \
        --content-type application/octet-stream --cache-control "$immutable"
fi

jq -n --arg version "$version" --arg url "$public_url/update/macos/$mac_zip" \
    --arg date "$(gh release view "$TAG" --repo "$REPO" --json createdAt --jq .createdAt)" \
    '{currentRelease: $version,
      releases: [{version: $version, updateTo: {version: $version, name: $version, notes: "", pub_date: $date, url: $url}}]}' \
    > releases.json
s3 s3 cp releases.json "s3://$BUCKET/desktop/update/macos/releases.json" --no-progress \
    --content-type application/json --cache-control no-cache
if [ -n "$win_nupkg" ]; then
    s3 s3 cp "$win_releases" "s3://$BUCKET/desktop/update/win32/x64/RELEASES" --no-progress \
        --content-type text/plain --cache-control no-cache
fi

prune desktop/update/macos/ desktop/update/macos/releases.json "desktop/update/macos/$mac_zip"
if [ -n "$win_nupkg" ]; then
    prune desktop/update/win32/x64/ desktop/update/win32/x64/RELEASES "desktop/update/win32/x64/$win_nupkg"
fi

echo "::notice::$TAG is the desktop update on $public_url/update/ (Electron $electron dictionaries on $public_url/hunspell/)"

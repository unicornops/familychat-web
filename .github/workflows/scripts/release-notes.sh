#!/usr/bin/env bash

# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial.
# Please see LICENSE files in the repository root for full details.

# Release notes for a Family Chat release tag (#5): the pull requests merged since the previous release tag, grouped by
# Conventional Commits type, plus the upstream release it is based on. Usage: release-notes.sh <tag>. Runs from a full
# clone.

# The single-quoted backticks are Markdown, not command substitutions.
# shellcheck disable=SC2016

set -euo pipefail

tag="$1"
upstream="$(sed -E 's/^(v[0-9.]+)-fc\.[0-9]+$/\1/' <<< "${tag}")"
# The release tag before this one in its history (not the newest tag: an older release may be built again).
previous="$(git describe --tags --abbrev=0 --match 'v*-fc.*' "${tag}^" 2>/dev/null || true)"
if [[ -z "${previous}" ]]; then
    # First release: everything since the fork, whose first pull request is the rebrand.
    first="$(git log --first-parent --merges --reverse --format='%H' --grep='^feat(brand): Family Chat rebrand' "${tag}" | head -n 1)"
    previous="${first}^"
fi
range="${previous}..${tag}"

echo "Family Chat for the web and desktop, based on [Element ${upstream}](https://github.com/element-hq/element-web/releases/tag/${upstream})."
echo
echo "Source: [${tag}](https://github.com/unicornops/familychat-web/tree/${tag}) (AGPL-3.0)."
echo
# Pull requests are merged with merge commits on familychat: their titles (Conventional Commits) are the first line of
# each first-parent merge's body. Upstream's own commits arrive through merges of its tags and are not listed.
titles="$(git log --first-parent --merges --format='%b%x00' "${range}" | awk 'BEGIN { RS = "\0" } { sub(/^\n+/, ""); split($0, l, "\n"); if (l[1] != "") print l[1] }')"
section() {
    local title="$1" pattern="$2" lines
    lines="$(grep -E "${pattern}" <<< "${titles}" | sed -E 's/^[a-z]+(\([^)]*\))?!?: /- /' || true)"
    if [[ -n "${lines}" ]]; then
        echo "### ${title}"
        echo
        echo "${lines}"
        echo
    fi
}
section "Features" '^feat(\(|!|:)'
section "Fixes" '^fix(\(|!|:)'
section "Upstream" '^chore\(upstream\)'
titles="$(grep -v '^chore(upstream)' <<< "${titles}" || true)"
section "Other changes" '^(chore|ci|test|docs|refactor|perf|build)(\([^)]*\))?!?: '
echo "### Files"
echo
echo '- `familychat-web-*.tar.gz`: the web app, as served at app.safechat.family.'
echo '- `familychat-desktop-*-macos-universal.dmg` (or `.zip`): macOS, signed with our Developer ID and notarised.'
echo '- `familychat-desktop-*-windows-x64-setup.exe` (or `.msi`): Windows, signed through Azure Artifact Signing.'
echo '- `*-full.nupkg` and `familychat-desktop-*-windows-x64-RELEASES`: the Windows update feed; installed apps fetch them, not people.'
echo '- `familychat-desktop-*-linux-amd64.deb`, `.AppImage` or `.tar.gz`: Linux, not signed; check it against `SHA256SUMS`.'
echo
echo 'The desktop builds have no encrypted-message search (Seshat is not built into them yet). Check any file against'
echo '`SHA256SUMS` and its attestation: `gh attestation verify <file> --repo unicornops/familychat-web`.'

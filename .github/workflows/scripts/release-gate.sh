#!/usr/bin/env bash

# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial.
# Please see LICENSE files in the repository root for full details.

# Gate of the release workflow (#5, docs/RELEASING.md). Fails unless:
# - TAG is v<x.y.z>-fc.<n> with n in 1..9 (Squirrel.Windows orders "fc10" before "fc9", see docs/RELEASING.md);
# - the upstream version in the tag is the version of both apps/web and apps/desktop in the tagged commit;
# - the tagged commit is on familychat;
# - CI passed on that commit: the latest push runs of Build, Tests, Static Analysis and the Linux desktop build
#   succeeded. Only push runs of those workflows count: anything scheduled on the same commit is ignored.
# Writes tag, version, fc and sha to GITHUB_OUTPUT. Needs TAG, REPO and GH_TOKEN; runs from a full clone.

set -euo pipefail

if [[ ! "${TAG}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-fc\.([1-9])$ ]]; then
    echo "::error::${TAG} is not a release tag: expected v<x.y.z>-fc.<n>, n in 1..9"
    exit 1
fi
tag_version="${BASH_REMATCH[1]}"
fc="${BASH_REMATCH[2]}"

sha="$(git rev-list -n 1 "refs/tags/${TAG}")"

for app in apps/web apps/desktop; do
    built_version="$(git show "${sha}:${app}/package.json" | jq -r .version)"
    if [[ "${tag_version}" != "${built_version}" ]]; then
        echo "::error::${TAG} says upstream ${tag_version}, but ${app} in the tagged commit is version ${built_version}"
        exit 1
    fi
done

if ! git merge-base --is-ancestor "${sha}" origin/familychat; then
    echo "::error::${TAG} (${sha}) is not on familychat"
    exit 1
fi

runs="$(gh api --paginate "repos/${REPO}/actions/runs?head_sha=${sha}&event=push&per_page=100" \
    --jq '.workflow_runs[] | {path, status, conclusion, run_number}' | jq -s .)"
for workflow in build.yml tests.yml static_analysis.yaml build_desktop_linux.yaml; do
    latest="$(jq -c --arg p ".github/workflows/${workflow}" '[.[] | select(.path == $p)] | max_by(.run_number) // empty' <<< "${runs}")"
    if [[ -z "${latest}" ]]; then
        echo "::error::${workflow} has not run on ${sha} (a push to familychat runs it)"
        exit 1
    fi
    result="$(jq -r '.status + " " + (.conclusion // "")' <<< "${latest}")"
    if [[ "${result}" != "completed success" ]]; then
        echo "::error::${workflow} is not green on ${sha}: ${result}"
        exit 1
    fi
done

echo "Release ${TAG}: upstream ${tag_version}, Family Chat release ${fc}, commit ${sha}"
{
    echo "tag=${TAG}"
    echo "version=${tag_version}"
    echo "fc=${fc}"
    echo "sha=${sha}"
} >> "${GITHUB_OUTPUT}"

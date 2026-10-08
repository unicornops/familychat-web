#!/usr/bin/env bash

# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial.
# Please see LICENSE files in the repository root for full details.

# Validates every workflow with action-validator. Its bundled schema (0.6.0, the latest) predates the `attestations`
# job permission that actions/attest-build-provenance needs (release.yml, promote.yml), so those permission lines are
# left out of the copy it checks. Everything else is validated as written; zizmor checks the real files.

set -euo pipefail

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

status=0
while IFS= read -r -d '' workflow; do
    echo "${workflow}"
    copy="${tmp}/$(basename "${workflow}")"
    sed -E '/^ +attestations: (read|write)$/d' "${workflow}" > "${copy}"
    action-validator "${copy}" || status=1
done < <(find .github/workflows -maxdepth 1 -type f \( -iname '*.yaml' -o -iname '*.yml' \) -print0 | sort -z)
exit "${status}"

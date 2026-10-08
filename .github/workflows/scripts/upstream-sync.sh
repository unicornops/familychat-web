#!/usr/bin/env bash
#
# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only
#
# Merges the newest stable upstream Element Web release tag into the default branch, on a branch of its own, and
# opens a pull request for a person to review. When the merge conflicts in a way it cannot resolve by the fork's
# fixed rules, it pushes nothing and opens (or updates) an issue labelled `upstream-sync` instead. It never merges
# anything into the default branch itself. See "Keeping up with upstream" in the README.
#
# Run by .github/workflows/upstream-sync.yml, and runnable locally from a clean checkout:
#
#   GITHUB_REPOSITORY=unicornops/familychat-web DRY_RUN=true TAG=v1.12.30 \
#     .github/workflows/scripts/upstream-sync.sh
#
# Environment:
#   GITHUB_REPOSITORY  owner/name of this repository (required)
#   GH_TOKEN           token for gh and for pushing: contents + pull requests + issues write on this
#                      repository only. Pushes made with GITHUB_TOKEN do not trigger CI, so it is a
#                      fine-grained token or a GitHub App token (locally, `gh auth` is used instead)
#   TAG                upstream tag to merge (default: upstream's newest stable vX.Y.Z release)
#   DRY_RUN            "true" to do everything locally and print the PR or issue instead of creating it
#   UPSTREAM_REPO      default element-hq/element-web
#   BASE_BRANCH        default familychat
#   REMOTE             the remote pointing at this repository, default origin
#
# Needs git, gh, jq and python3. With pnpm on the PATH it also regenerates pnpm-lock.yaml; without it a lockfile
# conflict is left for a person.

# The single-quoted backticks are Markdown, not command substitutions.
# shellcheck disable=SC2016

set -euo pipefail

upstream_repo="${UPSTREAM_REPO:-element-hq/element-web}"
base_branch="${BASE_BRANCH:-familychat}"
remote="${REMOTE:-origin}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set to owner/name}"
dry_run="${DRY_RUN:-false}"
label="upstream-sync"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Paths the fork deleted on purpose. Upstream edits to them are modify/delete conflicts, which are resolved by
# keeping the deletion. Anything else that conflicts goes to a person.
deleted_on_purpose_regex='^(\.github/(workflows/[^/]+\.ya?ml|labels\.yml|FUNDING\.yml|release-drafter\.yml|SSLcom-sandbox\.crt|ISSUE_TEMPLATE/[^/]+|actions/download-verify-element-tarball/.+)|apps/(web|desktop)/element\.io/.+|apps/web/src/toasts/MobileGuideToast(\.test)?\.ts|apps/web/src/vector/mobile_guide/.+|apps/web/playwright/e2e/mobile-guide/.+|apps/desktop/scripts/fetch-package\.ts|localazy\.json|LICENSE-COMMERCIAL)$'

# Paths where the fork's version always wins: our own CODEOWNERS and README, and the branding images and the
# screenshot baselines that show them (git cannot merge binaries anyway).
keep_ours_regex='^(\.github/CODEOWNERS|README\.md|apps/web/res/vector-icons/[^/]+\.png|apps/web/res/themes/element/img/logos/[^/]+|apps/web/res/img/element-desktop-logo\.svg|apps/web/res/img/element-shiny\.svg|apps/desktop/build/icon\.(png|ico)|apps/desktop/build/icon\.icon/.+|apps/web/src/__screenshots__/linux/favicon\.test\.browser\.ts/[^/]+\.png)$'

# Manifests whose conflicts are line-by-line field clashes (our name next to upstream's version bump, our pinned
# dependency next to upstream's bumped one). upstream-sync-resolve.py settles the hunks where each line changed on
# one side only.
manifest_regex='^((apps|packages|modules)/[^/]+/)?package\.json$|^pnpm-workspace\.yaml$'

# Upstream app releases are tagged vX.Y.Z. Release candidates (vX.Y.Z-rc.N) and package tags (module/*, …) are not.
tag_regex='^v[0-9]+\.[0-9]+\.[0-9]+$'

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
# The merge switches to the base branch, which may not have this script's helper yet (a local run from a branch).
resolver="$work_dir/upstream-sync-resolve.py"
cp "$script_dir/upstream-sync-resolve.py" "$resolver"

log() { echo "upstream-sync: $*" >&2; }

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    cat >> "$GITHUB_STEP_SUMMARY"
  else
    cat >&2
  fi
}

# --- Which tag ----------------------------------------------------------------------------------------------------

if [[ -n "${TAG:-}" ]]; then
  tag="$TAG"
else
  # Upstream publishes module and package releases from the same repository, so "latest" is not necessarily the app.
  tag="$(gh api "repos/$upstream_repo/releases?per_page=100" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name' \
    | grep -E "$tag_regex" | sort -V | tail -n 1 || true)"
  if [[ -z "$tag" ]]; then
    log "no stable vX.Y.Z release found on $upstream_repo"
    exit 1
  fi
fi

if [[ ! "$tag" =~ $tag_regex ]]; then
  log "'$tag' is not a vX.Y.Z release tag"
  exit 1
fi

release_json="$work_dir/release.json"
gh api "repos/$upstream_repo/releases/tags/$tag" > "$release_json"
if [[ "$(jq -r '.prerelease or .draft' "$release_json")" != "false" ]]; then
  log "$tag is a pre-release or a draft on $upstream_repo, only stable releases are merged"
  exit 1
fi

git fetch --quiet "$remote" "refs/heads/$base_branch:refs/remotes/$remote/$base_branch"
git fetch --quiet --no-tags "https://github.com/$upstream_repo.git" "+refs/tags/$tag:refs/tags/$tag"
base_ref="$remote/$base_branch"

if git merge-base --is-ancestor "$tag" "$base_ref"; then
  log "$base_branch already contains $tag, nothing to do"
  echo "\`$base_branch\` already contains \`$tag\`, nothing to do." | summary
  exit 0
fi

branch="upstream/$tag"
if [[ "$dry_run" != "true" ]] && git ls-remote --exit-code --heads "$remote" "$branch" > /dev/null; then
  log "$branch already exists on $remote, its pull request is waiting for review"
  echo "\`$branch\` already exists, its pull request is waiting for review." | summary
  exit 0
fi

# --- Security fast path -------------------------------------------------------------------------------------------

version="${tag#v}"
version_regex="(^|[^0-9.])v?${version//./[.]}([^0-9]|$)"
security_reasons=()
if jq -r '.body // ""' "$release_json" | grep -Eiq 'security|CVE-[0-9]{4}-|GHSA-'; then
  security_reasons+=("the release notes mention a security fix")
fi
advisories="$(gh api --paginate "repos/$upstream_repo/security-advisories?state=published" \
  --jq ".[] | select([.vulnerabilities[]?.patched_versions // \"\"] | any(test(\"$version_regex\"))) | .ghsa_id")"
if [[ -n "$advisories" ]]; then
  security_reasons+=("published advisories patched in $tag: $(echo "$advisories" | paste -sd ' ')")
fi
is_security=false
if (( ${#security_reasons[@]} > 0 )); then
  is_security=true
fi

owners=""
if [[ -f .github/CODEOWNERS ]]; then
  owners="$(awk '$1 == "*" { $1 = ""; print }' .github/CODEOWNERS | xargs)"
fi

# --- Merge --------------------------------------------------------------------------------------------------------

merge_base="$(git merge-base "$base_ref" "$tag")"
git switch --quiet --force-create "$branch" "$base_ref"

if [[ -z "$(git config user.email || true)" ]]; then
  git config user.name "Family Chat upstream sync"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
fi

merge_message="chore(upstream): merge $upstream_repo $tag"
auto_resolved=()
# Always --no-commit: the lockfile is regenerated before the merge commit is made, clean merge or not.
if ! git -c merge.conflictStyle=diff3 merge --no-ff --no-commit "$tag" > "$work_dir/merge.log" 2>&1; then
  cat "$work_dir/merge.log" >&2
fi

# Deleted by us, modified (or added by a rename) by them: keep the deletion.
while IFS= read -r path; do
  if [[ "$path" =~ $deleted_on_purpose_regex ]]; then
    git rm --quiet -r --cached -- "$path"
    rm -rf -- "$path"
    auto_resolved+=("\`$path\`: changed upstream, deleted in the fork; kept deleted")
  fi
done < <(git status --porcelain=v1 | awk '$1 == "DU" { print $2 }')

while IFS= read -r path; do
  if [[ "$path" =~ $keep_ours_regex ]]; then
    git checkout --quiet --ours -- "$path"
    git add -- "$path"
    auto_resolved+=("\`$path\`: fork-owned (brand or repo furniture); kept ours")
  elif [[ "$path" =~ $manifest_regex ]]; then
    if [[ -n "$(python3 "$resolver" "$path")" ]]; then
      git add -- "$path"
      auto_resolved+=("\`$path\`: each conflicting line changed on one side only; merged line by line")
    fi
  fi
done < <(git status --porcelain=v1 | awk '$1 == "UU" { print $2 }')

# The lockfile is generated, so take upstream's and let pnpm re-apply our manifests to it below.
lockfile_conflict=false
if git status --porcelain=v1 -- pnpm-lock.yaml | grep -q '^UU'; then
  lockfile_conflict=true
  if command -v pnpm > /dev/null; then
    git checkout --quiet --theirs -- pnpm-lock.yaml
    git add -- pnpm-lock.yaml
  fi
fi

conflicts="$(git diff --name-only --diff-filter=U)"

if [[ -z "$conflicts" ]]; then
  if command -v pnpm > /dev/null; then
    lock_before="$(git rev-parse --verify --quiet :pnpm-lock.yaml || true)"
    # No install, no scripts: only re-resolve the lockfile against the merged manifests.
    if ! pnpm install --lockfile-only --ignore-scripts > "$work_dir/pnpm.log" 2>&1; then
      cat "$work_dir/pnpm.log" >&2
      conflicts="pnpm-lock.yaml (pnpm install --lockfile-only failed, see the workflow log)"
    else
      git add -- pnpm-lock.yaml
      if [[ "$lockfile_conflict" == "true" ]]; then
        auto_resolved+=("\`pnpm-lock.yaml\`: took upstream's and regenerated it with \`pnpm install --lockfile-only\`")
      elif [[ "$(git rev-parse --verify --quiet :pnpm-lock.yaml || true)" != "$lock_before" ]]; then
        auto_resolved+=("\`pnpm-lock.yaml\`: refreshed with \`pnpm install --lockfile-only\`")
      fi
    fi
  else
    log "pnpm not found: pnpm-lock.yaml was not regenerated, CI's frozen install will catch any drift"
  fi
fi

if [[ -n "$conflicts" ]]; then
  git merge --abort 2> /dev/null || git reset --quiet --hard
  git switch --quiet --detach "$base_ref"
  git branch --quiet -D "$branch"
  log "$tag conflicts with $base_branch:"
  echo "$conflicts" >&2

  title="Upstream $tag does not merge cleanly"
  body="$work_dir/issue.md"
  {
    echo "Merging [\`$upstream_repo\` $tag](https://github.com/$upstream_repo/releases/tag/$tag) into \`$base_branch\` conflicts, so the sync workflow pushed nothing."
    echo
    if [[ "$is_security" == "true" ]]; then
      echo "> [!WARNING]"
      echo "> **Security release:** $(IFS=';'; echo "${security_reasons[*]}"). ${owners}"
      echo
    fi
    echo "### Conflicting paths"
    echo
    echo "$conflicts" | sed 's/^/- `/; s/$/`/'
    echo
    if (( ${#auto_resolved[@]} > 0 )); then
      echo "The workflow would have resolved these by the fork's fixed rules; do the same:"
      echo
      printf -- '- %s\n' "${auto_resolved[@]}"
      echo
    fi
    echo "### Reproduce and resolve"
    echo
    echo '```bash'
    echo "git fetch origin $base_branch"
    echo "git fetch --no-tags https://github.com/$upstream_repo.git 'refs/tags/$tag:refs/tags/$tag'"
    echo "git switch -c chore/merge-upstream-$tag origin/$base_branch"
    echo "git merge --no-ff $tag"
    echo '```'
    echo
    echo "Or run the workflow's script locally to get the same automatic resolutions first:"
    echo
    echo '```bash'
    echo "GITHUB_REPOSITORY=$repo DRY_RUN=true TAG=$tag .github/workflows/scripts/upstream-sync.sh"
    echo '```'
    echo
    echo "Resolve following \"Keeping up with upstream\" in the README (and the conflict list in #4), then open a pull request titled \`$merge_message\` with the per-merge checklist. Close this issue from that pull request."
  } > "$body"

  if [[ "$dry_run" == "true" ]]; then
    { echo "## Dry run: would open or update the issue \"$title\""; echo; cat "$body"; } | summary
    exit 0
  fi

  labels="$label"
  if [[ "$is_security" == "true" ]]; then
    labels="$labels,security"
  fi
  existing="$(gh issue list --repo "$repo" --state open --label "$label" --search "\"$title\" in:title" \
    --json number,title --jq ".[] | select(.title == \"$title\") | .number" | head -n 1)"
  if [[ -n "$existing" ]]; then
    gh issue edit "$existing" --repo "$repo" --body-file "$body" --add-label "$labels"
    log "updated issue #$existing"
  else
    gh issue create --repo "$repo" --title "$title" --body-file "$body" --label "$labels"
  fi
  exit 0
fi

git commit --quiet --no-edit -m "$merge_message"

# Upstream workflows new in this release would run on our pull requests (and, once merged, from our default branch),
# so drop them too. The reviewer restores any we want.
dropped_workflows=()
while IFS= read -r path; do
  [[ -n "$path" ]] && dropped_workflows+=("$path")
done < <(git diff --name-only --diff-filter=A "$base_ref" HEAD -- '.github/workflows/*.yml' '.github/workflows/*.yaml')
if (( ${#dropped_workflows[@]} > 0 )); then
  git rm --quiet -- "${dropped_workflows[@]}"
  git commit --quiet -m "chore(upstream): drop the workflows $tag adds" \
    -m "Upstream's automation stays off in the fork (README, \"Deleted upstream workflows\")."
fi

# --- Pull request -------------------------------------------------------------------------------------------------

# Files both sides changed since the merge base: the ones to read closely even though git merged them.
git diff --name-only "$merge_base" "$base_ref" | sort > "$work_dir/ours"
git diff --name-only "$merge_base" "$tag" | sort > "$work_dir/theirs"
# Only files still in the merged tree: the deleted-on-purpose ones are listed above.
overlap="$(comm -12 "$work_dir/ours" "$work_dir/theirs" | grep -v -E '^pnpm-lock\.yaml$|/i18n/strings/[^/]+\.json$' \
  | while IFS= read -r path; do if [[ -e "$path" ]]; then echo "$path"; fi; done || true)"

body="$work_dir/pr.md"
{
  echo "Merges [\`$upstream_repo\` $tag](https://github.com/$upstream_repo/releases/tag/$tag) into \`$base_branch\`. Opened by the upstream-sync workflow; a person reviews and merges it (with a merge commit), because upstream code runs in a child-directed app."
  echo
  if [[ "$is_security" == "true" ]]; then
    echo "> [!WARNING]"
    echo "> **Security release:** $(IFS=';'; echo "${security_reasons[*]}"). Please review promptly. ${owners}"
    echo
  fi
  echo "### Resolved automatically"
  echo
  if (( ${#auto_resolved[@]} == 0 && ${#dropped_workflows[@]} == 0 )); then
    echo "Nothing: the merge was clean."
  fi
  for item in "${auto_resolved[@]}"; do
    echo "- $item"
  done
  for path in "${dropped_workflows[@]}"; do
    echo "- \`$path\`: new upstream workflow; dropped (restore it if we want it)"
  done
  echo
  echo "### Changed on both sides since the last merge"
  echo
  if [[ -n "$overlap" ]]; then
    echo "Git merged these without conflicts, but both upstream and the fork changed them. Read them closely, and for test files check our cases still sit on top of upstream's version:"
    echo
    echo "$overlap" | head -n 200 | sed 's/^/- `/; s/$/`/'
    if (( $(echo "$overlap" | wc -l) > 200 )); then
      echo "- …and $(( $(echo "$overlap" | wc -l) - 200 )) more"
    fi
  else
    echo "None."
  fi
  echo
  echo "### Per-merge checklist"
  echo
  cat <<'CHECKLIST'
- [ ] `pnpm lint:types`, `i18n:lint`, `lint:knip` green; Node 24
- [ ] `matrix-js-sdk` is the version upstream's release uses (and `@matrix-org/matrix-sdk-crypto-wasm`/`matrix-widget-api` still satisfy it)
- [ ] Desktop Linux build artifact still branded Family Chat
- [ ] No upstream workflow re-added (or re-deleted + still disabled at repo level: `gh workflow list --all`)
- [ ] Brand check: no "Element"/Element URLs reintroduced in user-facing strings or config
- [ ] New config keys in upstream's `element.io/` configs have a Family Chat answer in `apps/*/familychat/config.json`
- [ ] Sign-in allowlist and sign-in-code rules unchanged (family-chat `docs/client-login-links.md`)
- [ ] No third-party analytics/telemetry re-enabled (Kids/Families declarations, family-chat#232 decisions 4 and 8)
- [ ] CI green
- [ ] README conflict hotspots (and #4) updated if this merge found a new one
CHECKLIST
  echo
  echo "### Upstream changelog"
  echo
  echo "<details><summary>$tag release notes</summary>"
  echo
  jq -r '.body // "No release notes."' "$release_json" | head -c 30000
  echo
  echo
  echo "</details>"
} > "$body"

if [[ "$dry_run" == "true" ]]; then
  { echo "## Dry run: would push \`$branch\` and open \"$merge_message\""; echo; cat "$body"; } | summary
  git log --oneline --no-decorate "$base_ref..HEAD" --first-parent >&2
  exit 0
fi

# The token is passed as a header for this one push, never stored in the git config.
auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
echo "::add-mask::$auth"
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
  push --quiet "https://github.com/$repo.git" "HEAD:refs/heads/$branch"

labels="$label"
if [[ "$is_security" == "true" ]]; then
  labels="$labels,security"
fi
gh pr create --repo "$repo" --base "$base_branch" --head "$branch" --title "$merge_message" \
  --body-file "$body" --label "$labels"

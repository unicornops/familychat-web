#!/usr/bin/env python3
#
# Copyright 2026 Unicorn Operations Ltd.
#
# SPDX-License-Identifier: AGPL-3.0-only
#
# Resolves the conflict hunks that every upstream merge produces in our package manifests, and leaves the rest for a
# person. Run by upstream-sync.sh on files that git left conflicted, after a merge with merge.conflictStyle=diff3.
#
# A hunk is resolved only in two shapes:
#
# - ours, the merge base and theirs have the same number of lines, and each line was changed on at most one side (or
#   identically on both): the fork's renamed `name`/`description`/`author` next to upstream's `version` bump, or a
#   dependency the fork pins differently next to one upstream bumped;
# - one side only added lines and the other only changed lines in place: the fork's extra dependency next to one
#   upstream bumped.
#
# Anything else, such as a line both sides changed differently, or a line one side removed, stays a conflict.
#
#   upstream-sync-resolve.py FILE...
#
# Rewrites each FILE in place with the hunks it could resolve, and prints the files that are now free of conflict
# markers. Exits 0 even when some files still conflict.

import sys

OURS = "<<<<<<< "
BASE = "||||||| "
THEIRS = "======="
END = ">>>>>>> "


def subsequence_positions(base, lines):
    """Positions in `lines` of each line of `base`, matched in order, or None if `base` is not a subsequence."""
    positions = []
    j = 0
    for line in base:
        while j < len(lines) and lines[j] != line:
            j += 1
        if j == len(lines):
            return None
        positions.append(j)
        j += 1
    return positions


def apply_inserts(inserted, base, edited):
    """`inserted` is `base` plus added lines; `edited` is `base` with lines changed in place. Combines the two."""
    positions = subsequence_positions(base, inserted)
    if positions is None:
        return None
    replacement = dict(zip(positions, edited))
    return [replacement.get(i, line) for i, line in enumerate(inserted)]


def resolve_hunk(ours, base, theirs):
    """Returns the resolved lines, or None when the hunk needs a person."""
    # One side only added lines (say, the fork's extra dependency) next to lines the other side changed in place
    # (upstream's bumped neighbour): keep the added lines and take the changes.
    if len(theirs) == len(base) < len(ours):
        return apply_inserts(ours, base, theirs)
    if len(ours) == len(base) < len(theirs):
        return apply_inserts(theirs, base, ours)
    if not (len(ours) == len(base) == len(theirs)):
        return None
    merged = []
    for o, b, t in zip(ours, base, theirs):
        if o == b:
            merged.append(t)
        elif t == b or o == t:
            merged.append(o)
        else:
            return None
    return merged


def resolve_file(path):
    """Resolves what it can in `path`; returns True when no conflict is left."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines(keepends=True)

    out = []
    clean = True
    i = 0
    while i < len(lines):
        if not lines[i].startswith(OURS):
            out.append(lines[i])
            i += 1
            continue

        # Collect one hunk: <<<<<<< ours ||||||| base ======= theirs >>>>>>>
        start = i
        sections = {"ours": [], "base": None, "theirs": []}
        current = "ours"
        i += 1
        while i < len(lines) and not lines[i].startswith(END):
            line = lines[i]
            if line.startswith(BASE) and current == "ours":
                sections["base"] = []
                current = "base"
            elif line.rstrip("\r\n") == THEIRS and current in ("ours", "base"):
                current = "theirs"
            else:
                sections[current].append(line)
            i += 1
        end = i  # the >>>>>>> line, or len(lines) if the file is malformed
        i += 1

        merged = None
        if sections["base"] is not None and end < len(lines):
            merged = resolve_hunk(sections["ours"], sections["base"], sections["theirs"])
        if merged is None:
            out.extend(lines[start : end + 1])
            clean = False
        else:
            out.extend(merged)

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)
    return clean


def main(paths):
    for path in paths:
        if resolve_file(path):
            print(path)


if __name__ == "__main__":
    main(sys.argv[1:])

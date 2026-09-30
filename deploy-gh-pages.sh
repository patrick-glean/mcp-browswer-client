#!/bin/bash
# Publishes public/ to the gh-pages branch through a temporary worktree, so the current
# checkout (branch, uncommitted work and ignored files such as venv/) is never touched.
#
#   ./deploy-gh-pages.sh [remote]    # default remote: origin
set -euo pipefail

remote="${1:-origin}"
branch="gh-pages"
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain -- public)" ]; then
    echo "public/ has uncommitted changes. Commit them first so the site matches a commit." >&2
    exit 1
fi

source_commit="$(git rev-parse --short HEAD)"
worktree="$(mktemp -d)"
cleanup() {
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$worktree"
}
trap cleanup EXIT

if git fetch --quiet "$remote" "$branch" 2>/dev/null; then
    git worktree add --quiet --detach "$worktree" FETCH_HEAD
else
    echo "No $branch branch on $remote yet; creating it."
    git worktree add --quiet --detach "$worktree"
    git -C "$worktree" checkout --quiet --orphan "$branch"
    git -C "$worktree" rm -rf --quiet .
fi

find "$worktree" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R public/. "$worktree/"
# Serve the files as-is; without this GitHub Pages runs Jekyll, which drops names starting with _.
touch "$worktree/.nojekyll"

git -C "$worktree" add -A
if git -C "$worktree" diff --cached --quiet; then
    echo "$remote/$branch already matches public/ at $source_commit."
    exit 0
fi
git -C "$worktree" commit --quiet -m "Deploy $source_commit to GitHub Pages"
git -C "$worktree" push --quiet "$remote" "HEAD:$branch"
echo "Deployed $source_commit to $remote/$branch."

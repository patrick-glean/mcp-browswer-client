#!/bin/bash

set -e

# Save current branch name
default_branch=$(git rev-parse --abbrev-ref HEAD)

echo "Preparing deployment from branch: $default_branch"

# Make sure public directory exists
if [ ! -d "public" ]; then
  echo "Error: public directory does not exist."
  exit 1
fi

# Create a temporary directory for deployment
DEPLOY_DIR=$(mktemp -d)
echo "Using temp dir: $DEPLOY_DIR"
cp -r public/* "$DEPLOY_DIR"

# Stash any uncommitted changes
if ! git diff-index --quiet HEAD --; then
  echo "Stashing uncommitted changes..."
  git stash --include-untracked
  STASHED=1
else
  STASHED=0
fi

# Switch to gh-pages branch (create if needed)
git fetch origin
git checkout gh-pages 2>/dev/null || git checkout --orphan gh-pages

echo "Cleaning old files..."
find . -maxdepth 1 ! -name '.git' ! -name '.' -exec rm -rf {} +

# Copy new files from deploy dir
cp -r "$DEPLOY_DIR"/* .

# Add and commit

git add .
git commit -m "Deploy to GitHub Pages" || echo "No changes to commit."

git push origin gh-pages

# Switch back to previous branch
git checkout "$default_branch"

# Restore stashed changes if any
if [ "$STASHED" -eq 1 ]; then
  echo "Restoring stashed changes..."
  git stash pop || true
fi

# Clean up
echo "Cleaning up temp dir..."
rm -rf "$DEPLOY_DIR"

echo "Deployment complete! Your site should be live on GitHub Pages soon." 
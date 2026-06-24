#!/bin/bash
# Run all backend tests
set -e
cd "$(dirname "$0")/.."
echo "Running backend API tests..."
node tests/api.test.js

echo "Running finding-revision tests (dir_1782260457892)..."
node tests/finding-revision.test.js

echo "Running loop-halt-detector tests (dir_1782242371780)..."
node tests/loop-halt-detector.test.js

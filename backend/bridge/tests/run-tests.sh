#!/bin/bash
# Run all backend tests
set -e
cd "$(dirname "$0")/.."
echo "Running backend API tests..."
node tests/api.test.js

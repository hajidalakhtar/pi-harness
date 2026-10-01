#!/bin/bash
# Standard startup and verification entrypoint for the {{PROJECT_NAME}} harness.
# Edit the commands below to match the project, then run: ./init.sh
set -e

echo "=== Harness Initialization: {{PROJECT_NAME}} ==="
echo "Harness root: {{HARNESS_ROOT}}"
echo "Project root: {{PROJECT_ROOT}}"
echo ""

cd "$(dirname "$0")"

{{INIT_BODY}}

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done"

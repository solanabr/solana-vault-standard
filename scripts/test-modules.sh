#!/bin/bash
# Test script for module integration tests
# This script ensures the program is built with modules feature before running tests

set -e

echo "🔨 Building SVS-1 with modules feature..."
anchor build -- --features modules

echo "📝 Verifying IDL has module instructions..."
# The build above generates IDL, but let's verify (IDL uses snake_case)
if ! grep -q "initialize_fee_config" target/idl/svs_1.json 2>/dev/null; then
    echo "❌ IDL doesn't contain module instructions. Build may have failed."
    exit 1
fi

echo "✅ Module instructions found in IDL:"
grep -o '"initialize_fee_config"\|"update_fee_config"\|"initialize_cap_config"\|"update_cap_config"\|"initialize_lock_config"\|"update_lock_config"\|"initialize_access_config"\|"update_access_config"' target/idl/svs_1.json | sort -u

echo ""
echo "🧪 Running module tests with anchor test (uses local validator)..."
# Use --skip-build to avoid re-building without modules feature
anchor test --skip-build -- tests/modules.ts

echo ""
echo "✅ Module tests complete!"

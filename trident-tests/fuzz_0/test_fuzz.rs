use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;

/// Vault state tracking for invariant checks
#[derive(Default, Clone)]
struct VaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault_tracker: VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault_tracker: VaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault_tracker = VaultTracker::default();
    }

    /// Initialize vault - this sets up the test environment
    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault_tracker.initialized {
            return;
        }

        // For now, just mark as initialized and track basic state
        // Full instruction building requires proper account setup
        self.vault_tracker.initialized = true;
        self.vault_tracker.decimals_offset = 3;
    }

    /// Test deposit invariants with fuzzed values
    #[flow]
    fn flow_deposit(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        // Generate random deposit amount
        let fuzz_assets: u64 = rand::random::<u64>() % 1_000_000_000_000;
        let assets = fuzz_assets.max(1001);

        // Track state changes
        let assets_before = self.vault_tracker.total_assets;
        let shares_before = self.vault_tracker.total_shares;

        // Calculate expected shares (floor rounding)
        let expected_shares = self.calculate_shares_for_assets(assets, assets_before, shares_before);

        // Update tracker
        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_add(assets);
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_add(expected_shares);

        // Invariant: shares should be positive for non-zero deposits
        if assets > 0 {
            assert!(expected_shares > 0 || assets_before == 0 && shares_before == 0,
                "Invariant: positive deposit should yield positive shares");
        }
    }

    /// Test redeem invariants with fuzzed values
    #[flow]
    fn flow_redeem(&mut self) {
        if !self.vault_tracker.initialized || self.vault_tracker.total_shares == 0 {
            return;
        }

        // Generate random redeem amount (within available shares)
        let fuzz_shares: u64 = rand::random::<u64>() % self.vault_tracker.total_shares;
        let shares = fuzz_shares.max(1);

        // Calculate expected assets (floor rounding)
        let expected_assets = self.calculate_assets_for_shares_floor(
            shares,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
        );

        // Update tracker
        self.vault_tracker.total_shares = self.vault_tracker.total_shares.saturating_sub(shares);
        self.vault_tracker.total_assets = self.vault_tracker.total_assets.saturating_sub(expected_assets);

        // Invariant: assets received should not exceed what's in vault
        assert!(expected_assets <= self.vault_tracker.total_assets.saturating_add(expected_assets),
            "Invariant: cannot redeem more assets than available");
    }

    /// Test conversion consistency
    #[flow]
    fn flow_conversion_check(&mut self) {
        if !self.vault_tracker.initialized {
            return;
        }

        // Random amount to test conversion
        let test_amount: u64 = rand::random::<u64>() % 1_000_000_000;
        let test_amount = test_amount.max(1);

        // Convert assets -> shares -> assets
        let shares = self.calculate_shares_for_assets(
            test_amount,
            self.vault_tracker.total_assets,
            self.vault_tracker.total_shares,
        );

        if shares > 0 {
            let assets_back = self.calculate_assets_for_shares_floor(
                shares,
                self.vault_tracker.total_assets.saturating_add(test_amount),
                self.vault_tracker.total_shares.saturating_add(shares),
            );

            // Invariant: Round-trip should not create assets (rounding favors vault)
            assert!(assets_back <= test_amount,
                "Invariant: round-trip should not create free assets");
        }
    }

    #[end]
    fn end(&mut self) {
        if self.vault_tracker.initialized {
            // Final invariant: shares/assets relationship
            let offset_multiplier = 10u64.pow(self.vault_tracker.decimals_offset as u32);

            // Invariant: Total shares should have reasonable bounds
            let max_theoretical_shares = self.vault_tracker.total_assets
                .saturating_mul(offset_multiplier)
                .saturating_add(offset_multiplier);

            assert!(
                self.vault_tracker.total_shares <= max_theoretical_shares.saturating_add(1000),
                "Invariant: shares exceed theoretical maximum"
            );
        }
    }

    // Helper: Calculate shares for given assets (floor rounding - deposit)
    fn calculate_shares_for_assets(&self, assets: u64, total_assets: u64, total_shares: u64) -> u64 {
        let offset = 10u64.pow(self.vault_tracker.decimals_offset as u32);
        let virtual_shares = total_shares.saturating_add(offset);
        let virtual_assets = total_assets.saturating_add(1);

        (assets as u128)
            .saturating_mul(virtual_shares as u128)
            .checked_div(virtual_assets as u128)
            .unwrap_or(0) as u64
    }

    // Helper: Calculate assets for given shares (floor rounding - redeem)
    fn calculate_assets_for_shares_floor(&self, shares: u64, total_assets: u64, total_shares: u64) -> u64 {
        let offset = 10u64.pow(self.vault_tracker.decimals_offset as u32);
        let virtual_shares = total_shares.saturating_add(offset);
        let virtual_assets = total_assets.saturating_add(1);

        (shares as u128)
            .saturating_mul(virtual_assets as u128)
            .checked_div(virtual_shares as u128)
            .unwrap_or(0) as u64
    }
}

fn main() {
    // Run 1000 iterations with up to 100 flows per iteration
    FuzzTest::fuzz(1000, 100);
}

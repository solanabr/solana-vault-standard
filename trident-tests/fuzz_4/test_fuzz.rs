//! SVS-7: Native SOL Vault Fuzz Test
//!
//! Simulates the SVS-7 native SOL vault and validates three invariant groups:
//!
//! 1. **SOL Round-Trip Safety** — users can never redeem more SOL than deposited.
//! 2. **Share Price Monotonicity** — share price never decreases for existing holders.
//! 3. **Native SOL Wrapping Atomicity** — no SOL created or destroyed in wrap/unwrap cycles.
//!
//! SVS-7 specifics:
//! - Asset is always native SOL (NATIVE_MINT)
//! - wSOL vault = vault PDA's ATA for NATIVE_MINT
//! - NO balance_model field (always Live — reads wsol_vault.amount directly)
//! - NO total_assets field on vault struct
//! - NO sync instruction
//! - Deposit/redeem use Floor rounding; mint/withdraw use Ceiling rounding
//! - MIN_DEPOSIT_AMOUNT = 1000 lamports

use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

const NUM_USERS: usize = 4;
/// SOL has 9 decimals and DECIMALS_OFFSET = MAX_DECIMALS - 9 = 0.
const DECIMALS_OFFSET: u8 = 0;
/// Minimum deposit enforced by the SVS-7 program.
const MIN_DEPOSIT_AMOUNT: u64 = 1_000;
/// Scale factor used for share price comparison (avoids integer truncation).
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18

/// Per-user simulation state.
#[derive(Default, Clone, Copy)]
struct SVS7UserState {
    shares_balance: u64,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
}

/// Vault-level simulation state for SVS-7.
///
/// `total_assets` mirrors `wsol_vault.amount` (the wSOL token account balance).
/// There is no `total_assets` field on the vault account itself in SVS-7 — the
/// Live balance model always reads from the wSOL token account directly.
#[derive(Clone)]
struct SVS7VaultTracker {
    initialized: bool,
    /// Current wSOL token account balance (mirrors wsol_vault.amount).
    total_assets: u64,
    /// Current shares mint supply.
    total_shares: u64,
    /// Lowest observed share price (numerator in PRICE_SCALE units).
    /// Initialised to u128::MAX so the first real reading always wins.
    share_price_floor: u128,
    /// Sum of all user deposits across all operations.
    total_deposited: u128,
    /// Sum of all assets returned to users across all operations.
    total_redeemed: u128,
    users: [SVS7UserState; NUM_USERS],
}

impl Default for SVS7VaultTracker {
    fn default() -> Self {
        Self {
            initialized: false,
            total_assets: 0,
            total_shares: 0,
            share_price_floor: u128::MAX,
            total_deposited: 0,
            total_redeemed: 0,
            users: [SVS7UserState::default(); NUM_USERS],
        }
    }
}

impl SVS7VaultTracker {
    /// Compute current share price in PRICE_SCALE units.
    ///
    /// Uses the same virtual-offset formula as svs_math: numerator adds
    /// 10^DECIMALS_OFFSET virtual shares and 1 virtual asset to prevent
    /// division by zero and inflation attacks. With DECIMALS_OFFSET=0 the
    /// virtual offset is 1 share / 1 asset.
    fn current_price(&self) -> u128 {
        let virtual_offset = 10u128.pow(DECIMALS_OFFSET as u32); // = 1 for SOL
        let assets_num = (self.total_assets as u128).saturating_add(1);
        let shares_denom = (self.total_shares as u128).saturating_add(virtual_offset);
        assets_num
            .saturating_mul(PRICE_SCALE)
            .checked_div(shares_denom)
            .unwrap_or(0)
    }

    /// Update the share price floor and assert it never decreased.
    /// Also asserts: significant shares imply positive assets, and zero shares
    /// imply zero assets.
    fn check_and_update_price_floor(&mut self) {
        // Invariant 2 (shares/assets consistency)
        if self.total_shares > 1_000 {
            assert!(
                self.total_assets > 0,
                "Significant shares ({}) with zero assets",
                self.total_shares,
            );
        }
        if self.total_shares == 0 {
            assert_eq!(
                self.total_assets, 0,
                "Empty share supply but non-zero assets {}",
                self.total_assets,
            );
            return;
        }

        // Invariant 2 (price monotonicity)
        let price = self.current_price();
        if self.share_price_floor == u128::MAX {
            // First observation — initialise floor.
            self.share_price_floor = price;
        } else {
            assert!(
                price >= self.share_price_floor,
                "Share price decreased: was {} now {} (assets={}, shares={})",
                self.share_price_floor,
                price,
                self.total_assets,
                self.total_shares,
            );
        }
        // Update floor to the current (non-decreasing) price.
        self.share_price_floor = price;
    }

    fn user_shares_sum(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, u| acc.saturating_add(u.shares_balance))
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault: SVS7VaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault: SVS7VaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault = SVS7VaultTracker::default();
    }

    // =========================================================================
    // Initialize vault (vault_id = 1, DECIMALS_OFFSET = 0)
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault.initialized {
            return;
        }
        self.vault.initialized = true;
        // DECIMALS_OFFSET is always 0 for SVS-7 (SOL = 9 decimals, offset = 9 - 9 = 0)
    }

    // =========================================================================
    // Invariant 1 helper — SOL Round-Trip Safety
    // =========================================================================

    /// Deposit native SOL into the vault.
    ///
    /// The program wraps the SOL to wSOL (sync_native), transfers to wsol_vault,
    /// and mints shares to the user. Total assets increases by the deposit amount.
    #[flow]
    fn flow_deposit_sol(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000_000).max(MIN_DEPOSIT_AMOUNT);
        let user_idx = random_user();

        let shares = match convert_to_shares(
            assets,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.total_deposited = self.vault.total_deposited.saturating_add(assets as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited = self.vault.users[user_idx]
            .cumulative_deposited
            .saturating_add(assets as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    /// Deposit wSOL into the vault.
    ///
    /// The program transfers from the user's wSOL account to wsol_vault directly.
    /// From the vault's perspective, total_assets increases identically to deposit_sol.
    #[flow]
    fn flow_deposit_wsol(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000_000).max(MIN_DEPOSIT_AMOUNT);
        let user_idx = random_user();

        let shares = match convert_to_shares(
            assets,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.total_deposited = self.vault.total_deposited.saturating_add(assets as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited = self.vault.users[user_idx]
            .cumulative_deposited
            .saturating_add(assets as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    /// Redeem shares for native SOL.
    ///
    /// The program burns shares, withdraws wSOL from wsol_vault, and closes the
    /// temporary wSOL account to return native SOL to the user. Total assets
    /// decreases by the redeemed amount.
    #[flow]
    fn flow_redeem_sol(&mut self) {
        if !self.vault.initialized || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        let assets = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault.total_assets {
            return;
        }

        self.vault.total_assets = self.vault.total_assets.saturating_sub(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.total_redeemed = self.vault.total_redeemed.saturating_add(assets as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault.users[user_idx].cumulative_redeemed = self.vault.users[user_idx]
            .cumulative_redeemed
            .saturating_add(assets as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    /// Redeem shares for wSOL.
    ///
    /// Burns shares and transfers wSOL from wsol_vault to the user's wSOL ATA.
    /// Total assets decreases by the redeemed amount.
    #[flow]
    fn flow_redeem_wsol(&mut self) {
        if !self.vault.initialized || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);

        let assets = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault.total_assets {
            return;
        }

        self.vault.total_assets = self.vault.total_assets.saturating_sub(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.total_redeemed = self.vault.total_redeemed.saturating_add(assets as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares);
        self.vault.users[user_idx].cumulative_redeemed = self.vault.users[user_idx]
            .cumulative_redeemed
            .saturating_add(assets as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    /// Withdraw an exact SOL amount.
    ///
    /// Uses Ceiling rounding (withdraw burns more shares than redeem for the
    /// same asset amount). The program computes shares = convert_to_shares(amount,
    /// Ceiling) and burns them, then sends the exact amount to the user.
    #[flow]
    fn flow_withdraw_sol(&mut self) {
        if !self.vault.initialized || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        // Amount must be <= what the user's shares are worth.
        let max_assets = match convert_to_assets(
            user_shares,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if max_assets < MIN_DEPOSIT_AMOUNT {
            return;
        }

        let amount: u64 = (rand::random::<u64>() % max_assets).max(MIN_DEPOSIT_AMOUNT);

        // Withdraw uses Ceiling rounding on shares (user pays slightly more).
        let shares_needed = match convert_to_shares(
            amount,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Ceiling,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares_needed > user_shares {
            return;
        }
        if amount > self.vault.total_assets {
            return;
        }

        self.vault.total_assets = self.vault.total_assets.saturating_sub(amount);
        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares_needed);
        self.vault.total_redeemed = self.vault.total_redeemed.saturating_add(amount as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_sub(shares_needed);
        self.vault.users[user_idx].cumulative_redeemed = self.vault.users[user_idx]
            .cumulative_redeemed
            .saturating_add(amount as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    /// Mint an exact number of shares.
    ///
    /// Uses Ceiling rounding on assets (user pays slightly more assets per share
    /// than they would get back via redeem). This is the "mint" operation symmetric
    /// to withdraw.
    #[flow]
    fn flow_mint_sol(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let user_idx = random_user();

        // Pick a shares amount to mint. Cap at a reasonable size.
        let shares: u64 = (rand::random::<u64>() % 1_000_000_000).max(1);

        // Mint uses Ceiling rounding on assets (user pays more).
        let assets_needed = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Ceiling,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets_needed < MIN_DEPOSIT_AMOUNT {
            return;
        }

        // INVARIANT: mint(shares) always costs >= redeem(shares) in assets.
        // This ensures mint does not give users a cheaper route than deposit.
        let assets_from_redeem = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };
        assert!(
            assets_needed >= assets_from_redeem,
            "mint is cheaper than redeem: mint_cost={} redeem_value={} shares={}",
            assets_needed,
            assets_from_redeem,
            shares,
        );

        self.vault.total_assets = self.vault.total_assets.saturating_add(assets_needed);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);
        self.vault.total_deposited = self
            .vault
            .total_deposited
            .saturating_add(assets_needed as u128);

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited = self.vault.users[user_idx]
            .cumulative_deposited
            .saturating_add(assets_needed as u128);

        self.check_roundtrip_safety(user_idx);
        self.vault.check_and_update_price_floor();
        self.check_wrapping_atomicity();
    }

    // =========================================================================
    // Invariant checks (called after each flow)
    // =========================================================================

    /// Invariant 1: SOL Round-Trip Safety.
    ///
    /// For user[user_idx]: cumulative_redeemed <= cumulative_deposited.
    /// No individual user should ever recover more SOL than they put in.
    fn check_roundtrip_safety(&self, user_idx: usize) {
        let user = &self.vault.users[user_idx];
        assert!(
            user.cumulative_redeemed <= user.cumulative_deposited,
            "Roundtrip safety violation for user {}: redeemed {} > deposited {}",
            user_idx,
            user.cumulative_redeemed,
            user.cumulative_deposited,
        );

        // Global: total_redeemed <= total_deposited (no SOL from nowhere)
        assert!(
            self.vault.total_redeemed <= self.vault.total_deposited,
            "Global roundtrip safety violation: total_redeemed {} > total_deposited {}",
            self.vault.total_redeemed,
            self.vault.total_deposited,
        );
    }

    /// Invariant 3: Native SOL Wrapping Atomicity.
    ///
    /// No SOL is created or destroyed in wrap/unwrap cycles. In the simulation
    /// this means total_assets == total_deposited - total_redeemed at all times
    /// (the wSOL vault balance always equals net inflows).
    fn check_wrapping_atomicity(&self) {
        let net_inflow = self
            .vault
            .total_deposited
            .saturating_sub(self.vault.total_redeemed);
        assert_eq!(
            self.vault.total_assets as u128, net_inflow,
            "Wrapping atomicity violation: wsol_balance={} net_inflow={} (deposited={} redeemed={})",
            self.vault.total_assets,
            net_inflow,
            self.vault.total_deposited,
            self.vault.total_redeemed,
        );
    }

    // =========================================================================
    // End invariants (run once at fuzz test completion)
    // =========================================================================

    #[end]
    fn end(&mut self) {
        if !self.vault.initialized {
            return;
        }

        // INVARIANT 1: Global SOL round-trip safety — no SOL created from nothing.
        assert!(
            self.vault.total_redeemed <= self.vault.total_deposited,
            "End: total_redeemed {} > total_deposited {}",
            self.vault.total_redeemed,
            self.vault.total_deposited,
        );

        // INVARIANT 1: Per-user round-trip safety.
        for (i, user) in self.vault.users.iter().enumerate() {
            assert!(
                user.cumulative_redeemed <= user.cumulative_deposited,
                "End: user {} redeemed {} > deposited {}",
                i,
                user.cumulative_redeemed,
                user.cumulative_deposited,
            );
        }

        // INVARIANT 2: Share accounting — user balances sum to total_shares.
        let user_sum = self.vault.user_shares_sum();
        assert_eq!(
            user_sum, self.vault.total_shares,
            "End: user shares sum {} != total_shares {}",
            user_sum, self.vault.total_shares,
        );

        // INVARIANT 2: Significant shares require positive assets.
        if self.vault.total_shares > 1_000 {
            assert!(
                self.vault.total_assets > 0,
                "End: significant shares ({}) with zero assets",
                self.vault.total_shares,
            );
        }

        // INVARIANT 2: Share price floor was never 0 while shares existed.
        // (share_price_floor == u128::MAX means no shares were ever minted)
        if self.vault.share_price_floor != u128::MAX {
            assert!(
                self.vault.share_price_floor > 0,
                "End: share price floor reached 0 while shares were outstanding",
            );
        }

        // INVARIANT 3: wSOL balance exactly equals net inflow (no lamports leaked).
        let net_inflow = self
            .vault
            .total_deposited
            .saturating_sub(self.vault.total_redeemed);
        assert_eq!(
            self.vault.total_assets as u128,
            net_inflow,
            "End: wsol_balance {} != net_inflow {} (deposited={} redeemed={})",
            self.vault.total_assets,
            net_inflow,
            self.vault.total_deposited,
            self.vault.total_redeemed,
        );

        // INVARIANT 3: If shares are 0, wSOL vault must also be empty.
        if self.vault.total_shares == 0 {
            assert_eq!(
                self.vault.total_assets, 0,
                "End: no shares outstanding but wsol_vault still holds {} lamports",
                self.vault.total_assets,
            );
        }
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}

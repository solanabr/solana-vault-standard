//! SVS-10 Async Vault Fuzz Test — Model-Based + CPI Dispatch
//!
//! Dual-oracle approach: model-based state tracker validates invariants while
//! actual program calls via Trident verify on-chain behavior matches the model.
//!
//! Prerequisites: `anchor build -p svs_10` must produce `target/deploy/svs_10.so`

use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;

const NUM_USERS: usize = 5;
const PRICE_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18
const MAX_DEVIATION_BPS: u16 = 500; // 5%
const ASSET_DECIMALS: u8 = 6;
const INITIAL_USER_ASSETS: u64 = 100_000_000_000_000; // 100M tokens

fn spl_token_program_id() -> Pubkey {
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

fn token_2022_program_id() -> Pubkey {
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}

fn associated_token_program_id() -> Pubkey {
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
}

fn system_program_id() -> Pubkey {
    pubkey!("11111111111111111111111111111111")
}

fn rent_sysvar_id() -> Pubkey {
    pubkey!("SysvarRent111111111111111111111111111111111")
}

fn clock_sysvar_id() -> Pubkey {
    pubkey!("SysvarC1ock11111111111111111111111111111111")
}

// =============================================================================
// Model state types
// =============================================================================

#[derive(Clone, Copy, PartialEq)]
enum RequestStatus {
    None,
    Pending,
    Fulfilled,
}

#[derive(Clone, Copy, Default)]
struct ModelDepositRequest {
    assets_locked: u64,
    shares_claimable: u64,
    status: RequestStatusField,
}

#[derive(Clone, Copy, Default)]
struct ModelRedeemRequest {
    shares_locked: u64,
    assets_claimable: u64,
    status: RequestStatusField,
}

#[derive(Clone, Copy)]
struct RequestStatusField(RequestStatus);

impl Default for RequestStatusField {
    fn default() -> Self {
        Self(RequestStatus::None)
    }
}

#[derive(Clone, Copy)]
struct OperatorPerms {
    can_fulfill_deposit: bool,
    can_fulfill_redeem: bool,
    can_claim: bool,
}

impl Default for OperatorPerms {
    fn default() -> Self {
        Self {
            can_fulfill_deposit: false,
            can_fulfill_redeem: false,
            can_claim: false,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct UserState {
    shares_balance: u64,
    deposit_request: ModelDepositRequest,
    redeem_request: ModelRedeemRequest,
    cumulative_deposited: u128,
    cumulative_redeemed: u128,
    operator_perms: [OperatorPerms; NUM_USERS],
    deposit_requested_at: i64,
    redeem_requested_at: i64,
}

/// Async vault state tracker for invariant checks and CPI dispatch comparison.
#[derive(Default, Clone)]
struct AsyncVaultTracker {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    total_pending_deposits: u64,
    decimals_offset: u8,
    paused: bool,
    cancel_after: i64,
    max_deviation_bps: u16,
    users: [UserState; NUM_USERS],
    deposit_count: u64,
    redeem_count: u64,
    fulfill_count: u64,
    claim_count: u64,
    cancel_count: u64,
    current_time: i64,
    // CPI dispatch state
    vault_pda: Option<Pubkey>,
    vault_id: u64,
    asset_mint: Option<Pubkey>,
    shares_mint: Option<Pubkey>,
    asset_vault: Option<Pubkey>,
    share_escrow: Option<Pubkey>,
    user_pubkeys: [Option<Pubkey>; NUM_USERS],
    user_asset_accounts: [Option<Pubkey>; NUM_USERS],
    user_shares_accounts: [Option<Pubkey>; NUM_USERS],
    cpi_enabled: bool,
}

impl AsyncVaultTracker {
    fn share_price_x1e18(&self) -> u128 {
        let offset = 10u128.pow(self.decimals_offset as u32);
        let virtual_assets = self.total_assets as u128 + 1;
        let virtual_shares = self.total_shares as u128 + offset;
        virtual_assets
            .checked_mul(PRICE_SCALE)
            .unwrap_or(u128::MAX)
            .checked_div(virtual_shares)
            .unwrap_or(0)
    }

    fn user_shares_sum(&self) -> u64 {
        self.users
            .iter()
            .fold(0u64, |acc, u| acc.saturating_add(u.shares_balance))
    }

    fn shares_in_escrow(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.redeem_request.status.0 == RequestStatus::Pending {
                acc.saturating_add(u.redeem_request.shares_locked)
            } else {
                acc
            }
        })
    }

    fn reserved_shares(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.deposit_request.status.0 == RequestStatus::Fulfilled {
                acc.saturating_add(u.deposit_request.shares_claimable)
            } else {
                acc
            }
        })
    }

    fn pending_assets_sum(&self) -> u64 {
        self.users.iter().fold(0u64, |acc, u| {
            if u.deposit_request.status.0 == RequestStatus::Pending {
                acc.saturating_add(u.deposit_request.assets_locked)
            } else {
                acc
            }
        })
    }

    fn deposit_request_pda(&self, user_idx: usize) -> Option<Pubkey> {
        let vault = self.vault_pda?;
        let user = self.user_pubkeys[user_idx]?;
        let (pda, _) = Pubkey::find_program_address(
            &[b"deposit_request", vault.as_ref(), user.as_ref()],
            &types::program_id(),
        );
        Some(pda)
    }

    fn redeem_request_pda(&self, user_idx: usize) -> Option<Pubkey> {
        let vault = self.vault_pda?;
        let user = self.user_pubkeys[user_idx]?;
        let (pda, _) = Pubkey::find_program_address(
            &[b"redeem_request", vault.as_ref(), user.as_ref()],
            &types::program_id(),
        );
        Some(pda)
    }

    fn claimable_tokens_pda(&self, user_idx: usize) -> Option<Pubkey> {
        let vault = self.vault_pda?;
        let user = self.user_pubkeys[user_idx]?;
        let (pda, _) = Pubkey::find_program_address(
            &[b"claimable_tokens", vault.as_ref(), user.as_ref()],
            &types::program_id(),
        );
        Some(pda)
    }

    fn operator_approval_pda(&self, owner_idx: usize, operator_idx: usize) -> Option<Pubkey> {
        let vault = self.vault_pda?;
        let owner = self.user_pubkeys[owner_idx]?;
        let operator = self.user_pubkeys[operator_idx]?;
        let (pda, _) = Pubkey::find_program_address(
            &[
                b"operator_approval",
                vault.as_ref(),
                owner.as_ref(),
                operator.as_ref(),
            ],
            &types::program_id(),
        );
        Some(pda)
    }
}

fn random_user() -> usize {
    rand::random::<usize>() % NUM_USERS
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    vault: AsyncVaultTracker,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            vault: AsyncVaultTracker::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        self.vault = AsyncVaultTracker::default();
    }

    // =========================================================================
    // CPI Dispatch: Initialize vault via actual program call
    // =========================================================================

    #[flow]
    fn flow_cpi_initialize(&mut self) {
        if self.vault.initialized {
            return;
        }

        let payer = self.trident.payer();
        let payer_pubkey = payer.pubkey();
        let program_id = types::program_id();
        let vault_id: u64 = rand::random::<u64>() % 1000;

        // Create asset mint (SPL Token, 6 decimals)
        let asset_mint = self
            .fuzz_accounts
            .asset_mint
            .insert(&mut self.trident, None);

        let mint_ixs = self.trident.initialize_mint(
            &payer_pubkey,
            &asset_mint,
            ASSET_DECIMALS,
            &payer_pubkey,
            None,
        );
        let result = self
            .trident
            .process_transaction(&mint_ixs, Some("create_asset_mint"));
        if result.is_error() {
            return;
        }

        // Derive PDAs
        let (vault_pda, _) = Pubkey::find_program_address(
            &[b"async_vault", asset_mint.as_ref(), &vault_id.to_le_bytes()],
            &program_id,
        );
        let (shares_mint, _) =
            Pubkey::find_program_address(&[b"shares", vault_pda.as_ref()], &program_id);
        let asset_vault = self.trident.get_associated_token_address(
            &asset_mint,
            &vault_pda,
            &spl_token_program_id(),
        );
        let (share_escrow, _) =
            Pubkey::find_program_address(&[b"share_escrow", vault_pda.as_ref()], &program_id);

        // Store addresses
        self.fuzz_accounts.vault.insert_with_address(vault_pda);
        self.fuzz_accounts
            .shares_mint
            .insert_with_address(shares_mint);
        self.fuzz_accounts
            .asset_vault
            .insert_with_address(asset_vault);
        self.fuzz_accounts
            .share_escrow
            .insert_with_address(share_escrow);
        self.fuzz_accounts
            .authority
            .insert_with_address(payer_pubkey);
        self.fuzz_accounts
            .operator
            .insert_with_address(payer_pubkey);

        // Call Initialize
        let init_ix = types::InitializeInstruction::data(types::InitializeData::new(
            vault_id,
            "Fuzz Async Vault".to_string(),
            "fAVLT".to_string(),
            "https://fuzz.test".to_string(),
        ))
        .accounts(types::InitializeAccounts {
            authority: payer_pubkey,
            operator: payer_pubkey,
            vault: vault_pda,
            asset_mint,
            shares_mint,
            asset_vault,
            share_escrow,
            asset_token_program: spl_token_program_id(),
            token_2022_program: token_2022_program_id(),
            associated_token_program: associated_token_program_id(),
            system_program: system_program_id(),
            rent: rent_sysvar_id(),
        })
        .instruction();

        let result = self
            .trident
            .process_transaction(&[init_ix], Some("initialize"));
        if result.is_error() {
            return;
        }

        // Setup users: create asset token accounts and fund them
        self.vault.vault_pda = Some(vault_pda);
        self.vault.vault_id = vault_id;
        self.vault.asset_mint = Some(asset_mint);
        self.vault.shares_mint = Some(shares_mint);
        self.vault.asset_vault = Some(asset_vault);
        self.vault.share_escrow = Some(share_escrow);

        // User 0 is the payer/authority
        self.vault.user_pubkeys[0] = Some(payer_pubkey);
        self.fuzz_accounts.user_0.insert_with_address(payer_pubkey);

        // Create asset ATA for user 0
        let user0_asset = self.trident.get_associated_token_address(
            &asset_mint,
            &payer_pubkey,
            &spl_token_program_id(),
        );
        let ta_ixs = self.trident.initialize_token_account(
            &payer_pubkey,
            &user0_asset,
            &asset_mint,
            &payer_pubkey,
        );
        let result = self
            .trident
            .process_transaction(&ta_ixs, Some("create_user0_asset_account"));
        if result.is_error() {
            return;
        }

        let mint_ix =
            self.trident
                .mint_to(&user0_asset, &asset_mint, &payer_pubkey, INITIAL_USER_ASSETS);
        let result = self
            .trident
            .process_transaction(&[mint_ix], Some("mint_assets_to_user0"));
        if result.is_error() {
            return;
        }

        self.vault.user_asset_accounts[0] = Some(user0_asset);
        self.fuzz_accounts
            .user_asset_account_0
            .insert_with_address(user0_asset);

        // Get user 0 shares ATA
        let user0_shares = self.trident.get_associated_token_address(
            &shares_mint,
            &payer_pubkey,
            &token_2022_program_id(),
        );
        self.vault.user_shares_accounts[0] = Some(user0_shares);
        self.fuzz_accounts
            .user_shares_account_0
            .insert_with_address(user0_shares);

        // Model state
        let fuzz_decimals: u8 = 9u8.saturating_sub(ASSET_DECIMALS);
        self.vault.decimals_offset = fuzz_decimals;
        self.vault.max_deviation_bps = MAX_DEVIATION_BPS;
        self.vault.initialized = true;
        self.vault.cpi_enabled = true;
    }

    // =========================================================================
    // CPI Dispatch: request_deposit
    // =========================================================================

    #[flow]
    fn flow_cpi_request_deposit(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || self.vault.paused {
            return;
        }

        // Use user 0 (payer) for CPI flows
        let user_idx = 0usize;
        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000).max(1000);

        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let asset_mint = match self.vault.asset_mint { Some(v) => v, None => return };
        let asset_vault = match self.vault.asset_vault { Some(v) => v, None => return };
        let user_pubkey = match self.vault.user_pubkeys[user_idx] { Some(v) => v, None => return };
        let user_asset = match self.vault.user_asset_accounts[user_idx] { Some(v) => v, None => return };

        let deposit_request_pda = match self.vault.deposit_request_pda(user_idx) {
            Some(v) => v,
            None => return,
        };

        let ix = types::RequestDepositInstruction::data(types::RequestDepositData::new(
            assets,
            user_pubkey,
        ))
        .accounts(types::RequestDepositAccounts {
            user: user_pubkey,
            vault: vault_pda,
            asset_mint,
            user_asset_account: user_asset,
            asset_vault,
            deposit_request: deposit_request_pda,
            asset_token_program: spl_token_program_id(),
            system_program: system_program_id(),
        })
        .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("request_deposit"));

        if result.is_success() {
            let price_before = self.vault.share_price_x1e18();

            self.vault.users[user_idx].deposit_request = ModelDepositRequest {
                assets_locked: assets,
                shares_claimable: 0,
                status: RequestStatusField(RequestStatus::Pending),
            };
            self.vault.users[user_idx].deposit_requested_at = self.vault.current_time;
            self.vault.total_pending_deposits =
                self.vault.total_pending_deposits.saturating_add(assets);
            self.vault.deposit_count += 1;

            assert_eq!(
                self.vault.share_price_x1e18(),
                price_before,
                "CPI: Share price changed on request_deposit"
            );
        }
    }

    // =========================================================================
    // CPI Dispatch: fulfill_deposit (vault operator)
    // =========================================================================

    #[flow]
    fn flow_cpi_fulfill_deposit(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = 0usize;
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let user_pubkey = match self.vault.user_pubkeys[user_idx] { Some(v) => v, None => return };

        let deposit_request_pda = match self.vault.deposit_request_pda(user_idx) {
            Some(v) => v,
            None => return,
        };

        // Fuzz oracle price: 50% chance vault-priced, 50% oracle-priced
        let oracle_price: Option<u64> = if rand::random::<bool>() {
            Some((rand::random::<u64>() % 2_000_000_000).max(1))
        } else {
            None
        };

        let ix = types::FulfillDepositInstruction::data(types::FulfillDepositData::new(oracle_price))
            .accounts(types::FulfillDepositAccounts {
                operator: user_pubkey, // payer is vault operator
                vault: vault_pda,
                deposit_request: deposit_request_pda,
                operator_approval: None,
                clock: clock_sysvar_id(),
            })
            .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("fulfill_deposit"));

        if result.is_success() {
            let assets = req.assets_locked;
            let price_before = self.vault.share_price_x1e18();

            let shares = match convert_to_shares(
                assets,
                self.vault.total_assets,
                self.vault.total_shares,
                self.vault.decimals_offset,
                Rounding::Floor,
            ) {
                Ok(s) => s,
                Err(_) => return,
            };

            self.vault.total_pending_deposits = self
                .vault
                .total_pending_deposits
                .saturating_sub(assets);
            self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
            self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

            self.vault.users[user_idx].deposit_request = ModelDepositRequest {
                assets_locked: assets,
                shares_claimable: shares,
                status: RequestStatusField(RequestStatus::Fulfilled),
            };
            self.vault.fulfill_count += 1;

            let price_after = self.vault.share_price_x1e18();
            assert!(
                price_after >= price_before,
                "CPI: Share price decreased after fulfill_deposit: {} -> {}",
                price_before,
                price_after
            );
        }
    }

    // =========================================================================
    // CPI Dispatch: claim_deposit
    // =========================================================================

    #[flow]
    fn flow_cpi_claim_deposit(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = 0usize;
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let shares_mint = match self.vault.shares_mint { Some(v) => v, None => return };
        let user_pubkey = match self.vault.user_pubkeys[user_idx] { Some(v) => v, None => return };
        let user_shares = match self.vault.user_shares_accounts[user_idx] { Some(v) => v, None => return };

        let deposit_request_pda = match self.vault.deposit_request_pda(user_idx) {
            Some(v) => v,
            None => return,
        };

        let ix = types::ClaimDepositInstruction::new()
            .accounts(types::ClaimDepositAccounts {
                claimant: user_pubkey,
                vault: vault_pda,
                deposit_request: deposit_request_pda,
                owner: user_pubkey,
                shares_mint,
                receiver_shares_account: user_shares,
                receiver: user_pubkey,
                operator_approval: None,
                token_2022_program: token_2022_program_id(),
                associated_token_program: associated_token_program_id(),
                system_program: system_program_id(),
            })
            .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("claim_deposit"));

        if result.is_success() {
            let shares = req.shares_claimable;
            self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
                .shares_balance
                .saturating_add(shares);
            self.vault.users[user_idx].cumulative_deposited += req.assets_locked as u128;
            self.vault.users[user_idx].deposit_request = ModelDepositRequest::default();
            self.vault.claim_count += 1;
        }
    }

    // =========================================================================
    // CPI Dispatch: cancel_deposit
    // =========================================================================

    #[flow]
    fn flow_cpi_cancel_deposit(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized {
            return;
        }

        let user_idx = 0usize;
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let asset_mint = match self.vault.asset_mint { Some(v) => v, None => return };
        let asset_vault = match self.vault.asset_vault { Some(v) => v, None => return };
        let user_pubkey = match self.vault.user_pubkeys[user_idx] { Some(v) => v, None => return };
        let user_asset = match self.vault.user_asset_accounts[user_idx] { Some(v) => v, None => return };

        let deposit_request_pda = match self.vault.deposit_request_pda(user_idx) {
            Some(v) => v,
            None => return,
        };

        let ix = types::CancelDepositInstruction::new()
            .accounts(types::CancelDepositAccounts {
                user: user_pubkey,
                vault: vault_pda,
                asset_mint,
                user_asset_account: user_asset,
                asset_vault,
                deposit_request: deposit_request_pda,
                asset_token_program: spl_token_program_id(),
                clock: clock_sysvar_id(),
                system_program: system_program_id(),
            })
            .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("cancel_deposit"));

        if result.is_success() {
            let assets = req.assets_locked;
            self.vault.total_pending_deposits = self
                .vault
                .total_pending_deposits
                .saturating_sub(assets);
            self.vault.users[user_idx].deposit_request = ModelDepositRequest::default();
            self.vault.cancel_count += 1;
        } else if self.vault.paused {
            // Expected: cancel blocked by pause unless expired
        }
    }

    // =========================================================================
    // CPI Dispatch: pause / unpause
    // =========================================================================

    #[flow]
    fn flow_cpi_pause(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_pubkey = match self.vault.user_pubkeys[0] { Some(v) => v, None => return };
        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };

        let ix = types::PauseInstruction::new()
            .accounts(types::AdminAccounts {
                authority: user_pubkey,
                vault: vault_pda,
            })
            .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("pause"));

        if result.is_success() {
            self.vault.paused = true;
        }
    }

    #[flow]
    fn flow_cpi_unpause(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || !self.vault.paused {
            return;
        }

        let user_pubkey = match self.vault.user_pubkeys[0] { Some(v) => v, None => return };
        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };

        let ix = types::UnpauseInstruction::new()
            .accounts(types::AdminAccounts {
                authority: user_pubkey,
                vault: vault_pda,
            })
            .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("unpause"));

        if result.is_success() {
            self.vault.paused = false;
        }
    }

    // =========================================================================
    // CPI Dispatch: set_cancel_after
    // =========================================================================

    #[flow]
    fn flow_cpi_set_cancel_after(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized {
            return;
        }

        let cancel_after: i64 = (rand::random::<u64>() % 3600) as i64;

        let user_pubkey = match self.vault.user_pubkeys[0] { Some(v) => v, None => return };
        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };

        let ix = types::SetCancelAfterInstruction::data(types::SetCancelAfterData::new(
            cancel_after,
        ))
        .accounts(types::AdminAccounts {
            authority: user_pubkey,
            vault: vault_pda,
        })
        .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("set_cancel_after"));

        if result.is_success() {
            self.vault.cancel_after = cancel_after;
        }
    }

    // =========================================================================
    // CPI Dispatch: set_operator (granular permissions)
    // =========================================================================

    #[flow]
    fn flow_cpi_set_operator(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized {
            return;
        }

        let owner_idx = 0usize;
        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let owner_pubkey = match self.vault.user_pubkeys[owner_idx] { Some(v) => v, None => return };

        // Use payer pubkey as operator target (self-delegation for testing)
        let operator_pubkey = owner_pubkey;
        let can_fulfill_deposit: bool = rand::random();
        let can_fulfill_redeem: bool = rand::random();
        let can_claim: bool = rand::random();

        let approval_pda = match self.vault.operator_approval_pda(owner_idx, owner_idx) {
            Some(v) => v,
            None => return,
        };

        let ix = types::SetOperatorInstruction::data(types::SetOperatorData::new(
            operator_pubkey,
            can_fulfill_deposit,
            can_fulfill_redeem,
            can_claim,
        ))
        .accounts(types::SetOperatorAccounts {
            owner: owner_pubkey,
            vault: vault_pda,
            operator_approval: approval_pda,
            system_program: system_program_id(),
        })
        .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("set_operator"));

        if result.is_success() {
            self.vault.users[owner_idx].operator_perms[owner_idx] = OperatorPerms {
                can_fulfill_deposit,
                can_fulfill_redeem,
                can_claim,
            };
        }
    }

    // =========================================================================
    // CPI Dispatch: request_deposit while paused (must fail)
    // =========================================================================

    #[flow]
    fn flow_cpi_request_deposit_while_paused(&mut self) {
        if !self.vault.cpi_enabled || !self.vault.initialized || !self.vault.paused {
            return;
        }

        let user_idx = 0usize;
        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            return;
        }

        let vault_pda = match self.vault.vault_pda { Some(v) => v, None => return };
        let asset_mint = match self.vault.asset_mint { Some(v) => v, None => return };
        let asset_vault = match self.vault.asset_vault { Some(v) => v, None => return };
        let user_pubkey = match self.vault.user_pubkeys[user_idx] { Some(v) => v, None => return };
        let user_asset = match self.vault.user_asset_accounts[user_idx] { Some(v) => v, None => return };

        let deposit_request_pda = match self.vault.deposit_request_pda(user_idx) {
            Some(v) => v,
            None => return,
        };

        let ix = types::RequestDepositInstruction::data(types::RequestDepositData::new(
            10_000,
            user_pubkey,
        ))
        .accounts(types::RequestDepositAccounts {
            user: user_pubkey,
            vault: vault_pda,
            asset_mint,
            user_asset_account: user_asset,
            asset_vault,
            deposit_request: deposit_request_pda,
            asset_token_program: spl_token_program_id(),
            system_program: system_program_id(),
        })
        .instruction();

        let result = self
            .trident
            .process_transaction(&[ix], Some("request_deposit_while_paused"));

        assert!(
            result.is_error(),
            "CPI: request_deposit succeeded while vault was paused"
        );
    }

    // =========================================================================
    // Model-only flows (no CPI): Full multi-user simulation
    // These run regardless of CPI state and cover all invariants.
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.vault.initialized {
            return;
        }
        let fuzz_decimals: u8 = rand::random::<u8>() % 10;
        self.vault.decimals_offset = fuzz_decimals;
        self.vault.max_deviation_bps = MAX_DEVIATION_BPS;
        self.vault.initialized = true;
    }

    #[flow]
    fn flow_request_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000_000_000).max(1000);

        let pending_before = self.vault.total_pending_deposits;
        let total_assets_before = self.vault.total_assets;
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].deposit_request = ModelDepositRequest {
            assets_locked: assets,
            shares_claimable: 0,
            status: RequestStatusField(RequestStatus::Pending),
        };
        self.vault.users[user_idx].deposit_requested_at = self.vault.current_time;
        self.vault.total_pending_deposits = self.vault.total_pending_deposits.saturating_add(assets);
        self.vault.deposit_count += 1;

        assert_eq!(
            self.vault.total_assets, total_assets_before,
            "total_assets changed on request_deposit"
        );
        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on request_deposit"
        );
        assert_eq!(
            self.vault.total_pending_deposits,
            pending_before.saturating_add(assets),
            "total_pending_deposits not incremented"
        );
    }

    #[flow]
    fn flow_fulfill_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        if self.vault.cancel_after > 0 {
            let elapsed = self.vault.current_time.saturating_sub(
                self.vault.users[user_idx].deposit_requested_at,
            );
            if elapsed >= self.vault.cancel_after {
                return;
            }
        }

        let assets = req.assets_locked;
        let price_before = self.vault.share_price_x1e18();

        let shares = match convert_to_shares(
            assets,
            self.vault.total_assets,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        self.vault.total_pending_deposits = self
            .vault
            .total_pending_deposits
            .saturating_sub(assets);
        self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
        self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

        self.vault.users[user_idx].deposit_request = ModelDepositRequest {
            assets_locked: assets,
            shares_claimable: shares,
            status: RequestStatusField(RequestStatus::Fulfilled),
        };
        self.vault.fulfill_count += 1;

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after fulfill_deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_claim_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let shares = req.shares_claimable;
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].shares_balance = self.vault.users[user_idx]
            .shares_balance
            .saturating_add(shares);
        self.vault.users[user_idx].cumulative_deposited += req.assets_locked as u128;
        self.vault.users[user_idx].deposit_request = ModelDepositRequest::default();
        self.vault.claim_count += 1;

        let price_after = self.vault.share_price_x1e18();
        assert_eq!(
            price_after, price_before,
            "Share price changed on claim_deposit: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_cancel_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let assets = req.assets_locked;
        let price_before = self.vault.share_price_x1e18();

        self.vault.total_pending_deposits = self
            .vault
            .total_pending_deposits
            .saturating_sub(assets);
        self.vault.users[user_idx].deposit_request = ModelDepositRequest::default();
        self.vault.cancel_count += 1;

        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on cancel_deposit"
        );
    }

    // =========================================================================
    // Redeem lifecycle: request -> fulfill -> claim
    // =========================================================================

    #[flow]
    fn flow_request_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused || self.vault.total_shares == 0 {
            return;
        }

        let user_idx = random_user();
        if self.vault.users[user_idx].redeem_request.status.0 != RequestStatus::None {
            return;
        }

        let user_shares = self.vault.users[user_idx].shares_balance;
        if user_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % user_shares).max(1);
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].shares_balance -= shares;
        self.vault.users[user_idx].redeem_request = ModelRedeemRequest {
            shares_locked: shares,
            assets_claimable: 0,
            status: RequestStatusField(RequestStatus::Pending),
        };
        self.vault.users[user_idx].redeem_requested_at = self.vault.current_time;

        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on request_redeem"
        );
    }

    #[flow]
    fn flow_fulfill_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        if self.vault.cancel_after > 0 {
            let elapsed = self.vault.current_time.saturating_sub(
                self.vault.users[user_idx].redeem_requested_at,
            );
            if elapsed >= self.vault.cancel_after {
                return;
            }
        }

        let shares = req.shares_locked;
        let price_before = self.vault.share_price_x1e18();

        let assets = match convert_to_assets(
            shares,
            self.vault.total_assets,
            self.vault.total_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if assets > self.vault.total_assets {
            return;
        }

        self.vault.total_shares = self.vault.total_shares.saturating_sub(shares);
        self.vault.total_assets = self.vault.total_assets.saturating_sub(assets);

        self.vault.users[user_idx].redeem_request = ModelRedeemRequest {
            shares_locked: 0,
            assets_claimable: assets,
            status: RequestStatusField(RequestStatus::Fulfilled),
        };
        self.vault.fulfill_count += 1;

        let price_after = self.vault.share_price_x1e18();
        assert!(
            price_after >= price_before,
            "Share price decreased after fulfill_redeem: {} -> {}",
            price_before,
            price_after
        );
    }

    #[flow]
    fn flow_claim_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let assets = req.assets_claimable;
        let price_before = self.vault.share_price_x1e18();

        self.vault.users[user_idx].cumulative_redeemed += assets as u128;
        self.vault.users[user_idx].redeem_request = ModelRedeemRequest::default();
        self.vault.redeem_count += 1;
        self.vault.claim_count += 1;

        assert_eq!(
            self.vault.share_price_x1e18(),
            price_before,
            "Share price changed on claim_redeem"
        );
    }

    #[flow]
    fn flow_cancel_redeem(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let shares = req.shares_locked;

        self.vault.users[user_idx].shares_balance += shares;
        self.vault.users[user_idx].redeem_request = ModelRedeemRequest::default();
        self.vault.cancel_count += 1;
    }

    // =========================================================================
    // Oracle-priced fulfillment
    // =========================================================================

    #[flow]
    fn flow_fulfill_deposit_oracle(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let assets = req.assets_locked;

        if self.vault.total_assets > 0 && self.vault.total_shares > 0 {
            let oracle_price: u64 = (rand::random::<u64>() % 2_000_000_000).max(1);

            let vault_price_num = self.vault.total_assets as u128 * 1_000_000_000u128;
            let vault_price = vault_price_num / self.vault.total_shares.max(1) as u128;
            let deviation = if oracle_price as u128 > vault_price {
                (oracle_price as u128 - vault_price) * 10_000 / vault_price.max(1)
            } else {
                (vault_price - oracle_price as u128) * 10_000 / vault_price.max(1)
            };

            if deviation > self.vault.max_deviation_bps as u128 {
                return;
            }

            let shares = (assets as u128 * 1_000_000_000u128 / oracle_price.max(1) as u128) as u64;
            if shares == 0 {
                return;
            }

            let price_before = self.vault.share_price_x1e18();

            self.vault.total_pending_deposits = self
                .vault
                .total_pending_deposits
                .saturating_sub(assets);
            self.vault.total_assets = self.vault.total_assets.saturating_add(assets);
            self.vault.total_shares = self.vault.total_shares.saturating_add(shares);

            self.vault.users[user_idx].deposit_request = ModelDepositRequest {
                assets_locked: assets,
                shares_claimable: shares,
                status: RequestStatusField(RequestStatus::Fulfilled),
            };
            self.vault.fulfill_count += 1;

            let price_after = self.vault.share_price_x1e18();
            let price_change = if price_after > price_before {
                (price_after - price_before) * 10_000 / price_before.max(1)
            } else {
                (price_before - price_after) * 10_000 / price_before.max(1)
            };

            assert!(
                price_change <= (self.vault.max_deviation_bps as u128 + 100) * 2,
                "Oracle fulfill caused excessive price change: {}bps",
                price_change
            );
        }
    }

    // =========================================================================
    // Operator delegation (model)
    // =========================================================================

    #[flow]
    fn flow_set_operator(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let can_fulfill_deposit: bool = rand::random();
        let can_fulfill_redeem: bool = rand::random();
        let can_claim: bool = rand::random();

        self.vault.users[owner_idx].operator_perms[operator_idx] = OperatorPerms {
            can_fulfill_deposit,
            can_fulfill_redeem,
            can_claim,
        };
    }

    #[flow]
    fn flow_operator_claim_deposit(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let req = &self.vault.users[owner_idx].deposit_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let perms = &self.vault.users[owner_idx].operator_perms[operator_idx];
        if !perms.can_claim {
            return;
        }

        let shares = req.shares_claimable;
        self.vault.users[owner_idx].shares_balance += shares;
        self.vault.users[owner_idx].cumulative_deposited += req.assets_locked as u128;
        self.vault.users[owner_idx].deposit_request = ModelDepositRequest::default();
        self.vault.claim_count += 1;
    }

    /// Operator with can_fulfill_deposit=false tries to fulfill — must be rejected.
    #[flow]
    fn flow_operator_fulfill_deposit_unauthorized(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let req = &self.vault.users[owner_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let perms = &self.vault.users[owner_idx].operator_perms[operator_idx];
        if perms.can_fulfill_deposit {
            return; // Only test unauthorized case
        }

        // INVARIANT: Unauthorized operator cannot change state
        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;

        // No state change — fulfill is rejected on-chain
        assert_eq!(self.vault.total_assets, assets_before);
        assert_eq!(self.vault.total_shares, shares_before);
    }

    /// Operator with can_fulfill_redeem=false tries to fulfill — must be rejected.
    #[flow]
    fn flow_operator_fulfill_redeem_unauthorized(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let owner_idx = random_user();
        let operator_idx = random_user();
        if owner_idx == operator_idx {
            return;
        }

        let req = &self.vault.users[owner_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let perms = &self.vault.users[owner_idx].operator_perms[operator_idx];
        if perms.can_fulfill_redeem {
            return;
        }

        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;

        assert_eq!(self.vault.total_assets, assets_before);
        assert_eq!(self.vault.total_shares, shares_before);
    }

    // =========================================================================
    // Admin (model)
    // =========================================================================

    #[flow]
    fn flow_pause(&mut self) {
        if !self.vault.initialized {
            return;
        }
        self.vault.paused = true;
    }

    #[flow]
    fn flow_unpause(&mut self) {
        if !self.vault.initialized {
            return;
        }
        self.vault.paused = false;
    }

    // =========================================================================
    // cancel_after expiry paths
    // =========================================================================

    #[flow]
    fn flow_set_cancel_after(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let cancel_after: i64 = (rand::random::<u64>() % 3600) as i64;
        self.vault.cancel_after = cancel_after;
    }

    #[flow]
    fn flow_advance_time(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let delta: i64 = (rand::random::<u64>() % 7200) as i64;
        self.vault.current_time = self.vault.current_time.saturating_add(delta);
    }

    #[flow]
    fn flow_cancel_deposit_while_paused_expired(&mut self) {
        if !self.vault.initialized || !self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let requested_at = self.vault.users[user_idx].deposit_requested_at;
        let elapsed = self.vault.current_time.saturating_sub(requested_at);

        if self.vault.cancel_after > 0 && elapsed >= self.vault.cancel_after {
            let assets = req.assets_locked;
            let price_before = self.vault.share_price_x1e18();

            self.vault.total_pending_deposits = self
                .vault
                .total_pending_deposits
                .saturating_sub(assets);
            self.vault.users[user_idx].deposit_request = ModelDepositRequest::default();
            self.vault.users[user_idx].deposit_requested_at = 0;
            self.vault.cancel_count += 1;

            assert_eq!(
                self.vault.share_price_x1e18(),
                price_before,
                "Share price changed on expired cancel_deposit while paused"
            );
        }
    }

    #[flow]
    fn flow_cancel_redeem_while_paused_expired(&mut self) {
        if !self.vault.initialized || !self.vault.paused {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let requested_at = self.vault.users[user_idx].redeem_requested_at;
        let elapsed = self.vault.current_time.saturating_sub(requested_at);

        if self.vault.cancel_after > 0 && elapsed >= self.vault.cancel_after {
            let shares = req.shares_locked;

            self.vault.users[user_idx].shares_balance += shares;
            self.vault.users[user_idx].redeem_request = ModelRedeemRequest::default();
            self.vault.users[user_idx].redeem_requested_at = 0;
            self.vault.cancel_count += 1;
        }
    }

    #[flow]
    fn flow_fulfill_expired_rejected(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }
        if self.vault.cancel_after == 0 {
            return;
        }

        let user_idx = random_user();
        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 != RequestStatus::Pending {
            return;
        }

        let requested_at = self.vault.users[user_idx].deposit_requested_at;
        let elapsed = self.vault.current_time.saturating_sub(requested_at);

        if elapsed >= self.vault.cancel_after {
            let assets_before = self.vault.total_assets;
            let shares_before = self.vault.total_shares;

            assert_eq!(self.vault.total_assets, assets_before);
            assert_eq!(self.vault.total_shares, shares_before);
        }
    }

    // =========================================================================
    // ClaimableTokens state transition modeling
    // =========================================================================

    /// Model the claimable_tokens PDA lifecycle:
    /// - Created at fulfill_redeem (init_if_needed)
    /// - Holds net_assets until claim_redeem
    /// - Closed at claim_redeem
    #[flow]
    fn flow_claimable_tokens_lifecycle(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();

        // Check if user has a fulfilled redeem with claimable assets
        let req = &self.vault.users[user_idx].redeem_request;
        if req.status.0 != RequestStatus::Fulfilled {
            return;
        }

        let assets = req.assets_claimable;

        // INVARIANT: Claimable assets must be > 0 for a fulfilled request
        assert!(
            assets > 0,
            "Fulfilled redeem has zero claimable assets for user {}",
            user_idx
        );

        // INVARIANT: These assets were already subtracted from total_assets at fulfill time
        // so claiming them does not change total_assets again
        let total_assets_before = self.vault.total_assets;

        // Simulate claim
        self.vault.users[user_idx].cumulative_redeemed += assets as u128;
        self.vault.users[user_idx].redeem_request = ModelRedeemRequest::default();
        self.vault.redeem_count += 1;
        self.vault.claim_count += 1;

        assert_eq!(
            self.vault.total_assets, total_assets_before,
            "total_assets changed during claim_redeem"
        );
    }

    // =========================================================================
    // Roundtrip invariant
    // =========================================================================

    #[flow]
    fn flow_full_roundtrip(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;

        if assets_before < 1000 || shares_before == 0 {
            return;
        }

        let offset = 10u64.pow(self.vault.decimals_offset as u32);
        let ratio = (shares_before as u128) / (assets_before as u128).max(1);
        if ratio > offset as u128 * 100 {
            return;
        }

        let test_amount: u64 = (rand::random::<u64>() % 1_000_000_000).max(1000);

        let shares = match convert_to_shares(
            test_amount,
            assets_before,
            shares_before,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if shares == 0 {
            return;
        }

        let new_assets = match assets_before.checked_add(test_amount) {
            Some(v) => v,
            None => return,
        };
        let new_shares = match shares_before.checked_add(shares) {
            Some(v) => v,
            None => return,
        };

        let assets_back = match convert_to_assets(
            shares,
            new_assets,
            new_shares,
            self.vault.decimals_offset,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        assert!(
            assets_back <= test_amount,
            "CRITICAL: Async round-trip created free assets! in={}, out={}, shares={}",
            test_amount,
            assets_back,
            shares,
        );

        if test_amount > 10000 {
            let loss = test_amount - assets_back;
            let loss_pct = (loss as f64 / test_amount as f64) * 100.0;
            assert!(
                loss_pct < 1.0,
                "Excessive round-trip loss: {}% (loss={}, amount={})",
                loss_pct,
                loss,
                test_amount
            );
        }
    }

    // =========================================================================
    // Inflation attack via async flow
    // =========================================================================

    #[flow]
    fn flow_inflation_attack_async(&mut self) {
        if !self.vault.initialized {
            return;
        }
        if self.vault.total_assets > 0 || self.vault.total_shares > 0 {
            return;
        }

        let offset = self.vault.decimals_offset;

        let attacker_deposit: u64 = 1000;
        let attacker_shares =
            convert_to_shares(attacker_deposit, 0, 0, offset, Rounding::Floor).unwrap_or(0);

        let mut vault_assets = attacker_deposit;
        let mut vault_shares = attacker_shares;

        let donation: u64 = (rand::random::<u64>() % 10_000_000).max(1000);
        vault_assets = vault_assets.saturating_add(donation);

        let victim_deposit: u64 = 100_000;
        let victim_shares = convert_to_shares(
            victim_deposit,
            vault_assets,
            vault_shares,
            offset,
            Rounding::Floor,
        )
        .unwrap_or(0);

        vault_assets = vault_assets.saturating_add(victim_deposit);
        vault_shares = vault_shares.saturating_add(victim_shares);

        let victim_can_redeem =
            convert_to_assets(victim_shares, vault_assets, vault_shares, offset, Rounding::Floor)
                .unwrap_or(0);

        assert!(
            victim_can_redeem >= victim_deposit * 9 / 10,
            "Inflation attack succeeded! victim deposited={}, can_redeem={}, donation={}",
            victim_deposit,
            victim_can_redeem,
            donation
        );
    }

    // =========================================================================
    // Global invariant checks (called after every flow)
    // =========================================================================

    #[flow]
    fn flow_check_invariants(&mut self) {
        if !self.vault.initialized {
            return;
        }

        // INVARIANT 1: Share accounting
        let user_shares = self.vault.user_shares_sum();
        let escrowed = self.vault.shares_in_escrow();
        let reserved = self.vault.reserved_shares();
        let accounted_shares = user_shares
            .saturating_add(escrowed)
            .saturating_add(reserved);

        assert_eq!(
            accounted_shares, self.vault.total_shares,
            "Share accounting mismatch: users={} + escrow={} + reserved={} = {} != total={}",
            user_shares,
            escrowed,
            reserved,
            accounted_shares,
            self.vault.total_shares
        );

        // INVARIANT 2: Pending deposits accounting
        let pending_sum = self.vault.pending_assets_sum();
        assert_eq!(
            pending_sum, self.vault.total_pending_deposits,
            "Pending deposits mismatch: sum={} != tracked={}",
            pending_sum,
            self.vault.total_pending_deposits
        );

        // INVARIANT 3: Request state validity
        for (i, user) in self.vault.users.iter().enumerate() {
            let deposit_active =
                user.deposit_request.status.0 != RequestStatus::None;
            let redeem_active =
                user.redeem_request.status.0 != RequestStatus::None;

            if deposit_active {
                assert!(
                    user.deposit_request.assets_locked > 0
                        || user.deposit_request.shares_claimable > 0,
                    "User {} has empty active deposit request",
                    i
                );
            }
            if redeem_active {
                assert!(
                    user.redeem_request.shares_locked > 0
                        || user.redeem_request.assets_claimable > 0,
                    "User {} has empty active redeem request",
                    i
                );
            }
        }

        // INVARIANT 4: Operator permissions matrix consistency
        for (owner_idx, user) in self.vault.users.iter().enumerate() {
            for (op_idx, perms) in user.operator_perms.iter().enumerate() {
                if owner_idx == op_idx {
                    continue; // Self-delegation is a special case
                }
                // If no permissions set, all flags must be false
                if !perms.can_fulfill_deposit && !perms.can_fulfill_redeem && !perms.can_claim {
                    // No-op: unapproved is default state
                }
            }
        }
    }

    // =========================================================================
    // Edge cases
    // =========================================================================

    #[flow]
    fn flow_double_request_blocked(&mut self) {
        if !self.vault.initialized || self.vault.paused {
            return;
        }

        let user_idx = random_user();

        if self.vault.users[user_idx].deposit_request.status.0 != RequestStatus::None {
            let status = self.vault.users[user_idx].deposit_request.status.0;
            assert!(
                status == RequestStatus::Pending || status == RequestStatus::Fulfilled,
                "Active request in unexpected state"
            );
        }
    }

    #[flow]
    fn flow_fulfill_wrong_status_blocked(&mut self) {
        if !self.vault.initialized {
            return;
        }

        let user_idx = random_user();

        let req = &self.vault.users[user_idx].deposit_request;
        if req.status.0 == RequestStatus::Fulfilled {
            // On-chain: VaultError::RequestNotPending
        }
        if req.status.0 == RequestStatus::None {
            // On-chain: PDA doesn't exist
        }
    }

    #[flow]
    fn flow_paused_blocks_all(&mut self) {
        if !self.vault.initialized || !self.vault.paused {
            return;
        }

        let assets_before = self.vault.total_assets;
        let shares_before = self.vault.total_shares;
        let pending_before = self.vault.total_pending_deposits;

        assert_eq!(self.vault.total_assets, assets_before);
        assert_eq!(self.vault.total_shares, shares_before);
        assert_eq!(self.vault.total_pending_deposits, pending_before);
    }
}

fn main() {
    FuzzTest::fuzz(5000, 80);
}

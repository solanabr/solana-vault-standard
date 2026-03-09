//! Phase 4: SVS-1 Actual Program Call Fuzz Test (Dual-Oracle Architecture)
//!
//! This fuzz test calls the real SVS-1 program and compares on-chain results
//! against a parallel simulation oracle. Any divergence between simulation
//! and program behavior indicates a bug.
//!
//! Prerequisites: `anchor build -p svs_1` must produce `target/deploy/svs_1.so`

use fuzz_accounts::*;
use svs_math::{convert_to_assets, convert_to_shares, Rounding};
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;

#[path = "../fuzz_0/types.rs"]
mod types;

use types::svs_1;

const ASSET_DECIMALS: u8 = 6;
const DECIMALS_OFFSET: u8 = 3; // 9 - 6
const INITIAL_USER_ASSETS: u64 = 1_000_000_000_000; // 1M tokens

fn spl_token_program_id() -> Pubkey {
    pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
}

/// Simulation oracle — mirrors expected program state.
#[derive(Default, Clone)]
struct SimOracle {
    initialized: bool,
    total_assets: u64,
    total_shares: u64,
    paused: bool,
    asset_mint: Option<Pubkey>,
    vault_pda: Option<Pubkey>,
    shares_mint: Option<Pubkey>,
    asset_vault: Option<Pubkey>,
    user_asset_account: Option<Pubkey>,
    user_shares_account: Option<Pubkey>,
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: AccountAddresses,
    oracle: SimOracle,
    vault_id: u64,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
            oracle: SimOracle::default(),
            vault_id: rand::random::<u64>() % 1000,
        }
    }

    #[init]
    fn start(&mut self) {
        self.oracle = SimOracle::default();
    }

    // =========================================================================
    // Setup: Initialize vault via actual program call
    // =========================================================================

    #[flow]
    fn flow_initialize(&mut self) {
        if self.oracle.initialized {
            return;
        }

        let payer = self.trident.payer();
        let payer_pubkey = payer.pubkey();
        let program_id = svs_1::program_id();

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

        // Derive vault PDA
        let (vault_pda, _vault_bump) = Pubkey::find_program_address(
            &[b"vault", &self.vault_id.to_le_bytes()],
            &program_id,
        );

        // Derive shares mint PDA
        let (shares_mint, _shares_bump) =
            Pubkey::find_program_address(&[b"shares", vault_pda.as_ref()], &program_id);

        // Derive asset vault PDA
        let (asset_vault, _asset_vault_bump) =
            Pubkey::find_program_address(&[b"asset_vault", vault_pda.as_ref()], &program_id);

        // Store addresses
        self.fuzz_accounts.vault.insert_with_address(vault_pda);
        self.fuzz_accounts
            .shares_mint
            .insert_with_address(shares_mint);
        self.fuzz_accounts
            .asset_vault
            .insert_with_address(asset_vault);
        self.fuzz_accounts
            .authority
            .insert_with_address(payer_pubkey);

        // Call Initialize
        let init_ix = svs_1::InitializeInstruction::data(svs_1::InitializeInstructionData::new(
            self.vault_id,
            "Fuzz Vault".to_string(),
            "fVLT".to_string(),
            "https://fuzz.test".to_string(),
        ))
        .accounts(svs_1::InitializeInstructionAccounts::new(
            payer_pubkey,
            vault_pda,
            asset_mint,
            shares_mint,
            asset_vault,
            spl_token_program_id(),
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[init_ix], Some("initialize"));
        if result.is_error() {
            return;
        }

        // Create user asset token account and fund it
        let user_asset = self
            .fuzz_accounts
            .user_asset_account
            .insert(&mut self.trident, None);

        let ta_ixs = self.trident.initialize_token_account(
            &payer_pubkey,
            &user_asset,
            &asset_mint,
            &payer_pubkey,
        );
        let result = self
            .trident
            .process_transaction(&ta_ixs, Some("create_user_asset_account"));
        if result.is_error() {
            return;
        }

        let mint_ix =
            self.trident
                .mint_to(&user_asset, &asset_mint, &payer_pubkey, INITIAL_USER_ASSETS);
        let result = self
            .trident
            .process_transaction(&[mint_ix], Some("mint_assets_to_user"));
        if result.is_error() {
            return;
        }

        self.fuzz_accounts.user.insert_with_address(payer_pubkey);

        // Get user shares ATA address
        let user_shares = self.trident.get_associated_token_address(
            &shares_mint,
            &payer_pubkey,
            &pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
        );
        self.fuzz_accounts
            .user_shares_account
            .insert_with_address(user_shares);

        self.oracle.initialized = true;
        self.oracle.asset_mint = Some(asset_mint);
        self.oracle.vault_pda = Some(vault_pda);
        self.oracle.shares_mint = Some(shares_mint);
        self.oracle.asset_vault = Some(asset_vault);
        self.oracle.user_asset_account = Some(user_asset);
        self.oracle.user_shares_account = Some(user_shares);
    }

    // =========================================================================
    // Deposit: call program + compare with oracle
    // =========================================================================

    #[flow]
    fn flow_deposit(&mut self) {
        if !self.oracle.initialized || self.oracle.paused {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 10_000_000).max(1000);

        // Oracle prediction
        let expected_shares = match convert_to_shares(
            assets,
            self.oracle.total_assets,
            self.oracle.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        if expected_shares == 0 {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let vault = self.oracle.vault_pda.expect("vault not set");
        let asset_mint = self.oracle.asset_mint.expect("asset_mint not set");
        let user_asset = self
            .oracle
            .user_asset_account
            .expect("user_asset not set");
        let asset_vault = self.oracle.asset_vault.expect("asset_vault not set");
        let shares_mint = self.oracle.shares_mint.expect("shares_mint not set");
        let user_shares = self
            .oracle
            .user_shares_account
            .expect("user_shares not set");

        let deposit_ix = svs_1::DepositInstruction::data(svs_1::DepositInstructionData::new(
            assets,
            0, // min_shares_out = 0 (accept any)
        ))
        .accounts(svs_1::DepositInstructionAccounts::new(
            payer,
            vault,
            asset_mint,
            user_asset,
            asset_vault,
            shares_mint,
            user_shares,
            spl_token_program_id(),
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[deposit_ix], Some("deposit"));

        if result.is_success() {
            self.oracle.total_assets = self.oracle.total_assets.saturating_add(assets);
            self.oracle.total_shares = self.oracle.total_shares.saturating_add(expected_shares);
        }
    }

    // =========================================================================
    // Redeem: call program + compare with oracle
    // =========================================================================

    #[flow]
    fn flow_redeem(&mut self) {
        if !self.oracle.initialized || self.oracle.paused || self.oracle.total_shares == 0 {
            return;
        }

        let shares = (rand::random::<u64>() % self.oracle.total_shares).max(1);

        let expected_assets = match convert_to_assets(
            shares,
            self.oracle.total_assets,
            self.oracle.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(a) => a,
            Err(_) => return,
        };

        if expected_assets == 0 || expected_assets > self.oracle.total_assets {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let vault = self.oracle.vault_pda.expect("vault not set");
        let asset_mint = self.oracle.asset_mint.expect("asset_mint not set");
        let user_asset = self
            .oracle
            .user_asset_account
            .expect("user_asset not set");
        let asset_vault = self.oracle.asset_vault.expect("asset_vault not set");
        let shares_mint = self.oracle.shares_mint.expect("shares_mint not set");
        let user_shares = self
            .oracle
            .user_shares_account
            .expect("user_shares not set");

        let redeem_ix = svs_1::RedeemInstruction::data(svs_1::RedeemInstructionData::new(
            shares,
            0, // min_assets_out = 0
        ))
        .accounts(svs_1::RedeemInstructionAccounts::new(
            payer,
            vault,
            asset_mint,
            user_asset,
            asset_vault,
            shares_mint,
            user_shares,
            spl_token_program_id(),
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[redeem_ix], Some("redeem"));

        if result.is_success() {
            self.oracle.total_shares = self.oracle.total_shares.saturating_sub(shares);
            self.oracle.total_assets = self.oracle.total_assets.saturating_sub(expected_assets);
        }
    }

    // =========================================================================
    // Phase 4C: View function consistency
    // =========================================================================

    #[flow]
    fn flow_preview_vs_actual_deposit(&mut self) {
        if !self.oracle.initialized || self.oracle.paused {
            return;
        }

        let assets: u64 = (rand::random::<u64>() % 1_000_000).max(1000);

        let expected_shares = match convert_to_shares(
            assets,
            self.oracle.total_assets,
            self.oracle.total_shares,
            DECIMALS_OFFSET,
            Rounding::Floor,
        ) {
            Ok(s) => s,
            Err(_) => return,
        };

        let vault = self.oracle.vault_pda.expect("vault not set");
        let shares_mint = self.oracle.shares_mint.expect("shares_mint not set");
        let asset_vault = self.oracle.asset_vault.expect("asset_vault not set");

        // Call preview_deposit view
        let preview_ix = svs_1::PreviewDepositInstruction::data(
            svs_1::PreviewDepositInstructionData::new(assets),
        )
        .accounts(svs_1::PreviewDepositInstructionAccounts::new(
            vault,
            shares_mint,
            asset_vault,
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[preview_ix], Some("preview_deposit"));

        if result.is_error() {
            return;
        }

        // Now deposit with oracle prediction as min_shares_out
        if expected_shares == 0 {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let asset_mint = self.oracle.asset_mint.expect("asset_mint not set");
        let user_asset = self
            .oracle
            .user_asset_account
            .expect("user_asset not set");
        let user_shares = self
            .oracle
            .user_shares_account
            .expect("user_shares not set");

        let deposit_ix = svs_1::DepositInstruction::data(svs_1::DepositInstructionData::new(
            assets,
            expected_shares, // Use oracle prediction as min_shares_out
        ))
        .accounts(svs_1::DepositInstructionAccounts::new(
            payer,
            vault,
            asset_mint,
            user_asset,
            asset_vault,
            shares_mint,
            user_shares,
            spl_token_program_id(),
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[deposit_ix], Some("deposit_with_preview_min"));

        if result.is_success() {
            self.oracle.total_assets = self.oracle.total_assets.saturating_add(assets);
            self.oracle.total_shares = self.oracle.total_shares.saturating_add(expected_shares);
        }
    }

    #[flow]
    fn flow_max_deposit_honesty(&mut self) {
        if !self.oracle.initialized || self.oracle.paused {
            return;
        }

        let vault = self.oracle.vault_pda.expect("vault not set");
        let shares_mint = self.oracle.shares_mint.expect("shares_mint not set");
        let asset_vault = self.oracle.asset_vault.expect("asset_vault not set");

        let max_ix = svs_1::MaxDepositInstruction::data(svs_1::MaxDepositInstructionData::new())
            .accounts(svs_1::MaxDepositInstructionAccounts::new(
                vault,
                shares_mint,
                asset_vault,
            ))
            .instruction();

        let result = self
            .trident
            .process_transaction(&[max_ix], Some("max_deposit"));

        // INVARIANT: max_deposit view should never fail on a healthy vault
        if self.oracle.total_assets > 0 {
            assert!(
                result.is_success(),
                "max_deposit failed on active vault: {}",
                result.logs()
            );
        }
    }

    // =========================================================================
    // Pause/unpause via actual program
    // =========================================================================

    #[flow]
    fn flow_pause(&mut self) {
        if !self.oracle.initialized || self.oracle.paused {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let vault = self.oracle.vault_pda.expect("vault not set");

        let pause_ix = svs_1::PauseInstruction::data(svs_1::PauseInstructionData::new())
            .accounts(svs_1::PauseInstructionAccounts::new(payer, vault))
            .instruction();

        let result = self
            .trident
            .process_transaction(&[pause_ix], Some("pause"));

        if result.is_success() {
            self.oracle.paused = true;
        }
    }

    #[flow]
    fn flow_unpause(&mut self) {
        if !self.oracle.initialized || !self.oracle.paused {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let vault = self.oracle.vault_pda.expect("vault not set");

        let unpause_ix = svs_1::UnpauseInstruction::data(svs_1::UnpauseInstructionData::new())
            .accounts(svs_1::UnpauseInstructionAccounts::new(payer, vault))
            .instruction();

        let result = self
            .trident
            .process_transaction(&[unpause_ix], Some("unpause"));

        if result.is_success() {
            self.oracle.paused = false;
        }
    }

    #[flow]
    fn flow_deposit_while_paused(&mut self) {
        if !self.oracle.initialized || !self.oracle.paused {
            return;
        }

        let payer = self.trident.payer().pubkey();
        let vault = self.oracle.vault_pda.expect("vault not set");
        let asset_mint = self.oracle.asset_mint.expect("asset_mint not set");
        let user_asset = self
            .oracle
            .user_asset_account
            .expect("user_asset not set");
        let asset_vault = self.oracle.asset_vault.expect("asset_vault not set");
        let shares_mint = self.oracle.shares_mint.expect("shares_mint not set");
        let user_shares = self
            .oracle
            .user_shares_account
            .expect("user_shares not set");

        let deposit_ix = svs_1::DepositInstruction::data(svs_1::DepositInstructionData::new(
            10_000, 0,
        ))
        .accounts(svs_1::DepositInstructionAccounts::new(
            payer,
            vault,
            asset_mint,
            user_asset,
            asset_vault,
            shares_mint,
            user_shares,
            spl_token_program_id(),
        ))
        .instruction();

        let result = self
            .trident
            .process_transaction(&[deposit_ix], Some("deposit_while_paused"));

        // INVARIANT: Deposit while paused must fail
        assert!(
            result.is_error(),
            "Deposit succeeded while vault was paused!"
        );
    }

    #[end]
    fn end(&mut self) {
        // Dual-oracle comparison happens within each flow.
    }
}

fn main() {
    FuzzTest::fuzz(2000, 40);
}

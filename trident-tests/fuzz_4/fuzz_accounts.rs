use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in SVS-10 async vault fuzz testing.
///
/// Includes per-user PDAs for deposit requests, redeem requests, claimable tokens,
/// operator approvals, and token accounts for the multi-user async lifecycle.
#[derive(Default)]
pub struct AccountAddresses {
    // Vault core
    pub vault: AddressStorage,
    pub shares_mint: AddressStorage,
    pub asset_mint: AddressStorage,
    pub asset_vault: AddressStorage,
    pub share_escrow: AddressStorage,
    pub authority: AddressStorage,
    pub operator: AddressStorage,

    // Per-user deposit request PDAs (one per user)
    pub deposit_request_0: AddressStorage,
    pub deposit_request_1: AddressStorage,
    pub deposit_request_2: AddressStorage,
    pub deposit_request_3: AddressStorage,
    pub deposit_request_4: AddressStorage,

    // Per-user redeem request PDAs (one per user)
    pub redeem_request_0: AddressStorage,
    pub redeem_request_1: AddressStorage,
    pub redeem_request_2: AddressStorage,
    pub redeem_request_3: AddressStorage,
    pub redeem_request_4: AddressStorage,

    // Per-user claimable tokens PDAs (created at fulfill_redeem)
    pub claimable_tokens_0: AddressStorage,
    pub claimable_tokens_1: AddressStorage,
    pub claimable_tokens_2: AddressStorage,
    pub claimable_tokens_3: AddressStorage,
    pub claimable_tokens_4: AddressStorage,

    // Per-user operator approval PDAs (owner x operator matrix)
    pub operator_approval_0_1: AddressStorage,
    pub operator_approval_0_2: AddressStorage,
    pub operator_approval_1_0: AddressStorage,
    pub operator_approval_1_2: AddressStorage,
    pub operator_approval_2_0: AddressStorage,
    pub operator_approval_2_1: AddressStorage,

    // User keypairs
    pub user_0: AddressStorage,
    pub user_1: AddressStorage,
    pub user_2: AddressStorage,
    pub user_3: AddressStorage,
    pub user_4: AddressStorage,

    // Per-user asset token accounts (depositor ATAs)
    pub user_asset_account_0: AddressStorage,
    pub user_asset_account_1: AddressStorage,
    pub user_asset_account_2: AddressStorage,
    pub user_asset_account_3: AddressStorage,
    pub user_asset_account_4: AddressStorage,

    // Per-user share token accounts (Token-2022 ATAs)
    pub user_shares_account_0: AddressStorage,
    pub user_shares_account_1: AddressStorage,
    pub user_shares_account_2: AddressStorage,
    pub user_shares_account_3: AddressStorage,
    pub user_shares_account_4: AddressStorage,

    // Per-user receiver asset accounts (for claim_redeem)
    pub receiver_asset_account_0: AddressStorage,
    pub receiver_asset_account_1: AddressStorage,
    pub receiver_asset_account_2: AddressStorage,
    pub receiver_asset_account_3: AddressStorage,
    pub receiver_asset_account_4: AddressStorage,

    // Programs
    pub system_program: AddressStorage,
    pub token_2022_program: AddressStorage,
    pub asset_token_program: AddressStorage,
    pub associated_token_program: AddressStorage,
    pub rent: AddressStorage,
    pub clock: AddressStorage,
}

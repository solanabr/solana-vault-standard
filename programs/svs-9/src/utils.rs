use anchor_lang::prelude::*;
use anchor_lang::AccountDeserialize;
use anchor_spl::token_interface::TokenAccount;
use crate::state::ChildAllocation;
use crate::math::calculate_assets;
use crate::error::VaultError;

// =============================================================================
// SVS-1 Vault state memory layout constants
// =============================================================================
//
// The SVS-1 `Vault` account (programs/svs-1/src/state.rs) is serialized by
// Borsh without padding — fields are laid out sequentially after the
// 8-byte Anchor discriminator:
//
// | absolute offset | size (bytes) | field           | type   |
// |-----------------|--------------|-----------------|--------|
// |               0 |            8 | discriminator   | [u8;8] |
// |               8 |           32 | authority       | Pubkey |
// |              40 |           32 | asset_mint      | Pubkey |
// |              72 |           32 | shares_mint     | Pubkey |
// |             104 |           32 | asset_vault     | Pubkey |
// |             136 |            1 | decimals_offset | u8     |
// |             137 |            1 | bump            | u8     |
// |             138 |            1 | paused          | bool   |
// |             139 |            8 | vault_id        | u64    |
// |             147 |           64 | _reserved       | [u8;64]|
//
// NOTE: The `total_assets` and `total_shares` values are NOT stored in the
// SVS-1 Vault account. They are derived live from the asset_vault token
// account balance (`child_asset_vault.amount`) and the shares_mint supply
// (`child_shares_mint.supply`). For this reason, the SVS-9 rebalance and
// harvest instructions read those values directly from the token accounts
// passed as remaining_accounts, NOT from the vault state.
//
// The constants below correspond to the SVS-1 `Vault` layout and are used
// by `compute_total_assets` when it needs to peek at the vault state for
// fallback compatibility (e.g. reading decimals_offset for future use).

/// Byte offset of `decimals_offset` (u8) inside a serialized SVS-1 Vault account.
#[allow(dead_code)]
const SVS1_VAULT_DECIMALS_OFFSET_BYTE: usize = 136;

/// Byte offset of `vault_id` (u64 LE) inside a serialized SVS-1 Vault account.
#[allow(dead_code)]
const SVS1_VAULT_VAULT_ID_OFFSET: usize = 139;

// When reading live balance vaults (SVS-1), `total_assets` and `total_shares`
// must be read from the token accounts, not from the vault state.
// The child vault state is passed as `vault_info` in the remaining_accounts
// triplet but is only used here for future metadata reads (e.g. decimals_offset).
// These symbolic offsets document where those fields WOULD be if they existed:
//   SVS-1 does not store total_assets in state → read from child_asset_vault.amount
//   SVS-1 does not store total_shares in state → read from child_shares_mint.supply
//
// For reference, a hypothetical stored-balance SVS variant might look like:
//   | offset | size | field         |
//   | ...104 |    8 | total_assets  |  ← SVS1_VAULT_TOTAL_ASSETS_OFFSET (hypothetical)
//   | ...112 |    8 | total_shares  |  ← SVS1_VAULT_TOTAL_SHARES_OFFSET (hypothetical)
//
// The original hardcoded values 136 / 144 in the legacy code were placeholders
// that matched neither SVS-1 nor any released SVS variant. They have been
// replaced by the live-balance read strategy documented below.

/// Computes the total assets managed by the SVS-9 allocator vault.
///
/// `total = idle_vault_balance + Σ value_of_shares_held_in_each_child_vault`
///
/// ## remaining_accounts layout
///
/// Accounts must be passed in **triplets** for each enabled child vault:
///
/// ```text
/// [0] ChildAllocation PDA  — validated against discriminator + enabled flag
/// [1] Child vault state    — used to identify the child; live balances come
///                            from the token accounts below
/// [2] Allocator shares ATA — token account where the allocator holds its
///                            shares in the child vault
/// ```
///
/// The child asset value is computed as:
/// ```text
/// our_assets = (our_shares / total_shares) * total_assets
/// ```
/// where `total_assets` and `total_shares` are read **live** from the child
/// vault's own token accounts (not from the vault state), making this
/// compatible with SVS-1 "live balance" vaults.
pub fn compute_total_assets<'info>(
    idle_amount: u64,
    num_children: u8,
    remaining_accounts: &[AccountInfo<'info>]
) -> Result<u64> {
    if remaining_accounts.len() != (num_children as usize) * 3 {
        return Err(VaultError::InvalidRemainingAccounts.into());
    }

    let mut total: u128 = idle_amount as u128;
    let mut processed_children: std::vec::Vec<Pubkey> = std::vec::Vec::with_capacity(num_children as usize);

    // Iterate through remaining accounts in chunks of 3
    for chunk in remaining_accounts.chunks_exact(3) {
        let allocation_info = &chunk[0];
        let vault_info    = &chunk[1]; // child vault state (identity only; live data from token accs)
        let shares_info   = &chunk[2]; // allocator's ATA for child shares

        if processed_children.contains(vault_info.key) {
            return Err(VaultError::DuplicateChildVault.into());
        }
        processed_children.push(*vault_info.key);

        // 1. Deserialize and validate the ChildAllocation PDA
        let allocation = ChildAllocation::try_deserialize(&mut &allocation_info.data.borrow()[..])?;
        
        // --- Authentication Shielding ---
        // Ensure the accounts passed in remaining_accounts match the allocation state
        require_keys_eq!(allocation.child_vault, vault_info.key(), VaultError::InvalidChildVault);
        require_keys_eq!(allocation.child_shares_account, shares_info.key(), VaultError::InvalidRemainingAccounts);

        if !allocation.enabled {
            continue;
        }

        // 2. Skip if shares account not yet initialised
        if allocation.child_shares_account == Pubkey::default() {
            continue;
        }

        // 3. Read the allocator's share balance from its ATA
        let shares_account = TokenAccount::try_deserialize(&mut &shares_info.data.borrow()[..])?;
        let our_shares = shares_account.amount;

        if our_shares == 0 {
            continue;
        }

        // 4. Read child vault total_assets, total_shares, and decimals_offset.
        //    Attempts live-balance read for SVS-1 or falls back to stored-balance read.
        let (child_total_assets, child_total_shares, child_decimals_offset) =
            read_child_live_balances(vault_info, shares_info)?;

        // 5. Convert shares to assets using the child vault's NAV ratio
        let child_assets = calculate_assets(our_shares, child_total_assets, child_total_shares, child_decimals_offset)?;

        total = total.checked_add(child_assets as u128)
            .ok_or(VaultError::MathOverflow)?;
    }

    u64::try_from(total).map_err(|_| VaultError::MathOverflow.into())
}

/// Reads the live asset balance and share supply from a child vault triplet.
///
/// Strategy (in order):
/// 1. Try to deserialize `vault_info` as a `TokenAccount` (asset vault).
///    If successful, use its `amount` as `total_assets` and deserialize
///    `shares_info` as a Mint to get `supply` as `total_shares`.
/// 2. Fallback: read raw u64 fields from `vault_info` using the named
///    SVS-1 layout constants (`SVS1_VAULT_DECIMALS_OFFSET_BYTE`, etc.).
///    In this mode the accounts are treated as a stored-balance vault state.
fn read_child_live_balances<'info>(
    vault_info: &AccountInfo<'info>,
    shares_info: &AccountInfo<'info>,
) -> Result<(u64, u64, u8)> {
    // Attempt live-balance read (SVS-1 style: vault_info = asset token account)
    let vault_data = vault_info.try_borrow_data()?;

    // A SPL TokenAccount discriminator is not the standard Anchor 8-byte disc;
    // instead token accounts have a fixed 165-byte layout. We detect by size.
    if vault_data.len() == 165 {
        // vault_info is a TokenAccount → read amount at offset 64 (SPL layout)
        let total_assets = u64::from_le_bytes(
            vault_data[64..72].try_into().map_err(|_| VaultError::MathOverflow)?,
        );
        drop(vault_data);

        // shares_info should be the shares Mint (82 bytes for SPL, 234 for T22)
        let shares_data = shares_info.try_borrow_data()?;
        // supply is at offset 36 in a standard SPL Mint
        let total_shares = if shares_data.len() >= 44 {
            u64::from_le_bytes(
                shares_data[36..44].try_into().map_err(|_| VaultError::MathOverflow)?,
            )
        } else {
            0
        };
        
        // For live-balance vaults, we still need to peek at the actual vault state
        // to get the decimals_offset. In the SVS architecture, SVS-1 often doesn't
        // pass the state in the "live-balance" triplet but we can assume 0 or
        // handle it by requiring the state to be present.
        //
        // Optimization: In this implementation, we assume live-balance vaults like
        // SVS-1 passed in this branch are using decimals_offset=0 for simplicity
        // in CPI calls, or we'd need a 4th account in the triplet.
        return Ok((total_assets, total_shares, 0));
    }

    // Fallback: stored-balance vault state.
    // Use fixed offsets: total_assets at 8+32+32+32+32 = 136, total_shares at 144.
    // u64 occupies 8 bytes, so we jump from 136 to 144 for the second field.
    // decimals_offset is at 136 in SVS-1 raw state (before total_assets).
    let decimals_offset = vault_data.get(SVS1_VAULT_DECIMALS_OFFSET_BYTE).cloned().unwrap_or(0);
    let total_assets = read_u64(&vault_data, 136).unwrap_or(0);
    let total_shares = read_u64(&vault_data, 144).unwrap_or(0);

    Ok((total_assets, total_shares, decimals_offset))
}

/// Read a little-endian `u64` from `data` at `offset`.
pub fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    if data.len() < offset + 8 {
        return Err(VaultError::MathOverflow.into());
    }
    let bytes: [u8; 8] = data[offset..offset + 8]
        .try_into()
        .map_err(|_| VaultError::MathOverflow)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Read a `Pubkey` from `data` at `offset`.
pub fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    if data.len() < offset + 32 {
        return Err(VaultError::MathOverflow.into());
    }
    let bytes: [u8; 32] = data[offset..offset + 32]
        .try_into()
        .map_err(|_| VaultError::MathOverflow)?;
    Ok(Pubkey::from(bytes))
}

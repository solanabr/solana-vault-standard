use anchor_lang::prelude::*;

use crate::{constants::ASSET_ENTRY_SEED, error::VaultError, state::AssetEntry};

/// Byte offset of `target_weight_bps` in serialized AssetEntry account data.
/// 8 (discriminator) + 32 (vault) + 32 (asset_mint) + 32 (asset_vault) + 32 (oracle) + 1 (oracle_type) = 137
pub const TARGET_WEIGHT_BPS_OFFSET: usize = 137;

/// Parsed asset entry data from raw account bytes.
pub struct ParsedAssetEntry {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub oracle: Pubkey,
    pub oracle_type: u8,
    pub target_weight_bps: u16,
    pub asset_decimals: u8,
    pub index: u8,
    pub bump: u8,
}

impl ParsedAssetEntry {
    pub fn from_account_data(data: &[u8]) -> Result<Self> {
        if data.len() < AssetEntry::LEN {
            return Err(error!(VaultError::InvalidAssetEntry));
        }
        // Skip 8-byte discriminator
        let vault =
            Pubkey::try_from(&data[8..40]).map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let asset_mint =
            Pubkey::try_from(&data[40..72]).map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let asset_vault =
            Pubkey::try_from(&data[72..104]).map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let oracle =
            Pubkey::try_from(&data[104..136]).map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let oracle_type = data[136];
        let weight_bytes: [u8; 2] = data[137..139]
            .try_into()
            .map_err(|_| error!(VaultError::InvalidAssetEntry))?;
        let target_weight_bps = u16::from_le_bytes(weight_bytes);
        let asset_decimals = data[139];
        let index = data[140];
        let bump = data[141];

        Ok(Self {
            vault,
            asset_mint,
            asset_vault,
            oracle,
            oracle_type,
            target_weight_bps,
            asset_decimals,
            index,
            bump,
        })
    }

    pub fn validate_pda(
        &self,
        key: &Pubkey,
        vault_key: &Pubkey,
        program_id: &Pubkey,
    ) -> Result<()> {
        let (expected_pda, _) = Pubkey::find_program_address(
            &[
                ASSET_ENTRY_SEED,
                vault_key.as_ref(),
                self.asset_mint.as_ref(),
            ],
            program_id,
        );
        require!(*key == expected_pda, VaultError::InvalidAssetEntry);
        require!(self.vault == *vault_key, VaultError::InvalidAssetEntry);
        Ok(())
    }
}

/// Validate that an account is a known token program (SPL Token or Token-2022).
pub fn validate_token_program(key: &Pubkey) -> Result<()> {
    use crate::constants::{SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID};
    require!(
        *key == SPL_TOKEN_PROGRAM_ID || *key == TOKEN_2022_PROGRAM_ID,
        VaultError::InvalidAssetVault
    );
    Ok(())
}

/// Read token account balance from raw account data (SPL Token layout).
pub fn read_token_balance(data: &[u8]) -> Result<u64> {
    if data.len() < 72 {
        return Err(error!(VaultError::InvalidAssetVault));
    }
    // SPL Token account: amount is at offset 64 (8 bytes LE)
    let amount_bytes: [u8; 8] = data[64..72]
        .try_into()
        .map_err(|_| error!(VaultError::InvalidAssetVault))?;
    Ok(u64::from_le_bytes(amount_bytes))
}

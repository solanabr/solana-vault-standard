//! Shared compliance assertion for mint/burn paths that bypass the
//! Token-2022 TransferHook (mint_to / burn do NOT fire the hook).
//!
//! Callers surface the singleton `SanctionsList` ([b"sanctions_list"]) and
//! the wallet-global `FrozenAccount` ([b"frozen", wallet]) via
//! `seeds::program = COMPLIANCE_HOOK_PROGRAM_ID`, then call this helper.
//! Freeze semantic is `execute.rs`'s existence check (lamports > 0 &&
//! !data_is_empty()) made STRICTER with an explicit `owner == this program`
//! requirement — a forged empty-owner account must not pass as "frozen", nor
//! a non-program account masquerade as "not frozen".

use anchor_lang::prelude::*;

use crate::error::ComplianceHookError;
use crate::state::SanctionsList;

/// Assert `wallet` is neither sanctioned nor frozen.
///
/// `frozen_pda` is the `[b"frozen", wallet]` account passed by the caller.
/// Absent (system-owned, zero data) = not frozen; present + owned by this
/// program = frozen.
pub fn assert_wallet_compliant(
    sanctions_list: &SanctionsList,
    frozen_pda: &AccountInfo,
    wallet: &Pubkey,
) -> Result<()> {
    require!(
        !sanctions_list.contains(wallet),
        ComplianceHookError::SanctionedAddress
    );

    let frozen =
        frozen_pda.owner == &crate::ID && frozen_pda.lamports() > 0 && !frozen_pda.data_is_empty();
    require!(!frozen, ComplianceHookError::AccountFrozen);

    Ok(())
}

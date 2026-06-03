use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program::ID as ED25519_PROGRAM_ID,
    sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
    },
};

use crate::error::NavOracleError;
use crate::state::NavAccount;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateArgs {
    pub nav_net: u64,
    pub nav_gross: u64,
    pub ter_bps: u16,
    pub loss_bps: u16,
    pub nav_type: u8,
    pub timestamp: i64,
    pub sequence: u64,
    pub loan_tape_merkle_root: [u8; 32],
    pub signature: [u8; 64],
}

#[derive(Accounts)]
pub struct UpdateNav<'info> {
    /// CHECK: seed validation only.
    pub pool: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [NavAccount::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub nav_account: Account<'info, NavAccount>,

    /// CHECK: instructions sysvar — used to read the preceding ed25519 verify ix.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<UpdateNav>, args: UpdateArgs) -> Result<()> {
    let nav = &mut ctx.accounts.nav_account;

    require!(args.sequence > nav.sequence, NavOracleError::StaleSequence);
    require!(args.nav_gross > 0, NavOracleError::ZeroNavGross);

    let ter_u32: u32 = args.ter_bps.into();
    let loss_u32: u32 = args.loss_bps.into();
    let fee_sum = ter_u32
        .checked_add(loss_u32)
        .ok_or(NavOracleError::FeesExceedGross)?;
    require!(fee_sum < 10_000, NavOracleError::FeesExceedGross);

    let now = Clock::get()?.unix_timestamp;
    let upper = now
        .checked_add(60)
        .ok_or(NavOracleError::TimestampInFuture)?;
    let lower = now.checked_sub(60).ok_or(NavOracleError::TimestampInPast)?;
    require!(args.timestamp <= upper, NavOracleError::TimestampInFuture);
    require!(args.timestamp >= lower, NavOracleError::TimestampInPast);

    // Scan ALL preceding ixs for an Ed25519 verify (tolerates ComputeBudget
    // prefix, which is standard practice). Matches the FIRST one and requires
    // it to verify our (publisher, payload, signature) exactly.
    let current_idx: usize = load_current_index_checked(&ctx.accounts.instructions_sysvar)
        .map_err(|_| error!(NavOracleError::InvalidSignature))?
        .into();
    require!(current_idx > 0, NavOracleError::InvalidSignature);

    let mut ed25519_ix_opt = None;
    for i in 0..current_idx {
        let ix = load_instruction_at_checked(i, &ctx.accounts.instructions_sysvar)
            .map_err(|_| error!(NavOracleError::InvalidSignature))?;
        if ix.program_id == ED25519_PROGRAM_ID {
            ed25519_ix_opt = Some(ix);
            break;
        }
    }
    let ed25519_ix = ed25519_ix_opt.ok_or_else(|| error!(NavOracleError::InvalidSignature))?;

    // Canonical signing payload (signature zeroed: it's produced AFTER signing).
    let expected_payload = {
        let staged_for_payload = NavAccount {
            version: NavAccount::HEADER_VERSION,
            nav_net: args.nav_net,
            timestamp: args.timestamp,
            sequence: args.sequence,
            pool: nav.pool,
            nav_gross: args.nav_gross,
            ter_bps: args.ter_bps,
            loss_provision_bps: args.loss_bps,
            nav_type: args.nav_type,
            _padding: [0u8; 7],
            publisher: nav.publisher,
            signature: [0u8; 64],
            loan_tape_merkle_root: args.loan_tape_merkle_root,
            // Not part of signing_payload(); placeholders only.
            last_published_nav: 0,
            max_deviation_bps: 0,
        };
        staged_for_payload.signing_payload()
    };

    require!(
        verify_ed25519_ix_strict(
            &ed25519_ix.data,
            &nav.publisher,
            &args.signature,
            &expected_payload,
        ),
        NavOracleError::InvalidSignature
    );

    // Consecutive-price deviation guard (genesis last_published_nav == 0 skips).
    check_deviation(nav.last_published_nav, args.nav_net, nav.max_deviation_bps)?;

    let staged = NavAccount {
        version: NavAccount::HEADER_VERSION,
        nav_net: args.nav_net,
        timestamp: args.timestamp,
        sequence: args.sequence,
        pool: nav.pool,
        nav_gross: args.nav_gross,
        ter_bps: args.ter_bps,
        loss_provision_bps: args.loss_bps,
        nav_type: args.nav_type,
        _padding: [0u8; 7],
        publisher: nav.publisher,
        signature: args.signature,
        loan_tape_merkle_root: args.loan_tape_merkle_root,
        last_published_nav: args.nav_net,
        max_deviation_bps: nav.max_deviation_bps,
    };
    require!(
        staged.verify_self_consistency(),
        NavOracleError::InconsistentNav
    );

    **nav = staged;

    emit!(NavUpdated {
        pool: nav.pool,
        nav_net: nav.nav_net,
        nav_gross: nav.nav_gross,
        ter_bps: nav.ter_bps,
        loss_provision_bps: nav.loss_provision_bps,
        nav_type: nav.nav_type,
        timestamp: nav.timestamp,
        sequence: nav.sequence,
        publisher: nav.publisher,
        loan_tape_merkle_root: nav.loan_tape_merkle_root,
    });

    Ok(())
}

/// Verifies the Solana ed25519_program ix data actually verified
/// `(expected_pubkey, expected_sig, expected_msg)`. The strict variant
/// requires `count == 1` and all `instruction_index` fields = `0xFFFF`
/// (data inlined, not pointing at a different instruction's data —
/// prevents substitution attacks).
///
/// ed25519_program ix layout:
///   [count: u8][_pad: u8]
///   [sig_offset: u16][sig_ix_idx: u16]
///   [pk_offset: u16][pk_ix_idx: u16]
///   [msg_offset: u16][msg_size: u16][msg_ix_idx: u16]
///   [...data...]
fn verify_ed25519_ix_strict(
    ix_data: &[u8],
    expected_pubkey: &Pubkey,
    expected_sig: &[u8; 64],
    expected_msg: &[u8],
) -> bool {
    if ix_data.len() < 16 || ix_data[0] != 1 {
        return false;
    }

    let sig_offset = usize::from(u16::from_le_bytes([ix_data[2], ix_data[3]]));
    let sig_ix_idx = u16::from_le_bytes([ix_data[4], ix_data[5]]);
    let pk_offset = usize::from(u16::from_le_bytes([ix_data[6], ix_data[7]]));
    let pk_ix_idx = u16::from_le_bytes([ix_data[8], ix_data[9]]);
    let msg_offset = usize::from(u16::from_le_bytes([ix_data[10], ix_data[11]]));
    let msg_size = usize::from(u16::from_le_bytes([ix_data[12], ix_data[13]]));
    let msg_ix_idx = u16::from_le_bytes([ix_data[14], ix_data[15]]);

    if sig_ix_idx != 0xFFFF || pk_ix_idx != 0xFFFF || msg_ix_idx != 0xFFFF {
        return false;
    }

    if pk_offset + 32 > ix_data.len()
        || sig_offset + 64 > ix_data.len()
        || msg_offset + msg_size > ix_data.len()
    {
        return false;
    }

    &ix_data[pk_offset..pk_offset + 32] == expected_pubkey.as_ref()
        && &ix_data[sig_offset..sig_offset + 64] == expected_sig
        && &ix_data[msg_offset..msg_offset + msg_size] == expected_msg
}

/// Pure consecutive-price deviation check. `last == 0` (genesis) always
/// passes — there is no prior value to bound against. Uses checked arithmetic
/// throughout so it is panic-free and unit-testable outside the gated handler.
pub fn check_deviation(last: u64, new: u64, max_bps: u16) -> Result<()> {
    if last == 0 {
        return Ok(());
    }
    let diff = new.abs_diff(last);
    let deviation_bps = diff
        .checked_mul(10_000)
        .and_then(|v| v.checked_div(last))
        .ok_or(error!(NavOracleError::DeviationExceeded))?;
    require!(
        deviation_bps <= max_bps as u64,
        NavOracleError::DeviationExceeded
    );
    Ok(())
}

#[event]
pub struct NavUpdated {
    pub pool: Pubkey,
    pub nav_net: u64,
    pub nav_gross: u64,
    pub ter_bps: u16,
    pub loss_provision_bps: u16,
    pub nav_type: u8,
    pub timestamp: i64,
    pub sequence: u64,
    pub publisher: Pubkey,
    pub loan_tape_merkle_root: [u8; 32],
}

#[cfg(test)]
mod deviation_tests {
    use super::check_deviation;

    #[test]
    fn rejects_over_deviation() {
        // 100% jump against a 5% ceiling.
        assert!(check_deviation(1_000_000_000, 2_000_000_000, 500).is_err());
    }

    #[test]
    fn accepts_within_bound() {
        // 4% jump under a 5% ceiling.
        assert!(check_deviation(1_000_000_000, 1_040_000_000, 500).is_ok());
    }

    #[test]
    fn genesis_accepts_any_magnitude() {
        assert!(check_deviation(0, u64::MAX, 1).is_ok());
    }
}

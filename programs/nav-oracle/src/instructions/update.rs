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
    /// CHECK: pool seed validation only.
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

    // 1. Sequence must strictly increase.
    require!(args.sequence > nav.sequence, NavOracleError::StaleSequence);

    // 2. Timestamp not in future (allow up to 60s clock skew).
    let now = Clock::get()?.unix_timestamp;
    require!(
        args.timestamp <= now + 60,
        NavOracleError::TimestampInFuture
    );

    // 3. Verify SOME PRECEDING instruction in this tx is the ed25519 verify
    //    of (publisher, message=signing_payload, signature=args.signature).
    //    Must scan ALL instructions before this one, not just index 0.
    //    Earlier draft used `load_instruction_at_checked(0, ...)` which assumes
    //    Ed25519Program is the FIRST instruction. That breaks the moment the
    //    publisher prepends a ComputeBudget instruction (priority fees / unit limits),
    //    which is standard practice on Solana mainnet. We must tolerate any layout
    //    where the Ed25519 verify is somewhere before this update ix.
    let current_idx = load_current_index_checked(&ctx.accounts.instructions_sysvar)
        .map_err(|_| error!(NavOracleError::InvalidSignature))? as usize;
    require!(current_idx > 0, NavOracleError::InvalidSignature); // need at least one prior ix

    let mut ed25519_ix_opt = None;
    for i in 0..current_idx {
        let ix = load_instruction_at_checked(i, &ctx.accounts.instructions_sysvar)
            .map_err(|_| error!(NavOracleError::InvalidSignature))?;
        if ix.program_id == ED25519_PROGRAM_ID {
            ed25519_ix_opt = Some(ix);
            break; // first ed25519 verify ix wins; if there are multiple, only [0] is checked
        }
    }
    let ed25519_ix = ed25519_ix_opt.ok_or_else(|| error!(NavOracleError::InvalidSignature))?;

    // 4. Reconstruct expected canonical signing payload from the supplied args
    //    using the SAME serialization the publisher used off-chain
    //    (NavAccount::signing_payload). The `signature` field is zeroed because
    //    the payload is signed BEFORE the signature is produced.
    let expected_payload = {
        let staged_for_payload = NavAccount {
            pool: nav.pool,
            nav_net: args.nav_net,
            nav_gross: args.nav_gross,
            ter_bps: args.ter_bps,
            loss_provision_bps: args.loss_bps,
            nav_type: args.nav_type,
            _padding: [0u8; 7],
            timestamp: args.timestamp,
            sequence: args.sequence,
            publisher: nav.publisher,
            signature: [0u8; 64],
            loan_tape_merkle_root: args.loan_tape_merkle_root,
            key_rotation_authority: nav.key_rotation_authority,
        };
        staged_for_payload.signing_payload()
    };

    // 5. Strict ed25519 precompile check: the matched ix must verify
    //    (publisher, signature, expected_payload) with all data inlined
    //    (instruction_index fields == 0xFFFF) and exactly one verification.
    require!(
        verify_ed25519_ix_strict(
            &ed25519_ix.data,
            &nav.publisher,
            &args.signature,
            &expected_payload,
        ),
        NavOracleError::InvalidSignature
    );

    // 6. Self-consistency check on the supplied fields (computed locally,
    //    independent of what we'll persist).
    let staged = NavAccount {
        pool: nav.pool,
        nav_net: args.nav_net,
        nav_gross: args.nav_gross,
        ter_bps: args.ter_bps,
        loss_provision_bps: args.loss_bps,
        nav_type: args.nav_type,
        _padding: [0u8; 7],
        timestamp: args.timestamp,
        sequence: args.sequence,
        publisher: nav.publisher,
        signature: args.signature,
        loan_tape_merkle_root: args.loan_tape_merkle_root,
        key_rotation_authority: nav.key_rotation_authority,
    };
    require!(
        staged.verify_self_consistency(),
        NavOracleError::InconsistentNav
    );

    // 7. Persist (deref through Account<'_, NavAccount> into the inner struct).
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

// NOTE: do NOT define a loose `verify_ed25519_ix` helper here. Earlier drafts of
// this plan included one that only checked payload length and was meant to be
// "tightened later", which is exactly the kind of partial implementation that
// gets shipped accidentally. The canonical helper is `verify_ed25519_ix_strict`
// below — and the handler above already calls THAT one (not a loose variant).
// A CI grep guard fails the build if the bare name `verify_ed25519_ix` (without
// `_strict`) ever reappears in this directory.

/// Strict verifier: confirms the ed25519_program ix at `ix_data` actually verified
/// `expected_sig` over `expected_msg` using `expected_pubkey`. The instruction layout is
/// the Solana ed25519_program standard:
///   [count:u8][padding:u8]
///   [signature_offset:u16][signature_instruction_index:u16]
///   [public_key_offset:u16][public_key_instruction_index:u16]
///   [message_data_offset:u16][message_data_size:u16][message_instruction_index:u16]
///   [...data...]
///
/// We require count == 1 (exactly one verification) and all instruction_index fields == 0xFFFF
/// (data is in this same instruction, not in another). This prevents an attacker from pointing
/// the ed25519 verify at someone else's earlier instruction.
fn verify_ed25519_ix_strict(
    ix_data: &[u8],
    expected_pubkey: &Pubkey,
    expected_sig: &[u8; 64],
    expected_msg: &[u8],
) -> bool {
    if ix_data.len() < 16 {
        return false;
    }
    if ix_data[0] != 1 {
        return false;
    } // count == 1

    let sig_offset = u16::from_le_bytes([ix_data[2], ix_data[3]]) as usize;
    let sig_ix_idx = u16::from_le_bytes([ix_data[4], ix_data[5]]);
    let pk_offset = u16::from_le_bytes([ix_data[6], ix_data[7]]) as usize;
    let pk_ix_idx = u16::from_le_bytes([ix_data[8], ix_data[9]]);
    let msg_offset = u16::from_le_bytes([ix_data[10], ix_data[11]]) as usize;
    let msg_size = u16::from_le_bytes([ix_data[12], ix_data[13]]) as usize;
    let msg_ix_idx = u16::from_le_bytes([ix_data[14], ix_data[15]]);

    // 0xFFFF means "data is in this same instruction".
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

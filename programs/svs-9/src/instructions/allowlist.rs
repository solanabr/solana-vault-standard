use crate::constants::*;
use crate::error::*;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;

// =============================================================================
// Initialize Allowed Programs
// =============================================================================

#[derive(Accounts)]
pub struct InitializeAllowedPrograms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        init,
        payer = authority,
        space = 8 + AllowedPrograms::INIT_SPACE,
        seeds = [ALLOWED_PROGRAMS_SEED, allocator_vault.key().as_ref()],
        bump
    )]
    pub allowed_programs: Account<'info, AllowedPrograms>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_allowed_programs_handler(
    ctx: Context<InitializeAllowedPrograms>,
    initial_programs: Vec<Pubkey>,
) -> Result<()> {
    let num = initial_programs.len();
    require!(num <= MAX_ALLOWED_PROGRAMS, VaultError::AllowlistFull);

    let allowed = &mut ctx.accounts.allowed_programs;
    allowed.allocator_vault = ctx.accounts.allocator_vault.key();
    allowed.num_programs = num as u8;
    allowed.programs = [Pubkey::default(); 10];
    allowed.bump = ctx.bumps.allowed_programs;

    for (i, program_id) in initial_programs.iter().enumerate() {
        // Check for duplicates within the provided list
        for prev in initial_programs.iter().take(i) {
            require!(*prev != *program_id, VaultError::ProgramAlreadyAllowed);
        }
        allowed.programs[i] = *program_id;
    }

    emit!(AllowedProgramsInitialized {
        allocator_vault: allowed.allocator_vault,
        num_programs: allowed.num_programs,
    });

    Ok(())
}

// =============================================================================
// Add Allowed Program
// =============================================================================

#[derive(Accounts)]
pub struct AddAllowedProgram<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        mut,
        seeds = [ALLOWED_PROGRAMS_SEED, allocator_vault.key().as_ref()],
        bump = allowed_programs.bump,
        has_one = allocator_vault @ VaultError::Unauthorized,
    )]
    pub allowed_programs: Account<'info, AllowedPrograms>,
}

pub fn add_allowed_program_handler(
    ctx: Context<AddAllowedProgram>,
    program_id: Pubkey,
) -> Result<()> {
    let allowed = &mut ctx.accounts.allowed_programs;
    let count = allowed.num_programs as usize;

    require!(count < MAX_ALLOWED_PROGRAMS, VaultError::AllowlistFull);

    // Check program is not already in list
    for i in 0..count {
        require!(
            allowed.programs[i] != program_id,
            VaultError::ProgramAlreadyAllowed
        );
    }

    allowed.programs[count] = program_id;
    allowed.num_programs = allowed
        .num_programs
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(AllowedProgramAdded {
        allocator_vault: allowed.allocator_vault,
        program_id,
    });

    Ok(())
}

// =============================================================================
// Remove Allowed Program
// =============================================================================

#[derive(Accounts)]
pub struct RemoveAllowedProgram<'info> {
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ VaultError::Unauthorized,
    )]
    pub allocator_vault: Account<'info, AllocatorVault>,

    #[account(
        mut,
        seeds = [ALLOWED_PROGRAMS_SEED, allocator_vault.key().as_ref()],
        bump = allowed_programs.bump,
        has_one = allocator_vault @ VaultError::Unauthorized,
    )]
    pub allowed_programs: Account<'info, AllowedPrograms>,
}

pub fn remove_allowed_program_handler(
    ctx: Context<RemoveAllowedProgram>,
    program_id: Pubkey,
) -> Result<()> {
    let allowed = &mut ctx.accounts.allowed_programs;
    let count = allowed.num_programs as usize;

    // Find the program in the list
    let mut found_index: Option<usize> = None;
    for i in 0..count {
        if allowed.programs[i] == program_id {
            found_index = Some(i);
            break;
        }
    }

    let index = found_index.ok_or(VaultError::ProgramNotInAllowlist)?;

    // Swap-remove: move last element into the removed slot
    let last_index = count.checked_sub(1).ok_or(VaultError::MathOverflow)?;
    if index != last_index {
        allowed.programs[index] = allowed.programs[last_index];
    }
    allowed.programs[last_index] = Pubkey::default();
    allowed.num_programs = allowed
        .num_programs
        .checked_sub(1)
        .ok_or(VaultError::MathOverflow)?;

    emit!(AllowedProgramRemoved {
        allocator_vault: allowed.allocator_vault,
        program_id,
    });

    Ok(())
}

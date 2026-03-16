//! SVS-9 constants and PDA seeds.

/// PDA seed for AllocatorVault accounts
pub const ALLOCATOR_SEED: &[u8] = b"allocator_vault";

/// PDA seed for ChildAllocation accounts
pub const CHILD_ALLOCATION_SEED: &[u8] = b"child_allocation";

/// PDA seed for the idle asset vault token account
pub const IDLE_VAULT_SEED: &[u8] = b"idle_vault";

/// Maximum number of child vault allocations
pub const MAX_CHILDREN: usize = 10;

/// Minimum deposit amount
pub const MIN_DEPOSIT_AMOUNT: u64 = 1;

/// Maximum idle buffer (100% in basis points)
pub const MAX_IDLE_BUFFER_BPS: u16 = 10_000;

/// Maximum weight in basis points (100%)
pub const MAX_WEIGHT_BPS: u16 = 10_000;

/// SVS-1 vault account discriminator (for child CPI validation)
pub const SVS1_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];

/// Byte offset of asset_vault field in SVS-1 Vault struct
pub const TOTAL_ASSETS_OFFSET: usize = 8 + 32 + 32 + 32 + 32;

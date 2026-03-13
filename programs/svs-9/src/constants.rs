//! Constants for SVS-9 allocator vault.

pub const ALLOCATOR_VAULT_SEED: &[u8] = b"allocator_vault";
pub const CHILD_ALLOCATION_SEED: &[u8] = b"child_allocation";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const IDLE_VAULT_SEED: &[u8] = b"idle_vault";

// Child vault discriminators for validation
pub const SVS1_VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
pub const SVS2_VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119]; // Same as SVS-1

// Child vault struct offsets for direct deserialization
pub const TOTAL_ASSETS_OFFSET: usize = 8 + 32 + 32 + 32 + 32; // discriminator + authority + asset_mint + shares_mint + asset_vault
pub const TOTAL_SHARES_OFFSET: usize = TOTAL_ASSETS_OFFSET + 8;
pub const DECIMALS_OFFSET_OFFSET: usize = TOTAL_SHARES_OFFSET + 8;

// Limits
pub const MAX_CHILDREN: u8 = 10;
pub const DEFAULT_IDLE_BUFFER_BPS: u16 = 500; // 5%
pub const MIN_WEIGHT_BPS: u16 = 100; // 1%
pub const MAX_WEIGHT_BPS: u16 = 8000; // 80%

// Compute optimization
pub const TOTAL_ASSETS_CACHE_TTL_SECS: i64 = 30; // 30 seconds cache
pub const HARVEST_BATCH_SIZE: usize = 4; // Process 4 children per harvest batch

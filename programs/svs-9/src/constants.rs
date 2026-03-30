use anchor_lang::prelude::*;

#[constant]
pub const ALLOCATOR_VAULT_SEED: &[u8] = b"allocator_vault";

#[constant]
pub const CHILD_ALLOCATION_SEED: &[u8] = b"child_allocation";

#[constant]
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

/// Anchor discriminator for global:deposit - sha256("global:deposit")[..8]
pub const DEPOSIT_DISCRIMINATOR: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];

/// Anchor discriminator for global:redeem - sha256("global:redeem")[..8]
pub const REDEEM_DISCRIMINATOR: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];

pub const VAULT_DISCRIMINATOR: [u8; 8] = [211, 8, 232, 43, 2, 152, 117, 119];
pub const CONFIDENTIAL_VAULT_DISCRIMINATOR: [u8; 8] = [107, 161, 220, 30, 88, 176, 39, 252];
pub const ALLOCATOR_VAULT_DISCRIMINATOR: [u8; 8] = [209, 232, 76, 227, 227, 115, 145, 134];

pub const SVS1_ID: Pubkey = pubkey!("Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC");
pub const SVS2_ID: Pubkey = pubkey!("3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD");
pub const SVS3_ID: Pubkey = pubkey!("EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh");
pub const SVS4_ID: Pubkey = pubkey!("2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY");
pub const SVS9_ID: Pubkey = pubkey!("CZweMiLWPPgKMiQXVNSuuwaoiHUyKWZzoBhhFg2D1VaU");

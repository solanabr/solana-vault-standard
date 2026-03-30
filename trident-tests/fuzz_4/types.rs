//! SVS-10 instruction builders for Trident fuzz testing.
//!
//! Follows the same pattern as the auto-generated fuzz_0/types.rs.

#![allow(dead_code)]

use borsh::{BorshDeserialize, BorshSerialize};
use trident_fuzz::fuzzing::*;

pub fn program_id() -> Pubkey {
    pubkey!("CpjFjyxRwTGYxR6JWXpfQ1923z5wVwpyBvgPFjm9jamJ")
}

// ============================================================================
// Initialize
// ============================================================================

pub struct InitializeInstruction {
    pub accounts: InitializeAccountMetas,
    pub data: InitializeData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct InitializeAccountMetas {
    pub authority: AccountMeta,
    pub operator: AccountMeta,
    pub vault: AccountMeta,
    pub asset_mint: AccountMeta,
    pub shares_mint: AccountMeta,
    pub asset_vault: AccountMeta,
    pub share_escrow: AccountMeta,
    pub asset_token_program: AccountMeta,
    pub token_2022_program: AccountMeta,
    pub associated_token_program: AccountMeta,
    pub system_program: AccountMeta,
    pub rent: AccountMeta,
}

pub struct InitializeAccounts {
    pub authority: Pubkey,
    pub operator: Pubkey,
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub share_escrow: Pubkey,
    pub asset_token_program: Pubkey,
    pub token_2022_program: Pubkey,
    pub associated_token_program: Pubkey,
    pub system_program: Pubkey,
    pub rent: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct InitializeData {
    pub vault_id: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

impl InitializeData {
    pub fn new(vault_id: u64, name: String, symbol: String, uri: String) -> Self {
        Self { vault_id, name, symbol, uri }
    }
}

impl InitializeInstruction {
    fn discriminator() -> [u8; 8] {
        [175u8, 175u8, 109u8, 31u8, 13u8, 152u8, 155u8, 237u8]
    }

    pub fn data(data: InitializeData) -> Self {
        Self { accounts: InitializeAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: InitializeAccounts) -> Self {
        self.accounts.authority = AccountMeta::new(a.authority, true);
        self.accounts.operator = AccountMeta::new_readonly(a.operator, false);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.asset_mint = AccountMeta::new_readonly(a.asset_mint, false);
        self.accounts.shares_mint = AccountMeta::new(a.shares_mint, false);
        self.accounts.asset_vault = AccountMeta::new(a.asset_vault, false);
        self.accounts.share_escrow = AccountMeta::new(a.share_escrow, false);
        self.accounts.asset_token_program = AccountMeta::new_readonly(a.asset_token_program, false);
        self.accounts.token_2022_program = AccountMeta::new_readonly(a.token_2022_program, false);
        self.accounts.associated_token_program = AccountMeta::new_readonly(a.associated_token_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self.accounts.rent = AccountMeta::new_readonly(a.rent, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let mut metas = vec![
            self.accounts.authority.clone(),
            self.accounts.operator.clone(),
            self.accounts.vault.clone(),
            self.accounts.asset_mint.clone(),
            self.accounts.shares_mint.clone(),
            self.accounts.asset_vault.clone(),
            self.accounts.share_escrow.clone(),
            self.accounts.asset_token_program.clone(),
            self.accounts.token_2022_program.clone(),
            self.accounts.associated_token_program.clone(),
            self.accounts.system_program.clone(),
            self.accounts.rent.clone(),
        ];
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// RequestDeposit
// ============================================================================

pub struct RequestDepositInstruction {
    pub accounts: RequestDepositAccountMetas,
    pub data: RequestDepositData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct RequestDepositAccountMetas {
    pub user: AccountMeta,
    pub vault: AccountMeta,
    pub asset_mint: AccountMeta,
    pub user_asset_account: AccountMeta,
    pub asset_vault: AccountMeta,
    pub deposit_request: AccountMeta,
    pub asset_token_program: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct RequestDepositAccounts {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub user_asset_account: Pubkey,
    pub asset_vault: Pubkey,
    pub deposit_request: Pubkey,
    pub asset_token_program: Pubkey,
    pub system_program: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct RequestDepositData {
    pub assets: u64,
    pub receiver: Pubkey,
}

impl RequestDepositData {
    pub fn new(assets: u64, receiver: Pubkey) -> Self {
        Self { assets, receiver }
    }
}

impl RequestDepositInstruction {
    fn discriminator() -> [u8; 8] {
        [243u8, 202u8, 197u8, 215u8, 135u8, 97u8, 213u8, 109u8]
    }

    pub fn data(data: RequestDepositData) -> Self {
        Self { accounts: RequestDepositAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: RequestDepositAccounts) -> Self {
        self.accounts.user = AccountMeta::new(a.user, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.asset_mint = AccountMeta::new_readonly(a.asset_mint, false);
        self.accounts.user_asset_account = AccountMeta::new(a.user_asset_account, false);
        self.accounts.asset_vault = AccountMeta::new(a.asset_vault, false);
        self.accounts.deposit_request = AccountMeta::new(a.deposit_request, false);
        self.accounts.asset_token_program = AccountMeta::new_readonly(a.asset_token_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let mut metas = vec![
            self.accounts.user.clone(),
            self.accounts.vault.clone(),
            self.accounts.asset_mint.clone(),
            self.accounts.user_asset_account.clone(),
            self.accounts.asset_vault.clone(),
            self.accounts.deposit_request.clone(),
            self.accounts.asset_token_program.clone(),
            self.accounts.system_program.clone(),
        ];
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// CancelDeposit
// ============================================================================

pub struct CancelDepositInstruction {
    pub accounts: CancelDepositAccountMetas,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct CancelDepositAccountMetas {
    pub user: AccountMeta,
    pub vault: AccountMeta,
    pub asset_mint: AccountMeta,
    pub user_asset_account: AccountMeta,
    pub asset_vault: AccountMeta,
    pub deposit_request: AccountMeta,
    pub asset_token_program: AccountMeta,
    pub clock: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct CancelDepositAccounts {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub user_asset_account: Pubkey,
    pub asset_vault: Pubkey,
    pub deposit_request: Pubkey,
    pub asset_token_program: Pubkey,
    pub clock: Pubkey,
    pub system_program: Pubkey,
}

impl CancelDepositInstruction {
    fn discriminator() -> [u8; 8] {
        [207u8, 37u8, 219u8, 229u8, 183u8, 50u8, 54u8, 245u8]
    }

    pub fn new() -> Self {
        Self { accounts: CancelDepositAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: CancelDepositAccounts) -> Self {
        self.accounts.user = AccountMeta::new(a.user, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.asset_mint = AccountMeta::new_readonly(a.asset_mint, false);
        self.accounts.user_asset_account = AccountMeta::new(a.user_asset_account, false);
        self.accounts.asset_vault = AccountMeta::new(a.asset_vault, false);
        self.accounts.deposit_request = AccountMeta::new(a.deposit_request, false);
        self.accounts.asset_token_program = AccountMeta::new_readonly(a.asset_token_program, false);
        self.accounts.clock = AccountMeta::new_readonly(a.clock, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let mut metas = vec![
            self.accounts.user.clone(),
            self.accounts.vault.clone(),
            self.accounts.asset_mint.clone(),
            self.accounts.user_asset_account.clone(),
            self.accounts.asset_vault.clone(),
            self.accounts.deposit_request.clone(),
            self.accounts.asset_token_program.clone(),
            self.accounts.clock.clone(),
            self.accounts.system_program.clone(),
        ];
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// FulfillDeposit
// ============================================================================

pub struct FulfillDepositInstruction {
    pub accounts: FulfillDepositAccountMetas,
    pub data: FulfillDepositData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct FulfillDepositAccountMetas {
    pub operator: AccountMeta,
    pub vault: AccountMeta,
    pub deposit_request: AccountMeta,
    pub operator_approval: AccountMeta,
    pub clock: AccountMeta,
}

pub struct FulfillDepositAccounts {
    pub operator: Pubkey,
    pub vault: Pubkey,
    pub deposit_request: Pubkey,
    pub operator_approval: Option<Pubkey>,
    pub clock: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct FulfillDepositData {
    pub oracle_price: Option<u64>,
}

impl FulfillDepositData {
    pub fn new(oracle_price: Option<u64>) -> Self {
        Self { oracle_price }
    }
}

impl FulfillDepositInstruction {
    fn discriminator() -> [u8; 8] {
        [69u8, 18u8, 152u8, 243u8, 47u8, 69u8, 190u8, 112u8]
    }

    pub fn data(data: FulfillDepositData) -> Self {
        Self { accounts: FulfillDepositAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: FulfillDepositAccounts) -> Self {
        self.accounts.operator = AccountMeta::new_readonly(a.operator, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.deposit_request = AccountMeta::new(a.deposit_request, false);
        if let Some(approval) = a.operator_approval {
            self.accounts.operator_approval = AccountMeta::new_readonly(approval, false);
        }
        self.accounts.clock = AccountMeta::new_readonly(a.clock, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let mut metas = vec![
            self.accounts.operator.clone(),
            self.accounts.vault.clone(),
            self.accounts.deposit_request.clone(),
        ];
        if self.accounts.operator_approval.pubkey != Pubkey::default() {
            metas.push(self.accounts.operator_approval.clone());
        }
        metas.push(self.accounts.clock.clone());
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// ClaimDeposit
// ============================================================================

pub struct ClaimDepositInstruction {
    pub accounts: ClaimDepositAccountMetas,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct ClaimDepositAccountMetas {
    pub claimant: AccountMeta,
    pub vault: AccountMeta,
    pub deposit_request: AccountMeta,
    pub owner: AccountMeta,
    pub shares_mint: AccountMeta,
    pub receiver_shares_account: AccountMeta,
    pub receiver: AccountMeta,
    pub operator_approval: AccountMeta,
    pub token_2022_program: AccountMeta,
    pub associated_token_program: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct ClaimDepositAccounts {
    pub claimant: Pubkey,
    pub vault: Pubkey,
    pub deposit_request: Pubkey,
    pub owner: Pubkey,
    pub shares_mint: Pubkey,
    pub receiver_shares_account: Pubkey,
    pub receiver: Pubkey,
    pub operator_approval: Option<Pubkey>,
    pub token_2022_program: Pubkey,
    pub associated_token_program: Pubkey,
    pub system_program: Pubkey,
}

impl ClaimDepositInstruction {
    fn discriminator() -> [u8; 8] {
        [201u8, 106u8, 1u8, 224u8, 122u8, 144u8, 210u8, 155u8]
    }

    pub fn new() -> Self {
        Self { accounts: ClaimDepositAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: ClaimDepositAccounts) -> Self {
        self.accounts.claimant = AccountMeta::new(a.claimant, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.deposit_request = AccountMeta::new(a.deposit_request, false);
        self.accounts.owner = AccountMeta::new(a.owner, false);
        self.accounts.shares_mint = AccountMeta::new(a.shares_mint, false);
        self.accounts.receiver_shares_account = AccountMeta::new(a.receiver_shares_account, false);
        self.accounts.receiver = AccountMeta::new_readonly(a.receiver, false);
        if let Some(approval) = a.operator_approval {
            self.accounts.operator_approval = AccountMeta::new_readonly(approval, false);
        }
        self.accounts.token_2022_program = AccountMeta::new_readonly(a.token_2022_program, false);
        self.accounts.associated_token_program = AccountMeta::new_readonly(a.associated_token_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let mut metas = vec![
            self.accounts.claimant.clone(),
            self.accounts.vault.clone(),
            self.accounts.deposit_request.clone(),
            self.accounts.owner.clone(),
            self.accounts.shares_mint.clone(),
            self.accounts.receiver_shares_account.clone(),
            self.accounts.receiver.clone(),
        ];
        if self.accounts.operator_approval.pubkey != Pubkey::default() {
            metas.push(self.accounts.operator_approval.clone());
        }
        metas.push(self.accounts.token_2022_program.clone());
        metas.push(self.accounts.associated_token_program.clone());
        metas.push(self.accounts.system_program.clone());
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// RequestRedeem
// ============================================================================

pub struct RequestRedeemInstruction {
    pub accounts: RequestRedeemAccountMetas,
    pub data: RequestRedeemData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct RequestRedeemAccountMetas {
    pub user: AccountMeta,
    pub vault: AccountMeta,
    pub shares_mint: AccountMeta,
    pub user_shares_account: AccountMeta,
    pub share_escrow: AccountMeta,
    pub redeem_request: AccountMeta,
    pub token_2022_program: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct RequestRedeemAccounts {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub shares_mint: Pubkey,
    pub user_shares_account: Pubkey,
    pub share_escrow: Pubkey,
    pub redeem_request: Pubkey,
    pub token_2022_program: Pubkey,
    pub system_program: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct RequestRedeemData {
    pub shares: u64,
    pub receiver: Pubkey,
}

impl RequestRedeemData {
    pub fn new(shares: u64, receiver: Pubkey) -> Self {
        Self { shares, receiver }
    }
}

impl RequestRedeemInstruction {
    fn discriminator() -> [u8; 8] {
        [105u8, 49u8, 44u8, 38u8, 207u8, 241u8, 33u8, 173u8]
    }

    pub fn data(data: RequestRedeemData) -> Self {
        Self { accounts: RequestRedeemAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: RequestRedeemAccounts) -> Self {
        self.accounts.user = AccountMeta::new(a.user, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.shares_mint = AccountMeta::new(a.shares_mint, false);
        self.accounts.user_shares_account = AccountMeta::new(a.user_shares_account, false);
        self.accounts.share_escrow = AccountMeta::new(a.share_escrow, false);
        self.accounts.redeem_request = AccountMeta::new(a.redeem_request, false);
        self.accounts.token_2022_program = AccountMeta::new_readonly(a.token_2022_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let mut metas = vec![
            self.accounts.user.clone(),
            self.accounts.vault.clone(),
            self.accounts.shares_mint.clone(),
            self.accounts.user_shares_account.clone(),
            self.accounts.share_escrow.clone(),
            self.accounts.redeem_request.clone(),
            self.accounts.token_2022_program.clone(),
            self.accounts.system_program.clone(),
        ];
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// CancelRedeem
// ============================================================================

pub struct CancelRedeemInstruction {
    pub accounts: CancelRedeemAccountMetas,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct CancelRedeemAccountMetas {
    pub user: AccountMeta,
    pub vault: AccountMeta,
    pub shares_mint: AccountMeta,
    pub user_shares_account: AccountMeta,
    pub share_escrow: AccountMeta,
    pub redeem_request: AccountMeta,
    pub token_2022_program: AccountMeta,
    pub clock: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct CancelRedeemAccounts {
    pub user: Pubkey,
    pub vault: Pubkey,
    pub shares_mint: Pubkey,
    pub user_shares_account: Pubkey,
    pub share_escrow: Pubkey,
    pub redeem_request: Pubkey,
    pub token_2022_program: Pubkey,
    pub clock: Pubkey,
    pub system_program: Pubkey,
}

impl CancelRedeemInstruction {
    fn discriminator() -> [u8; 8] {
        [111u8, 76u8, 232u8, 50u8, 39u8, 175u8, 48u8, 242u8]
    }

    pub fn new() -> Self {
        Self { accounts: CancelRedeemAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: CancelRedeemAccounts) -> Self {
        self.accounts.user = AccountMeta::new(a.user, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.shares_mint = AccountMeta::new(a.shares_mint, false);
        self.accounts.user_shares_account = AccountMeta::new(a.user_shares_account, false);
        self.accounts.share_escrow = AccountMeta::new(a.share_escrow, false);
        self.accounts.redeem_request = AccountMeta::new(a.redeem_request, false);
        self.accounts.token_2022_program = AccountMeta::new_readonly(a.token_2022_program, false);
        self.accounts.clock = AccountMeta::new_readonly(a.clock, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let mut metas = vec![
            self.accounts.user.clone(),
            self.accounts.vault.clone(),
            self.accounts.shares_mint.clone(),
            self.accounts.user_shares_account.clone(),
            self.accounts.share_escrow.clone(),
            self.accounts.redeem_request.clone(),
            self.accounts.token_2022_program.clone(),
            self.accounts.clock.clone(),
            self.accounts.system_program.clone(),
        ];
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// FulfillRedeem
// ============================================================================

pub struct FulfillRedeemInstruction {
    pub accounts: FulfillRedeemAccountMetas,
    pub data: FulfillRedeemData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct FulfillRedeemAccountMetas {
    pub operator: AccountMeta,
    pub vault: AccountMeta,
    pub redeem_request: AccountMeta,
    pub operator_approval: AccountMeta,
    pub asset_mint: AccountMeta,
    pub asset_vault: AccountMeta,
    pub shares_mint: AccountMeta,
    pub share_escrow: AccountMeta,
    pub claimable_tokens: AccountMeta,
    pub asset_token_program: AccountMeta,
    pub token_2022_program: AccountMeta,
    pub system_program: AccountMeta,
    pub clock: AccountMeta,
}

pub struct FulfillRedeemAccounts {
    pub operator: Pubkey,
    pub vault: Pubkey,
    pub redeem_request: Pubkey,
    pub operator_approval: Option<Pubkey>,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,
    pub shares_mint: Pubkey,
    pub share_escrow: Pubkey,
    pub claimable_tokens: Pubkey,
    pub asset_token_program: Pubkey,
    pub token_2022_program: Pubkey,
    pub system_program: Pubkey,
    pub clock: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct FulfillRedeemData {
    pub oracle_price: Option<u64>,
}

impl FulfillRedeemData {
    pub fn new(oracle_price: Option<u64>) -> Self {
        Self { oracle_price }
    }
}

impl FulfillRedeemInstruction {
    fn discriminator() -> [u8; 8] {
        [220u8, 34u8, 48u8, 32u8, 158u8, 20u8, 185u8, 188u8]
    }

    pub fn data(data: FulfillRedeemData) -> Self {
        Self { accounts: FulfillRedeemAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: FulfillRedeemAccounts) -> Self {
        self.accounts.operator = AccountMeta::new(a.operator, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.redeem_request = AccountMeta::new(a.redeem_request, false);
        if let Some(approval) = a.operator_approval {
            self.accounts.operator_approval = AccountMeta::new_readonly(approval, false);
        }
        self.accounts.asset_mint = AccountMeta::new_readonly(a.asset_mint, false);
        self.accounts.asset_vault = AccountMeta::new(a.asset_vault, false);
        self.accounts.shares_mint = AccountMeta::new(a.shares_mint, false);
        self.accounts.share_escrow = AccountMeta::new(a.share_escrow, false);
        self.accounts.claimable_tokens = AccountMeta::new(a.claimable_tokens, false);
        self.accounts.asset_token_program = AccountMeta::new_readonly(a.asset_token_program, false);
        self.accounts.token_2022_program = AccountMeta::new_readonly(a.token_2022_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self.accounts.clock = AccountMeta::new_readonly(a.clock, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let mut metas = vec![
            self.accounts.operator.clone(),
            self.accounts.vault.clone(),
            self.accounts.redeem_request.clone(),
        ];
        if self.accounts.operator_approval.pubkey != Pubkey::default() {
            metas.push(self.accounts.operator_approval.clone());
        }
        metas.push(self.accounts.asset_mint.clone());
        metas.push(self.accounts.asset_vault.clone());
        metas.push(self.accounts.shares_mint.clone());
        metas.push(self.accounts.share_escrow.clone());
        metas.push(self.accounts.claimable_tokens.clone());
        metas.push(self.accounts.asset_token_program.clone());
        metas.push(self.accounts.token_2022_program.clone());
        metas.push(self.accounts.system_program.clone());
        metas.push(self.accounts.clock.clone());
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// ClaimRedeem
// ============================================================================

pub struct ClaimRedeemInstruction {
    pub accounts: ClaimRedeemAccountMetas,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct ClaimRedeemAccountMetas {
    pub claimant: AccountMeta,
    pub vault: AccountMeta,
    pub asset_mint: AccountMeta,
    pub redeem_request: AccountMeta,
    pub owner: AccountMeta,
    pub claimable_tokens: AccountMeta,
    pub receiver_asset_account: AccountMeta,
    pub receiver: AccountMeta,
    pub operator_approval: AccountMeta,
    pub asset_token_program: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct ClaimRedeemAccounts {
    pub claimant: Pubkey,
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub redeem_request: Pubkey,
    pub owner: Pubkey,
    pub claimable_tokens: Pubkey,
    pub receiver_asset_account: Pubkey,
    pub receiver: Pubkey,
    pub operator_approval: Option<Pubkey>,
    pub asset_token_program: Pubkey,
    pub system_program: Pubkey,
}

impl ClaimRedeemInstruction {
    fn discriminator() -> [u8; 8] {
        [125u8, 14u8, 137u8, 237u8, 160u8, 63u8, 225u8, 226u8]
    }

    pub fn new() -> Self {
        Self { accounts: ClaimRedeemAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: ClaimRedeemAccounts) -> Self {
        self.accounts.claimant = AccountMeta::new(a.claimant, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self.accounts.asset_mint = AccountMeta::new_readonly(a.asset_mint, false);
        self.accounts.redeem_request = AccountMeta::new(a.redeem_request, false);
        self.accounts.owner = AccountMeta::new(a.owner, false);
        self.accounts.claimable_tokens = AccountMeta::new(a.claimable_tokens, false);
        self.accounts.receiver_asset_account = AccountMeta::new(a.receiver_asset_account, false);
        self.accounts.receiver = AccountMeta::new_readonly(a.receiver, false);
        if let Some(approval) = a.operator_approval {
            self.accounts.operator_approval = AccountMeta::new_readonly(approval, false);
        }
        self.accounts.asset_token_program = AccountMeta::new_readonly(a.asset_token_program, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let mut metas = vec![
            self.accounts.claimant.clone(),
            self.accounts.vault.clone(),
            self.accounts.asset_mint.clone(),
            self.accounts.redeem_request.clone(),
            self.accounts.owner.clone(),
            self.accounts.claimable_tokens.clone(),
            self.accounts.receiver_asset_account.clone(),
            self.accounts.receiver.clone(),
        ];
        if self.accounts.operator_approval.pubkey != Pubkey::default() {
            metas.push(self.accounts.operator_approval.clone());
        }
        metas.push(self.accounts.asset_token_program.clone());
        metas.push(self.accounts.system_program.clone());
        metas.extend(self.remaining_accounts.clone());
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// SetOperator
// ============================================================================

pub struct SetOperatorInstruction {
    pub accounts: SetOperatorAccountMetas,
    pub data: SetOperatorData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct SetOperatorAccountMetas {
    pub owner: AccountMeta,
    pub vault: AccountMeta,
    pub operator_approval: AccountMeta,
    pub system_program: AccountMeta,
}

pub struct SetOperatorAccounts {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub operator_approval: Pubkey,
    pub system_program: Pubkey,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct SetOperatorData {
    pub operator: Pubkey,
    pub can_fulfill_deposit: bool,
    pub can_fulfill_redeem: bool,
    pub can_claim: bool,
}

impl SetOperatorData {
    pub fn new(
        operator: Pubkey,
        can_fulfill_deposit: bool,
        can_fulfill_redeem: bool,
        can_claim: bool,
    ) -> Self {
        Self { operator, can_fulfill_deposit, can_fulfill_redeem, can_claim }
    }
}

impl SetOperatorInstruction {
    fn discriminator() -> [u8; 8] {
        [238u8, 153u8, 101u8, 169u8, 243u8, 131u8, 36u8, 1u8]
    }

    pub fn data(data: SetOperatorData) -> Self {
        Self { accounts: SetOperatorAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: SetOperatorAccounts) -> Self {
        self.accounts.owner = AccountMeta::new(a.owner, true);
        self.accounts.vault = AccountMeta::new_readonly(a.vault, false);
        self.accounts.operator_approval = AccountMeta::new(a.operator_approval, false);
        self.accounts.system_program = AccountMeta::new_readonly(a.system_program, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let metas = vec![
            self.accounts.owner.clone(),
            self.accounts.vault.clone(),
            self.accounts.operator_approval.clone(),
            self.accounts.system_program.clone(),
        ];
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// Pause
// ============================================================================

pub struct PauseInstruction {
    pub accounts: AdminAccountMetas,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, Clone, Default)]
pub struct AdminAccountMetas {
    pub authority: AccountMeta,
    pub vault: AccountMeta,
}

pub struct AdminAccounts {
    pub authority: Pubkey,
    pub vault: Pubkey,
}

impl PauseInstruction {
    fn discriminator() -> [u8; 8] {
        [211u8, 22u8, 221u8, 251u8, 74u8, 121u8, 193u8, 47u8]
    }

    pub fn new() -> Self {
        Self { accounts: AdminAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: AdminAccounts) -> Self {
        self.accounts.authority = AccountMeta::new_readonly(a.authority, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let metas = vec![
            self.accounts.authority.clone(),
            self.accounts.vault.clone(),
        ];
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// Unpause
// ============================================================================

pub struct UnpauseInstruction {
    pub remaining_accounts: Vec<AccountMeta>,
    pub accounts: AdminAccountMetas,
}

impl UnpauseInstruction {
    fn discriminator() -> [u8; 8] {
        [169u8, 144u8, 4u8, 38u8, 10u8, 141u8, 188u8, 255u8]
    }

    pub fn new() -> Self {
        Self { accounts: AdminAccountMetas::default(), remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: AdminAccounts) -> Self {
        self.accounts.authority = AccountMeta::new_readonly(a.authority, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        let metas = vec![
            self.accounts.authority.clone(),
            self.accounts.vault.clone(),
        ];
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

// ============================================================================
// SetCancelAfter
// ============================================================================

pub struct SetCancelAfterInstruction {
    pub accounts: AdminAccountMetas,
    pub data: SetCancelAfterData,
    pub remaining_accounts: Vec<AccountMeta>,
}

#[derive(Debug, BorshDeserialize, BorshSerialize, Clone)]
pub struct SetCancelAfterData {
    pub cancel_after: i64,
}

impl SetCancelAfterData {
    pub fn new(cancel_after: i64) -> Self {
        Self { cancel_after }
    }
}

impl SetCancelAfterInstruction {
    fn discriminator() -> [u8; 8] {
        [101u8, 164u8, 92u8, 127u8, 39u8, 8u8, 43u8, 27u8]
    }

    pub fn data(data: SetCancelAfterData) -> Self {
        Self { accounts: AdminAccountMetas::default(), data, remaining_accounts: Vec::new() }
    }

    pub fn accounts(mut self, a: AdminAccounts) -> Self {
        self.accounts.authority = AccountMeta::new_readonly(a.authority, true);
        self.accounts.vault = AccountMeta::new(a.vault, false);
        self
    }

    pub fn instruction(&self) -> Instruction {
        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&Self::discriminator());
        self.data.serialize(&mut buffer).unwrap();
        let metas = vec![
            self.accounts.authority.clone(),
            self.accounts.vault.clone(),
        ];
        Instruction::new_with_bytes(program_id(), &buffer, metas)
    }
}

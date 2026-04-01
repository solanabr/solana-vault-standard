# Pinocchio Framework — Patterns, Security & API Reference
# Frank Castle — Safe Solana Builder
# Read this AFTER shared-base.md when the user selects Pinocchio.
# Every rule here is in addition to — not instead of — shared-base.md.

---

## Overview

Pinocchio is Anza's zero-dependency, zero-copy Solana framework. It treats incoming transaction data as a single byte slice, reading it in-place. It delivers 88–95% compute unit reduction and ~40% smaller binaries vs. Anchor. **It is unaudited — use with caution in production.**

### When to Use Pinocchio
- High-throughput programs (DEXs, orderbooks, games)
- Compute units are a bottleneck
- Maximum control over memory needed
- Building infrastructure (tokens, vaults, escrows)

### When to Use Anchor Instead
- Rapid prototyping / MVPs
- Team unfamiliar with low-level Rust
- Tight audit timeline (more auditors know Anchor)

---

## 1. PROJECT SETUP

```toml
[package]
name = "my-program"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
pinocchio        = "0.10"
pinocchio-system = "0.4"
pinocchio-token  = "0.4"
bytemuck         = { version = "1.14", features = ["derive"] }

[profile.release]
overflow-checks = true
lto             = "fat"
codegen-units   = 1
opt-level       = 3
```

---

## 2. PROGRAM STRUCTURE

```rust
use pinocchio::{
    account_info::AccountInfo, entrypoint,
    program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction_data.first() {
        Some(0) => initialize(accounts, &instruction_data[1..]),
        Some(1) => execute(accounts, &instruction_data[1..]),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

### Entrypoint Options (ordered by CU cost, cheapest last)

| Macro | Use When | Notes |
|---|---|---|
| `no_allocator!()` + `entrypoint!` | Statically-sized ops, no `String`/`Vec`/`Box` | Maximum CU savings |
| `lazy_entrypoint!` | Single-instruction programs | Defers account parsing until needed |
| `entrypoint!` | General use | Auto heap + panic handler |

---

## 3. ACCOUNT DEFINITIONS (BYTEMUCK — PREFERRED)

Use `bytemuck` for fixed-size accounts. Prefer over Borsh for zero-copy reads.

```rust
use bytemuck::{Pod, Zeroable};

pub const VAULT_DISCRIMINATOR: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Vault {
    pub discriminator: u8,
    pub owner: [u8; 32],
    pub balance: u64,
    pub bump: u8,
    pub _padding: [u8; 6],   // align to 8 bytes — always add padding
}

impl Vault {
    pub const LEN: usize = std::mem::size_of::<Self>();

    pub fn from_account(account: &AccountInfo) -> Result<&Self, ProgramError> {
        let data = account.try_borrow_data()?;
        if data.len() < Self::LEN { return Err(ProgramError::InvalidAccountData); }
        if data[0] != VAULT_DISCRIMINATOR { return Err(ProgramError::InvalidAccountData); }
        Ok(bytemuck::from_bytes(&data[..Self::LEN]))
    }

    pub fn from_account_mut(account: &AccountInfo) -> Result<&mut Self, ProgramError> {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() < Self::LEN { return Err(ProgramError::InvalidAccountData); }
        Ok(bytemuck::from_bytes_mut(&mut data[..Self::LEN]))
    }
}
```

**Security notes:**
- Always check discriminator before trusting any field (see shared-base §1.4).
- Always check data length before casting.
- Add `_padding` to align structs to 8 bytes — misalignment causes UB with `bytemuck`.

---

## 4. ACCOUNT VALIDATION PATTERNS

### Pattern A — TryFrom (Recommended)

```rust
pub struct DepositAccounts<'a> {
    pub vault: &'a AccountInfo,
    pub owner: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl<'a> TryFrom<&'a [AccountInfo]> for DepositAccounts<'a> {
    type Error = ProgramError;

    fn try_from(accounts: &'a [AccountInfo]) -> Result<Self, Self::Error> {
        let [vault, owner, system_program, ..] = accounts else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        if !owner.is_signer()    { return Err(ProgramError::MissingRequiredSignature); }
        if !vault.is_writable()  { return Err(ProgramError::InvalidAccountData); }
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(Self { vault, owner, system_program })
    }
}
```

### Pattern B — Validation Macros

```rust
macro_rules! require {
    ($cond:expr, $err:expr) => { if !$cond { return Err($err); } };
}
macro_rules! require_signer   { ($a:expr) => { require!($a.is_signer(),   ProgramError::MissingRequiredSignature) }; }
macro_rules! require_writable { ($a:expr) => { require!($a.is_writable(), ProgramError::InvalidAccountData) }; }
```

**Mandatory validation order (same as native — see native-rust.md §1.1):**
1. Key check (fixed accounts / sysvars)
2. Owner check — `account.owner() != &expected_program::ID`
3. Signer check — `account.is_signer()`
4. Writable check — `account.is_writable()`
5. Discriminator check — `data[0] != DISCRIMINATOR`
6. Field range validation

---

## 5. PDA OPERATIONS

```rust
// At init: find canonical bump, verify, and store
let (pda, bump) = Pubkey::find_program_address(
    &[b"vault", user.key().as_ref()],
    program_id,
);
if ctx.vault.key() != &pda { return Err(ProgramError::InvalidSeeds); }
vault.bump = bump;  // store for reuse

// On subsequent calls: re-derive from stored bump (cheaper)
let pda = Pubkey::create_program_address(
    &[b"vault", user.key().as_ref(), &[vault.bump]],
    program_id,
)?;
if ctx.vault.key() != &pda { return Err(ProgramError::InvalidSeeds); }
```

**Security notes (same as shared-base §2):**
- Never allow the user to supply a bump.
- Use `create_program_address` on subsequent calls — not `find_program_address`.
- Always include the user's pubkey in seeds for user-specific accounts.

---

## 6. CPI PATTERNS

### System Program

```rust
use pinocchio_system::instructions::{CreateAccount, Transfer};

// Create account
CreateAccount { from: payer, to: new_account, lamports, space, owner: &crate::ID }.invoke()?;

// Transfer SOL (PDA signer)
Transfer { from: vault_pda, to: destination, lamports: amount }
    .invoke_signed(&[&[b"vault", owner.as_ref(), &[bump]]])?;
```

### Token Program

```rust
use pinocchio_token::instructions::{Transfer, MintTo};

Transfer { source, destination, authority: owner, amount }.invoke()?;

MintTo { mint, token_account: dest, authority: mint_auth_pda, amount }
    .invoke_signed(&[&[b"mint_auth", &[bump]]])?;
```

### Custom CPI

```rust
use pinocchio::{instruction::{AccountMeta, Instruction}, program::invoke};

let ix = Instruction {
    program_id: &external_program_id,
    accounts: &[AccountMeta::new(*account.key(), false)],
    data: &instruction_data,
};
invoke(&ix, &[account])?;
```

**Security notes (same as shared-base §5):**
- Always verify external program IDs before invoking.
- Reload account data after any CPI that may have modified it — re-borrow and re-cast.
- Never use `invoke_signed` to elevate non-signer accounts.
- Pass only the accounts the callee needs.

---

## 7. DATA SERIALIZATION

| Method | Use When | Notes |
|---|---|---|
| `bytemuck` | Fixed-size structs (account state) | Zero-copy, fastest; preferred for on-chain account layout |
| `wincode` | Variable-size instruction data; foreign type adaptation | Anza-built, bincode-compatible, in-place; no intermediate buffers |
| `borsh` | Variable-size data where borsh compatibility is required | Allocates; use only when the wire format must be Borsh |
| Manual parsing | Maximum control / simple scalar types | Safe with explicit length checks |

**Manual parsing example (always bounds-check first):**
```rust
pub fn parse_u64(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
    Ok(u64::from_le_bytes(data[..8].try_into().unwrap()))
}
```

---

## 7a. WINCODE — IN-PLACE SERIALIZATION / DESERIALIZATION

`wincode` is Anza's fast, bincode-compatible serializer that eliminates intermediate
staging buffers by writing directly into final memory destinations. It is the natural
complement to Pinocchio's zero-copy philosophy for **instruction data** and any
variable-size payloads.

> **Compatibility:** `wincode` produces the same bytes as `bincode` (default config)
> for all covered shapes — clients using `bincode` can talk to programs using `wincode`
> for deserialization, and vice versa.

### Cargo setup

```toml
[dependencies]
wincode = { version = "0.4", features = ["derive"] }
```

The `derive` feature enables the `SchemaWrite` and `SchemaRead` proc-macro derives.

### Basic usage

```rust
use wincode::{SchemaWrite, SchemaRead};

#[derive(SchemaWrite, SchemaRead)]
pub struct DepositArgs {
    pub amount:   u64,
    pub deadline: i64,
}

// --- Deserializing instruction data inside a Pinocchio handler ---
pub fn deposit(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Always bounds-check before deserializing
    let args: DepositArgs = wincode::deserialize(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // Use args.amount, args.deadline ...
    Ok(())
}

// --- Serializing a response / off-chain client ---
let args = DepositArgs { amount: 1_000_000, deadline: 1_700_000_000 };
let bytes = wincode::serialize(&args).unwrap();
```

### Zero-copy deserialization

For padding-free `#[repr(C)]` structs, `wincode` can deserialize **in-place**
(zero allocations, zero copies). This is the highest-performance path and pairs
perfectly with Pinocchio's ethos.

**Rules for zero-copy eligibility:**
- Struct must be `#[repr(C)]`
- No implicit padding (reorder fields or add an explicit `_padding` field — same
  rule as `bytemuck`)
- No tuples (Rust does not guarantee tuple layout)

```rust
use wincode::{SchemaWrite, SchemaRead, ZeroCopy};

// Reorder fields to eliminate implicit padding (u32 first, then u16, then u8s)
#[repr(C)]
#[derive(SchemaWrite, SchemaRead)]
pub struct SwapArgs {
    pub min_out:   u64,   // 8 bytes
    pub max_in:    u64,   // 8 bytes
    pub deadline:  i64,   // 8 bytes
    pub slippage:  u16,   // 2 bytes
    pub side:      u8,    // 1 byte
    pub _padding:  u8,    // explicit padding — aligns to 8 bytes total
}

pub fn swap(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Zero-copy: no heap allocation, reads directly from the incoming byte slice
    let args: &SwapArgs = wincode::config::ZeroCopy::deserialize(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // args is a reference into `data` — no copy made
    let _ = args.min_out;
    Ok(())
}
```

### Adapting foreign / third-party types

When a third-party type uses `serde` and visits bytes element-by-element,
`wincode` can wrap it with `Pod<T>` to read the whole field in one pass —
without changing the wire format:

```rust
use wincode::{SchemaWrite, SchemaRead, Pod};

// Suppose `ExternalPubkey` is defined in another crate with a slow serde impl
#[derive(SchemaWrite, SchemaRead)]
#[wincode(from = "ExternalInstruction")]
pub struct MyInstruction {
    pub recipient: Pod<ExternalPubkey>,  // reads 32 bytes in one pass
    pub amount:    u64,
}
```

### Pluggable length encoding (short-vec / compact-u16)

For instruction payloads that embed Solana's compact-u16 length prefix
(used in transaction wire format), enable the `solana-short-vec` feature
and switch the `SeqLen` encoder:

```toml
[dependencies]
wincode = { version = "0.4", features = ["derive", "solana-short-vec"] }
```

```rust
use wincode::{SchemaWrite, SchemaRead};
use wincode::config::ShortVec; // compact-u16 length prefix

#[derive(SchemaWrite, SchemaRead)]
pub struct InstructionWithAccounts {
    #[wincode(seq_len = "ShortVec")]
    pub accounts: Vec<[u8; 32]>,
    pub data:     u64,
}
```

### wincode vs. bytemuck — choosing the right tool

| Concern | `bytemuck` | `wincode` |
|---|---|---|
| **Fixed-size on-chain account state** | ✅ Ideal | Possible but unnecessary overhead |
| **Variable-size instruction data** | ❌ Not suitable | ✅ Ideal |
| **Zero allocations** | ✅ Always | ✅ With `ZeroCopy` config |
| **Wire format** | Raw memory layout | bincode (widely supported) |
| **Derive macros** | `Pod` + `Zeroable` | `SchemaWrite` + `SchemaRead` |
| **Foreign type adaptation** | ❌ Cannot | ✅ Via `Pod<T>` wrapper |
| **Padding required** | ✅ Yes — explicit `_padding` | ✅ Yes for zero-copy — same rule |

**Rule of thumb:**
- `bytemuck` for **account data** (fixed-size, on-chain state).
- `wincode` for **instruction data** and any variable-size or dynamic payloads.
- Never mix both in the same struct — pick one ownership boundary.

### Security notes specific to wincode

- **Always validate deserialized values** — `wincode` guarantees byte layout, not
  business logic. Check amounts, deadlines, and enum variants after deserialization.
- **Fail loudly on bad data** — map `wincode` errors to `ProgramError::InvalidInstructionData`,
  never to a silent default. Never `unwrap()` inside an instruction handler.
- **Do not trust client-supplied sizes** — `wincode` enforces a default max size for dynamic
  structures to prevent allocation exhaustion; do not override this limit without a clear
  upper bound justified in comments.
- **Padding field must be zeroed** — for zero-copy structs, initialize `_padding` to `[0u8; N]`
  on construction; stale bytes in padding fields can leak information across instructions.

---

## 8. IDL GENERATION (SHANK)

Pinocchio does not auto-generate IDLs. Use Shank:

```rust
use shank::{ShankAccount, ShankInstruction};

#[derive(ShankAccount)]
pub struct Vault { pub owner: Pubkey, pub balance: u64 }

#[derive(ShankInstruction)]
pub enum ProgramInstruction {
    #[account(0, writable, signer, name = "vault")]
    #[account(1, signer, name = "owner")]
    Initialize,
    #[account(0, writable, name = "vault")]
    #[account(1, signer, name = "owner")]
    Deposit { amount: u64 },
}
```

For client code generation, use **Codama** with the Shank-generated IDL.

---

## 9. PINOCCHIO SECURITY CHECKLIST

All rules from `shared-base.md` apply. Additional Pinocchio-specific checks:

- [ ] Struct padded to 8-byte alignment (`_padding` field added)
- [ ] Discriminator checked before any field access
- [ ] Account data length checked before `bytemuck::from_bytes`
- [ ] Canonical bump found at init, stored in account, reused with `create_program_address`
- [ ] Owner checked via `account.owner()` before deserializing
- [ ] After CPI: re-borrow and re-cast to get updated state (no `.reload()` — manual)
- [ ] Validation struct uses `TryFrom` or equivalent — no inline ad-hoc checks
- [ ] `overflow-checks = true` in `[profile.release]`
- [ ] No `unwrap()` / `expect()` in instruction handlers
- [ ] **[wincode]** `wincode` errors mapped to `ProgramError::InvalidInstructionData` — never `unwrap()`
- [ ] **[wincode]** Zero-copy structs use `#[repr(C)]` with explicit `_padding` zeroed on construction
- [ ] **[wincode]** Deserialized instruction values range-checked before use (amounts > 0, deadlines in future, etc.)
- [ ] **[wincode]** Max-size limit for dynamic `Vec` fields not overridden without a documented upper bound

---

## 10. COMMON PINOCCHIO BUILD ERRORS

Pinocchio uses `cargo build-sbf` — the same toolchain as native Rust. See `native-rust.md §10` for full error reference. Key points:

- **Platform tools corruption:** `cargo build-sbf --force-tools-install` (needs ~2 GB free in `~/.cache/solana/`)
- **edition2024 errors:** Pin `blake3 =1.8.2`, `constant_time_eq =0.3.1`, `base64ct =1.7.3`, `indexmap =2.11.4` and commit `Cargo.lock`
- **`cargo build-sbf` not found:** Install Solana CLI and add to PATH
- **LiteSVM on GLIBC <2.38:** Use `solana-bankrun` instead
- **Shank IDL generation:** `shank idl -o idl.json -p src/lib.rs`. For client code, pipe through **Codama**.
- **`wincode` proc-macro not found:** Ensure `features = ["derive"]` is set in `Cargo.toml` — the derive macros are feature-gated.
- **`wincode` zero-copy fails to compile:** Struct has implicit padding — reorder fields or add explicit `_padding: [u8; N]` until the compiler stops complaining.

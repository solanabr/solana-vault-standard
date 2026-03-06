# SVS Events Reference

This document describes all events emitted by SVS vault programs for indexers, analytics, and user interfaces.

---

## Core Events (All Variants)

### VaultInitialized

Emitted when a new vault is created.

```rust
#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,       // Vault PDA address
    pub authority: Pubkey,   // Vault admin
    pub asset_mint: Pubkey,  // Underlying asset mint
    pub shares_mint: Pubkey, // LP share token mint
    pub vault_id: u64,       // Unique vault identifier
}
```

**Emitted by**: `initialize`

**Use cases**:
- Index new vaults
- Track vault deployments
- Build vault registry

---

### Deposit

Emitted when assets are deposited and shares are minted.

```rust
#[event]
pub struct Deposit {
    pub vault: Pubkey,   // Vault PDA
    pub caller: Pubkey,  // Transaction signer
    pub owner: Pubkey,   // Share recipient (usually same as caller)
    pub assets: u64,     // Assets deposited
    pub shares: u64,     // Shares minted
}
```

**Emitted by**: `deposit`, `mint`

**Use cases**:
- Track user deposit history
- Calculate TVL changes
- Build activity feed
- Compute user positions

---

### Withdraw

Emitted when shares are burned and assets are withdrawn.

```rust
#[event]
pub struct Withdraw {
    pub vault: Pubkey,    // Vault PDA
    pub caller: Pubkey,   // Transaction signer
    pub receiver: Pubkey, // Asset recipient
    pub owner: Pubkey,    // Share owner (whose shares were burned)
    pub assets: u64,      // Assets withdrawn
    pub shares: u64,      // Shares burned
}
```

**Emitted by**: `withdraw`, `redeem`

**Use cases**:
- Track user withdrawal history
- Calculate TVL changes
- Build activity feed
- Compute realized returns

---

### VaultStatusChanged

Emitted when vault is paused or unpaused.

```rust
#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,  // Vault PDA
    pub paused: bool,   // New paused state
}
```

**Emitted by**: `pause`, `unpause`

**Use cases**:
- Alert on vault status changes
- Track operational events
- Audit trail for admin actions

---

### AuthorityTransferred

Emitted when vault authority is transferred.

```rust
#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,             // Vault PDA
    pub previous_authority: Pubkey, // Old authority
    pub new_authority: Pubkey,      // New authority
}
```

**Emitted by**: `transfer_authority`

**Use cases**:
- Security monitoring
- Governance tracking
- Audit trail

---

## SVS-2/4 Additional Events

### VaultSynced

Emitted when stored balance is synchronized with actual balance.

```rust
#[event]
pub struct VaultSynced {
    pub vault: Pubkey,       // Vault PDA
    pub total_assets: u64,   // New total_assets value
}
```

**Emitted by**: `sync`

**Use cases**:
- Track yield recognition
- Monitor balance updates
- Detect sync timing

---

## SVS-3/4 Confidential Events

### AccountConfigured

Emitted when user configures their shares account for confidential transfers.

```rust
#[event]
pub struct AccountConfigured {
    pub vault: Pubkey,            // Vault PDA
    pub user: Pubkey,             // User who configured
    pub shares_account: Pubkey,   // Configured token account
}
```

**Emitted by**: `configure_account`

### PendingApplied

Emitted when pending confidential balance is applied.

```rust
#[event]
pub struct PendingApplied {
    pub vault: Pubkey,     // Vault PDA
    pub user: Pubkey,      // User
    pub amount: u64,       // Amount applied (plaintext)
}
```

**Emitted by**: `apply_pending`

---

## Module Events

### svs-fees

```rust
#[event]
pub struct FeeConfigUpdated {
    pub vault: Pubkey,
    pub entry_fee_bps: u16,
    pub exit_fee_bps: u16,
    pub management_fee_bps: u16,
    pub performance_fee_bps: u16,
}

#[event]
pub struct FeesCollected {
    pub vault: Pubkey,
    pub fee_recipient: Pubkey,
    pub management_fee: u64,
    pub performance_fee: u64,
}
```

### svs-caps

```rust
#[event]
pub struct CapConfigUpdated {
    pub vault: Pubkey,
    pub global_cap: u64,
    pub per_user_cap: u64,
}
```

### svs-locks

```rust
#[event]
pub struct LockConfigUpdated {
    pub vault: Pubkey,
    pub lock_duration: i64,
}

#[event]
pub struct SharesLocked {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub locked_until: i64,
}
```

### svs-access

```rust
#[event]
pub struct AccessModeChanged {
    pub vault: Pubkey,
    pub mode: AccessMode,  // Open, Whitelist, Blacklist
}

#[event]
pub struct MerkleRootUpdated {
    pub vault: Pubkey,
    pub merkle_root: [u8; 32],
}

#[event]
pub struct AccountFrozen {
    pub vault: Pubkey,
    pub user: Pubkey,
    pub frozen_by: Pubkey,
}

#[event]
pub struct AccountUnfrozen {
    pub vault: Pubkey,
    pub user: Pubkey,
}
```

### svs-rewards

```rust
#[event]
pub struct RewardsFunded {
    pub vault: Pubkey,
    pub reward_mint: Pubkey,
    pub amount: u64,
    pub funder: Pubkey,
}

#[event]
pub struct RewardsClaimed {
    pub vault: Pubkey,
    pub reward_mint: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}
```

---

## Parsing Events

### TypeScript with Anchor

```typescript
import { Program, BN } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';

// Listen to events
program.addEventListener('Deposit', (event, slot) => {
  console.log('Deposit event:', {
    vault: event.vault.toBase58(),
    caller: event.caller.toBase58(),
    owner: event.owner.toBase58(),
    assets: event.assets.toString(),
    shares: event.shares.toString(),
    slot,
  });
});

// Parse from transaction logs
async function parseEventsFromTx(txSignature: string) {
  const tx = await connection.getTransaction(txSignature, {
    commitment: 'confirmed',
  });

  if (!tx?.meta?.logMessages) return [];

  const events = [];
  for (const log of tx.meta.logMessages) {
    if (log.startsWith('Program data:')) {
      const base64Data = log.slice('Program data: '.length);
      const data = Buffer.from(base64Data, 'base64');

      // Decode based on discriminator
      const discriminator = data.slice(0, 8);
      // ... decode event based on discriminator
    }
  }
  return events;
}
```

### Historical Event Fetching

```typescript
import { EventParser } from '@coral-xyz/anchor';

async function fetchHistoricalDeposits(
  connection: Connection,
  program: Program,
  vaultPubkey: PublicKey,
  limit: number = 100
) {
  const signatures = await connection.getSignaturesForAddress(
    vaultPubkey,
    { limit }
  );

  const deposits = [];
  for (const sig of signatures) {
    const tx = await connection.getTransaction(sig.signature);
    const parser = new EventParser(program.programId, program.coder);
    const events = parser.parseLogs(tx?.meta?.logMessages || []);

    for (const event of events) {
      if (event.name === 'Deposit') {
        deposits.push({
          ...event.data,
          signature: sig.signature,
          slot: sig.slot,
          timestamp: sig.blockTime,
        });
      }
    }
  }
  return deposits;
}
```

---

## Event Discriminators

Anchor events use an 8-byte discriminator (first 8 bytes of SHA256 hash of event name).

| Event | Discriminator (hex) |
|-------|---------------------|
| VaultInitialized | `e445a52e51cb9a1d` |
| Deposit | `f223c68952e1f2b6` |
| Withdraw | `b712469c946da122` |
| VaultStatusChanged | `...` |
| AuthorityTransferred | `...` |

```typescript
// Calculate discriminator
import { sha256 } from '@noble/hashes/sha256';

function getEventDiscriminator(eventName: string): Buffer {
  const hash = sha256(`event:${eventName}`);
  return Buffer.from(hash.slice(0, 8));
}
```

---

## Indexing Best Practices

### 1. Subscribe to Real-Time Events

```typescript
// Use WebSocket subscription for real-time
const subscriptionId = connection.onLogs(
  programId,
  (logs, context) => {
    // Parse and handle events
  },
  'confirmed'
);
```

### 2. Handle Reorgs

```typescript
// Wait for finalized confirmation for critical events
const tx = await connection.getTransaction(signature, {
  commitment: 'finalized',  // Not just 'confirmed'
});
```

### 3. Index Key Fields

For efficient querying, index:
- `vault` - Filter by vault
- `caller` / `owner` - Filter by user
- `slot` - Time-based queries
- Event type - Filter by action

### 4. Store Raw Data

```typescript
// Store both parsed and raw for future needs
interface IndexedEvent {
  signature: string;
  slot: number;
  blockTime: number;
  programId: string;
  eventName: string;
  rawData: string;  // Base64 encoded
  parsed: {
    vault: string;
    // ... event-specific fields
  };
}
```

---

## Event Emission Pattern

When implementing new instructions, follow this pattern:

```rust
pub fn handler(ctx: Context<MyInstruction>, amount: u64) -> Result<()> {
    // 1. Validation
    require!(amount > 0, MyError::ZeroAmount);

    // 2. Business logic
    let result = compute_something(amount)?;

    // 3. State mutations
    ctx.accounts.state.value = result;

    // 4. CPIs
    transfer_tokens(...)?;

    // 5. Emit event LAST (after all mutations)
    emit!(MyEvent {
        account: ctx.accounts.state.key(),
        actor: ctx.accounts.user.key(),
        amount,
        result,
    });

    Ok(())
}
```

**Key rules**:
1. Emit after all state mutations
2. Include all relevant data in event
3. Use consistent field naming (`vault`, `caller`, `owner`, `assets`, `shares`)
4. Include both inputs and outputs for traceability

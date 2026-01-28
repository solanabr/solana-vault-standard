# SVS-1 TypeScript SDK

Complete guide to using the SVS-1 TypeScript SDK for interacting with Solana Vault Standard vaults.

## Installation

```bash
cd sdk
yarn install
```

### Dependencies

```json
{
  "dependencies": {
    "@coral-xyz/anchor": "^0.31.1",
    "@solana/spl-token": "^0.4.10",
    "@solana/web3.js": "^1.98.0"
  }
}
```

## Quick Start

```typescript
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, clusterApiUrl } from "@solana/web3.js";
import { SolanaVault } from "@svs1/sdk";

// Setup provider
const connection = new Connection(clusterApiUrl("devnet"));
const provider = AnchorProvider.env();

// Load existing vault
const vault = await SolanaVault.load(
  program,
  assetMint,
  1  // vault_id
);

// Deposit 1000 USDC
const assets = new BN(1000_000_000);
const minShares = await vault.previewDeposit(assets);
const slippageShares = minShares.mul(new BN(95)).div(new BN(100));

await vault.deposit(wallet.publicKey, {
  assets,
  minSharesOut: slippageShares
});
```

## Exports

```typescript
// Main SDK
export { SolanaVault } from "./vault";

// PDA helpers
export {
  getVaultAddress,
  getSharesMintAddress,
  deriveVaultAddresses
} from "./pda";

// Math functions
export {
  convertToShares,
  convertToAssets,
  previewDeposit,
  previewMint,
  previewWithdraw,
  previewRedeem,
  calculateDecimalsOffset,
  Rounding
} from "./math";

// Re-exports
export { BN } from "@coral-xyz/anchor";
export { PublicKey } from "@solana/web3.js";
```

## SolanaVault Class

The main class for vault interactions.

### Creating a Vault

```typescript
import { SolanaVault, CreateVaultParams } from "@svs1/sdk";

const params: CreateVaultParams = {
  assetMint: usdcMint,
  vaultId: new BN(1),
  name: "USDC Savings Vault",
  symbol: "vUSDC",
  uri: "https://example.com/vault-metadata.json"
};

const vault = await SolanaVault.create(program, params);
console.log("Vault created:", vault.vault.toBase58());
```

### Loading an Existing Vault

```typescript
const vault = await SolanaVault.load(
  program,
  assetMint,
  1  // vault_id (number or BN)
);

// Access vault addresses
console.log("Vault:", vault.vault.toBase58());
console.log("Shares Mint:", vault.sharesMint.toBase58());
console.log("Asset Vault:", vault.assetVault.toBase58());
```

### Deposit

Deposit assets and receive shares.

```typescript
import { DepositParams } from "@svs1/sdk";

// Preview to get expected shares
const expectedShares = await vault.previewDeposit(assets);

// Add 5% slippage tolerance
const minShares = expectedShares.mul(new BN(95)).div(new BN(100));

const params: DepositParams = {
  assets: new BN(1000_000_000),  // 1000 USDC
  minSharesOut: minShares
};

const txSig = await vault.deposit(userPublicKey, params);
```

### Mint

Request exact shares, pay required assets.

```typescript
import { MintParams } from "@svs1/sdk";

// Preview to get required assets
const requiredAssets = await vault.previewMint(shares);

// Add 5% slippage tolerance (pay up to 5% more)
const maxAssets = requiredAssets.mul(new BN(105)).div(new BN(100));

const params: MintParams = {
  shares: new BN(1000_000_000_000),  // 1000 shares (9 decimals)
  maxAssetsIn: maxAssets
};

const txSig = await vault.mint(userPublicKey, params);
```

### Withdraw

Request exact assets, burn required shares.

```typescript
import { WithdrawParams } from "@svs1/sdk";

// Preview to get required shares
const requiredShares = await vault.previewWithdraw(assets);

// Add 5% slippage tolerance (burn up to 5% more)
const maxShares = requiredShares.mul(new BN(105)).div(new BN(100));

const params: WithdrawParams = {
  assets: new BN(500_000_000),  // 500 USDC
  maxSharesIn: maxShares
};

const txSig = await vault.withdraw(userPublicKey, params);
```

### Redeem

Burn shares and receive assets.

```typescript
import { RedeemParams } from "@svs1/sdk";

// Preview to get expected assets
const expectedAssets = await vault.previewRedeem(shares);

// Add 5% slippage tolerance
const minAssets = expectedAssets.mul(new BN(95)).div(new BN(100));

const params: RedeemParams = {
  shares: new BN(500_000_000_000),  // 500 shares
  minAssetsOut: minAssets
};

const txSig = await vault.redeem(userPublicKey, params);
```

### View Functions

All view functions work off-chain (no transactions).

```typescript
// Get vault state
const state = await vault.getState();
console.log("Authority:", state.authority.toBase58());
console.log("Total Assets:", state.totalAssets.toString());
console.log("Paused:", state.paused);

// Total assets in vault
const totalAssets = await vault.totalAssets();

// Total shares supply
const totalShares = await vault.totalShares();

// Convert between assets and shares
const sharesFor1000USDC = await vault.convertToShares(new BN(1000_000_000));
const assetsFor1000Shares = await vault.convertToAssets(new BN(1000_000_000_000));

// Preview operations
const sharesFromDeposit = await vault.previewDeposit(assets);
const assetsForMint = await vault.previewMint(shares);
const sharesToWithdraw = await vault.previewWithdraw(assets);
const assetsFromRedeem = await vault.previewRedeem(shares);

// Refresh state from chain
await vault.refresh();
```

### Admin Functions

Admin operations require the vault authority to sign.

```typescript
// Pause vault (emergency)
await vault.pause(authorityPublicKey);

// Unpause vault
await vault.unpause(authorityPublicKey);

// Transfer authority
await vault.transferAuthority(
  currentAuthority,
  newAuthority
);

// Sync total_assets with actual balance
await vault.sync(authorityPublicKey);

// Check if paused
const isPaused = await vault.isPaused();

// Get current authority
const authority = await vault.getAuthority();
```

### Helper Methods

```typescript
// Get user's shares token account
const userSharesAccount = vault.getUserSharesAccount(userPublicKey);

// Get user's asset token account
const userAssetAccount = vault.getUserAssetAccount(userPublicKey);

// Get decimals offset
const offset = await vault.getDecimalsOffset();
```

## PDA Functions

Low-level PDA derivation helpers.

```typescript
import {
  getVaultAddress,
  getSharesMintAddress,
  deriveVaultAddresses,
  VAULT_SEED,
  SHARES_MINT_SEED
} from "@svs1/sdk";

// Derive vault address
const [vaultPda, vaultBump] = getVaultAddress(
  programId,
  assetMint,
  vaultId
);

// Derive shares mint address
const [sharesMintPda, sharesMintBump] = getSharesMintAddress(
  programId,
  vaultPda
);

// Derive all addresses at once
const addresses = deriveVaultAddresses(
  programId,
  assetMint,
  vaultId
);
// addresses.vault
// addresses.vaultBump
// addresses.sharesMint
// addresses.sharesMintBump
```

## Math Functions

Off-chain math matching on-chain calculations.

```typescript
import {
  convertToShares,
  convertToAssets,
  previewDeposit,
  previewMint,
  previewWithdraw,
  previewRedeem,
  calculateDecimalsOffset,
  Rounding
} from "@svs1/sdk";

// Calculate decimals offset
const offset = calculateDecimalsOffset(6);  // USDC = 3

// Convert with explicit rounding
const shares = convertToShares(
  assets,
  totalAssets,
  totalShares,
  decimalsOffset,
  Rounding.Floor  // Deposit rounding
);

const assets = convertToAssets(
  shares,
  totalAssets,
  totalShares,
  decimalsOffset,
  Rounding.Floor  // Redeem rounding
);

// Preview functions (correct rounding built-in)
const depositShares = previewDeposit(assets, totalAssets, totalShares, offset);
const mintAssets = previewMint(shares, totalAssets, totalShares, offset);
const withdrawShares = previewWithdraw(assets, totalAssets, totalShares, offset);
const redeemAssets = previewRedeem(shares, totalAssets, totalShares, offset);
```

### Rounding Strategy

```typescript
enum Rounding {
  Floor,    // Round down (deposit, redeem)
  Ceiling   // Round up (mint, withdraw)
}

// Rounding always favors the vault:
// deposit  → Floor   → User gets fewer shares
// mint     → Ceiling → User pays more assets
// withdraw → Ceiling → User burns more shares
// redeem   → Floor   → User gets fewer assets
```

## Type Definitions

### VaultState

```typescript
interface VaultState {
  authority: PublicKey;      // Admin who can pause/unpause
  assetMint: PublicKey;      // Underlying asset mint
  sharesMint: PublicKey;     // LP token mint
  assetVault: PublicKey;     // Token account holding assets
  totalAssets: BN;           // Cached total assets
  decimalsOffset: number;    // Inflation protection offset
  bump: number;              // PDA bump
  paused: boolean;           // Emergency pause flag
  vaultId: BN;               // Unique identifier
}
```

### Operation Parameters

```typescript
interface CreateVaultParams {
  assetMint: PublicKey;
  vaultId: BN | number;
  name: string;
  symbol: string;
  uri: string;
}

interface DepositParams {
  assets: BN;
  minSharesOut: BN;
}

interface MintParams {
  shares: BN;
  maxAssetsIn: BN;
}

interface WithdrawParams {
  assets: BN;
  maxSharesIn: BN;
}

interface RedeemParams {
  shares: BN;
  minAssetsOut: BN;
}
```

## Error Handling

```typescript
try {
  await vault.deposit(user, params);
} catch (error) {
  // Parse Anchor error
  if (error.message.includes("SlippageExceeded")) {
    console.error("Slippage tolerance exceeded");
  } else if (error.message.includes("VaultPaused")) {
    console.error("Vault is currently paused");
  } else if (error.message.includes("DepositTooSmall")) {
    console.error("Deposit below minimum threshold");
  }
}
```

### Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | ZeroAmount | Amount must be > 0 |
| 6001 | SlippageExceeded | Slippage tolerance exceeded |
| 6002 | VaultPaused | Vault is paused |
| 6003 | InvalidAssetDecimals | Asset decimals > 9 |
| 6004 | MathOverflow | Arithmetic overflow |
| 6005 | DivisionByZero | Division by zero |
| 6006 | InsufficientShares | Not enough shares |
| 6007 | InsufficientAssets | Not enough assets |
| 6008 | Unauthorized | Not vault authority |
| 6009 | DepositTooSmall | Below minimum deposit |

## Slippage Calculation

Always use slippage protection to guard against MEV.

```typescript
// For deposits/redeems (receiving something):
// Apply negative slippage (accept less)
const minAmount = expectedAmount.mul(new BN(95)).div(new BN(100));  // 5% slippage

// For mints/withdraws (paying something):
// Apply positive slippage (pay more)
const maxAmount = expectedAmount.mul(new BN(105)).div(new BN(100));  // 5% slippage
```

### Slippage Helper

```typescript
function applySlippage(
  amount: BN,
  slippageBps: number,
  isReceiving: boolean
): BN {
  const bps = new BN(10000);
  const slippage = new BN(slippageBps);

  if (isReceiving) {
    // Accept less (deposit, redeem)
    return amount.mul(bps.sub(slippage)).div(bps);
  } else {
    // Pay more (mint, withdraw)
    return amount.mul(bps.add(slippage)).div(bps);
  }
}

// Usage
const minShares = applySlippage(expectedShares, 50, true);  // 0.5% slippage
const maxAssets = applySlippage(requiredAssets, 50, false);
```

## Testing

```bash
cd sdk
yarn test
```

### Test Coverage

| Category | Tests |
|----------|-------|
| Math | 18 |
| PDA | 11 |
| Vault Interfaces | 30 |
| Error Handling | 25 |
| Event Parsing | 29 |
| **Total** | **113** |

## Building

```bash
cd sdk
yarn build
```

Output in `dist/`:
- `dist/index.js` - CommonJS build
- `dist/index.d.ts` - TypeScript declarations

## Integration Example

Complete example integrating with a Next.js frontend:

```typescript
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { SolanaVault } from "@svs1/sdk";
import { IDL } from "./idl/svs_1";

function useVault(assetMint: PublicKey, vaultId: number) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const [vault, setVault] = useState<SolanaVault | null>(null);

  useEffect(() => {
    if (!wallet) return;

    const provider = new AnchorProvider(connection, wallet, {});
    const program = new Program(IDL, PROGRAM_ID, provider);

    SolanaVault.load(program, assetMint, vaultId)
      .then(setVault)
      .catch(console.error);
  }, [wallet, assetMint, vaultId]);

  return vault;
}

function DepositButton({ vault, amount }: { vault: SolanaVault; amount: BN }) {
  const wallet = useAnchorWallet();

  const handleDeposit = async () => {
    if (!wallet) return;

    const expectedShares = await vault.previewDeposit(amount);
    const minShares = expectedShares.mul(new BN(95)).div(new BN(100));

    const txSig = await vault.deposit(wallet.publicKey, {
      assets: amount,
      minSharesOut: minShares
    });

    console.log("Deposited:", txSig);
  };

  return <button onClick={handleDeposit}>Deposit</button>;
}
```

## Best Practices

1. **Always use slippage protection** - Never set min/max to 0 or MAX
2. **Refresh state before operations** - Call `vault.refresh()` for latest data
3. **Handle errors gracefully** - Check for paused state, insufficient balance
4. **Use preview functions** - Calculate expected amounts before transactions
5. **Cache vault instance** - Reuse `SolanaVault` object, don't recreate

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical deep-dive
- [Security](./SECURITY.md) - Security considerations
- [Testing](./TESTING.md) - Test coverage

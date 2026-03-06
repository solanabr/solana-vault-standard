# Solana Vault CLI

Command-line interface for managing SVS (Solana Vault Standard) vaults.

## Installation

```bash
# From npm
npm install -g @stbr/solana-vault-cli

# Or run via npx
npx solana-vault <command>
```

## Quick Start

```bash
# Initialize config
solana-vault config init

# Add a vault alias
solana-vault config add-vault my-vault <VAULT_ADDRESS> --variant svs-1

# Check vault info
solana-vault info my-vault

# Deposit with slippage protection
solana-vault deposit my-vault --amount 1000000 --slippage 50
```

## Global Options

All commands support these options:

| Option | Description |
|--------|-------------|
| `-u, --url <url>` | RPC endpoint URL |
| `-k, --keypair <path>` | Path to keypair file |
| `-o, --output <format>` | Output format: `table`, `json`, `csv` (default: `table`) |
| `-p, --profile <name>` | Use saved config profile |
| `-v, --verbose` | Show detailed output |
| `-q, --quiet` | Minimal output (for scripts) |
| `-y, --yes` | Skip confirmation prompts |
| `--dry-run` | Preview changes without executing |

## Commands

### Inspect Commands

#### `info <vault>`
Display vault state and information.

```bash
solana-vault info my-vault
solana-vault info my-vault --output json
```

#### `balance <vault> [user]`
Check user's vault balance (shares and asset value).

```bash
solana-vault balance my-vault
solana-vault balance my-vault <USER_PUBKEY>
```

#### `preview <vault> <operation> <amount>`
Preview deposit/mint/withdraw/redeem without executing.

```bash
solana-vault preview my-vault deposit 1000000
solana-vault preview my-vault redeem 500000
```

#### `list`
List all configured vaults.

```bash
solana-vault list
```

#### `history <vault>`
Show transaction history for a vault.

```bash
solana-vault history my-vault
solana-vault history my-vault --limit 50
```

---

### Operate Commands

#### `deposit <vault>`
Deposit assets into a vault.

```bash
solana-vault deposit my-vault --amount 1000000
solana-vault deposit my-vault --amount 1000000 --slippage 100
solana-vault deposit my-vault --amount 1000000 --dry-run
```

| Option | Description |
|--------|-------------|
| `-a, --amount <amount>` | Amount of assets to deposit (required) |
| `-s, --slippage <bps>` | Max slippage in basis points (default: 50) |

#### `mint <vault>`
Mint exact shares by depositing assets.

```bash
solana-vault mint my-vault --shares 1000000
```

| Option | Description |
|--------|-------------|
| `--shares <amount>` | Exact shares to mint (required) |
| `-s, --slippage <bps>` | Max slippage in basis points |

#### `withdraw <vault>`
Withdraw exact assets from a vault.

```bash
solana-vault withdraw my-vault --amount 500000
```

| Option | Description |
|--------|-------------|
| `-a, --amount <amount>` | Amount of assets to withdraw (required) |
| `-s, --slippage <bps>` | Max slippage in basis points |

#### `redeem <vault>`
Redeem shares for assets.

```bash
solana-vault redeem my-vault --shares 500000
solana-vault redeem my-vault --all
```

| Option | Description |
|--------|-------------|
| `--shares <amount>` | Shares to redeem |
| `--all` | Redeem all shares |
| `-s, --slippage <bps>` | Max slippage in basis points |

---

### Admin Commands

#### `pause <vault>`
Emergency pause vault operations.

```bash
solana-vault pause my-vault
```

#### `unpause <vault>`
Resume vault operations.

```bash
solana-vault unpause my-vault
```

#### `sync <vault>`
Sync stored balance with actual balance (SVS-2/SVS-4 only).

```bash
solana-vault sync my-vault
```

#### `transfer-authority <vault>`
Transfer vault authority to a new address.

```bash
solana-vault transfer-authority my-vault --new-authority <PUBKEY>
```

#### `permissions <vault>`
Show who can do what in a vault.

```bash
solana-vault permissions my-vault
```

---

### Fee Commands

#### `fees show <vault>`
Display current fee configuration and accrued fees.

```bash
solana-vault fees show my-vault
```

#### `fees configure <vault>`
Configure vault fee settings.

```bash
solana-vault fees configure my-vault --management 200 --performance 2000
solana-vault fees configure my-vault --entry 50 --exit 50
solana-vault fees configure my-vault --recipient <FEE_RECIPIENT>
```

| Option | Description |
|--------|-------------|
| `--management <bps>` | Management fee in basis points (0-10000) |
| `--performance <bps>` | Performance fee in basis points |
| `--entry <bps>` | Entry fee in basis points |
| `--exit <bps>` | Exit fee in basis points |
| `--recipient <pubkey>` | Fee recipient address |

#### `fees preview <vault>`
Preview fee collection amount.

```bash
solana-vault fees preview my-vault --total-assets 1000000000 --hours 168
```

#### `fees clear <vault>`
Clear fee configuration.

```bash
solana-vault fees clear my-vault
```

---

### Cap Commands

#### `cap show <vault>`
Display deposit cap configuration and utilization.

```bash
solana-vault cap show my-vault
solana-vault cap show my-vault --total-assets 500000000
```

#### `cap configure <vault>`
Configure deposit caps.

```bash
solana-vault cap configure my-vault --global 1000000000 --per-user 10000000
solana-vault cap configure my-vault --disable
```

| Option | Description |
|--------|-------------|
| `--global <amount>` | Global deposit cap |
| `--per-user <amount>` | Per-user deposit cap |
| `--disable` | Disable all caps |

#### `cap check <vault> <amount>`
Check if a deposit amount would be allowed.

```bash
solana-vault cap check my-vault 5000000
```

#### `cap max <vault>`
Get maximum deposit allowed.

```bash
solana-vault cap max my-vault --total-assets 900000000
```

---

### Access Commands

#### `access show <vault>`
Display access control configuration.

```bash
solana-vault access show my-vault
```

#### `access set-mode <vault>`
Set access control mode.

```bash
solana-vault access set-mode my-vault --mode whitelist
solana-vault access set-mode my-vault --mode blacklist
solana-vault access set-mode my-vault --mode open
```

#### `access add <vault>`
Add address to whitelist/blacklist.

```bash
solana-vault access add my-vault --address <PUBKEY>
```

#### `access remove <vault>`
Remove address from whitelist/blacklist.

```bash
solana-vault access remove my-vault --address <PUBKEY>
```

#### `access check <vault>`
Check if an address has access.

```bash
solana-vault access check my-vault --address <PUBKEY>
```

#### `access generate-proof <vault>`
Generate merkle proof for an address.

```bash
solana-vault access generate-proof my-vault --address <PUBKEY>
```

---

### Emergency Commands

#### `emergency show <vault>`
Show emergency withdrawal configuration.

```bash
solana-vault emergency show my-vault
```

#### `emergency configure <vault>`
Configure emergency withdrawal settings.

```bash
solana-vault emergency configure my-vault --penalty 500 --cooldown 3600
solana-vault emergency configure my-vault --recipient <PENALTY_RECIPIENT>
```

| Option | Description |
|--------|-------------|
| `--penalty <bps>` | Penalty in basis points (0-5000) |
| `--cooldown <seconds>` | Cooldown between withdrawals |
| `--recipient <pubkey>` | Penalty recipient address |
| `--require-pause` | Only allow when vault is paused |

#### `emergency preview <vault>`
Preview emergency withdrawal penalty.

```bash
solana-vault emergency preview my-vault --shares 100000
```

#### `emergency withdraw <vault>`
Execute emergency withdrawal (when vault is paused).

```bash
solana-vault emergency withdraw my-vault --shares 100000
```

---

### Timelock Commands

#### `timelock show <vault>`
Show timelock configuration and pending proposals.

```bash
solana-vault timelock show my-vault
```

#### `timelock configure <vault>`
Configure timelock settings.

```bash
solana-vault timelock configure my-vault --min-delay 86400
solana-vault timelock configure my-vault --min-delay 86400 --max-delay 604800
```

#### `timelock propose <vault>`
Create a timelocked proposal.

```bash
solana-vault timelock propose my-vault --action transfer-authority --params '{"newAuthority":"..."}'
solana-vault timelock propose my-vault --action pause --delay 172800
```

| Action Types | Description |
|--------------|-------------|
| `transfer-authority` | Transfer vault ownership |
| `update-fees` | Update fee configuration |
| `update-caps` | Update deposit caps |
| `update-access` | Update access control |
| `pause` | Pause vault |
| `unpause` | Unpause vault |

#### `timelock execute <vault>`
Execute a ready proposal.

```bash
solana-vault timelock execute my-vault --proposal-id <ID>
```

#### `timelock cancel <vault>`
Cancel a pending proposal.

```bash
solana-vault timelock cancel my-vault --proposal-id <ID>
```

#### `timelock list <vault>`
List all proposals.

```bash
solana-vault timelock list my-vault
solana-vault timelock list my-vault --status pending
```

---

### Strategy Commands

#### `strategy show <vault>`
Show configured strategies and positions.

```bash
solana-vault strategy show my-vault
```

#### `strategy add <vault>`
Add a new strategy.

```bash
solana-vault strategy add my-vault --type lending --name "Kamino USDC"
solana-vault strategy add my-vault --type liquid-staking --name "Marinade" --program-id <ID>
```

| Option | Description |
|--------|-------------|
| `--type <type>` | Strategy type: `lending`, `liquid-staking`, `lp`, `custom` |
| `--name <name>` | Strategy name |
| `--program-id <pubkey>` | Target protocol program ID |
| `--pool <pubkey>` | Pool/stake account address |
| `--receipt-mint <pubkey>` | Receipt token mint |
| `--weight <bps>` | Target allocation weight |

#### `strategy remove <vault>`
Remove a strategy.

```bash
solana-vault strategy remove my-vault --strategy-id <ID>
```

#### `strategy set-weight <vault>`
Set target allocation weight.

```bash
solana-vault strategy set-weight my-vault --strategy-id <ID> --weight 3000
```

#### `strategy deploy <vault>`
Deploy assets to strategies.

```bash
solana-vault strategy deploy my-vault
solana-vault strategy deploy my-vault --amount 1000000 --strategy-id <ID>
```

#### `strategy recall <vault>`
Recall assets from strategies.

```bash
solana-vault strategy recall my-vault --amount 500000
```

#### `strategy rebalance <vault>`
Rebalance to match target weights.

```bash
solana-vault strategy rebalance my-vault
```

#### `strategy health <vault>`
Check strategy health status.

```bash
solana-vault strategy health my-vault
```

---

### Portfolio Commands

Multi-vault portfolio management for diversified exposure.

#### `portfolio show`
Show configured portfolio.

```bash
solana-vault portfolio show
```

#### `portfolio configure`
Configure portfolio allocations.

```bash
solana-vault portfolio configure --allocations '[
  {"vault":"usdc-vault","targetWeightBps":5000,"name":"USDC"},
  {"vault":"sol-vault","targetWeightBps":5000,"name":"SOL"}
]'
```

#### `portfolio status`
Show current vs target allocations.

```bash
solana-vault portfolio status --values '{"usdc-vault":"500000","sol-vault":"600000"}'
```

#### `portfolio deposit`
Deposit across multiple vaults.

```bash
solana-vault portfolio deposit --amount 1000000
```

#### `portfolio redeem`
Redeem from multiple vaults.

```bash
solana-vault portfolio redeem --amount 500000
solana-vault portfolio redeem --all
```

#### `portfolio rebalance`
Rebalance to target weights.

```bash
solana-vault portfolio rebalance --values '{"usdc-vault":"500000","sol-vault":"600000"}'
```

---

### Monitor Commands

#### `dashboard <vault>`
Real-time vault monitoring dashboard.

```bash
solana-vault dashboard my-vault
```

#### `health <vault>`
Comprehensive vault health check.

```bash
solana-vault health my-vault
```

---

### Automation Commands

#### `autopilot show <vault>`
Show autopilot configuration.

#### `autopilot configure <vault>`
Configure automated operations.

```bash
solana-vault autopilot configure my-vault --sync-interval 1h --fee-threshold 10000
```

#### `autopilot run <vault>`
Run autopilot tasks.

#### `guard show <vault>`
Show guard (safety rail) configuration.

#### `guard configure <vault>`
Configure safety limits.

```bash
solana-vault guard configure my-vault --max-deposit 100000000 --cooldown 60
```

#### `guard check <vault>`
Check if operation would pass guards.

```bash
solana-vault guard check my-vault --operation deposit --amount 50000000
```

#### `batch run <file>`
Execute batch operations from file.

#### `batch validate <file>`
Validate batch file without executing.

#### `batch template`
Generate batch file template.

---

### Confidential Commands (SVS-3/SVS-4)

Commands for vaults with Token-2022 confidential transfers.

#### `ct configure <vault>`
Setup account for confidential transfers. **Required before first deposit to SVS-3/SVS-4 vaults.**

```bash
solana-vault ct configure my-vault
```

#### `ct apply-pending <vault>`
Apply pending balance to available balance. **Required after each deposit/mint.**

```bash
solana-vault ct apply-pending my-vault
```

#### `ct status <vault>`
Show confidential transfer account status.

```bash
solana-vault ct status my-vault
```

---

### Config Commands

#### `config init`
Initialize CLI configuration.

```bash
solana-vault config init
```

#### `config show`
Display current configuration.

```bash
solana-vault config show
```

#### `config add-vault <alias> <address>`
Add a vault alias.

```bash
solana-vault config add-vault my-vault <ADDRESS> --variant svs-1
solana-vault config add-vault my-vault <ADDRESS> --variant svs-2 --asset-mint <MINT>
```

#### `config remove-vault <alias>`
Remove a vault alias.

```bash
solana-vault config remove-vault my-vault
```

#### `config set <key> <value>`
Set configuration value.

```bash
solana-vault config set cluster mainnet-beta
solana-vault config set output json
```

---

### Offline Commands

Commands that work without RPC connection.

#### `derive`
Derive vault PDA addresses.

```bash
solana-vault derive --program-id <ID> --asset-mint <MINT> --vault-id 1
```

#### `convert`
Convert between units.

```bash
solana-vault convert --shares 1000000 --total-assets 1000000000 --total-shares 1000000000
```

---

## Configuration File

The CLI stores configuration in `~/.solana-vault/config.yaml`:

```yaml
defaults:
  cluster: devnet
  keypair: ~/.config/solana/id.json
  output: table
  confirmation: confirmed

profiles:
  mainnet:
    cluster: mainnet-beta
    confirmation: finalized

vaults:
  my-vault:
    address: "7xKYqBvpmmN4dZFrAPCfPKBNqPhsRUFwsHPDKJeJpump"
    variant: svs-1
    assetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    vaultId: 1

autopilot:
  my-vault:
    sync:
      enabled: true
      interval: "1h"

guards:
  my-vault:
    maxDepositPerTx: "100000000"
    cooldownSeconds: 60

fees:
  my-vault:
    managementFeeBps: 200
    performanceFeeBps: 2000

caps:
  my-vault:
    enabled: true
    globalCap: "1000000000"
    perUserCap: "10000000"

alerts:
  discord: "https://discord.webhook..."
```

## Output Formats

All commands support three output formats:

### Table (default)
Human-readable formatted tables.

```bash
solana-vault info my-vault
```

### JSON
Machine-readable JSON output.

```bash
solana-vault info my-vault --output json
```

### CSV
Comma-separated values for spreadsheets.

```bash
solana-vault info my-vault --output csv
```

## Examples

### Complete Deposit Flow (SVS-1/SVS-2)

```bash
# Check vault state
solana-vault info my-vault

# Preview deposit
solana-vault preview my-vault deposit 1000000

# Execute deposit with dry-run first
solana-vault deposit my-vault --amount 1000000 --dry-run
solana-vault deposit my-vault --amount 1000000

# Check balance
solana-vault balance my-vault
```

### Complete Deposit Flow (SVS-3/SVS-4)

```bash
# Configure account for confidential transfers (one-time)
solana-vault ct configure my-vault

# Deposit
solana-vault deposit my-vault --amount 1000000

# Apply pending balance (required after each deposit)
solana-vault ct apply-pending my-vault

# Check status
solana-vault ct status my-vault
```

### Admin Operations with Timelock

```bash
# Configure timelock (24h delay)
solana-vault timelock configure my-vault --min-delay 86400

# Propose fee update
solana-vault timelock propose my-vault --action update-fees \
  --params '{"managementFeeBps":300}'

# Wait 24 hours...

# Execute proposal
solana-vault timelock execute my-vault --proposal-id <ID>
```

### Multi-Vault Portfolio

```bash
# Configure portfolio (60% USDC, 40% SOL)
solana-vault portfolio configure --allocations '[
  {"vault":"usdc-vault","targetWeightBps":6000,"name":"USDC"},
  {"vault":"sol-vault","targetWeightBps":4000,"name":"SOL"}
]'

# Deposit 1M split across vaults
solana-vault portfolio deposit --amount 1000000

# Check status
solana-vault portfolio status

# Rebalance if needed
solana-vault portfolio rebalance
```

## Troubleshooting

### Common Issues

**"IDL not found"**
Run `anchor build` to generate the IDL files.

**"Insufficient funds"**
Ensure your wallet has enough SOL for transaction fees and the asset tokens for deposits.

**"Vault not found in config"**
Add the vault with `solana-vault config add-vault <alias> <address>`.

**"CT account not configured" (SVS-3/SVS-4)**
Run `solana-vault ct configure <vault>` before depositing.

**"Pending balance not applied" (SVS-3/SVS-4)**
Run `solana-vault ct apply-pending <vault>` after each deposit.

### Debug Mode

Use verbose mode for detailed output:

```bash
solana-vault info my-vault --verbose
```

### RPC Issues

Specify a different RPC endpoint:

```bash
solana-vault info my-vault --url https://api.mainnet-beta.solana.com
```

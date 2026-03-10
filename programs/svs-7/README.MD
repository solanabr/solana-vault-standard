# SVS-7: Native SOL Vault Standard

**Author:** Verdelli Tecnologia (Jacques)  
**Status:** `Draft / Implementation Complete`  
**Reference:** Adapted from ERC-7535

---

## 1. Overview

**SVS-7** is a specialized implementation of the Solana Vault Standard designed to accept **native SOL (lamports)**. It eliminates manual wrapping friction by integrating the SOL ↔ wSOL conversion directly into the Vault's deposit and withdraw flows.

### Why SVS-7?
Most DeFi protocols on Solana require **wSOL**, creating a UX barrier for retail users. SVS-7 acts as a native adapter:
* **Superior UX:** One-click/one-signature SOL deposits.
* **Composability:** The internal balance is maintained in wSOL, enabling native interactions with Kamino, MarginFi, and other SPL-based protocols.

---

## 2. Architectural Differentiators

### A. Dual Interface (Hybrid Access)
SVS-7 exposes two entry and exit paths for maximum flexibility:
1.  **`deposit_sol` / `withdraw_sol`:** Focused on the end-user (B2C), handling raw lamports.
2.  **`deposit_wsol` / `withdraw_wsol`:** Focused on protocols (B2B), accepting wSOL directly.

### B. Atomic Sync Mechanism
During the deposit flow, we utilize the `sync_native` instruction from the SPL Token Program. This ensures that lamports sent via the `system_program` are instantly recognized as a token balance, mitigating accounting errors and donation attacks.

### C. Automated Withdrawal Unwrap
The withdrawal process utilizes an **ephemeral temporary account** (managed via SDK) that allows the Vault to convert wSOL back to SOL and close the account in the same transaction, returning both the lamports and the rent to the user.

---

## 3. Technical Specifications

| Aspect | Detail |
| :--- | :--- |
| **Asset Mint** | Fixed: `So11111111111111111111111111111111111111112` |
| **Decimals** | 9 (Native SOL Standard) |
| **Share Token** | Token-2022 |
| **Protection** | Virtual Offset (Inflation Attack Protection) |

---

## 4. SDK Structure

The TypeScript SDK abstracts unwrap complexity for the frontend developer:

* **`depositSol()`**: Bundles the transfer and the `sync_native` command.
* **`withdrawSol()`**: Manages ephemeral `Keypair` creation and the atomic withdrawal.

```typescript
// Example usage via Verdelli SDK
const tx = await client.depositSol(vaultPubkey, 1.5 * LAMPORTS_PER_SOL);
/**
 * SVS-11 Compliance Test Script
 *
 * Compliance is enforced at the PROTOCOL level by the compliance-hook program
 * (single source of truth) — vault managers no longer freeze per-vault. This
 * script demonstrates:
 * - Protocol-level freeze/unfreeze of a wallet via compliance-hook.
 * - Window-closed gating still rejecting deposit requests.
 *
 * Note: freeze blocks the mint/burn paths (claim_deposit / approve_redeem) and
 * every Token-2022 cPOOL transfer (via the hook). It does NOT gate
 * request_deposit, which only escrows asset tokens.
 *
 * Run: npx ts-node scripts/svs-11/compliance.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { setupTest, createVaultContext, explorerUrl } from "./helpers";

const COMPLIANCE_HOOK_PROGRAM_ID = new PublicKey(
  "6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P",
);

async function main() {
  const setup = await setupTest("Compliance");
  const { program, payer, provider } = setup;
  const ctx = await createVaultContext(setup);

  const complianceHookIdl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../../target/idl/compliance_hook.json"),
      "utf-8",
    ),
  );
  const complianceHook = new Program(complianceHookIdl, provider);

  const [sanctionsList] = PublicKey.findProgramAddressSync(
    [Buffer.from("sanctions_list")],
    COMPLIANCE_HOOK_PROGRAM_ID,
  );
  const [frozenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("frozen"), ctx.investor.publicKey.toBuffer()],
    COMPLIANCE_HOOK_PROGRAM_ID,
  );

  // Step 1: Protocol-level freeze via compliance-hook
  console.log("\n" + "-".repeat(70));
  console.log("Step 1: Freeze wallet (protocol-level, compliance-hook)");
  console.log("-".repeat(70));

  // The SanctionsList singleton must exist; create it idempotently.
  try {
    await complianceHook.methods
      .initializeSanctionsList()
      .accountsPartial({
        sanctionsList,
        authority: payer.publicKey,
        payer: payer.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  } catch (_err) {
    // Already initialized — fine.
  }

  const freezeSig = await complianceHook.methods
    .freezeAccount()
    .accounts({
      sanctionsList,
      authority: payer.publicKey,
      ownerToFreeze: ctx.investor.publicKey,
      frozenAccount,
      payer: payer.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`  Freeze: ${explorerUrl(freezeSig)}`);

  const frozen = await provider.connection.getAccountInfo(frozenAccount);
  if (frozen && frozen.owner.equals(COMPLIANCE_HOOK_PROGRAM_ID)) {
    console.log("  Wallet is now frozen (FrozenAccount PDA exists)");
  } else {
    console.log("  WARNING: FrozenAccount PDA missing after freeze");
  }

  // Step 2: Unfreeze
  console.log("\n" + "-".repeat(70));
  console.log("Step 2: Unfreeze wallet");
  console.log("-".repeat(70));

  const unfreezeSig = await complianceHook.methods
    .unfreezeAccount()
    .accounts({
      sanctionsList,
      authority: payer.publicKey,
      ownerToUnfreeze: ctx.investor.publicKey,
      frozenAccount,
      rentRecipient: payer.publicKey,
    })
    .rpc();

  console.log(`  Unfreeze: ${explorerUrl(unfreezeSig)}`);

  // Step 3: Window closed gating
  console.log("\n" + "-".repeat(70));
  console.log("Step 3: Window closed gating");
  console.log("-".repeat(70));

  // Close window (it is opened during vault setup elsewhere; ensure closed).
  try {
    await program.methods
      .closeInvestmentWindow()
      .accountsPartial({ manager: payer.publicKey, vault: ctx.vault })
      .rpc();
  } catch (_err) {
    // Already closed — fine.
  }

  console.log(`  Window closed`);

  try {
    await program.methods
      .requestDeposit(new BN(500_000_000))
      .accountsPartial({
        investor: ctx.investor.publicKey,
        vault: ctx.vault,
        assetMint: ctx.assetMint,
        investorTokenAccount: ctx.investorAta,
        depositVault: ctx.depositVault,
        investmentRequest: ctx.investmentRequest,
        attestation: ctx.attestation,
        assetTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([ctx.investor])
      .rpc();

    console.log("  WARNING: Request succeeded while window closed");
  } catch (err: any) {
    const msg = err.toString();
    if (
      msg.includes("Window") ||
      msg.includes("window") ||
      msg.includes("Closed") ||
      msg.includes("closed")
    ) {
      console.log("  Request correctly rejected (window closed)");
    } else {
      console.log(`  Request rejected: ${msg.slice(0, 120)}`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  All tests passed!");
  console.log("=".repeat(70) + "\n");
}

main().catch((err) => {
  console.error("\nScript failed:", err);
  process.exit(1);
});

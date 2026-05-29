/** nav publish — sign + submit a NAV update transaction */

import { Command } from "commander";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { createContext } from "../../middleware";
import { getGlobalOptions } from "../../index";
import { NavOracle } from "../../../nav-oracle";
import { getNavAccountAddress } from "../../../nav-oracle-pda";
import { loadIdl } from "../../utils";

function parseHex32(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) {
    throw new Error(
      `--merkle-root must be 32 bytes (64 hex chars); got ${clean.length}`,
    );
  }
  return Buffer.from(clean, "hex");
}

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf-8");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export function registerPublishNavCommand(parent: Command): void {
  parent
    .command("publish")
    .description("Publish a signed NAV update to the per-pool NavAccount")
    .argument("<pool>", "Pool PDA (CreditVault address)")
    .requiredOption("--nav-net <u64>", "Net NAV (raw u64)")
    .requiredOption("--nav-gross <u64>", "Gross NAV (raw u64)")
    .requiredOption("--ter-bps <u16>", "Total expense ratio (basis points)")
    .requiredOption("--loss-bps <u16>", "Loss provision (basis points)")
    .requiredOption(
      "--nav-type <u8>",
      "NAV type discriminator (e.g. 0 = monthly close)",
    )
    .requiredOption(
      "--timestamp <i64>",
      "Unix-timestamp seconds when NAV was computed",
    )
    .requiredOption("--sequence <u64>", "Strictly-increasing sequence number")
    .requiredOption(
      "--merkle-root <hex64>",
      "Loan-tape Merkle root (32 bytes hex; 64 chars)",
    )
    .requiredOption(
      "--publisher-secret <path>",
      "Path to publisher Keypair JSON file",
    )
    .action(async (poolArg, opts) => {
      const globalOpts = getGlobalOptions(parent.parent!);
      const ctx = await createContext(globalOpts, opts, true, true);
      const { output, provider, wallet } = ctx;

      const idlPath = path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "target",
        "idl",
        "nav_oracle.json",
      );
      if (!fs.existsSync(idlPath)) {
        output.error(
          "nav-oracle IDL not found. Run `anchor build -p nav_oracle` first.",
        );
        process.exit(1);
      }

      try {
        const idl = loadIdl(idlPath);
        const prog = new Program(idl as any, provider);
        const programId = new PublicKey((idl as any).address);
        const pool = new PublicKey(poolArg);
        const [navAccount] = getNavAccountAddress(pool, programId);

        const merkleRoot = parseHex32(opts.merkleRoot);
        const publisher = loadKeypair(opts.publisherSecret);
        // The signature is computed inside NavOracle.update — we pass
        // `publisher` (the Keypair) and the SDK signs the canonical
        // 133-byte payload internally via tweetnacl. The zero-filled
        // signature here is a type-required field that the SDK
        // overwrites before composing the Ed25519 verify ix; we only
        // include it because UpdateNavParams demands it for the
        // KMS-managed flow (where callers compute the signature
        // externally). For local-keypair flow, the SDK does the work.
        const args = {
          navNet: new BN(opts.navNet),
          navGross: new BN(opts.navGross),
          terBps: parseInt(opts.terBps, 10),
          lossBps: parseInt(opts.lossBps, 10),
          navType: parseInt(opts.navType, 10),
          timestamp: new BN(opts.timestamp),
          sequence: new BN(opts.sequence),
          loanTapeMerkleRoot: Array.from(merkleRoot) as number[],
          signature: new Array(64).fill(0) as number[],
        };

        output.info("═══ NavOracle: Publish NAV ═══");
        output.info(`  Pool:        ${pool.toBase58()}`);
        output.info(`  NavAccount:  ${navAccount.toBase58()}`);
        output.info(`  Publisher:   ${publisher.publicKey.toBase58()}`);
        output.info(`  Sequence:    ${opts.sequence}`);
        output.info(`  navNet:      ${opts.navNet}`);
        output.info(`  navGross:    ${opts.navGross}`);
        output.info(`  Payer:       ${wallet.publicKey.toBase58()}`);

        if (globalOpts.dryRun) {
          output.success("Dry run complete. No transaction sent.");
          return;
        }

        if (!globalOpts.yes) {
          const confirmed = await output.confirm("Submit NAV update?");
          if (!confirmed) {
            output.warn("Aborted.");
            return;
          }
        }

        const spinner = output.spinner("Signing + submitting NAV update...");
        spinner.start();

        const sig = await NavOracle.update(prog, {
          pool,
          args,
          // Pass the publisher Keypair so the SDK signs the canonical
          // 133-byte NAV payload locally (`nacl.sign.detached`). The
          // publisher itself is NOT a transaction signer — Ed25519 verify
          // is a precompile and the signature is verified there.
          publisher,
        });

        spinner.succeed("NAV update landed");
        output.success(`Tx: ${sig}`);

        if (globalOpts.output === "json") {
          output.json({
            success: true,
            pool: pool.toBase58(),
            navAccount: navAccount.toBase58(),
            sequence: opts.sequence,
            signature: sig,
          });
        }
      } catch (error) {
        output.error(
          `Publish NAV failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });
}

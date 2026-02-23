#!/usr/bin/env node

import { Command } from "commander";
import { Connection, PublicKey, Keypair, clusterApiUrl } from "@solana/web3.js";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import { SolanaVault } from "./vault";
import { deriveVaultAddresses } from "./pda";
import * as math from "./math";
import * as fs from "fs";
import * as path from "path";

const program = new Command();

program
  .name("solana-vault")
  .description("CLI for Solana Vault Standard (SVS)")
  .version("0.1.0");

// Shared options
function addConnectionOpts(cmd: Command): Command {
  return cmd
    .option("-u, --url <url>", "RPC URL", "https://api.devnet.solana.com")
    .option(
      "-k, --keypair <path>",
      "Path to keypair file",
      `${process.env.HOME}/.config/solana/id.json`,
    );
}

function loadKeypair(keypairPath: string): Keypair {
  const resolved = keypairPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function getProvider(
  url: string,
  keypairPath: string,
): { provider: AnchorProvider; connection: Connection } {
  const connection = new Connection(url, "confirmed");
  const keypair = loadKeypair(keypairPath);
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return { provider, connection };
}

function formatAmount(amount: BN, decimals: number): string {
  const str = amount.toString().padStart(decimals + 1, "0");
  const intPart = str.slice(0, str.length - decimals) || "0";
  const decPart = str.slice(str.length - decimals);
  return `${intPart}.${decPart}`;
}

// ============ info ============

addConnectionOpts(
  program
    .command("info")
    .description("Show vault state")
    .requiredOption("--program-id <pubkey>", "Program ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .option("--vault-id <number>", "Vault ID", "1"),
).action(async (opts) => {
  const { provider } = getProvider(opts.url, opts.keypair);
  const programId = new PublicKey(opts.programId);
  const assetMint = new PublicKey(opts.assetMint);
  const vaultId = new BN(opts.vaultId);

  const addresses = deriveVaultAddresses(programId, assetMint, vaultId);

  console.log("Vault Addresses:");
  console.log(`  Vault PDA:    ${addresses.vault.toBase58()}`);
  console.log(`  Shares Mint:  ${addresses.sharesMint.toBase58()}`);
  console.log();

  try {
    // Load IDL from filesystem (Anchor convention)
    const idlPath = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "target",
      "idl",
      "svs_1.json",
    );
    if (!fs.existsSync(idlPath)) {
      console.log("IDL not found at", idlPath, "— run `anchor build` first.");
      console.log("Showing derived addresses only.");
      return;
    }

    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    const prog = new Program(idl, provider);
    const vault = await SolanaVault.load(prog, assetMint, vaultId);
    const state = await vault.getState();
    const totalAssets = await vault.totalAssets();
    const totalShares = await vault.totalShares();

    console.log("Vault State:");
    console.log(`  Authority:      ${state.authority.toBase58()}`);
    console.log(`  Asset Mint:     ${state.assetMint.toBase58()}`);
    console.log(`  Shares Mint:    ${state.sharesMint.toBase58()}`);
    console.log(`  Asset Vault:    ${state.assetVault.toBase58()}`);
    console.log(`  Total Assets:   ${totalAssets.toString()}`);
    console.log(`  Total Shares:   ${totalShares.toString()}`);
    console.log(`  Decimals Offset: ${state.decimalsOffset}`);
    console.log(`  Paused:         ${state.paused}`);
    console.log(`  Vault ID:       ${state.vaultId.toString()}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Failed to load vault:", msg);
  }
});

// ============ preview ============

addConnectionOpts(
  program
    .command("preview")
    .description("Preview vault operations")
    .requiredOption("--program-id <pubkey>", "Program ID")
    .requiredOption("--asset-mint <pubkey>", "Asset mint address")
    .requiredOption(
      "--operation <op>",
      "Operation: deposit, mint, withdraw, redeem",
    )
    .requiredOption("--amount <number>", "Amount (in raw units)")
    .option("--vault-id <number>", "Vault ID", "1"),
).action(async (opts) => {
  const { provider } = getProvider(opts.url, opts.keypair);
  const programId = new PublicKey(opts.programId);
  const assetMint = new PublicKey(opts.assetMint);
  const vaultId = new BN(opts.vaultId);
  const amount = new BN(opts.amount);

  const idlPath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "target",
    "idl",
    "svs_1.json",
  );
  if (!fs.existsSync(idlPath)) {
    console.error("IDL not found — run `anchor build` first.");
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const prog = new Program(idl, provider);
  const vault = await SolanaVault.load(prog, assetMint, vaultId);

  let result: BN;
  let label: string;

  switch (opts.operation) {
    case "deposit":
      result = await vault.previewDeposit(amount);
      label = `Deposit ${amount.toString()} assets -> ${result.toString()} shares`;
      break;
    case "mint":
      result = await vault.previewMint(amount);
      label = `Mint ${amount.toString()} shares -> costs ${result.toString()} assets`;
      break;
    case "withdraw":
      result = await vault.previewWithdraw(amount);
      label = `Withdraw ${amount.toString()} assets -> burns ${result.toString()} shares`;
      break;
    case "redeem":
      result = await vault.previewRedeem(amount);
      label = `Redeem ${amount.toString()} shares -> ${result.toString()} assets`;
      break;
    default:
      console.error(
        `Unknown operation: ${opts.operation}. Use deposit, mint, withdraw, or redeem.`,
      );
      process.exit(1);
  }

  console.log(label);
});

// ============ convert ============

program
  .command("convert")
  .description("Offline asset/share conversion (no RPC needed)")
  .requiredOption("--amount <number>", "Amount to convert")
  .requiredOption("--direction <dir>", "Direction: to-shares or to-assets")
  .requiredOption("--total-assets <number>", "Current total assets")
  .requiredOption("--total-shares <number>", "Current total shares")
  .requiredOption("--asset-decimals <number>", "Asset decimals (0-9)")
  .action((opts) => {
    const amount = new BN(opts.amount);
    const totalAssets = new BN(opts.totalAssets);
    const totalShares = new BN(opts.totalShares);
    const decimalsOffset = math.calculateDecimalsOffset(
      parseInt(opts.assetDecimals),
    );

    if (opts.direction === "to-shares") {
      const shares = math.convertToShares(
        amount,
        totalAssets,
        totalShares,
        decimalsOffset,
      );
      console.log(`${amount.toString()} assets = ${shares.toString()} shares`);
    } else if (opts.direction === "to-assets") {
      const assets = math.convertToAssets(
        amount,
        totalAssets,
        totalShares,
        decimalsOffset,
      );
      console.log(`${amount.toString()} shares = ${assets.toString()} assets`);
    } else {
      console.error("Direction must be 'to-shares' or 'to-assets'");
      process.exit(1);
    }
  });

// ============ derive ============

program
  .command("derive")
  .description("Derive vault PDA addresses (no RPC needed)")
  .requiredOption("--program-id <pubkey>", "Program ID")
  .requiredOption("--asset-mint <pubkey>", "Asset mint address")
  .option("--vault-id <number>", "Vault ID", "1")
  .action((opts) => {
    const programId = new PublicKey(opts.programId);
    const assetMint = new PublicKey(opts.assetMint);
    const vaultId = new BN(opts.vaultId);

    const addresses = deriveVaultAddresses(programId, assetMint, vaultId);

    console.log(
      `Vault PDA:       ${addresses.vault.toBase58()} (bump: ${addresses.vaultBump})`,
    );
    console.log(
      `Shares Mint PDA: ${addresses.sharesMint.toBase58()} (bump: ${addresses.sharesMintBump})`,
    );
  });

program.parse();

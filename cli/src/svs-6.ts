#!/usr/bin/env ts-node

/**
 * SVS-6 CLI — Confidential Streaming Yield Vault
 *
 * Usage:
 *   svs-6 initialize --asset-mint <PUBKEY> --vault-id <NUM> --asset-decimals <NUM>
 *   svs-6 deposit --vault <PUBKEY> --amount <NUM> --min-shares <NUM>
 *   svs-6 redeem --vault <PUBKEY> --shares <NUM> --min-assets <NUM>
 *   svs-6 distribute-yield --vault <PUBKEY> --amount <NUM> --duration <SECONDS>
 *   svs-6 checkpoint --vault <PUBKEY>
 *   svs-6 status --vault <PUBKEY>
 *   svs-6 pause --vault <PUBKEY>
 *   svs-6 unpause --vault <PUBKEY>
 */

import { Command } from "commander";
import {
  Connection,
  PublicKey,
  Keypair,
  clusterApiUrl,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const IDL_PATH = path.resolve(__dirname, "../../target/idl/svs_6.json");

// ── Helpers ──

function loadWallet(keypairPath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getProvider(cluster: string, walletPath: string): AnchorProvider {
  const connection = new Connection(
    cluster.startsWith("http") ? cluster : clusterApiUrl(cluster as any),
    "confirmed"
  );
  const wallet = new Wallet(loadWallet(walletPath));
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
}

function loadProgram(provider: AnchorProvider): Program {
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  return new Program(idl, provider);
}

function deriveVault(
  programId: PublicKey,
  assetMint: PublicKey,
  vaultId: BN
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("confidential_stream_vault"),
      assetMint.toBuffer(),
      vaultId.toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];
}

function deriveSharesMint(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), vault.toBuffer()],
    programId
  )[0];
}

// ── CLI Setup ──

const cli = new Command();

cli
  .name("svs-6")
  .description("SVS-6: Confidential Streaming Yield Vault CLI")
  .version("0.1.0")
  .option("-c, --cluster <url>", "Solana cluster", "devnet")
  .option(
    "-k, --keypair <path>",
    "Wallet keypair path",
    "~/.config/solana/id.json"
  );

// ── Initialize ──

cli
  .command("initialize")
  .description("Create a new SVS-6 vault")
  .requiredOption("--asset-mint <pubkey>", "Asset mint address")
  .requiredOption("--vault-id <number>", "Unique vault identifier")
  .requiredOption("--asset-decimals <number>", "Asset token decimals")
  .option("--auditor-key <hex>", "Optional auditor ElGamal public key (hex)")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const assetMint = new PublicKey(opts.assetMint);
    const vaultId = new BN(opts.vaultId);
    const vault = deriveVault(program.programId, assetMint, vaultId);
    const sharesMint = deriveSharesMint(program.programId, vault);
    const assetVault = getAssociatedTokenAddressSync(assetMint, vault, true);

    const auditor = opts.auditorKey
      ? Array.from(Buffer.from(opts.auditorKey, "hex"))
      : null;

    const sig = await program.methods
      .initialize({
        vaultId,
        assetDecimals: parseInt(opts.assetDecimals),
        auditorElgamalPubkey: auditor,
      })
      .accounts({
        authority: provider.wallet.publicKey,
        vault,
        assetMint,
        sharesMint,
        assetVault,
      })
      .rpc();

    console.log("Vault initialized!");
    console.log(`  Vault:       ${vault.toBase58()}`);
    console.log(`  Shares Mint: ${sharesMint.toBase58()}`);
    console.log(`  Asset Vault: ${assetVault.toBase58()}`);
    console.log(`  Tx:          ${sig}`);
  });

// ── Deposit ──

cli
  .command("deposit")
  .description("Deposit assets into the vault")
  .requiredOption("--vault <pubkey>", "Vault address")
  .requiredOption("--amount <number>", "Amount of assets to deposit")
  .option("--min-shares <number>", "Minimum shares to receive", "0")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const vault = new PublicKey(opts.vault);
    const vaultState = await program.account.confidentialStreamVault.fetch(vault);
    const sharesMint = deriveSharesMint(program.programId, vault);

    const sig = await program.methods
      .deposit(new BN(opts.amount), new BN(opts.minShares))
      .accounts({
        user: provider.wallet.publicKey,
        vault,
        assetMint: vaultState.assetMint,
        userAssetAccount: getAssociatedTokenAddressSync(
          vaultState.assetMint,
          provider.wallet.publicKey
        ),
        assetVault: vaultState.assetVault,
        sharesMint,
        userSharesAccount: getAssociatedTokenAddressSync(
          sharesMint,
          provider.wallet.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
      })
      .rpc();

    console.log(`Deposited ${opts.amount} assets. Tx: ${sig}`);
  });

// ── Distribute Yield ──

cli
  .command("distribute-yield")
  .description("Start a yield stream (authority only)")
  .requiredOption("--vault <pubkey>", "Vault address")
  .requiredOption("--amount <number>", "Yield amount to stream")
  .requiredOption("--duration <seconds>", "Stream duration in seconds")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const sig = await program.methods
      .distributeYield(new BN(opts.amount), new BN(opts.duration))
      .accounts({
        authority: provider.wallet.publicKey,
        vault: new PublicKey(opts.vault),
      })
      .rpc();

    console.log(`Yield stream started: ${opts.amount} over ${opts.duration}s. Tx: ${sig}`);
  });

// ── Checkpoint ──

cli
  .command("checkpoint")
  .description("Settle accrued yield (permissionless)")
  .requiredOption("--vault <pubkey>", "Vault address")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const sig = await program.methods
      .checkpoint()
      .accounts({
        caller: provider.wallet.publicKey,
        vault: new PublicKey(opts.vault),
      })
      .rpc();

    console.log(`Checkpoint complete. Tx: ${sig}`);
  });

// ── Status ──

cli
  .command("status")
  .description("Show vault status and streaming info")
  .requiredOption("--vault <pubkey>", "Vault address")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const vault = await program.account.confidentialStreamVault.fetch(
      new PublicKey(opts.vault)
    );

    const now = Math.floor(Date.now() / 1000);
    const streamStart = vault.streamStart.toNumber();
    const streamEnd = vault.streamEnd.toNumber();
    const duration = streamEnd - streamStart;
    const elapsed = Math.min(Math.max(now - streamStart, 0), duration);
    const accrued =
      duration > 0
        ? Math.floor((vault.streamAmount.toNumber() * elapsed) / duration)
        : 0;
    const effective = vault.baseAssets.toNumber() + accrued;
    const price =
      vault.totalShares.toNumber() > 0
        ? effective / vault.totalShares.toNumber()
        : 1.0;

    console.log("═══ SVS-6 Vault Status ═══");
    console.log(`  Authority:     ${vault.authority.toBase58()}`);
    console.log(`  Asset Mint:    ${vault.assetMint.toBase58()}`);
    console.log(`  Paused:        ${vault.paused}`);
    console.log(`  Base Assets:   ${vault.baseAssets.toString()}`);
    console.log(`  Total Shares:  ${vault.totalShares.toString()}`);
    console.log(`  Share Price:   ${price.toFixed(6)}`);
    console.log("");
    console.log("─── Streaming ───");
    console.log(`  Stream Amount: ${vault.streamAmount.toString()}`);
    console.log(`  Accrued:       ${accrued}`);
    console.log(`  Effective:     ${effective}`);
    console.log(
      `  Progress:      ${duration > 0 ? Math.round((elapsed / duration) * 100) : 0}%`
    );
    console.log(
      `  Stream End:    ${new Date(streamEnd * 1000).toISOString()}`
    );
    console.log("");
    console.log("─── Privacy ───");
    console.log(
      `  Auditor Key:   ${vault.auditorElgamalPubkey ? "Set" : "None (full privacy)"}`
    );
  });

// ── Pause / Unpause ──

cli
  .command("pause")
  .description("Emergency pause (authority only)")
  .requiredOption("--vault <pubkey>", "Vault address")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const sig = await program.methods
      .pause()
      .accounts({
        authority: provider.wallet.publicKey,
        vault: new PublicKey(opts.vault),
      })
      .rpc();

    console.log(`Vault paused. Tx: ${sig}`);
  });

cli
  .command("unpause")
  .description("Resume operations (authority only)")
  .requiredOption("--vault <pubkey>", "Vault address")
  .action(async (opts) => {
    const parent = cli.opts();
    const provider = getProvider(parent.cluster, parent.keypair);
    const program = loadProgram(provider);

    const sig = await program.methods
      .unpause()
      .accounts({
        authority: provider.wallet.publicKey,
        vault: new PublicKey(opts.vault),
      })
      .rpc();

    console.log(`Vault unpaused. Tx: ${sig}`);
  });

cli.parse();

/**
 * SVS-8 Multi-Asset Basket Vault — CLI commands.
 *
 * Registers all basket-specific commands under the "basket" subcommand group.
 * All commands follow the CLI conventions established in docs/CLI.md.
 *
 * Available commands:
 *   solana-vault basket init          — Initialize a new basket vault
 *   solana-vault basket info          — Display vault state and asset weights
 *   solana-vault basket add-asset     — Add an asset to the basket
 *   solana-vault basket remove-asset  — Remove an asset from the basket
 *   solana-vault basket update-weights — Update target allocation weights
 *   solana-vault basket deposit        — Deposit assets (single or proportional)
 *   solana-vault basket redeem         — Redeem shares (single or proportional)
 *   solana-vault basket rebalance      — Trigger rebalance via Jupiter
 *   solana-vault basket pause          — Emergency pause
 *   solana-vault basket unpause        — Resume operations
 *   solana-vault basket transfer-authority — Transfer admin
 */

import { Command } from "commander";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { BN, AnchorProvider, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import {
  BasketVault,
  multiVaultPda,
  basketSharesMintPda,
  assetEntryPda,
  assetVaultPda,
  validateBasketWeights,
} from "../../basket-vault";

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8")))
  );
}

function formatBN(bn: BN, decimals = 6): string {
  const n = Number(bn.toString()) / Math.pow(10, decimals);
  return n.toFixed(decimals);
}

function getProgram(opts: { url: string; keypair: string; programId: string }) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const anchor = require("@coral-xyz/anchor");
  const wallet = loadKeypair(opts.keypair);
  const connection = new Connection(opts.url, "confirmed");
  const provider = new AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idl = require("../../../../../target/idl/svs_8.json");
  return new Program(idl, new PublicKey(opts.programId), provider);
}

// ── Command group ─────────────────────────────────────────────────────────────

export function registerBasketCommands(program: Command): void {
  const basket = program
    .command("basket")
    .description("SVS-8 Multi-Asset Basket Vault operations");

  // ── basket init ──────────────────────────────────────────────────────────
  basket
    .command("init <vault-id>")
    .description("Initialize a new multi-asset basket vault")
    .option("--decimals-offset <n>", "Virtual offset for inflation protection", "6")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const [vault] = multiVaultPda(vaultId, prog.programId);
      const [sharesMint] = basketSharesMintPda(vault, prog.programId);

      console.log(`Initializing basket vault #${vaultIdStr}...`);
      console.log(`  Vault PDA:    ${vault.toBase58()}`);
      console.log(`  Shares Mint:  ${sharesMint.toBase58()}`);

      const authority = loadKeypair(opts.keypair);
      const sig = await prog.methods
        .initialize(vaultId, parseInt(opts.decimalsOffset), 0)
        .accounts({
          vault,
          sharesMint,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: require("@solana/web3.js").SystemProgram.programId,
          rent: require("@solana/web3.js").SYSVAR_RENT_PUBKEY,
        })
        .signers([authority])
        .rpc();

      console.log(`\n✅ Vault initialized! Tx: ${sig}`);
      console.log(`   Program ID:   ${prog.programId.toBase58()}`);
      console.log(`   Vault ID:     ${vaultIdStr}`);
    });

  // ── basket info ──────────────────────────────────────────────────────────
  basket
    .command("info <vault-id>")
    .description("Display basket vault state and asset allocations")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--output <format>", "Output format (table|json)", "table")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);

      const bv = await BasketVault.load(prog, vaultId);
      const s = bv.state;

      if (opts.output === "json") {
        console.log(JSON.stringify({
          vault: bv.vaultPubkey.toBase58(),
          sharesMint: bv.sharesMint.toBase58(),
          authority: s.authority.toBase58(),
          totalShares: s.totalShares.toString(),
          numAssets: s.numAssets,
          paused: s.paused,
          decimalsOffset: s.decimalsOffset,
          assets: bv.assets.map(a => ({
            mint: a.assetMint.toBase58(),
            oracle: a.oracle.toBase58(),
            weightBps: a.targetWeightBps,
            decimals: a.assetDecimals,
            index: a.index,
          })),
        }, null, 2));
        return;
      }

      console.log(`\n━━━ SVS-8 Basket Vault #${vaultIdStr} ━━━`);
      console.log(`  Vault PDA:    ${bv.vaultPubkey.toBase58()}`);
      console.log(`  Shares Mint:  ${bv.sharesMint.toBase58()}`);
      console.log(`  Authority:    ${s.authority.toBase58()}`);
      console.log(`  Total Shares: ${s.totalShares.toString()}`);
      console.log(`  Paused:       ${s.paused}`);
      console.log(`  Num Assets:   ${s.numAssets}`);
      console.log(`\n  Assets:`);
      for (const a of bv.assets) {
        const pct = (a.targetWeightBps / 100).toFixed(2);
        console.log(`    [${a.index}] ${a.assetMint.toBase58().substring(0,8)}...  ${pct}%  (oracle: ${a.oracle.toBase58().substring(0,8)}...)`);
      }
    });

  // ── basket add-asset ─────────────────────────────────────────────────────
  basket
    .command("add-asset <vault-id> <asset-mint> <oracle> <weight-bps>")
    .description("Add an asset to the basket (weight-bps: allocation in basis points)")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (vaultIdStr: string, assetMintStr: string, oracleStr: string, weightStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const assetMint = new PublicKey(assetMintStr);
      const oracle = new PublicKey(oracleStr);
      const weight = parseInt(weightStr);

      const bv = await BasketVault.load(prog, vaultId);
      const newTotal = bv.assets.reduce((s, a) => s + a.targetWeightBps, 0) + weight;

      console.log(`\nAdding asset to basket vault #${vaultIdStr}:`);
      console.log(`  Asset Mint:  ${assetMint.toBase58()}`);
      console.log(`  Oracle:      ${oracle.toBase58()}`);
      console.log(`  Weight:      ${weight} bps (${(weight/100).toFixed(2)}%)`);
      console.log(`  Total after: ${newTotal} bps`);

      if (newTotal > 10_000) {
        console.error(`\n❌ Error: Total weight would exceed 10,000 bps (${newTotal})`);
        process.exit(1);
      }

      if (!opts.yes) {
        console.log("\nUse --yes to confirm.");
        return;
      }

      const authority = loadKeypair(opts.keypair);
      const sig = await bv.addAsset(authority, { assetMint, oracle, targetWeightBps: weight });
      console.log(`\n✅ Asset added! Tx: ${sig}`);
    });

  // ── basket remove-asset ──────────────────────────────────────────────────
  basket
    .command("remove-asset <vault-id> <asset-mint>")
    .description("Remove an asset from the basket (vault must be empty)")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, assetMintStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const assetMint = new PublicKey(assetMintStr);

      if (!opts.yes) {
        console.log("Use --yes to confirm removal of asset:", assetMintStr);
        return;
      }

      const bv = await BasketVault.load(prog, vaultId);
      const authority = loadKeypair(opts.keypair);
      const sig = await bv.removeAsset(authority, assetMint);
      console.log(`✅ Asset removed! Tx: ${sig}`);
    });

  // ── basket update-weights ────────────────────────────────────────────────
  basket
    .command("update-weights <vault-id> <weights...>")
    .description("Update target weights (space-separated bps values, must sum to 10000)")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, weightsArr: string[], opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const weights = weightsArr.map(Number);

      if (!validateBasketWeights(weights)) {
        console.error(`\n❌ Invalid weights: sum=${weights.reduce((a,b)=>a+b,0)}, expected 10000`);
        process.exit(1);
      }

      const bv = await BasketVault.load(prog, vaultId);
      if (weights.length !== bv.assets.length) {
        console.error(`❌ Weight count (${weights.length}) != asset count (${bv.assets.length})`);
        process.exit(1);
      }

      console.log("New weights:");
      for (let i = 0; i < bv.assets.length; i++) {
        console.log(`  [${i}] ${bv.assets[i].assetMint.toBase58().substring(0,8)}... → ${weights[i]} bps (${(weights[i]/100).toFixed(2)}%)`);
      }

      if (!opts.yes) { console.log("Use --yes to confirm."); return; }

      const authority = loadKeypair(opts.keypair);
      const assetEntries = bv.getAssetEntryPubkeys();
      const sig = await bv.updateWeights(authority, { newWeights: weights, assetEntries });
      console.log(`✅ Weights updated! Tx: ${sig}`);
    });

  // ── basket deposit ───────────────────────────────────────────────────────
  basket
    .command("deposit <vault-id>")
    .description("Deposit assets into the basket vault")
    .requiredOption("--asset <mint>", "Asset mint to deposit (for single-asset mode)")
    .requiredOption("--amount <n>", "Amount in raw token units")
    .option("--proportional", "Deposit all assets proportionally instead of single-asset")
    .option("--oracle <pubkey>", "Oracle for the deposited asset")
    .option("--min-shares <n>", "Minimum shares to receive", "0")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const amount = new BN(opts.amount);
      const minShares = new BN(opts.minShares);

      const bv = await BasketVault.load(prog, vaultId);
      const user = loadKeypair(opts.keypair);

      if (bv.state.paused) {
        console.error("❌ Vault is paused.");
        process.exit(1);
      }

      if (!opts.yes) {
        console.log(`Deposit ${opts.amount} of ${opts.asset} into vault #${vaultIdStr}`);
        console.log("Use --yes to confirm.");
        return;
      }

      if (opts.proportional) {
        // Proportional deposit — requires all asset infos
        // In CLI mode we'd need the user to specify all assets/oracles
        // For simplicity, use the stored oracle from AssetEntry
        const basketAssets = bv.assets.map(a => ({
          assetMint: a.assetMint,
          oracle: a.oracle,
          userTokenAccount: undefined as unknown as PublicKey, // resolved below
        }));
        console.log("Proportional deposit not fully supported in CLI — use SDK directly.");
        return;
      }

      // Single-asset deposit
      if (!opts.oracle) {
        // Try to get oracle from AssetEntry
        const entry = bv.assets.find(a => a.assetMint.toBase58() === opts.asset);
        if (!entry) {
          console.error("❌ Asset not found in basket. Specify --oracle");
          process.exit(1);
        }
        opts.oracle = entry.oracle.toBase58();
      }

      const assetMint = new PublicKey(opts.asset);
      const oracle = new PublicKey(opts.oracle);
      const basketAssets = bv.assets.map(a => ({
        assetMint: a.assetMint,
        oracle: a.oracle,
      }));

      const sig = await bv.depositSingle(user, {
        assetMint,
        amount,
        minSharesOut: minShares,
        oracle,
        basketAssets,
      });
      console.log(`✅ Deposited! Tx: ${sig}`);
    });

  // ── basket redeem ────────────────────────────────────────────────────────
  basket
    .command("redeem <vault-id>")
    .description("Redeem shares from the basket vault")
    .requiredOption("--shares <n>", "Number of shares to burn")
    .option("--asset <mint>", "Asset to receive (for single-asset mode)")
    .option("--asset-index <n>", "Asset index (for single-asset mode)", "0")
    .option("--proportional", "Redeem proportionally across all assets")
    .option("--oracle <pubkey>", "Oracle for the redeemed asset")
    .option("--min-out <n>", "Minimum tokens to receive", "0")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const shares = new BN(opts.shares);
      const minOut = new BN(opts.minOut);

      const bv = await BasketVault.load(prog, vaultId);
      const user = loadKeypair(opts.keypair);

      if (!opts.yes) {
        console.log(`Redeem ${opts.shares} shares from vault #${vaultIdStr}`);
        console.log("Use --yes to confirm.");
        return;
      }

      if (opts.proportional) {
        // Proportional redeem
        const basketAssets = bv.assets.map(a => ({
          assetMint: a.assetMint,
          oracle: a.oracle,
          userTokenAccount: undefined as unknown as PublicKey,
        }));
        console.log("Proportional redeem not fully supported in CLI — use SDK directly.");
        return;
      }

      const assetMint = opts.asset
        ? new PublicKey(opts.asset)
        : bv.assets[parseInt(opts.assetIndex)].assetMint;
      const assetIndex = parseInt(opts.assetIndex);
      const oracle = opts.oracle
        ? new PublicKey(opts.oracle)
        : bv.assets[assetIndex].oracle;

      const basketAssets = bv.assets.map(a => ({
        assetMint: a.assetMint,
        oracle: a.oracle,
      }));

      const sig = await bv.redeemSingle(user, {
        shares,
        assetIndex,
        assetMint,
        minAmountOut: minOut,
        oracle,
        basketAssets,
      });
      console.log(`✅ Redeemed! Tx: ${sig}`);
    });

  // ── basket rebalance ─────────────────────────────────────────────────────
  basket
    .command("rebalance <vault-id>")
    .description("Rebalance basket via Jupiter aggregator")
    .requiredOption("--from <mint>", "Source asset mint")
    .requiredOption("--to <mint>", "Destination asset mint")
    .requiredOption("--min-out <n>", "Minimum tokens to receive")
    .option("--route <hex>", "Jupiter route data (hex-encoded)", "00")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, opts) => {
      const JUPITER_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const bv = await BasketVault.load(prog, vaultId);
      const authority = loadKeypair(opts.keypair);

      console.log(`Rebalancing: ${opts.from.substring(0,8)}... → ${opts.to.substring(0,8)}...`);
      if (!opts.yes) { console.log("Use --yes to confirm."); return; }

      const sig = await bv.rebalance(authority, {
        fromAssetMint: new PublicKey(opts.from),
        toAssetMint: new PublicKey(opts.to),
        routeData: Buffer.from(opts.route, "hex"),
        minimumOut: new BN(opts.minOut),
        jupiterProgram: JUPITER_PROGRAM_ID,
      });
      console.log(`✅ Rebalanced! Tx: ${sig}`);
    });

  // ── basket pause ─────────────────────────────────────────────────────────
  basket
    .command("pause <vault-id>")
    .description("Emergency pause — disable all financial operations")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const bv = await BasketVault.load(prog, vaultId);
      const authority = loadKeypair(opts.keypair);
      const sig = await bv.pause(authority);
      console.log(`✅ Vault #${vaultIdStr} paused! Tx: ${sig}`);
    });

  // ── basket unpause ───────────────────────────────────────────────────────
  basket
    .command("unpause <vault-id>")
    .description("Resume vault financial operations")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .action(async (vaultIdStr: string, opts) => {
      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const bv = await BasketVault.load(prog, vaultId);
      const authority = loadKeypair(opts.keypair);
      const sig = await bv.unpause(authority);
      console.log(`✅ Vault #${vaultIdStr} unpaused! Tx: ${sig}`);
    });

  // ── basket transfer-authority ────────────────────────────────────────────
  basket
    .command("transfer-authority <vault-id> <new-authority>")
    .description("Transfer vault admin authority to a new address")
    .option("--keypair <path>", "Keypair file path", process.env.ANCHOR_WALLET || "~/.config/solana/id.json")
    .option("--url <rpc>", "RPC endpoint", process.env.RPC_URL || "https://api.devnet.solana.com")
    .option("--program-id <id>", "SVS-8 Program ID", "SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j")
    .option("-y, --yes", "Skip confirmation")
    .action(async (vaultIdStr: string, newAuthStr: string, opts) => {
      const newAuthority = new PublicKey(newAuthStr);
      console.log(`Transferring authority to ${newAuthority.toBase58()}`);
      if (!opts.yes) { console.log("Use --yes to confirm."); return; }

      const prog = getProgram(opts);
      const vaultId = new BN(vaultIdStr);
      const bv = await BasketVault.load(prog, vaultId);
      const authority = loadKeypair(opts.keypair);
      const sig = await bv.transferAuthority(authority, newAuthority);
      console.log(`✅ Authority transferred! Tx: ${sig}`);
    });
}

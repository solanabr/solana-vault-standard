/**
 * Initialize NavAccount Script.
 *
 * Creates a per-pool NavAccount PDA in the deployed nav-oracle program.
 * This is the on-chain anchor for monthly + event-driven NAV publishes
 * from the credit-model publisher.
 *
 * Pre-conditions:
 *   * nav-oracle program is deployed (devnet 2026-04-29 at
 *     7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7)
 *   * The target pool's CreditVault PDA exists on-chain (SVS-11
 *     init_pool must have run for this pool already; without it the
 *     PDA seed derivation works but downstream SVS-11 reads will fail)
 *   * The publisher keypair (separate from operator) is generated and
 *     persisted somewhere safe.
 *   * The rotation authority is decided. Production deployments should
 *     use a governance or multisig authority; test deployments can pass
 *     the operator pubkey as a temporary placeholder and rotate later
 *     via `rotate_publisher`.
 *
 * Usage:
 *   npx ts-node scripts/initialize-nav-account.ts \
 *     --pool <CreditVault-PDA> \
 *     --publisher <PUBLISHER-PUBKEY> \
 *     --rotation-authority <GOVERNANCE-or-temp-pubkey> \
 *     [--cluster devnet]
 *
 * Required env:
 *   NAV_ORACLE_PROGRAM_ID  — defaults to devnet 2026-04-29 deploy
 *   ANCHOR_WALLET          — operator keypair path (defaults to
 *                            ~/.config/solana/id.json)
 *
 * After this runs, the NavAccount PDA is empty (sequence=0, all fields
 * zero except pool/publisher/rotation_authority). The first NAV publish
 * from the credit-model publisher writes real values.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Default to the devnet deployment from 2026-04-29.
const NAV_ORACLE_PROGRAM_ID_DEFAULT = "7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7";

// ─── CLI parsing ────────────────────────────────────────────────────────────

interface Args {
  pool: string;
  publisher: string;
  rotationAuthority: string;
  cluster: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let pool: string | undefined;
  let publisher: string | undefined;
  let rotationAuthority: string | undefined;
  let cluster = "devnet";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pool" && next) {
      pool = next;
      i++;
    } else if (a === "--publisher" && next) {
      publisher = next;
      i++;
    } else if (a === "--rotation-authority" && next) {
      rotationAuthority = next;
      i++;
    } else if (a === "--cluster" && next) {
      cluster = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printUsageAndExit(0);
    } else if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      printUsageAndExit(1);
    }
  }

  if (!pool || !publisher || !rotationAuthority) {
    console.error(
      `Missing required: --pool, --publisher, and --rotation-authority all required`,
    );
    printUsageAndExit(1);
  }

  // Refuse to run with the all-zero pubkey (System Program), which is
  // easy to hit by mistake when smoke-testing CLI parsing. The script
  // broadcasts a real on-chain tx, so any value-shaped input would
  // otherwise just go through.
  const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();
  for (const [name, value] of [
    ["pool", pool],
    ["publisher", publisher],
    ["rotation-authority", rotationAuthority],
  ] as const) {
    let parsed: PublicKey;
    try {
      parsed = new PublicKey(value!);
    } catch {
      console.error(`❌ --${name}=${value} is not a valid base58 pubkey.`);
      process.exit(1);
    }
    if (parsed.toBase58() === SYSTEM_PROGRAM) {
      console.error(
        `❌ Refusing to run: --${name}=${value} is the System Program / zero pubkey.\n` +
          `   Pass a real pubkey or use --help.`,
      );
      process.exit(1);
    }
  }

  return {
    pool: pool!,
    publisher: publisher!,
    rotationAuthority: rotationAuthority!,
    cluster,
  };
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage:\n  npx ts-node scripts/initialize-nav-account.ts \\\n    --pool <CreditVault-PDA> \\\n    --publisher <PUBLISHER-PUBKEY> \\\n    --rotation-authority <PROTOCOL-GUARDIAN-PDA> \\\n    [--cluster devnet]\n\nRequired env: NAV_ORACLE_PROGRAM_ID (defaults to devnet 2026-04-29).\n`,
  );
  process.exit(code);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadOperatorKeypair(): Keypair {
  const keyPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Operator keypair not found at ${keyPath}. Set ANCHOR_WALLET.`,
    );
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))),
  );
}

function rpcUrlForCluster(cluster: string): string {
  if (cluster === "localhost" || cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  return clusterApiUrl(cluster as "devnet" | "testnet" | "mainnet-beta");
}

/**
 * Anchor's instruction discriminator: SHA-256("global:<method_name>")[0..8].
 * For the `initialize` ix, that's the leading 8 bytes of
 * SHA-256("global:initialize"). We hard-code the value here to avoid
 * requiring the Anchor runtime + IDL just to send a single ix.
 *
 * To regenerate manually:
 *   node -e "console.log(require('crypto').createHash('sha256').update('global:initialize').digest().slice(0,8).toString('hex'))"
 */
const INITIALIZE_IX_DISCRIMINATOR = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237, // sha256("global:initialize")[0..8]
]);

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const programId = new PublicKey(
    process.env.NAV_ORACLE_PROGRAM_ID ?? NAV_ORACLE_PROGRAM_ID_DEFAULT,
  );
  const conn = new Connection(rpcUrlForCluster(args.cluster), "confirmed");
  const operator = loadOperatorKeypair();

  const pool = new PublicKey(args.pool);
  const publisher = new PublicKey(args.publisher);
  const rotationAuthority = new PublicKey(args.rotationAuthority);

  // Derive NavAccount PDA: seed = [b"nav_oracle", pool] under the
  // nav-oracle program. Seed prefix MUST match
  // programs/programs/nav-oracle/src/state.rs:NavAccount::SEED_PREFIX.
  const [navAccountPda, navAccountBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("nav_oracle"), pool.toBuffer()],
    programId,
  );

  console.log(`\n=== Initialize NavAccount ===`);
  console.log(`Cluster:             ${args.cluster}`);
  console.log(`Pool:                ${pool.toBase58()}`);
  console.log(`Publisher:           ${publisher.toBase58()}`);
  console.log(`Rotation authority:  ${rotationAuthority.toBase58()}`);
  console.log(`NavOracle program:   ${programId.toBase58()}`);
  console.log(`NavAccount PDA:      ${navAccountPda.toBase58()} (bump=${navAccountBump})`);
  console.log(`Operator (payer):    ${operator.publicKey.toBase58()}\n`);

  // Bail early if the PDA already exists — Anchor's `init` constraint
  // would reject anyway, but failing here gives a cleaner error.
  const existing = await conn.getAccountInfo(navAccountPda);
  if (existing) {
    console.error(
      `❌ NavAccount already exists at ${navAccountPda.toBase58()}.\n` +
        `   Existing data length: ${existing.data.length} bytes\n` +
        `   To re-init, you'd need to close the account first (no close ix\n` +
        `   exposed; would require manual recovery).`,
    );
    process.exit(1);
  }

  // Build the ix manually — InitializeNavAccount has no args, just
  // accounts. Order MUST match the #[derive(Accounts)] struct in
  // programs/nav-oracle/src/instructions/initialize.rs:5-30:
  //   1. pool                        (writable=false, signer=false)
  //   2. nav_account (PDA)           (writable=true,  signer=false)
  //   3. publisher                   (writable=false, signer=false)
  //   4. key_rotation_authority      (writable=false, signer=false)
  //   5. payer                       (writable=true,  signer=true)
  //   6. system_program              (writable=false, signer=false)
  const ix: TransactionInstruction = {
    programId,
    keys: [
      { pubkey: pool, isWritable: false, isSigner: false },
      { pubkey: navAccountPda, isWritable: true, isSigner: false },
      { pubkey: publisher, isWritable: false, isSigner: false },
      { pubkey: rotationAuthority, isWritable: false, isSigner: false },
      { pubkey: operator.publicKey, isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: INITIALIZE_IX_DISCRIMINATOR,
  };

  console.log(`Submitting initialize tx...`);
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(ix),
    [operator],
  );
  console.log(`✅ NavAccount initialized`);
  console.log(`   tx:           ${sig}`);
  console.log(`   PDA:          ${navAccountPda.toBase58()}`);

  // Quick post-init readback so the operator can see the on-chain state.
  const after = await conn.getAccountInfo(navAccountPda);
  if (!after) {
    console.error(
      `⚠️  Tx succeeded but PDA readback returned null — check the explorer.`,
    );
    process.exit(2);
  }
  console.log(`   data length:  ${after.data.length} bytes (expected 8 + NavAccount::SPACE)`);
  console.log(
    `   explorer:     https://explorer.solana.com/address/${navAccountPda.toBase58()}?cluster=${args.cluster}\n`,
  );

  console.log(`Next: run credit-model monthly_cron`);
  console.log(`with this NavAccount PDA to land sequence=1.\n`);
}

main().catch((e) => {
  console.error(`\n❌ initialize-nav-account failed:`);
  console.error(e);
  process.exit(1);
});

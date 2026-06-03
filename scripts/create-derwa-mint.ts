/**
 * Create dePOOL Mint Script.
 *
 * Creates a per-pool dePOOL Token-2022 mint with the ComplianceHook
 * bound at the Token-2022 extension level. The resulting mint pubkey
 * is the input to `wrapper.initialize()`.
 *
 * Why this exists: the wrapper code references `derwa_mint` as if it
 * already exists with a FreelyTransferable hook binding, but nothing
 * else creates it. Without this script, `wrap` and `unwrap` would
 * either fail with "mint not found" OR worse, succeed silently against
 * a mint that has NO compliance hook (sanctions checks bypassed).
 *
 * The script also creates the compliance-hook PDAs required by the
 * Token-2022 runtime:
 *   (a) MintConfig with mode=FreelyTransferable and pool_policy=None
 *   (b) ExtraAccountMetaList at [b"extra-account-metas", mint]
 *
 * Authority choreography: compliance-hook authorizes MintConfig creation
 * against the Token-2022 mint authority, so the mint is initialized with
 * operator authority first, the hook PDAs are created, then mint+freeze
 * authority are transferred to wrapper_signer. Final state: only the
 * derwa-wrapper program can mint/burn/freeze dePOOL.
 *
 * Usage:
 *   npx ts-node scripts/create-derwa-mint.ts \
 *     --pool <CreditVault-PDA> \
 *     [--cluster devnet]
 *
 * Required env:
 *   COMPLIANCE_HOOK_PROGRAM_ID  — devnet compliance-hook program ID
 *   DERWA_WRAPPER_PROGRAM_ID    — devnet derwa-wrapper program ID
 *   SOLANA_DEPLOYER_KEY         — operator keypair path (defaults to
 *                                 ANCHOR_WALLET → ~/.config/solana/id.json)
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
import {
  TOKEN_2022_PROGRAM_ID,
  AuthorityType,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createSetAuthorityInstruction,
  getMintLen,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import complianceHookIdl from "../target/idl/compliance_hook.json";
import type { ComplianceHook } from "../target/types/compliance_hook";

// ─── CLI parsing ────────────────────────────────────────────────────────────
//
// Hand-rolled loop parser; yargs is not in package.json deps so we use
// vanilla process.argv parsing throughout the operator scripts.

interface Args {
  pool: string;
  cluster: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let pool: string | undefined;
  let cluster = "devnet";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pool" && next) {
      pool = next;
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

  if (!pool) {
    console.error("Missing required --pool <CreditVault-PDA>");
    printUsageAndExit(1);
  }

  return { pool: pool!, cluster };
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage:\n  npx ts-node scripts/create-derwa-mint.ts --pool <CreditVault-PDA> [--cluster devnet]\n\nRequired env:\n  COMPLIANCE_HOOK_PROGRAM_ID, DERWA_WRAPPER_PROGRAM_ID, SOLANA_DEPLOYER_KEY (or ANCHOR_WALLET)\n`,
  );
  process.exit(code);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadOperatorKeypair(): Keypair {
  const keyPath =
    process.env.SOLANA_DEPLOYER_KEY ??
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config", "solana", "id.json");

  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Operator keypair not found at ${keyPath}. Set SOLANA_DEPLOYER_KEY or ANCHOR_WALLET.`,
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

function requireEnvPubkey(name: string): PublicKey {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name}`);
  }
  try {
    return new PublicKey(v);
  } catch (err) {
    throw new Error(`Env var ${name} is not a valid pubkey: ${v}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const conn = new Connection(rpcUrlForCluster(args.cluster), "confirmed");
  const operator = loadOperatorKeypair();

  const pool = new PublicKey(args.pool);
  const COMPLIANCE_HOOK = requireEnvPubkey("COMPLIANCE_HOOK_PROGRAM_ID");
  const DERWA_WRAPPER = requireEnvPubkey("DERWA_WRAPPER_PROGRAM_ID");

  console.log(`\n=== Create dePOOL Mint ===`);
  console.log(`Cluster:           ${args.cluster}`);
  console.log(`Pool:              ${pool.toBase58()}`);
  console.log(`ComplianceHook:    ${COMPLIANCE_HOOK.toBase58()}`);
  console.log(`DerwaWrapper:      ${DERWA_WRAPPER.toBase58()}`);
  console.log(`Operator:          ${operator.publicKey.toBase58()}\n`);

  // 1. Generate the mint keypair (the dePOOL mint address is its public key).
  const mintKp = Keypair.generate();
  console.log(`dePOOL mint will be: ${mintKp.publicKey.toBase58()}`);

  // 2. Derive the wrapper signer PDA: seed = [b"wrapper_signer", pool].
  //    This becomes mint+freeze authority, ensuring only the derwa-wrapper
  //    program can mint/burn dePOOL. The seed string MUST match the wrapper
  //    program's signer derivation in state.rs.
  const [wrapperSigner, wrapperSignerBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("wrapper_signer"), pool.toBuffer()],
    DERWA_WRAPPER,
  );
  console.log(
    `Wrapper signer PDA: ${wrapperSigner.toBase58()} (bump=${wrapperSignerBump})`,
  );

  // 3. Compute mint account size for Token-2022 + TransferHook extension.
  //    `getMintLen` adds the TLV-encoded extension space on top of the base
  //    mint state size, so the account is correctly sized at create time
  //    (Token-2022 cannot grow a mint account post-init).
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintRent = await conn.getMinimumBalanceForRentExemption(mintLen);

  const ixs: TransactionInstruction[] = [
    // a. Create the mint account (rent + space for Token-2022 + TransferHook)
    SystemProgram.createAccount({
      fromPubkey: operator.publicKey,
      newAccountPubkey: mintKp.publicKey,
      lamports: mintRent,
      space: mintLen,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // b. Initialize the TransferHook extension pointing at compliance-hook.
    //    The extension AUTHORITY (= operator here) can later rotate the hook
    //    program ID. Production deployments should rotate this authority
    //    to their configured governance or multisig authority so a
    //    single-key compromise cannot swap the hook program at runtime.
    //    Setting the extension MUST happen BEFORE InitializeMint or
    //    Token-2022 rejects it (per the Token-2022 spec: extensions are
    //    configured pre-init).
    createInitializeTransferHookInstruction(
      mintKp.publicKey,
      operator.publicKey, // extension authority — rotate to governance after setup
      COMPLIANCE_HOOK, // hook program — compliance-hook
      TOKEN_2022_PROGRAM_ID,
    ),
    // c. Initialize the mint itself with operator as temporary mint/freeze
    //    authority. compliance-hook's initialize_mint_config must be signed
    //    by the current mint authority, and the wrapper_signer PDA cannot
    //    sign outside a derwa-wrapper CPI. We transfer authority to
    //    wrapper_signer immediately after MintConfig + EAML creation.
    //
    //    Decimals = 6: matches cPOOL's default decimals from
    //    (`initialize_pool` defaults `permissioned_mint.decimals = 6`).
    //    Wrap/unwrap is 1:1 between cPOOL and dePOOL, so the decimals MUST
    //    match exactly — any mismatch breaks the wrap math.
    createInitializeMintInstruction(
      mintKp.publicKey,
      6,
      operator.publicKey,
      operator.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
  ];

  console.log(`\nSubmitting mint creation tx...`);
  const sig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(...ixs),
    [operator, mintKp],
  );
  console.log(`✅ dePOOL Token-2022 mint created`);
  console.log(`   tx: ${sig}`);
  console.log(
    `   TransferHook → ${COMPLIANCE_HOOK.toBase58()} (extension authority: operator, rotate post-deploy)`,
  );

  // 4. Create compliance-hook MintConfig in FreelyTransferable mode.
  const [mintConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), mintKp.publicKey.toBuffer()],
    COMPLIANCE_HOOK,
  );

  const [emaListPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mintKp.publicKey.toBuffer()],
    COMPLIANCE_HOOK,
  );

  const provider = new AnchorProvider(conn, new Wallet(operator), {
    commitment: "confirmed",
  });
  const complianceHook = new Program<ComplianceHook>(
    complianceHookIdl as ComplianceHook,
    provider,
  );

  console.log(`\nInitializing compliance-hook MintConfig...`);
  // dePOOL is FreelyTransferable — trust anchors are stored but unused
  // by the hook (no Permissioned-mode attestation enforcement on dePOOL
  // transfers). Pass default-zero anchors for clarity. The on-chain
  // handler accepts default values when mode != Permissioned.
  const initMintConfigSig = await complianceHook.methods
    .initializeMintConfig({
      mode: { freelyTransferable: {} },
      poolPolicy: null,
      attestationProgram: PublicKey.default,
      attestationIssuer: PublicKey.default,
      requiredAttestationType: 0,
    })
    .accountsPartial({
      mintConfig: mintConfigPda,
      mint: mintKp.publicKey,
      mintAuthority: operator.publicKey,
      payer: operator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`✅ MintConfig initialized`);
  console.log(`   tx: ${initMintConfigSig}`);

  console.log(`\nInitializing ExtraAccountMetaList...`);
  const initEamlSig = await complianceHook.methods
    .initializeExtraAccountMetaList()
    .accountsPartial({
      extraAccountMetaList: emaListPda,
      mint: mintKp.publicKey,
      mintConfig: mintConfigPda,
      mintAuthority: operator.publicKey,
      payer: operator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`✅ ExtraAccountMetaList initialized`);
  console.log(`   tx: ${initEamlSig}`);

  console.log(`\nTransferring mint/freeze authority to wrapper signer...`);
  const authoritySig = await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      createSetAuthorityInstruction(
        mintKp.publicKey,
        operator.publicKey,
        AuthorityType.MintTokens,
        wrapperSigner,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      createSetAuthorityInstruction(
        mintKp.publicKey,
        operator.publicKey,
        AuthorityType.FreezeAccount,
        wrapperSigner,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ),
    [operator],
  );
  console.log(`✅ Mint/freeze authority transferred to wrapper signer`);
  console.log(`   tx: ${authoritySig}`);

  // 6. Persist the artifact JSON for downstream consumers.
  const outFile = path.resolve(`.derwa-mints-${pool.toBase58()}.json`);
  const artifact = {
    cluster: args.cluster,
    pool: pool.toBase58(),
    derwa_mint: mintKp.publicKey.toBase58(),
    mint_config: mintConfigPda.toBase58(),
    extra_account_meta_list: emaListPda.toBase58(),
    wrapper_signer: wrapperSigner.toBase58(),
    wrapper_signer_bump: wrapperSignerBump,
    compliance_hook_program_id: COMPLIANCE_HOOK.toBase58(),
    derwa_wrapper_program_id: DERWA_WRAPPER.toBase58(),
    decimals: 6,
    transfer_hook_extension_authority: operator.publicKey.toBase58(),
    created_at: new Date().toISOString(),
    creation_tx: sig,
    initialize_mint_config_tx: initMintConfigSig,
    initialize_extra_account_meta_list_tx: initEamlSig,
    authority_transfer_tx: authoritySig,
    pending_runbook_steps: [
      "Rotate TransferHook extension authority from operator to the deployment's governance or multisig authority",
    ],
    fully_wired: true,
  };

  fs.writeFileSync(outFile, JSON.stringify(artifact, null, 2));
  console.log(`\nWrote dePOOL artifacts → ${outFile}`);

  console.log(
    `\nNext: pass derwa_mint=${mintKp.publicKey.toBase58()} to wrapper.initialize. TransferHook extension authority rotation remains a governance runbook step.\n`,
  );
}

main().catch((e) => {
  console.error(`\n❌ create-derwa-mint failed:`);
  console.error(e);
  process.exit(1);
});

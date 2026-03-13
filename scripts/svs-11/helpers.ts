/**
 * SVS-11 helpers — credit vault setup, PDA derivation, oracle/attestation utils.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Svs11 } from "../../target/types/svs_11";
import { MockOracle } from "../../target/types/mock_oracle";
import { MockSas as MockAttestation } from "../../target/types/mock_sas";
import {
  loadKeypair,
  explorerUrl,
  accountUrl,
  fundAccount,
} from "../shared/common-helpers";
import {
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getCreditFrozenAccountAddress,
} from "../../sdk/core/src/credit-vault-pda";
import * as fs from "fs";
import * as path from "path";

export {
  explorerUrl,
  accountUrl,
  loadKeypair,
  fundAccount,
  getCreditVaultAddress,
  getCreditSharesMintAddress,
  getRedemptionEscrowAddress,
  getInvestmentRequestAddress,
  getRedemptionRequestAddress,
  getClaimableTokensAddress,
  getCreditFrozenAccountAddress,
};

export const PRICE_SCALE = new BN(1_000_000_000);
export const ASSET_DECIMALS = 6;

function loadProgramId(keypairFile: string): PublicKey {
  const kpPath = path.join(__dirname, `../../target/deploy/${keypairFile}`);
  if (!fs.existsSync(kpPath)) {
    console.error(`\n  ERROR: Keypair not found at ${kpPath}. Run 'anchor build' first.`);
    process.exit(1);
  }
  return loadKeypair(kpPath).publicKey;
}

export const PROGRAM_ID = loadProgramId("svs_11-keypair.json");
export const MOCK_ORACLE_ID = loadProgramId("mock_oracle-keypair.json");
export const ATTESTATION_PROGRAM_ID = loadProgramId("mock_sas-keypair.json");

export function getOracleDataPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    MOCK_ORACLE_ID,
  );
}

export function getAttestationPDA(
  subject: PublicKey,
  issuer: PublicKey,
  attestationType: number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("attestation"), subject.toBuffer(), issuer.toBuffer(), Buffer.from([attestationType])],
    ATTESTATION_PROGRAM_ID,
  );
}

export interface SetupResult {
  connection: Connection;
  payer: Keypair;
  provider: anchor.AnchorProvider;
  program: Program<Svs11>;
  oracleProgram: Program<MockOracle>;
  attestationProgram: Program<MockAttestation>;
}

export async function setupTest(testName: string): Promise<SetupResult> {
  console.log("\n" + "=".repeat(70));
  console.log(`  SVS-11 Test: ${testName}`);
  console.log("=".repeat(70) + "\n");

  const rpcUrl = process.env.RPC_URL || process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  const walletPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const payer = loadKeypair(walletPath);

  console.log("Configuration:");
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Wallet: ${payer.publicKey.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  const sol = balance / 1_000_000_000;
  console.log(`  Balance: ${sol} SOL`);

  if (balance < 500_000_000) {
    console.error("\n  ERROR: Insufficient balance. Need at least 0.5 SOL.");
    process.exit(1);
  }

  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  const loadIdl = (name: string) => {
    const idlPath = path.join(__dirname, `../../target/idl/${name}.json`);
    if (!fs.existsSync(idlPath)) {
      console.error(`\n  ERROR: IDL not found at ${idlPath}. Run 'anchor build' first.`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  };

  const program = new Program(loadIdl("svs_11"), provider) as unknown as Program<Svs11>;
  const oracleProgram = new Program(loadIdl("mock_oracle"), provider) as unknown as Program<MockOracle>;
  const attestationProgram = new Program(loadIdl("mock_sas"), provider) as unknown as Program<MockAttestation>;

  console.log(`  Program ID: ${PROGRAM_ID.toBase58()}`);
  console.log(`  Mock Oracle: ${MOCK_ORACLE_ID.toBase58()}`);
  console.log(`  Attestation: ${ATTESTATION_PROGRAM_ID.toBase58()}`);

  return { connection, payer, provider, program, oracleProgram, attestationProgram };
}

export interface VaultContext {
  vaultId: BN;
  assetMint: PublicKey;
  vault: PublicKey;
  sharesMint: PublicKey;
  redemptionEscrow: PublicKey;
  depositVault: PublicKey;
  navOracle: PublicKey;
  attester: Keypair;
  investor: Keypair;
  investorAta: PublicKey;
  payerAta: PublicKey;
  investorSharesAta: PublicKey;
  attestation: PublicKey;
  investmentRequest: PublicKey;
  redemptionRequest: PublicKey;
  claimableTokens: PublicKey;
}

/**
 * Creates a mint, funds accounts, derives all PDAs, sets oracle price,
 * creates attestation, and initializes the vault. Returns all context
 * needed to run instructions against the vault.
 */
export async function createVaultContext(
  setup: SetupResult,
): Promise<VaultContext> {
  const { connection, payer, provider, program, oracleProgram, attestationProgram } = setup;

  const vaultId = new BN(Date.now() % 100000);
  const attester = Keypair.generate();
  const investor = Keypair.generate();
  const attestationType = 0;
  const countryCode = [66, 82];

  // Create mint and fund accounts
  const assetMint = await createMint(
    connection, payer, payer.publicKey, null, ASSET_DECIMALS,
    Keypair.generate(), undefined, TOKEN_PROGRAM_ID,
  );

  const payerAtaObj = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, payer.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  await fundAccount(connection, payer, investor.publicKey, 0.1);

  const investorAtaObj = await getOrCreateAssociatedTokenAccount(
    connection, payer, assetMint, investor.publicKey, false, undefined, undefined, TOKEN_PROGRAM_ID,
  );

  const mintAmount = 10_000_000_000;
  await mintTo(connection, payer, assetMint, investorAtaObj.address, payer, mintAmount);
  await mintTo(connection, payer, assetMint, payerAtaObj.address, payer, mintAmount);

  // Derive PDAs
  const [vault] = getCreditVaultAddress(PROGRAM_ID, assetMint, vaultId);
  const [sharesMint] = getCreditSharesMintAddress(PROGRAM_ID, vault);
  const [redemptionEscrow] = getRedemptionEscrowAddress(PROGRAM_ID, vault);
  const depositVault = getAssociatedTokenAddressSync(assetMint, vault, true, TOKEN_PROGRAM_ID);
  const [investmentRequest] = getInvestmentRequestAddress(PROGRAM_ID, vault, investor.publicKey);
  const [redemptionRequest] = getRedemptionRequestAddress(PROGRAM_ID, vault, investor.publicKey);
  const [claimableTokens] = getClaimableTokensAddress(PROGRAM_ID, vault, investor.publicKey);
  const [navOracle] = getOracleDataPDA();

  // Set oracle price
  await oracleProgram.methods
    .setPrice(PRICE_SCALE)
    .accountsPartial({
      authority: payer.publicKey,
      oracleData: navOracle,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Create attestation
  const expiresAt = new BN(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const [attestation] = getAttestationPDA(investor.publicKey, attester.publicKey, attestationType);

  await attestationProgram.methods
    .createAttestation(attester.publicKey, attestationType, countryCode, expiresAt)
    .accountsPartial({
      authority: payer.publicKey,
      attestation,
      subject: investor.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Initialize vault
  await program.methods
    .initializePool(vaultId, new BN(1_000_000), new BN(3600))
    .accountsPartial({
      authority: payer.publicKey,
      manager: payer.publicKey,
      assetMint,
      navOracle,
      oracleProgram: MOCK_ORACLE_ID,
      attester: attester.publicKey,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      vault,
      sharesMint,
      depositVault,
      redemptionEscrow,
      assetTokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Create Token-2022 ATA for investor shares
  await getOrCreateAssociatedTokenAccount(
    connection, payer, sharesMint, investor.publicKey, false,
    undefined, undefined, TOKEN_2022_PROGRAM_ID,
  );

  const investorSharesAta = getAssociatedTokenAddressSync(
    sharesMint, investor.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );

  console.log(`  Vault ID: ${vaultId.toString()}`);
  console.log(`  Vault PDA: ${vault.toBase58()}`);
  console.log(`  Asset mint: ${assetMint.toBase58()}`);

  return {
    vaultId,
    assetMint,
    vault,
    sharesMint,
    redemptionEscrow,
    depositVault,
    navOracle,
    attester,
    investor,
    investorAta: investorAtaObj.address,
    payerAta: payerAtaObj.address,
    investorSharesAta,
    attestation,
    investmentRequest,
    redemptionRequest,
    claimableTokens,
  };
}

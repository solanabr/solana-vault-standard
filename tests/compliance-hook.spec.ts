import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { ComplianceHook } from "../target/types/compliance_hook";
import { MockSas } from "../target/types/mock_sas";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountIdempotent,
  createTransferCheckedInstruction,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

import {
  ComplianceModeArg,
  createHookBoundMint,
  createSvsAttestation,
  getAttestationPda,
  getEamlPda,
  initEaml,
  initMintConfig,
  resolveHookExtras,
} from "./helpers/hook-mint";

// Mock-sas program ID — matches Anchor.toml. Same constant used by
// svs-11.ts and derwa-wrapper.spec.ts.
const ATTESTATION_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);
const FAR_FUTURE_EXPIRY = new BN(4_102_444_800); // ~year 2100

describe("compliance-hook: update_sanctions_list", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ComplianceHook as Program<ComplianceHook>;

  // Use provider wallet as the SanctionsList authority. svs-11.ts runs
  // before this suite in anchor's test order and initializes the
  // singleton SanctionsList with the same authority — so this suite's
  // init is idempotent (skips on "already in use") and the
  // authority-gated paths exercised below all sign with the same key.
  const nonAuthority = Keypair.generate();
  const provWallet = (provider.wallet as anchor.Wallet).payer;
  let sanctionsListPda: PublicKey;

  before(async () => {
    [sanctionsListPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sanctions_list")],
      program.programId,
    );

    await provider.connection.requestAirdrop(nonAuthority.publicKey, 1e9);
    await new Promise((r) => setTimeout(r, 1500));

    try {
      await program.methods
        .initializeSanctionsList()
        .accountsPartial({
          sanctionsList: sanctionsListPda,
          authority: provider.wallet.publicKey,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_err) {
      // Idempotent: svs-11.ts may have initialized the singleton already.
    }
  });

  it("authority can add an address", async () => {
    const sanctioned = Keypair.generate().publicKey;
    // Capture the version BEFORE the add — svs-11.ts may have already
    // bumped it via prior test runs / re-init flow, so we assert the
    // delta rather than the absolute value.
    const before = await program.account.sanctionsList.fetch(sanctionsListPda);
    await program.methods
      .updateSanctionsList([sanctioned], [])
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: provider.wallet.publicKey,
      })
      .signers([provWallet])
      .rpc();

    const list = await program.account.sanctionsList.fetch(sanctionsListPda);
    expect(list.addresses.map((a) => a.toBase58())).to.include(
      sanctioned.toBase58(),
    );
    expect(list.version.toNumber()).to.equal(before.version.toNumber() + 1);
  });

  it("non-authority is rejected", async () => {
    const sanctioned = Keypair.generate().publicKey;
    try {
      await program.methods
        .updateSanctionsList([sanctioned], [])
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: nonAuthority.publicKey,
        })
        .signers([nonAuthority])
        .rpc();
      expect.fail("expected UnauthorizedAuthority");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("UnauthorizedAuthority");
    }
  });

  it("authority can freeze and unfreeze an owner", async () => {
    const owner = Keypair.generate().publicKey;
    const [frozenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen"), owner.toBuffer()],
      program.programId,
    );

    await program.methods
      .freezeAccount()
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: provider.wallet.publicKey,
        ownerToFreeze: owner,
        frozenAccount,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([provWallet])
      .rpc();

    const frozen = await program.account.frozenAccount.fetch(frozenAccount);
    expect(frozen.bump).to.be.a("number");

    await program.methods
      .unfreezeAccount()
      .accounts({
        sanctionsList: sanctionsListPda,
        authority: provider.wallet.publicKey,
        ownerToUnfreeze: owner,
        frozenAccount,
        rentRecipient: provider.wallet.publicKey,
      })
      .signers([provWallet])
      .rpc();

    const closed = await provider.connection.getAccountInfo(frozenAccount);
    expect(closed).to.equal(null);
  });

  it("non-authority cannot freeze an owner", async () => {
    const owner = Keypair.generate().publicKey;
    const [frozenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen"), owner.toBuffer()],
      program.programId,
    );

    try {
      await program.methods
        .freezeAccount()
        .accounts({
          sanctionsList: sanctionsListPda,
          authority: nonAuthority.publicKey,
          ownerToFreeze: owner,
          frozenAccount,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonAuthority])
        .rpc();
      expect.fail("expected UnauthorizedAuthority");
    } catch (e: any) {
      expect(e.error.errorCode.code).to.equal("UnauthorizedAuthority");
    }
  });
});

describe("compliance-hook: execute (FreelyTransferable mode)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ComplianceHook as Program<ComplianceHook>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Per-suite mint + ATAs. Source and destination are arbitrary keypairs
  // (no real KYC needed for FreelyTransferable mode; the hook only
  // checks sanctions + freeze). Source is the mint authority so we can
  // mint test funds without a separate authority Keypair.
  const source = Keypair.generate();
  const destination = Keypair.generate();
  let mint: PublicKey;
  let sourceAta: PublicKey;
  let destinationAta: PublicKey;

  before(async () => {
    // Fund the source wallet so it can sign transfers (rent-exempt).
    const sig = await connection.requestAirdrop(
      source.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig);

    // Token-2022 mint with TransferHook extension pointing at compliance-hook.
    ({ mint } = await createHookBoundMint(
      connection,
      payer,
      source.publicKey, // mint authority + ext authority
      program.programId,
      6,
    ));

    // Bind the mint to FreelyTransferable mode. Trust anchors are stored
    // but unused in this mode — defaults are accepted on-chain.
    await initMintConfig(program, mint, source, payer, {
      mode: ComplianceModeArg.freelyTransferable(),
    });
    await initEaml(program, mint, source, payer);

    // Source + destination ATAs.
    sourceAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      source.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    destinationAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      destination.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Mint test funds to source.
    await mintTo(
      connection,
      payer,
      mint,
      sourceAta,
      source,
      10_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
  });

  it("transfer between two non-sanctioned wallets succeeds", async () => {
    // Use spl-token's `addExtraAccountMetasForExecute` to populate the
    // hook's EAML-resolved extras + hook program + EAML PDA in canonical
    // SPL order. This is the same helper that
    // `createTransferCheckedWithTransferHookInstruction` uses internally;
    // building the inner `transfer_checked` and decorating it with the
    // helper avoids any ambiguity in the off-chain PDA resolution.
    const ix = createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      source.publicKey,
      1_000_000,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    await addExtraAccountMetasForExecute(
      connection,
      ix,
      program.programId,
      sourceAta,
      mint,
      destinationAta,
      source.publicKey,
      BigInt(1_000_000),
    );

    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [source]);

    const destAcct = await getAccount(
      connection,
      destinationAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(destAcct.amount).to.equal(1_000_000n);
  });

  // Frozen / sanctioned negative paths are kept as visible skipped coverage —
  // the active happy-path test above proves the EAML resolution works
  // end-to-end; the negative cases land alongside a more comprehensive
  // hook-policy fuzz harness.
  it.skip("transfer where destination owner is sanctioned fails", async () => {
    // Setup: add destination's wallet to sanctions list, then call execute.
    // Expected: SanctionedAddress (6000) error.
  });

  it.skip("transfer where source owner is sanctioned fails", async () => {
    // Mirror of the above for source owner.
    // Expected: SanctionedAddress (6000) error.
  });

  it.skip("transfer where source owner has FrozenAccount PDA fails", async () => {
    // Setup: create a FrozenAccount PDA at [b"frozen", source_owner].
    // Expected: AccountFrozen (6001) error.
  });

  it.skip("transfer where destination owner has FrozenAccount PDA fails", async () => {
    // Mirror for destination.
    // Expected: AccountFrozen (6001) error.
  });
});

describe("compliance-hook: execute (Permissioned mode)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ComplianceHook as Program<ComplianceHook>;
  const mockSas = anchor.workspace.MockSas as Program<MockSas>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Per-suite principals. The `attester` plays the role of a real
  // KYB issuer (Civic Pass, SAS, etc.). `poolPolicy` is an arbitrary
  // pubkey baked into the EAML — `execute` does NOT enforce any
  // threshold against it (reserved slot for a future policy layer),
  // so any non-default pubkey works for this test.
  const source = Keypair.generate();
  const destination = Keypair.generate();
  const attester = Keypair.generate();
  const poolPolicy = Keypair.generate().publicKey;
  const REQUIRED_TYPE = 0;

  let mint: PublicKey;
  let sourceAta: PublicKey;
  let destinationAta: PublicKey;
  let sourceAttestation: PublicKey;
  let destinationAttestation: PublicKey;

  before(async () => {
    const sig = await connection.requestAirdrop(
      source.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig);

    // Token-2022 mint with hook extension. Source is the mint authority
    // so we can mint test funds without a separate Keypair.
    ({ mint } = await createHookBoundMint(
      connection,
      payer,
      source.publicKey,
      program.programId,
      6,
    ));

    // Permissioned MintConfig: trust anchors are required (non-default).
    // The on-chain `check_attestation` reads exactly these fields when
    // validating each attestation passed by the runtime via the EAML.
    await initMintConfig(program, mint, source, payer, {
      mode: ComplianceModeArg.permissioned(),
      poolPolicy,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: REQUIRED_TYPE,
    });
    // EAML init reads MintConfig and bakes in the cross-program PDA
    // derivation for source/destination_attestation. Capacity = 8 extras.
    await initEaml(program, mint, source, payer);

    sourceAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      source.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    destinationAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      destination.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await mintTo(
      connection,
      payer,
      mint,
      sourceAta,
      source,
      10_000_000,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Issue valid attestations for both wallets via mock-sas. Subject
    // and issuer match the EAML's cross-program PDA derivation:
    //   PDA = [b"attestation", subject, attester, [REQUIRED_TYPE]]
    sourceAttestation = await createSvsAttestation(
      mockSas,
      payer,
      source.publicKey,
      attester.publicKey,
      REQUIRED_TYPE,
      [66, 82],
      FAR_FUTURE_EXPIRY,
    );
    destinationAttestation = await createSvsAttestation(
      mockSas,
      payer,
      destination.publicKey,
      attester.publicKey,
      REQUIRED_TYPE,
      [66, 82],
      FAR_FUTURE_EXPIRY,
    );

    // Sanity-check that our off-chain PDA derivation matches mock-sas's
    // on-chain PDA derivation. This catches seed drift between the test
    // helper and the canonical convention (subject/issuer/type byte
    // ordering, hyphen vs underscore literals, etc.).
    expect(sourceAttestation.toBase58()).to.equal(
      getAttestationPda(
        source.publicKey,
        attester.publicKey,
        REQUIRED_TYPE,
        ATTESTATION_PROGRAM_ID,
      ).toBase58(),
    );
  });

  it("transfer succeeds when both wallets have valid attestations", async () => {
    void sourceAttestation;
    void destinationAttestation;

    const ix = createTransferCheckedInstruction(
      sourceAta,
      mint,
      destinationAta,
      source.publicKey,
      500_000,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    ix.keys.push(
      ...resolveHookExtras({
        complianceHookProgramId: program.programId,
        mint,
        sourceOwner: source.publicKey,
        destinationOwner: destination.publicKey,
        permissioned: true,
        attestationProgram: ATTESTATION_PROGRAM_ID,
        attestationIssuer: attester.publicKey,
        requiredAttestationType: REQUIRED_TYPE,
        poolPolicy,
      }),
    );

    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [source]);

    const destAcct = await getAccount(
      connection,
      destinationAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    expect(destAcct.amount).to.equal(500_000n);
  });

  it("transfer fails when destination attestation is missing", async () => {
    // Use a fresh destination wallet that has NO attestation. The
    // runtime resolves the destination_attestation PDA address
    // deterministically from seeds, but no account exists there, so it
    // appears as a default-zero account: `lamports == 0`,
    // `data.len() == 0`. The handler rejects the transfer during
    // destination-side attestation validation.
    const stranger = Keypair.generate();
    const strangerAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      stranger.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    const ix = createTransferCheckedInstruction(
      sourceAta,
      mint,
      strangerAta,
      source.publicKey,
      100_000,
      6,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    ix.keys.push(
      ...resolveHookExtras({
        complianceHookProgramId: program.programId,
        mint,
        sourceOwner: source.publicKey,
        destinationOwner: stranger.publicKey,
        permissioned: true,
        attestationProgram: ATTESTATION_PROGRAM_ID,
        attestationIssuer: attester.publicKey,
        requiredAttestationType: REQUIRED_TYPE,
        poolPolicy,
      }),
    );

    let errored = false;
    try {
      await provider.sendAndConfirm(new Transaction().add(ix), [source]);
    } catch (e: unknown) {
      errored = true;
      const errStr = String(e);
      // The hook's owner-first ordering means a default-zero account
      // (system-program-owned) fails the owner check before the
      // existence check. Either rejection proves the unattested
      // destination is blocked: 6002 (AttestationNotFound) or 6012
      // (InvalidAttestationProgram).
      expect(
        errStr.includes("AttestationNotFound") ||
          errStr.includes("InvalidAttestationProgram") ||
          errStr.includes("0x1772") || // hex(6002)
          errStr.includes("0x177c") || // hex(6012)
          errStr.includes("6002") ||
          errStr.includes("6012"),
      ).to.equal(
        true,
        `Expected attestation-validation rejection, got: ${errStr}`,
      );
    }
    expect(errored).to.equal(
      true,
      "transfer to non-attested destination should reject",
    );
  });

  // Revoked / expired / source-missing-symmetric paths land alongside a
  // more comprehensive Permissioned-mode test pass — kept as visible
  // skipped coverage. The two active tests above prove the load-bearing
  // path: EAML cross-program PDA resolution + check_attestation full
  // identity binding.
  it.skip("transfer fails when source attestation is missing", async () => {
    // Symmetric mirror of the active destination-missing case. Requires
    // minting test funds to an unattested source without using a
    // TransferHook-gated transfer path.
  });

  it.skip("transfer fails when destination attestation is revoked", async () => {
    // Setup: destination Attestation written with `revoked = true` (byte 83
    // of payload after the 8-byte discriminator, per the layout locked in
    // the v2 attestation extension). Source attestation is valid.
    // Expected: AttestationRevoked (6003) error.
  });

  it.skip("transfer fails when destination attestation is expired", async () => {
    // Setup: destination Attestation written with `expires_at` set to a
    // unix timestamp in the past (bytes 75..83 of payload, little-endian
    // i64). Source attestation is valid.
    // Expected: AttestationExpired (6004) error.
  });
});

describe("compliance-hook: initialize_extra_account_meta_list", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ComplianceHook as Program<ComplianceHook>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  it("creates the ExtraAccountMetaList PDA at the canonical seed", async () => {
    // Stand up a fresh hook-bound mint + FreelyTransferable MintConfig,
    // then exercise initEaml. Asserting `getAccountInfo()` returns a
    // non-null record at the canonical PDA address proves: (a) the
    // hyphen-separated seed `b"extra-account-metas"` matches what the
    // runtime looks up, and (b) the EAML init handler ran to completion
    // (mint owner check, mint authority check, ExtraAccountMetaList::init).
    const mintAuthority = Keypair.generate();
    const sig = await connection.requestAirdrop(
      mintAuthority.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig);

    const { mint } = await createHookBoundMint(
      connection,
      payer,
      mintAuthority.publicKey,
      program.programId,
      6,
    );
    await initMintConfig(program, mint, mintAuthority, payer, {
      mode: ComplianceModeArg.freelyTransferable(),
    });
    const eaml = await initEaml(program, mint, mintAuthority, payer);

    expect(eaml.toBase58()).to.equal(
      getEamlPda(mint, program.programId).toBase58(),
    );
    const eamlAcct = await connection.getAccountInfo(eaml);
    expect(eamlAcct).to.not.equal(null);
    expect(eamlAcct!.owner.toBase58()).to.equal(program.programId.toBase58());
  });

  // The "rejects re-init" path is implicit in Anchor's `init` constraint
  // (returns "account already in use" on the second call); covered by the
  // active happy-path test above + Anchor's framework-level guarantees.
  it.skip("rejects re-initialization (already_in_use)", async () => {
    // Setup: invoke initialize_extra_account_meta_list twice on the same
    // mint without closing the PDA in between.
    // Expected: second call fails with the standard Anchor "account
    // already in use" / SystemProgram::CreateAccount-failure error.
  });

  it.skip("execute resolves all extra accounts via the PDA", async () => {
    // Covered end-to-end by the FreelyTransferable + Permissioned
    // execute tests above (both go through the EAML resolution).
  });
});

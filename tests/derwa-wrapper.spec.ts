/**
 * derwa-wrapper integration tests.
 *
 * The cPOOL mint is constructed with an active Token-2022 TransferHook
 * extension pointing at compliance-hook in Permissioned mode. Both
 * `wrap` and `unwrap` CPI transfers run through the real hook and must
 * receive the EAML extras via `remainingAccounts` (resolved off-chain
 * by `resolveHookExtras`) — proving the program's CPI remaining-account
 * forwarding wires correctly into the
 * Token-2022 hook invocation.
 *
 * Permissioned-mode hooks validate BOTH transfer owners. For the
 * wrapper-mediated transfers, that means:
 *   - `wrap`:    source = investor       → dest = wrapper_signer (PDA)
 *   - `unwrap`:  source = wrapper_signer → dest = investor
 * So the suite issues attestations for the investor AND a "system"
 * attestation for `wrapper_signer`. The `wrapper_signer` PDA cannot
 * actually perform KYB; this just satisfies the hook's owner check on
 * the wrapper-bound side of every transfer (mock-sas accepts any
 * subject — production deployments would issue this from the
 * compliance attester at wrapper-deploy time).
 *
 * What we test:
 *   ✅ wrap moves cPOOL → wrapper PDA + mints dePOOL 1:1 + bumps locked_supply
 *      (cPOOL transfer goes through the active Permissioned hook)
 *   ✅ unwrap with valid attestation burns dePOOL + releases cPOOL
 *      (cPOOL transfer goes through the active Permissioned hook)
 *   ✅ unwrap without attestation rejects with AttestationRequired (8001)
 *      via the wrapper's explicit check (fires BEFORE the cPOOL CPI)
 *   ✅ rejects unwrap when attestation belongs to a DIFFERENT subject (8005)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

import { ComplianceHook } from "../target/types/compliance_hook";
import { DerwaWrapper } from "../target/types/derwa_wrapper";
import { MockSas as MockAttestation } from "../target/types/mock_sas";
import {
  ComplianceModeArg,
  createHookBoundMint,
  createSvsAttestation,
  initEaml,
  initMintConfig,
  resolveHookExtras,
} from "./helpers/hook-mint";

// Mock-sas program ID — matches Anchor.toml entry. Same constant used by
// svs-11.ts; if mock-sas is redeployed, both must update.
const ATTESTATION_PROGRAM_ID = new PublicKey(
  "GTTMWDHTZibyEpqNRr33RnBhgms262U6qHaGrjoHqEXg",
);
const FAR_FUTURE_EXPIRY = new BN(4_102_444_800); // ~year 2100

describe("derwa-wrapper: wrap + unwrap roundtrip", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DerwaWrapper as Program<DerwaWrapper>;
  const complianceHook = anchor.workspace
    .ComplianceHook as Program<ComplianceHook>;
  const mockSas = anchor.workspace.MockSas as Program<MockAttestation>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test-scoped principals.
  const investor = Keypair.generate();
  const attester = Keypair.generate(); // issuer of the SVS-11 attestation
  const pool = Keypair.generate(); // stand-in for CreditVault PDA — wrapper
  // doesn't deserialize, so any pubkey works

  // Per-test-setup-derived state.
  let permissionedMint: PublicKey; // cPOOL (Permissioned hook active)
  let derwaMint: PublicKey; // dePOOL (FreelyTransferable hook active)
  let wrapperConfigPda: PublicKey;
  let wrapperSignerPda: PublicKey;
  let investorPermAta: PublicKey;
  let investorDerwaAta: PublicKey;
  let wrapperLockedAta: PublicKey;
  let attestationPda: PublicKey;
  // Permissioned-hook trust anchor for cPOOL — also captured by
  // `WrapperConfig` so `unwrap`'s explicit attestation check uses the
  // same trust posture as the on-chain hook.
  const REQUIRED_TYPE = 0;
  // Arbitrary pool_policy pubkey — `execute` does not enforce thresholds
  // against it (reserved slot for a future policy-enforcement layer), so
  // any non-default pubkey works for this test.
  const cPoolPolicy = Keypair.generate().publicKey;

  // EAML extras for the cPOOL Permissioned hook, computed per direction
  // because the (source_owner, dest_owner) pair drives the
  // source_attestation / destination_attestation cross-program PDAs.
  const wrapHookExtras = (): ReturnType<typeof resolveHookExtras> =>
    resolveHookExtras({
      complianceHookProgramId: complianceHook.programId,
      mint: permissionedMint,
      sourceOwner: investor.publicKey,
      destinationOwner: wrapperSignerPda,
      permissioned: true,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: REQUIRED_TYPE,
      poolPolicy: cPoolPolicy,
    });
  const unwrapHookExtras = (): ReturnType<typeof resolveHookExtras> =>
    resolveHookExtras({
      complianceHookProgramId: complianceHook.programId,
      mint: permissionedMint,
      sourceOwner: wrapperSignerPda,
      destinationOwner: investor.publicKey,
      permissioned: true,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: REQUIRED_TYPE,
      poolPolicy: cPoolPolicy,
    });

  const WRAP_AMOUNT = new BN(1_000_000); // 1.0 token at 6 decimals

  before(async () => {
    // Fund investor for tx fees + ATA rent.
    const sig = await connection.requestAirdrop(
      investor.publicKey,
      5 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig);

    // Derive wrapper PDAs (must match seeds in derwa-wrapper state.rs).
    [wrapperConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wrapper_config"), pool.publicKey.toBuffer()],
      program.programId,
    );
    [wrapperSignerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("wrapper_signer"), pool.publicKey.toBuffer()],
      program.programId,
    );

    // Ensure the global SanctionsList exists. The compliance-hook test
    // suite usually creates it first, but anchor test runs are file-
    // ordered alphabetically (compliance-hook runs before derwa-wrapper),
    // so it should exist. We make this idempotent against re-runs by
    // tolerating "already in use".
    try {
      const [sanctionsListPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("sanctions_list")],
        complianceHook.programId,
      );
      await complianceHook.methods
        .initializeSanctionsList()
        .accountsPartial({
          sanctionsList: sanctionsListPda,
          authority: provider.wallet.publicKey,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (_err) {
      // already initialized — fine
    }

    // Create cPOOL (permissioned mint) WITH the TransferHook extension
    // pointing at compliance-hook. The Permissioned MintConfig + EAML
    // get initialized below.
    ({ mint: permissionedMint } = await createHookBoundMint(
      connection,
      payer,
      investor.publicKey, // mint authority + ext authority — investor for test convenience
      complianceHook.programId,
      6,
    ));

    // Bind cPOOL to compliance-hook in Permissioned mode. Trust anchors
    // match what WrapperConfig will store, so the on-chain hook AND the
    // wrapper's explicit unwrap check enforce the same posture.
    await initMintConfig(complianceHook, permissionedMint, investor, payer, {
      mode: ComplianceModeArg.permissioned(),
      poolPolicy: cPoolPolicy,
      attestationProgram: ATTESTATION_PROGRAM_ID,
      attestationIssuer: attester.publicKey,
      requiredAttestationType: REQUIRED_TYPE,
    });
    await initEaml(complianceHook, permissionedMint, investor, payer);

    // dePOOL: FreelyTransferable mode. The wrapper PDA owns mint+freeze
    // authority. We DON'T bind a hook for dePOOL in this test (its
    // canonical config would be FreelyTransferable, but mint_to in
    // wrap.rs doesn't trigger a hook anyway — only transfer_checked does).
    derwaMint = await createMint(
      connection,
      payer,
      wrapperSignerPda,
      wrapperSignerPda,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Create the three required ATAs.
    investorPermAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      permissionedMint,
      investor.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    investorDerwaAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      derwaMint,
      investor.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    // wrapperSignerPda is a PDA (off-curve) — pass allowOwnerOffCurve=true.
    wrapperLockedAta = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      permissionedMint,
      wrapperSignerPda,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      undefined,
      true,
    );

    // Mint cPOOL to investor. `mint_to` does NOT go through the
    // TransferHook (only `transfer_checked` does), so this works even
    // with the Permissioned hook bound.
    await mintTo(
      connection,
      payer,
      permissionedMint,
      investorPermAta,
      investor,
      10_000_000, // 10.0 cPOOL
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    // Issue the investor's KYB attestation. Subject = investor.
    await createSvsAttestation(
      mockSas,
      payer,
      investor.publicKey,
      attester.publicKey,
      REQUIRED_TYPE,
      [66, 82],
      FAR_FUTURE_EXPIRY,
    );

    // Issue the wrapper-PDA "system" attestation. Subject =
    // wrapper_signer. The Permissioned hook validates BOTH owners on
    // every cPOOL transfer; without this the wrap's investor → wrapper
    // CPI and the unwrap's wrapper → investor CPI both fail at the
    // wrapper-side attestation check. Mock-sas accepts off-curve PDAs
    // as subjects, which mirrors what real attestation programs would
    // need to support for wrapped-asset deployments.
    await createSvsAttestation(
      mockSas,
      payer,
      wrapperSignerPda,
      attester.publicKey,
      REQUIRED_TYPE,
      [66, 82],
      FAR_FUTURE_EXPIRY,
    );

    // Initialize the wrapper for this pool.
    //
    // Trust anchors: bind the wrapper to the mock-sas attestation
    // program + the test-scoped `attester` issuer + attestation_type 0.
    // The on-chain `unwrap` handler will validate destination
    // attestations against these anchors via the
    // owner / subject / issuer / type / canonical-PDA chain.
    await program.methods
      .initialize({
        attestationProgram: ATTESTATION_PROGRAM_ID,
        attestationIssuer: attester.publicKey,
        requiredAttestationType: REQUIRED_TYPE,
      })
      .accountsPartial({
        pool: pool.publicKey,
        wrapperConfig: wrapperConfigPda,
        permissionedMint,
        derwaMint,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("wrap moves cPOOL to wrapper PDA + mints dePOOL 1:1", async () => {
    const investorPermBefore = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaBefore = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapperLockedBefore = await getAccount(
      connection,
      wrapperLockedAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      // Pass the resolved EAML extras for the cPOOL transfer
      // (source = investor, destination = wrapper_signer). The wrap
      // handler forwards these into the `transfer_checked` CPI via
      // `with_remaining_accounts` so the active Permissioned hook can
      // validate both owners.
      .remainingAccounts(wrapHookExtras())
      .signers([investor])
      .rpc();

    // Balance assertions: cPOOL moved investor → wrapper, dePOOL minted to investor.
    const investorPermAfter = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaAfter = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapperLockedAfter = await getAccount(
      connection,
      wrapperLockedAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapAmt = BigInt(WRAP_AMOUNT.toString());

    expect(investorPermAfter.amount).to.equal(
      investorPermBefore.amount - wrapAmt,
    );
    expect(wrapperLockedAfter.amount).to.equal(
      wrapperLockedBefore.amount + wrapAmt,
    );
    expect(investorDerwaAfter.amount).to.equal(
      investorDerwaBefore.amount + wrapAmt,
    );

    // locked_supply on-chain matches.
    const cfg = await program.account.wrapperConfig.fetch(wrapperConfigPda);
    expect(cfg.lockedSupply.eq(WRAP_AMOUNT)).to.be.true;
  });

  it("unwrap with valid attestation burns dePOOL + releases cPOOL", async () => {
    // Resolve the investor's attestation PDA — already created during
    // `before()` setup, so we just compute its address here for the
    // `investorAttestation` account-meta on the unwrap ix.
    [attestationPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        investor.publicKey.toBuffer(),
        attester.publicKey.toBuffer(),
        Buffer.from([REQUIRED_TYPE]),
      ],
      ATTESTATION_PROGRAM_ID,
    );

    const investorPermBefore = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaBefore = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );

    await program.methods
      .unwrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        wrapperLockedAta,
        investorPermissionedAta: investorPermAta,
        investorDerwaAta,
        investorAttestation: attestationPda,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      // Pass the resolved EAML extras for the cPOOL transfer
      // (source = wrapper_signer, destination = investor). Different
      // direction than `wrap`, so source/destination_attestation PDAs
      // resolve to different addresses.
      .remainingAccounts(unwrapHookExtras())
      .signers([investor])
      .rpc();

    const investorPermAfter = await getAccount(
      connection,
      investorPermAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const investorDerwaAfter = await getAccount(
      connection,
      investorDerwaAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
    );
    const wrapAmt = BigInt(WRAP_AMOUNT.toString());

    // cPOOL flows back, dePOOL gets burned.
    expect(investorPermAfter.amount).to.equal(
      investorPermBefore.amount + wrapAmt,
    );
    expect(investorDerwaAfter.amount).to.equal(
      investorDerwaBefore.amount - wrapAmt,
    );

    // locked_supply now zero.
    const cfg = await program.account.wrapperConfig.fetch(wrapperConfigPda);
    expect(cfg.lockedSupply.eqn(0)).to.be.true;
  });

  it("unwrap without attestation fails with AttestationRequired (8001)", async () => {
    // First, re-wrap so we have something to attempt to unwrap.
    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(wrapHookExtras())
      .signers([investor])
      .rpc();

    // Pass a random non-existent pubkey as the attestation account.
    // The unwrap handler now performs the owner check FIRST (`att.owner
    // == wrapper_config.attestation_program`) — this fails for a default-
    // zero system account because its `owner` is the system program, not
    // mock-sas. So the first rejection is `InvalidAttestationProgram`
    // (8004), NOT `AttestationRequired` (8001) like the prior
    // existence-first ordering produced.
    //
    // Owner-first ordering is the safer security posture: a single
    // Pubkey comparison rejects forgeries from foreign programs before
    // any payload reads happen. Both error codes mean "the attestation
    // is unusable" so the test accepts either.
    const fakeAttestation = Keypair.generate().publicKey;

    let errored = false;
    try {
      await program.methods
        .unwrap(WRAP_AMOUNT)
        .accountsPartial({
          wrapperConfig: wrapperConfigPda,
          wrapperSigner: wrapperSignerPda,
          permissionedMint,
          derwaMint,
          wrapperLockedAta,
          investorPermissionedAta: investorPermAta,
          investorDerwaAta,
          investorAttestation: fakeAttestation,
          investor: investor.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();
    } catch (e: unknown) {
      errored = true;
      const errStr = String(e);
      // Either rejection is acceptable: 8001 = AttestationRequired,
      // 8004 = InvalidAttestationProgram. Current validation checks
      // ownership before existence; if a future ordering checks
      // existence first, 8001 would still indicate the unwrap handler
      // refused the fake attestation.
      expect(
        errStr.includes("InvalidAttestationProgram") ||
          errStr.includes("AttestationRequired") ||
          errStr.includes("0x1f41") || // hex(8001)
          errStr.includes("0x1f44") || // hex(8004)
          errStr.includes("8001") ||
          errStr.includes("8004"),
      ).to.equal(
        true,
        `Expected attestation-validation rejection, got: ${errStr}`,
      );
    }
    expect(errored).to.equal(true, "unwrap should have rejected");
  });

  it("rejects unwrap when attestation belongs to a DIFFERENT subject (8005)", async () => {
    // Security-class check: a previous version of the unwrap handler
    // only validated existence + revoked + expires, NEVER reading the
    // `subject` field of the attestation payload. That meant any holder
    // of dePOOL could pass ANY pre-existing valid attestation account
    // (e.g. a friend's KYC'd attestation) and unwrap into the
    // permissioned cPOOL — defeating the entire Permissioned-mode
    // invariant.
    //
    // The fix reads `payload[0..32]` (subject) and compares to
    // investor.key(); a mismatch surfaces as
    // `InvalidAttestationSubject` (8005). This test creates a
    // VALID attestation for a *different* wallet (`stranger`) under
    // the *same* issuer + type, then attempts to unwrap with it.
    // Pre-fix this would have silently succeeded.

    const stranger = Keypair.generate();
    const [strangerAttestation] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("attestation"),
        stranger.publicKey.toBuffer(),
        attester.publicKey.toBuffer(),
        Buffer.from([0]), // same attestation_type as investor
      ],
      ATTESTATION_PROGRAM_ID,
    );

    // Create the stranger's attestation. Note: we DO NOT fund the
    // stranger or have them sign anything — the attestation creation
    // signer is the test payer (mock-sas accepts any signer for create
    // by design).
    await mockSas.methods
      .createAttestation(attester.publicKey, 0, [66, 82], FAR_FUTURE_EXPIRY)
      .accountsPartial({
        authority: payer.publicKey,
        attestation: strangerAttestation,
        subject: stranger.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // First, re-wrap something so we have a position to attempt to unwrap.
    // (The previous test fully unwrapped to zero.)
    await program.methods
      .wrap(WRAP_AMOUNT)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda,
        wrapperSigner: wrapperSignerPda,
        permissionedMint,
        derwaMint,
        investorPermissionedAta: investorPermAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: investor.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(wrapHookExtras())
      .signers([investor])
      .rpc();

    // Attempt unwrap with the stranger's attestation. The investor is
    // still the tx signer, so all token-program checks pass — only the
    // attestation subject check (now hardened) should reject.
    let errored = false;
    try {
      await program.methods
        .unwrap(WRAP_AMOUNT)
        .accountsPartial({
          wrapperConfig: wrapperConfigPda,
          wrapperSigner: wrapperSignerPda,
          permissionedMint,
          derwaMint,
          wrapperLockedAta,
          investorPermissionedAta: investorPermAta,
          investorDerwaAta,
          investorAttestation: strangerAttestation, // ← stranger's, not investor's
          investor: investor.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([investor])
        .rpc();
    } catch (e: unknown) {
      errored = true;
      const errStr = String(e);
      // 8005 = 0x1f45 = InvalidAttestationSubject.
      expect(
        errStr.includes("InvalidAttestationSubject") ||
          errStr.includes("0x1f45") ||
          errStr.includes("8005"),
      ).to.equal(
        true,
        `Expected InvalidAttestationSubject error, got: ${errStr}`,
      );
    }
    expect(errored).to.equal(
      true,
      "unwrap with foreign attestation should have rejected",
    );
  });
});

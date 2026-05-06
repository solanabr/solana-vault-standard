/**
 * derwa-wrapper SDK
 *
 * TypeScript client for the derwa-wrapper program — wraps permissioned cPOOL
 * tokens into freely-transferable dePOOL tokens at 1:1 (and vice versa,
 * gated by an attestation on unwrap).
 *
 * Mirrors the public API of `programs/derwa-wrapper/src/lib.rs`:
 *   - initialize(pool, permissionedMint, derwaMint)
 *   - wrap(amount)
 *   - unwrap(amount)
 *
 * @example
 * ```ts
 * import { DeRwaWrapper } from "@stbr/solana-vault";
 *
 * // One-shot per pool — binds (cPOOL, dePOOL) to the pool key
 * const { wrapperConfig } = await DeRwaWrapper.initialize(program, payer, {
 *   pool,
 *   permissionedMint,
 *   derwaMint,
 * });
 *
 * // cPOOL -> dePOOL
 * await DeRwaWrapper.wrap(program, investor, { user: investor, amount: new BN(1_000_000) });
 *
 * // dePOOL -> cPOOL (requires valid attestation on the destination wallet)
 * await DeRwaWrapper.unwrap(program, investor, {
 *   user: investor,
 *   amount: new BN(1_000_000),
 *   attestation,
 * });
 * ```
 */

import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Signer,
  type AccountMeta,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  getWrapperConfigAddress,
  getWrapperSignerAddress,
} from "./derwa-wrapper-pda";

// ============================================================
// State Interfaces — match `WrapperConfig` in state.rs
// ============================================================

/**
 * On-chain `WrapperConfig` account state (decoded by Anchor).
 *
 * Layout (from `programs/derwa-wrapper/src/state.rs`):
 *   discriminator (8) | pool (32) | permissionedMint (32) | derwaMint (32)
 *   | lockedSupply (u64) | bump (u8) | attestationProgram (32)
 *   | attestationIssuer (32) | requiredAttestationType (u8) = 178 bytes.
 *
 * Trust-anchor fields (`attestationProgram`, `attestationIssuer`,
 * `requiredAttestationType`) are set at `initialize` time and drive the
 * full identity-binding validation in `unwrap` (owner / subject /
 * issuer / type / canonical PDA).
 */
export interface WrapperConfigState {
  /** Pool this wrapper is bound to (the SVS-11 CreditVault PDA). */
  pool: PublicKey;
  /** Token-2022 cPOOL mint (Permissioned ComplianceHook mode). */
  permissionedMint: PublicKey;
  /** Token-2022 dePOOL mint (FreelyTransferable ComplianceHook mode). */
  derwaMint: PublicKey;
  /**
   * Total cPOOL currently locked in the wrapper PDA. Increments on wrap,
   * decrements on unwrap. Must equal `dePOOL.supply` at all times.
   */
  lockedSupply: BN;
  /** PDA bump for `WrapperConfig`. */
  bump: number;
  /** Program owning acceptable attestation accounts (e.g. mock-sas / SAS). */
  attestationProgram: PublicKey;
  /** Expected `issuer` field on attestation payloads — the per-pool attester. */
  attestationIssuer: PublicKey;
  /** Required `attestation_type` byte (KYC tier required for unwrap). */
  requiredAttestationType: number;
}

// ============================================================
// Instruction Parameter Interfaces
// ============================================================

/**
 * Params for `DeRwaWrapper.initialize`. Binds a pool to a (cPOOL, dePOOL) pair
 * AND captures the per-pool trust anchors used by `unwrap` to validate
 * destination wallet attestations.
 *
 * Pre-conditions (NOT enforced by the program but required at the binding sites):
 *   1. cPOOL mint exists with ComplianceHook in Permissioned mode.
 *   2. dePOOL mint exists with ComplianceHook in FreelyTransferable mode.
 *   3. dePOOL mint authority is the `wrapper_signer` PDA (set by deployment script).
 *
 * Trust-anchor invariants (enforced by the on-chain handler):
 *   - `attestationProgram` MUST NOT equal `PublicKey.default` (rejected
 *     with `InvalidAttestationConfig`).
 *   - `attestationIssuer` MUST NOT equal `PublicKey.default` (same).
 *   - These fields are immutable after init.
 */
export interface InitializeWrapperParams {
  pool: PublicKey;
  permissionedMint: PublicKey;
  derwaMint: PublicKey;
  /**
   * Program that owns acceptable attestation accounts (mock-sas in tests,
   * real SAS / Civic Pass in prod).
   */
  attestationProgram: PublicKey;
  /**
   * Expected `issuer` field on attestation payloads. Pins the trust anchor
   * to a specific compliance attester (e.g. a Brazilian KYB provider for
   * a Cayman-LLC-wrapped FIDC pool).
   */
  attestationIssuer: PublicKey;
  /**
   * Required `attestation_type` byte (e.g. 0 = generic KYC,
   * 2 = accredited investor). Defaults to 0 if omitted.
   */
  requiredAttestationType?: number;
}

/**
 * Params for `DeRwaWrapper.wrap` (cPOOL -> dePOOL at 1:1).
 *
 * `amount` must be > 0 (enforced on-chain via `DeRwaError::ZeroAmount`).
 *
 * Optional ATA overrides default to the standard ATA derivation. Pass them
 * explicitly when using non-canonical accounts (e.g. tests with bespoke ATAs).
 */
export interface WrapParams {
  /** Investor wallet — must be the signer of the wrap tx. */
  user: PublicKey;
  /** Amount of cPOOL to wrap (in base units). Must be > 0. */
  amount: BN;
  /** Optional override for the investor's cPOOL ATA. Defaults to the canonical ATA. */
  investorPermissionedAta?: PublicKey;
  /** Optional override for the wrapper PDA's locked cPOOL ATA. Defaults to ATA(wrapperSigner, cPOOL). */
  wrapperLockedAta?: PublicKey;
  /** Optional override for the investor's dePOOL ATA. Defaults to the canonical ATA. */
  investorDerwaAta?: PublicKey;
  /**
   * Token-2022 TransferHook extra accounts resolved from the cPOOL mint's EAML.
   * Required when the permissioned cPOOL mint has an active hook and this
   * instruction is invoked via CPI.
   */
  remainingAccounts?: AccountMeta[];
}

/**
 * Params for `DeRwaWrapper.unwrap` (dePOOL -> cPOOL at 1:1, attestation-gated).
 *
 * The `attestation` PDA is REQUIRED — it's gated on the user's wallet via the
 * issuer/SAS-program ownership model. Without a valid (non-revoked, non-expired)
 * attestation, the on-chain handler aborts with `DeRwaError::AttestationRequired`.
 */
export interface UnwrapParams {
  /** Investor wallet — must be the signer of the unwrap tx. */
  user: PublicKey;
  /** Amount of dePOOL to unwrap (in base units). Must be > 0 and <= lockedSupply. */
  amount: BN;
  /** Investor's attestation PDA from the SAS program (`mock_sas` on devnet). */
  attestation: PublicKey;
  /** Optional override for the wrapper PDA's locked cPOOL ATA. */
  wrapperLockedAta?: PublicKey;
  /** Optional override for the investor's cPOOL ATA. */
  investorPermissionedAta?: PublicKey;
  /** Optional override for the investor's dePOOL ATA. */
  investorDerwaAta?: PublicKey;
  /**
   * Token-2022 TransferHook extra accounts resolved from the cPOOL mint's EAML.
   * Required when the permissioned cPOOL mint has an active hook and this
   * instruction is invoked via CPI.
   */
  remainingAccounts?: AccountMeta[];
}

// ============================================================
// Static Client
// ============================================================

/**
 * Static client for the derwa-wrapper program. The program has only three ixs
 * and no per-instance state worth caching beyond what the caller already has,
 * so a class with statics is the right shape (mirroring the lightweight
 * surface of e.g. `cap.ts`).
 */
export class DeRwaWrapper {
  /**
   * Initialize a new WrapperConfig — binds `pool` to the `(permissionedMint, derwaMint)` pair.
   * One-shot per pool: Anchor's `init` constraint forbids re-init.
   *
   * Returns the resolved `wrapperConfig` PDA and the on-chain tx signature.
   */
  static async initialize(
    program: Program,
    payer: PublicKey | Signer,
    params: InitializeWrapperParams,
  ): Promise<{ wrapperConfig: PublicKey; signature: string }> {
    const payerKey =
      payer instanceof PublicKey ? payer : (payer as Signer).publicKey;

    const [wrapperConfig] = getWrapperConfigAddress(
      params.pool,
      params.derwaMint,
      program.programId,
    );

    type InitArgs = {
      attestationProgram: PublicKey;
      attestationIssuer: PublicKey;
      requiredAttestationType: number;
    };
    const methodsNs = program.methods as unknown as {
      initialize: (args: InitArgs) => {
        accountsPartial: (a: Record<string, PublicKey>) => {
          rpc: () => Promise<string>;
        };
      };
    };

    const signature = await methodsNs
      .initialize({
        attestationProgram: params.attestationProgram,
        attestationIssuer: params.attestationIssuer,
        requiredAttestationType: params.requiredAttestationType ?? 0,
      })
      .accountsPartial({
        pool: params.pool,
        wrapperConfig,
        permissionedMint: params.permissionedMint,
        derwaMint: params.derwaMint,
        payer: payerKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { wrapperConfig, signature };
  }

  /**
   * Wrap `amount` cPOOL into `amount` dePOOL (1:1).
   *
   * The investor's wallet must be the tx signer (provided by `program.provider`).
   * `user` is the investor pubkey — exposed as a parameter for clarity even though
   * it must equal `provider.wallet.publicKey` for the tx to land.
   */
  static async wrap(
    program: Program,
    user: PublicKey,
    params: WrapParams,
  ): Promise<string> {
    const provider = program.provider as AnchorProvider;
    const wrapperConfigPda = await this._loadConfigForUser(program, user);
    const cfg = wrapperConfigPda.state;

    const [wrapperSigner] = getWrapperSignerAddress(
      cfg.pool,
      program.programId,
    );

    const investorPermissionedAta =
      params.investorPermissionedAta ??
      getAssociatedTokenAddressSync(
        cfg.permissionedMint,
        params.user,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const wrapperLockedAta =
      params.wrapperLockedAta ??
      getAssociatedTokenAddressSync(
        cfg.permissionedMint,
        wrapperSigner,
        true, // PDA owner — off-curve
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const investorDerwaAta =
      params.investorDerwaAta ??
      getAssociatedTokenAddressSync(
        cfg.derwaMint,
        params.user,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const methodsNs = program.methods as unknown as {
      wrap: (amount: BN) => {
        accountsPartial: (a: Record<string, PublicKey>) => {
          remainingAccounts: (a: AccountMeta[]) => {
            rpc: () => Promise<string>;
          };
          rpc: () => Promise<string>;
        };
      };
    };

    const builder = methodsNs
      .wrap(params.amount)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda.pda,
        wrapperSigner,
        permissionedMint: cfg.permissionedMint,
        derwaMint: cfg.derwaMint,
        investorPermissionedAta,
        wrapperLockedAta,
        investorDerwaAta,
        investor: params.user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });

    return (params.remainingAccounts?.length
      ? builder.remainingAccounts(params.remainingAccounts)
      : builder)
      .rpc()
      .then((sig) => {
        // Touch provider so unused-var lint doesn't fire on this branch.
        void provider;
        return sig;
      });
  }

  /**
   * Unwrap `amount` dePOOL into `amount` cPOOL (1:1) — attestation-gated.
   *
   * The investor must hold a valid (non-revoked, non-expired) attestation PDA
   * issued by the SAS program. On-chain enforcement is in `unwrap.rs` via
   * explicit offset reads — see `DeRwaError::AttestationRequired`.
   */
  static async unwrap(
    program: Program,
    user: PublicKey,
    params: UnwrapParams,
  ): Promise<string> {
    const wrapperConfigPda = await this._loadConfigForUser(program, user);
    const cfg = wrapperConfigPda.state;

    const [wrapperSigner] = getWrapperSignerAddress(
      cfg.pool,
      program.programId,
    );

    const wrapperLockedAta =
      params.wrapperLockedAta ??
      getAssociatedTokenAddressSync(
        cfg.permissionedMint,
        wrapperSigner,
        true,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const investorPermissionedAta =
      params.investorPermissionedAta ??
      getAssociatedTokenAddressSync(
        cfg.permissionedMint,
        params.user,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const investorDerwaAta =
      params.investorDerwaAta ??
      getAssociatedTokenAddressSync(
        cfg.derwaMint,
        params.user,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const methodsNs = program.methods as unknown as {
      unwrap: (amount: BN) => {
        accountsPartial: (a: Record<string, PublicKey>) => {
          remainingAccounts: (a: AccountMeta[]) => {
            rpc: () => Promise<string>;
          };
          rpc: () => Promise<string>;
        };
      };
    };

    const builder = methodsNs
      .unwrap(params.amount)
      .accountsPartial({
        wrapperConfig: wrapperConfigPda.pda,
        wrapperSigner,
        permissionedMint: cfg.permissionedMint,
        derwaMint: cfg.derwaMint,
        wrapperLockedAta,
        investorPermissionedAta,
        investorDerwaAta,
        investorAttestation: params.attestation,
        investor: params.user,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });

    return (params.remainingAccounts?.length
      ? builder.remainingAccounts(params.remainingAccounts)
      : builder
    ).rpc();
  }

  /**
   * Fetch and decode the on-chain `WrapperConfig` account.
   *
   * @param program - Anchor `Program` instance constructed with the derwa-wrapper IDL.
   * @param wrapperConfigPda - The `wrapper_config` PDA address.
   */
  static async fetchWrapperConfig(
    program: Program,
    wrapperConfigPda: PublicKey,
  ): Promise<WrapperConfigState> {
    const accountNs = program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["wrapperConfig"].fetch(
      wrapperConfigPda,
    )) as WrapperConfigState;
  }

  /**
   * Internal: derive a user's relevant WrapperConfig and fetch its state. The
   * `user` arg is currently unused because the SDK supports a single config
   * per pool; preserved as a parameter for forward-compatibility once we add a
   * pool-discovery helper. Callers who already know the config can call
   * `fetchWrapperConfig` directly.
   */
  private static async _loadConfigForUser(
    program: Program,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _user: PublicKey,
  ): Promise<{ pda: PublicKey; state: WrapperConfigState }> {
    const accountNs = program.account as Record<
      string,
      { all: () => Promise<{ publicKey: PublicKey; account: unknown }[]> }
    >;
    const all = await accountNs["wrapperConfig"].all();
    if (all.length === 0) {
      throw new Error(
        "No WrapperConfig accounts found. Call DeRwaWrapper.initialize first.",
      );
    }
    if (all.length > 1) {
      throw new Error(
        `Multiple (${all.length}) WrapperConfig accounts found; pass an explicit wrapperConfig PDA via the per-instruction params instead.`,
      );
    }
    return {
      pda: all[0].publicKey,
      state: all[0].account as WrapperConfigState,
    };
  }
}

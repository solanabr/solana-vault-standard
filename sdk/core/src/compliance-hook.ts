/**
 * SDK wrapper for the `compliance-hook` Anchor program.
 *
 * Mirrors the established SVS SDK pattern: instruction methods + state
 * fetchers + PDA derivation are co-located on a `ComplianceHook` class so
 * callers can reach the program without hand-assembling accounts.
 *
 * The class exposes the five public instructions:
 *   - `initializeSanctionsList`        (singleton, once per deployment)
 *   - `initializeMintConfig`           (per-mint, sets compliance posture)
 *   - `initializeExtraAccountMetaList` (per-mint, Token-2022 hook PDA)
 *   - `updateSanctionsList`            (authority-gated, add/remove addrs)
 *   - `freezeAccount` / `unfreezeAccount`
 *                                      (authority-gated global freeze PDA)
 *   - `execute`                        (CPI'd by Token-2022 — not exposed
 *                                       here as a regular instance method;
 *                                       integrators do not call it directly)
 *
 * `execute` is intentionally NOT exposed as an SDK helper: it is invoked by
 * the Token-2022 TransferHook runtime during transfers, not by user code.
 */
import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Keypair,
} from "@solana/web3.js";

import {
  COMPLIANCE_HOOK_PROGRAM_ID,
  getMintConfigAddress,
  getSanctionsListAddress,
  getExtraAccountMetaListAddress,
  getComplianceFrozenAccountAddress,
} from "./compliance-hook-pda";

// =============================================================================
// State interfaces (mirror Anchor IDL types in camelCase)
// =============================================================================

/**
 * Compliance posture the mint operates under.
 *
 * The Anchor IDL uses camelCase variant tags here, matching the
 * conventional `{ variantName: {} }` object form Anchor produces in TS.
 * Either branch is recognized by `program.methods.initializeMintConfig`.
 */
export type ComplianceMode =
  | { freelyTransferable: Record<string, never> }
  | { permissioned: Record<string, never> };

/** Convenience constructors for {@link ComplianceMode}. */
export const ComplianceMode = {
  freelyTransferable: (): ComplianceMode => ({ freelyTransferable: {} }),
  permissioned: (): ComplianceMode => ({ permissioned: {} }),
} as const;

/**
 * On-chain `MintConfig` account. Bound to a Token-2022 mint that uses the
 * compliance hook.
 *
 * Trust-anchor fields (`attestationProgram`, `attestationIssuer`,
 * `requiredAttestationType`) drive `execute::check_attestation` for
 * Permissioned-mode mints — the on-chain handler enforces full identity
 * binding (owner / subject / issuer / type / canonical PDA) against
 * these. For `freelyTransferable`, they are stored but unused.
 */
export interface MintConfigState {
  mint: PublicKey;
  mode: ComplianceMode;
  /** Optional pool-policy PDA (Permissioned mode); `null` in FreelyTransferable. */
  poolPolicy: PublicKey | null;
  /** Program owning acceptable attestation accounts (e.g. mock-sas / SAS). */
  attestationProgram: PublicKey;
  /** Expected `issuer` field on attestation payloads. */
  attestationIssuer: PublicKey;
  /** Required `attestation_type` byte (e.g. 0 = generic KYC, 2 = accredited). */
  requiredAttestationType: number;
}

/**
 * On-chain `SanctionsList` account. Singleton across the program deployment.
 */
export interface SanctionsListState {
  authority: PublicKey;
  version: BN;
  updatedAt: BN;
  addresses: PublicKey[];
}

/** On-chain `FrozenAccount` marker. Existence at `[b"frozen", owner]` freezes an owner. */
export interface ComplianceFrozenAccountState {
  bump: number;
}

// =============================================================================
// Instruction parameter types
// =============================================================================

/** Args for {@link ComplianceHook.initializeSanctionsList}. */
export interface InitializeSanctionsListParams {
  /** Address that gates all future updates (typically a governance or multisig authority). */
  authority: PublicKey;
}

/** Args for {@link ComplianceHook.initializeMintConfig}. */
export interface InitializeMintConfigParams {
  mint: PublicKey;
  mode: ComplianceMode;
  /** Required (`Some`) for `permissioned`; must be omitted for `freelyTransferable`. */
  poolPolicy?: PublicKey | null;
  /**
   * Program owning acceptable attestation accounts. REQUIRED (non-default)
   * for `permissioned`. For `freelyTransferable`, defaults to
   * `PublicKey.default` if omitted.
   */
  attestationProgram?: PublicKey;
  /**
   * Expected `issuer` field on attestation payloads. REQUIRED (non-default)
   * for `permissioned`. Defaults to `PublicKey.default` for
   * `freelyTransferable`.
   */
  attestationIssuer?: PublicKey;
  /**
   * Required `attestation_type` byte (e.g. 0 = generic KYC,
   * 2 = accredited investor). Defaults to 0.
   */
  requiredAttestationType?: number;
  /**
   * Mint-authority signer that authorizes the binding. Must match
   * `mint.mint_authority` on-chain or the ix returns `UnauthorizedAuthority`.
   */
  mintAuthority: Keypair;
}

/** Args for {@link ComplianceHook.initializeExtraAccountMetaList}. */
export interface InitializeExtraAccountMetaListParams {
  mint: PublicKey;
  /** Same role as in {@link InitializeMintConfigParams}; signer-only here. */
  mintAuthority: Keypair;
}

/** Args for {@link ComplianceHook.updateSanctionsList}. */
export interface UpdateSanctionsListParams {
  /** Sanctions-list authority signer (must match on-chain `authority`). */
  authority: Keypair;
  /** Addresses to add (skipped if already present). */
  additions?: PublicKey[];
  /** Addresses to remove (no-op if not present). */
  removals?: PublicKey[];
}

/** Args for {@link ComplianceHook.freezeAccount}. */
export interface FreezeAccountParams {
  /** Sanctions-list authority signer. */
  authority: Keypair;
  /** Source/destination owner to freeze globally across hook-bound mints. */
  owner: PublicKey;
}

/** Args for {@link ComplianceHook.unfreezeAccount}. */
export interface UnfreezeAccountParams {
  /** Sanctions-list authority signer. */
  authority: Keypair;
  /** Owner whose `[b"frozen", owner]` PDA will be closed. */
  owner: PublicKey;
  /** Receives rent from the closed freeze PDA; defaults to `authority.publicKey`. */
  rentRecipient?: PublicKey;
}

// =============================================================================
// Class
// =============================================================================

/**
 * Wrapper around an Anchor `Program<ComplianceHook>` that derives PDAs and
 * exposes the program's public instructions.
 *
 * Use {@link ComplianceHook.create} to invoke `initializeSanctionsList` and
 * obtain a handle, or {@link ComplianceHook.load} to attach to an already-
 * initialized deployment.
 *
 * Per-mint instructions ({@link ComplianceHook.initializeMintConfig},
 * {@link ComplianceHook.initializeExtraAccountMetaList}) are exposed as
 * static helpers so callers can run them without round-tripping through the
 * sanctions-list singleton.
 */
export class ComplianceHook {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly sanctionsListPda: PublicKey;
  readonly programId: PublicKey;

  private _state: SanctionsListState | null = null;

  protected constructor(
    program: Program,
    provider: AnchorProvider,
    sanctionsListPda: PublicKey,
  ) {
    this.program = program;
    this.provider = provider;
    this.sanctionsListPda = sanctionsListPda;
    this.programId = program.programId;
  }

  // ---------------------------------------------------------------------------
  // Constructors
  // ---------------------------------------------------------------------------

  /**
   * Initialize the singleton `SanctionsList` PDA and return a wrapper.
   *
   * Idempotent caveat: this calls `initialize_sanctions_list`, which fails
   * with "account already in use" if the PDA already exists. Use
   * {@link ComplianceHook.load} to attach to an existing deployment.
   */
  static async create(
    program: Program,
    params: InitializeSanctionsListParams,
  ): Promise<ComplianceHook> {
    const provider = program.provider as AnchorProvider;
    const [sanctionsList] = getSanctionsListAddress(program.programId);

    await program.methods
      .initializeSanctionsList()
      .accountsStrict({
        sanctionsList,
        authority: params.authority,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return ComplianceHook.load(program);
  }

  /**
   * Attach to an existing compliance-hook deployment by reading the
   * singleton `SanctionsList` account.
   */
  static async load(program: Program): Promise<ComplianceHook> {
    const provider = program.provider as AnchorProvider;
    const [sanctionsList] = getSanctionsListAddress(program.programId);

    const instance = new ComplianceHook(program, provider, sanctionsList);
    await instance.refresh();
    return instance;
  }

  // ---------------------------------------------------------------------------
  // State accessors
  // ---------------------------------------------------------------------------

  async refresh(): Promise<SanctionsListState> {
    const accountNs = this.program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    this._state = (await accountNs["sanctionsList"].fetch(
      this.sanctionsListPda,
    )) as SanctionsListState;
    return this._state;
  }

  async getState(): Promise<SanctionsListState> {
    if (!this._state) {
      await this.refresh();
    }
    return this._state!;
  }

  // ---------------------------------------------------------------------------
  // Per-mint instructions (exposed both as static & instance methods so the
  // class is usable both as a singleton handle and as a stateless namespace)
  // ---------------------------------------------------------------------------

  /**
   * Bind a Token-2022 mint to a compliance posture.
   *
   * Constraint: `poolPolicy` MUST be set when `mode` is `permissioned` and
   * MUST be unset / `null` when `mode` is `freelyTransferable`. The on-chain
   * handler enforces this and rejects with
   * `MissingPoolPolicyForPermissioned` / `PoolPolicySetOnFreelyTransferable`.
   */
  static async initializeMintConfig(
    program: Program,
    params: InitializeMintConfigParams,
  ): Promise<{ mintConfig: PublicKey; signature: string }> {
    const provider = program.provider as AnchorProvider;
    const [mintConfig] = getMintConfigAddress(params.mint, program.programId);

    const signature = await program.methods
      .initializeMintConfig({
        mode: params.mode,
        poolPolicy: params.poolPolicy ?? null,
        attestationProgram: params.attestationProgram ?? PublicKey.default,
        attestationIssuer: params.attestationIssuer ?? PublicKey.default,
        requiredAttestationType: params.requiredAttestationType ?? 0,
      })
      .accountsStrict({
        mintConfig,
        mint: params.mint,
        mintAuthority: params.mintAuthority.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.mintAuthority])
      .rpc();

    return { mintConfig, signature };
  }

  async initializeMintConfig(
    params: InitializeMintConfigParams,
  ): Promise<{ mintConfig: PublicKey; signature: string }> {
    return ComplianceHook.initializeMintConfig(this.program, params);
  }

  /**
   * Initialize the per-mint `ExtraAccountMetaList` PDA. Must be called AFTER
   * {@link ComplianceHook.initializeMintConfig} for the same mint — the
   * on-chain handler reads the typed `MintConfig` account to size and
   * populate the EAML entries.
   */
  static async initializeExtraAccountMetaList(
    program: Program,
    params: InitializeExtraAccountMetaListParams,
  ): Promise<{ extraAccountMetaList: PublicKey; signature: string }> {
    const provider = program.provider as AnchorProvider;
    const [extraAccountMetaList] = getExtraAccountMetaListAddress(
      params.mint,
      program.programId,
    );
    const [mintConfig] = getMintConfigAddress(params.mint, program.programId);

    const signature = await program.methods
      .initializeExtraAccountMetaList()
      .accountsStrict({
        extraAccountMetaList,
        mint: params.mint,
        mintConfig,
        mintAuthority: params.mintAuthority.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.mintAuthority])
      .rpc();

    return { extraAccountMetaList, signature };
  }

  async initializeExtraAccountMetaList(
    params: InitializeExtraAccountMetaListParams,
  ): Promise<{ extraAccountMetaList: PublicKey; signature: string }> {
    return ComplianceHook.initializeExtraAccountMetaList(this.program, params);
  }

  // ---------------------------------------------------------------------------
  // Sanctions-list mutation
  // ---------------------------------------------------------------------------

  /**
   * Apply an additions/removals delta to the sanctions list. Removals are
   * applied first; additions skip already-present entries. Bumps the
   * on-chain `version` counter and emits `SanctionsListUpdated`.
   */
  async updateSanctionsList(
    params: UpdateSanctionsListParams,
  ): Promise<string> {
    const additions = params.additions ?? [];
    const removals = params.removals ?? [];

    const signature = await this.program.methods
      .updateSanctionsList(additions, removals)
      .accountsStrict({
        sanctionsList: this.sanctionsListPda,
        authority: params.authority.publicKey,
      })
      .signers([params.authority])
      .rpc();

    return signature;
  }

  /**
   * Freeze an owner globally across all hook-bound mints. Creates
   * `[b"frozen", owner]`; transfers where the owner is source or destination
   * will fail with `AccountFrozen`.
   */
  async freezeAccount(params: FreezeAccountParams): Promise<string> {
    const provider = this.program.provider as AnchorProvider;
    const [frozenAccount] = getComplianceFrozenAccountAddress(
      params.owner,
      this.programId,
    );

    return this.program.methods
      .freezeAccount()
      .accountsStrict({
        sanctionsList: this.sanctionsListPda,
        authority: params.authority.publicKey,
        ownerToFreeze: params.owner,
        frozenAccount,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.authority])
      .rpc();
  }

  /**
   * Unfreeze an owner by closing `[b"frozen", owner]`.
   */
  async unfreezeAccount(params: UnfreezeAccountParams): Promise<string> {
    const [frozenAccount] = getComplianceFrozenAccountAddress(
      params.owner,
      this.programId,
    );

    return this.program.methods
      .unfreezeAccount()
      .accountsStrict({
        sanctionsList: this.sanctionsListPda,
        authority: params.authority.publicKey,
        ownerToUnfreeze: params.owner,
        frozenAccount,
        rentRecipient: params.rentRecipient ?? params.authority.publicKey,
      })
      .signers([params.authority])
      .rpc();
  }

  // ---------------------------------------------------------------------------
  // Account fetchers
  // ---------------------------------------------------------------------------

  /** Fetch and decode a `SanctionsList` account. */
  static async fetchSanctionsList(
    program: Program,
    sanctionsListPda?: PublicKey,
  ): Promise<SanctionsListState> {
    const pda =
      sanctionsListPda ?? getSanctionsListAddress(program.programId)[0];
    const accountNs = program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["sanctionsList"].fetch(pda)) as SanctionsListState;
  }

  /** Fetch and decode a `MintConfig` account. */
  static async fetchMintConfig(
    program: Program,
    mintConfigPda: PublicKey,
  ): Promise<MintConfigState> {
    const accountNs = program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["mintConfig"].fetch(
      mintConfigPda,
    )) as MintConfigState;
  }

  /** Fetch and decode a `FrozenAccount` marker PDA. */
  static async fetchFrozenAccount(
    program: Program,
    owner: PublicKey,
  ): Promise<ComplianceFrozenAccountState> {
    const [frozenAccount] = getComplianceFrozenAccountAddress(
      owner,
      program.programId,
    );
    const accountNs = program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["frozenAccount"].fetch(
      frozenAccount,
    )) as ComplianceFrozenAccountState;
  }

  // ---------------------------------------------------------------------------
  // PDA pass-throughs (so callers don't need to import compliance-hook-pda
  // separately when they already hold a class instance)
  // ---------------------------------------------------------------------------

  getMintConfigAddress(mint: PublicKey): PublicKey {
    return getMintConfigAddress(mint, this.programId)[0];
  }

  getExtraAccountMetaListAddress(mint: PublicKey): PublicKey {
    return getExtraAccountMetaListAddress(mint, this.programId)[0];
  }

  getSanctionsListAddress(): PublicKey {
    return this.sanctionsListPda;
  }

  getFrozenAccountAddress(owner: PublicKey): PublicKey {
    return getComplianceFrozenAccountAddress(owner, this.programId)[0];
  }
}

/** Default export for the program ID, mirroring the `compliance-hook-pda` re-export. */
export { COMPLIANCE_HOOK_PROGRAM_ID };

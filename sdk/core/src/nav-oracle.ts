import { BN, Program, AnchorProvider } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  Keypair,
  Signer,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as nacl from "tweetnacl";

import {
  NAV_ORACLE_PROGRAM_ID,
  getNavAccountAddress,
} from "./nav-oracle-pda";

/**
 * On-chain `NavAccount` state. Mirrors the Rust struct in
 * `programs/nav-oracle/src/state.rs`. Field order/types match the IDL emitted
 * by Anchor (`target/types/nav_oracle.ts`) — snake_case → camelCase.
 *
 * Note: the Rust struct has a `_padding: [u8; 7]` field. Anchor exposes it
 * to clients under the camelCase name `padding`. It carries no semantic
 * meaning and is set to zero by the program.
 */
export interface NavAccountState {
  pool: PublicKey;
  navNet: BN;
  navGross: BN;
  terBps: number;
  lossProvisionBps: number;
  navType: number;
  padding: number[];
  timestamp: BN;
  sequence: BN;
  publisher: PublicKey;
  signature: number[];
  loanTapeMerkleRoot: number[];
  keyRotationAuthority: PublicKey;
}

/**
 * Args passed to the `update` instruction. Matches the Rust `UpdateArgs`
 * struct in `programs/nav-oracle/src/instructions/update.rs` (camelCased).
 *
 * `loanTapeMerkleRoot` is a 32-byte array; `signature` is a 64-byte array.
 * Both are over the canonical 133-byte signing payload — see
 * {@link buildSigningPayload}.
 */
export interface UpdateNavParams {
  navNet: BN;
  navGross: BN;
  terBps: number;
  lossBps: number;
  navType: number;
  timestamp: BN;
  sequence: BN;
  loanTapeMerkleRoot: Uint8Array | number[];
  signature: Uint8Array | number[];
}

export interface InitializeNavAccountParams {
  pool: PublicKey;
  publisher: PublicKey;
  keyRotationAuthority: PublicKey;
  /**
   * Must equal `CreditVault.authority` of the pool (bytes 8..40 of the
   * pool account data). Nav-oracle's `initialize` verifies the signer
   * to gate per-pool init against squat-race attacks.
   */
  poolAuthority: PublicKey;
}

/**
 * Inputs to {@link buildSigningPayload}. All integers are encoded
 * little-endian, matching the Rust `to_le_bytes()` calls in
 * `NavAccount::signing_payload`.
 */
export interface SigningPayloadFields {
  pool: PublicKey;
  /** u64 */
  navNet: bigint | BN;
  /** u64 */
  navGross: bigint | BN;
  /** u16 */
  terBps: number;
  /** u16 */
  lossBps: number;
  /** u8 */
  navType: number;
  /** i64 (signed, two's-complement little-endian) */
  timestamp: bigint | BN;
  /** u64 */
  sequence: bigint | BN;
  publisher: PublicKey;
  /** 32 bytes */
  loanTapeMerkleRoot: Uint8Array | Buffer | number[];
}

/** Canonical signing-payload byte length, matches the Rust comment. */
export const NAV_SIGNING_PAYLOAD_LEN = 133;

const POOL_OFFSET = 0;
const NAV_NET_OFFSET = 32;
const NAV_GROSS_OFFSET = 40;
const TER_BPS_OFFSET = 48;
const LOSS_BPS_OFFSET = 50;
const NAV_TYPE_OFFSET = 52;
const TIMESTAMP_OFFSET = 53;
const SEQUENCE_OFFSET = 61;
const PUBLISHER_OFFSET = 69;
const MERKLE_ROOT_OFFSET = 101;

/**
 * Field byte offsets inside the canonical 133-byte signing payload. Exposed
 * primarily for tests / tooling that need to peek at specific fields.
 */
export const NAV_SIGNING_PAYLOAD_OFFSETS = Object.freeze({
  pool: POOL_OFFSET,
  navNet: NAV_NET_OFFSET,
  navGross: NAV_GROSS_OFFSET,
  terBps: TER_BPS_OFFSET,
  lossBps: LOSS_BPS_OFFSET,
  navType: NAV_TYPE_OFFSET,
  timestamp: TIMESTAMP_OFFSET,
  sequence: SEQUENCE_OFFSET,
  publisher: PUBLISHER_OFFSET,
  merkleRoot: MERKLE_ROOT_OFFSET,
});

function toBigIntU64(v: bigint | BN): bigint {
  if (typeof v === "bigint") return v;
  return BigInt(v.toString());
}

function toBigIntI64(v: bigint | BN): bigint {
  if (typeof v === "bigint") return v;
  // BN preserves sign through .toString(), so this round-trip is safe for i64.
  return BigInt(v.toString());
}

function toMerkleRootBuffer(
  v: Uint8Array | Buffer | number[],
): Buffer {
  const buf = Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array | number[]);
  if (buf.length !== 32) {
    throw new Error(
      `loanTapeMerkleRoot must be 32 bytes, received ${buf.length}`,
    );
  }
  return buf;
}

/**
 * Build the canonical 133-byte signing payload that the publisher signs with
 * Ed25519. This is the *exact* byte sequence the on-chain
 * `NavAccount::signing_payload()` computes — must stay in lockstep with
 * `programs/nav-oracle/src/state.rs`.
 *
 * Layout (all little-endian for multi-byte fields):
 *   ` 0..32 ` pool (Pubkey)
 *   `32..40 ` nav_net (u64)
 *   `40..48 ` nav_gross (u64)
 *   `48..50 ` ter_bps (u16)
 *   `50..52 ` loss_provision_bps (u16)
 *   `52..53 ` nav_type (u8)
 *   `53..61 ` timestamp (i64)
 *   `61..69 ` sequence (u64)
 *   `69..101` publisher (Pubkey)
 *   `101..133` loan_tape_merkle_root (32 bytes)
 *
 * Padding bytes are intentionally excluded — matches the Rust comment.
 */
export function buildSigningPayload(fields: SigningPayloadFields): Buffer {
  const buf = Buffer.alloc(NAV_SIGNING_PAYLOAD_LEN);

  fields.pool.toBuffer().copy(buf, POOL_OFFSET);
  buf.writeBigUInt64LE(toBigIntU64(fields.navNet), NAV_NET_OFFSET);
  buf.writeBigUInt64LE(toBigIntU64(fields.navGross), NAV_GROSS_OFFSET);
  buf.writeUInt16LE(fields.terBps, TER_BPS_OFFSET);
  buf.writeUInt16LE(fields.lossBps, LOSS_BPS_OFFSET);
  buf.writeUInt8(fields.navType, NAV_TYPE_OFFSET);
  buf.writeBigInt64LE(toBigIntI64(fields.timestamp), TIMESTAMP_OFFSET);
  buf.writeBigUInt64LE(toBigIntU64(fields.sequence), SEQUENCE_OFFSET);
  fields.publisher.toBuffer().copy(buf, PUBLISHER_OFFSET);
  toMerkleRootBuffer(fields.loanTapeMerkleRoot).copy(buf, MERKLE_ROOT_OFFSET);

  return buf;
}

/**
 * Thin client wrapper around the deployed `nav-oracle` program. Mirrors the
 * structure of the other SVS SDK classes — static methods that compose
 * Anchor instructions, plus a state-fetching helper.
 *
 * Most callers only need the static methods; an instance is rarely useful
 * because `NavAccount` carries no client-side ATAs or side-tables.
 */
export class NavOracle {
  /** Re-exported for convenience so callers can avoid a second import. */
  static readonly PROGRAM_ID = NAV_ORACLE_PROGRAM_ID;

  /**
   * Initialize the per-pool NavAccount PDA. Returns the derived PDA address
   * along with the transaction signature.
   */
  static async initialize(
    program: Program,
    payer: PublicKey,
    params: InitializeNavAccountParams,
  ): Promise<{ navAccount: PublicKey; signature: string }> {
    const [navAccount] = getNavAccountAddress(params.pool, program.programId);

    const signature = await program.methods
      .initialize()
      .accountsPartial({
        pool: params.pool,
        navAccount,
        poolAuthority: params.poolAuthority,
        publisher: params.publisher,
        keyRotationAuthority: params.keyRotationAuthority,
        payer,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { navAccount, signature };
  }

  /**
   * Build the `update` instruction WITHOUT the prepended Ed25519 verify ix.
   * Use this if you need to compose into a custom transaction (e.g. with
   * ComputeBudget priority fee instructions). For the simple end-to-end
   * path, prefer {@link update}.
   */
  static async buildUpdateInstruction(
    program: Program,
    params: { pool: PublicKey; args: UpdateNavParams },
  ): Promise<TransactionInstruction> {
    const [navAccount] = getNavAccountAddress(
      params.pool,
      program.programId,
    );

    const signatureBytes = Array.from(
      params.args.signature instanceof Uint8Array
        ? params.args.signature
        : Buffer.from(params.args.signature),
    );
    const merkleRootBytes = Array.from(
      params.args.loanTapeMerkleRoot instanceof Uint8Array
        ? params.args.loanTapeMerkleRoot
        : Buffer.from(params.args.loanTapeMerkleRoot),
    );

    return program.methods
      .update({
        navNet: params.args.navNet,
        navGross: params.args.navGross,
        terBps: params.args.terBps,
        lossBps: params.args.lossBps,
        navType: params.args.navType,
        timestamp: params.args.timestamp,
        sequence: params.args.sequence,
        loanTapeMerkleRoot: merkleRootBytes,
        signature: signatureBytes,
      })
      .accountsPartial({
        pool: params.pool,
        navAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
  }

  /**
   * Build the Ed25519 verify ix that MUST precede the `update` ix. The
   * on-chain `update` handler scans all preceding instructions for the
   * Ed25519 program and validates the canonical signing payload — this
   * helper assembles it correctly so callers don't have to.
   */
  static buildEd25519VerifyInstruction(params: {
    publisher: PublicKey;
    payload: Uint8Array | Buffer;
    signature: Uint8Array | Buffer;
  }): TransactionInstruction {
    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: params.publisher.toBytes(),
      message: Buffer.isBuffer(params.payload)
        ? params.payload
        : Buffer.from(params.payload),
      signature: Buffer.isBuffer(params.signature)
        ? params.signature
        : Buffer.from(params.signature),
    });
  }

  /**
   * Sign a canonical NAV signing payload with the publisher's secret key.
   *
   * Returns the 64-byte Ed25519 detached signature that
   * {@link NavOracle.update} accepts in `args.signature`. Callers using a
   * KMS-managed publisher key (production HSM flow) can implement
   * equivalent signing externally — the SDK accepts ANY 64-byte
   * signature in `args.signature` so long as it verifies against the
   * canonical payload + the on-chain publisher key.
   *
   * Local-key flow (tests, devnet operator scripts) should use this
   * helper directly; it keeps CLI/operator flows from accidentally
   * sending an unsigned zero-filled signature.
   */
  static signPayload(
    publisher: Keypair,
    fields: SigningPayloadFields,
  ): Uint8Array {
    const payload = buildSigningPayload(fields);
    return nacl.sign.detached(payload, publisher.secretKey);
  }

  /**
   * End-to-end NAV update — composes the Ed25519 verify ix + the program
   * `update` ix into a single transaction and submits it through the
   * provider attached to `program`.
   *
   * The publisher key is read from the on-chain NavAccount (so callers
   * don't have to re-fetch it). The signature MUST be over the canonical
   * payload returned by {@link buildSigningPayload}.
   *
   * Two signing flows:
   *
   * 1. **Caller-provided signature** (`params.args.signature`): the
   *    caller computes a 64-byte Ed25519 signature ahead of time —
   *    typical for KMS / HSM publishers where the secret key is not
   *    accessible to the SDK. The SDK uses the supplied bytes verbatim.
   *
   * 2. **Local Keypair signing** (`params.publisher`): pass a
   *    `Keypair` and the SDK signs the canonical payload internally
   *    via {@link NavOracle.signPayload} before composing the verify
   *    ix. Convenient for tests and devnet operator flows.
   *
   * If both are provided, `params.publisher` wins (the SDK overwrites
   * `args.signature` with a fresh signature). If neither is provided
   * with a non-zero signature, the on-chain handler will reject the
   * update at the Ed25519 precompile verify ix.
   *
   * Optional `additionalSigners` lets callers pass extra signers (e.g.
   * a fee payer keypair); the publisher itself does NOT sign the
   * transaction — only the precompile verifies its signature on the
   * payload.
   */
  static async update(
    program: Program,
    params: {
      pool: PublicKey;
      args: UpdateNavParams;
      additionalSigners?: (Signer | Keypair)[];
      /**
       * Optional publisher Keypair — when provided, the SDK signs the
       * canonical payload locally and overrides any value in
       * `args.signature`. Use this for tests / devnet operator scripts;
       * for KMS-managed publishers, pre-compute the signature externally
       * and pass it via `args.signature` instead.
       */
      publisher?: Keypair;
    },
  ): Promise<string> {
    const provider = program.provider as AnchorProvider;
    const [navAccount] = getNavAccountAddress(
      params.pool,
      program.programId,
    );

    // Fetch the NavAccount to learn the current publisher.
    const state = await NavOracle.fetchNavAccount(program, navAccount);

    // If a Keypair was provided, the publisher's pubkey MUST match the
    // on-chain publisher recorded in NavAccount; otherwise the Ed25519
    // verify ix would sign+verify with a key that differs from the
    // payload's `publisher` field, producing a downstream mismatch.
    if (params.publisher) {
      if (!params.publisher.publicKey.equals(state.publisher)) {
        throw new Error(
          `Publisher Keypair pubkey ${params.publisher.publicKey.toBase58()} ` +
            `does not match on-chain publisher ${state.publisher.toBase58()}. ` +
            `Use rotatePublisher first, or provide a Keypair for the registered key.`,
        );
      }
    }

    // Reconstruct the canonical payload from the supplied args + on-chain
    // pool/publisher; this is what the on-chain handler will reconstruct
    // and compare against.
    const payload = buildSigningPayload({
      pool: params.pool,
      navNet: params.args.navNet,
      navGross: params.args.navGross,
      terBps: params.args.terBps,
      lossBps: params.args.lossBps,
      navType: params.args.navType,
      timestamp: params.args.timestamp,
      sequence: params.args.sequence,
      publisher: state.publisher,
      loanTapeMerkleRoot: params.args.loanTapeMerkleRoot,
    });

    // Compute or accept signature per the two-flow design described in
    // the doc-comment above.
    const signatureBytes: Uint8Array = params.publisher
      ? nacl.sign.detached(payload, params.publisher.secretKey)
      : params.args.signature instanceof Uint8Array
        ? params.args.signature
        : Buffer.from(params.args.signature);

    // Mutate `args.signature` so the program ix carries the same bytes
    // as the verify ix — the on-chain handler reads back `args.signature`
    // and stores it onto the NavAccount for forensic replay.
    const finalArgs: UpdateNavParams = {
      ...params.args,
      signature: signatureBytes,
    };

    const ed25519Ix = NavOracle.buildEd25519VerifyInstruction({
      publisher: state.publisher,
      payload,
      signature: signatureBytes,
    });

    const updateIx = await NavOracle.buildUpdateInstruction(program, {
      pool: params.pool,
      args: finalArgs,
    });

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    return provider.sendAndConfirm(tx, params.additionalSigners ?? []);
  }

  /**
   * Rotate the publisher pubkey on a NavAccount. Caller-provided
   * `rotationAuthority` MUST be the signer that controls the
   * `key_rotation_authority` recorded in the account (typically a
   * governance or multisig authority's vault PDA).
   */
  static async rotatePublisher(
    program: Program,
    rotationAuthority: PublicKey,
    params: { pool: PublicKey; newPublisher: PublicKey },
  ): Promise<string> {
    const [navAccount] = getNavAccountAddress(
      params.pool,
      program.programId,
    );

    return program.methods
      .rotatePublisher()
      .accountsPartial({
        pool: params.pool,
        navAccount,
        keyRotationAuthority: rotationAuthority,
        newPublisher: params.newPublisher,
      })
      .rpc();
  }

  /** Fetch and decode the NavAccount at the given PDA. */
  static async fetchNavAccount(
    program: Program,
    navAccountPda: PublicKey,
  ): Promise<NavAccountState> {
    const accountNs = program.account as Record<
      string,
      { fetch: (addr: PublicKey) => Promise<unknown> }
    >;
    return (await accountNs["navAccount"].fetch(
      navAccountPda,
    )) as NavAccountState;
  }
}

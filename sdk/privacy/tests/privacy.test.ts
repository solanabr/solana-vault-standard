import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CRYPTO_SIZES,
  ProofType,
  ProofLocation,
  ElGamalKeypair,
  AesKey,
  EncryptedBalance,
  DecryptableBalance,
} from "../src/types";
import {
  deriveElGamalKeypair,
  deriveAesKey,
  createDecryptableZeroBalance,
  createDecryptableBalance,
  decryptBalance,
  computeNewDecryptableBalance,
  elgamalPubkeyToBytes,
  decryptableBalanceToBytes,
} from "../src/encryption";
import {
  PROOF_DATA_SIZES,
  ZK_ELGAMAL_PROOF_PROGRAM_ID,
  createPubkeyValidityProofData,
  createEqualityProofData,
  createRangeProofData,
  createVerifyPubkeyValidityInstruction,
  createVerifyEqualityProofInstruction,
  createVerifyRangeProofInstruction,
  configureProofBackend,
  isProofBackendAvailable,
} from "../src/proofs";

describe("Privacy SDK", () => {
  const testWallet = Keypair.generate();
  const testTokenAccount = Keypair.generate().publicKey;

  describe("CRYPTO_SIZES Constants", () => {
    it("defines correct ElGamal sizes", () => {
      expect(CRYPTO_SIZES.ELGAMAL_PUBKEY).to.equal(32);
      expect(CRYPTO_SIZES.ELGAMAL_SECRET_KEY).to.equal(32);
      expect(CRYPTO_SIZES.ELGAMAL_CIPHERTEXT).to.equal(64);
    });

    it("defines correct AES sizes", () => {
      expect(CRYPTO_SIZES.AES_KEY).to.equal(16);
      expect(CRYPTO_SIZES.AES_NONCE).to.equal(12);
      expect(CRYPTO_SIZES.AES_TAG).to.equal(16);
      expect(CRYPTO_SIZES.DECRYPTABLE_BALANCE).to.equal(36);
    });

    it("defines correct Pedersen sizes", () => {
      expect(CRYPTO_SIZES.PEDERSEN_COMMITMENT).to.equal(32);
      expect(CRYPTO_SIZES.PEDERSEN_BLINDING).to.equal(32);
    });

    it("defines correct proof sizes", () => {
      expect(CRYPTO_SIZES.PUBKEY_VALIDITY_PROOF).to.equal(64);
      expect(CRYPTO_SIZES.EQUALITY_PROOF).to.equal(192);
      expect(CRYPTO_SIZES.RANGE_PROOF_U64_BASE).to.equal(672);
    });
  });

  describe("PROOF_DATA_SIZES Constants", () => {
    it("defines correct proof data sizes", () => {
      expect(PROOF_DATA_SIZES.PubkeyValidityProofData).to.equal(64);
      expect(PROOF_DATA_SIZES.CiphertextCommitmentEqualityProofData).to.equal(
        192,
      );
      expect(PROOF_DATA_SIZES.BatchedRangeProofU64Data).to.equal(672);
    });
  });

  describe("ProofType Enum", () => {
    it("has all required proof types", () => {
      expect(ProofType.PubkeyValidity).to.equal("pubkey_validity");
      expect(ProofType.CiphertextCommitmentEquality).to.equal(
        "ciphertext_commitment_equality",
      );
      expect(ProofType.BatchedRangeProofU64).to.equal(
        "batched_range_proof_u64",
      );
      expect(ProofType.ZeroBalance).to.equal("zero_balance");
      expect(ProofType.CiphertextValidity).to.equal("ciphertext_validity");
      expect(ProofType.FeeSigma).to.equal("fee_sigma");
    });
  });

  describe("ProofLocation Enum", () => {
    it("has instruction offset and context state options", () => {
      expect(ProofLocation.InstructionOffset).to.equal("instruction_offset");
      expect(ProofLocation.ContextStateAccount).to.equal(
        "context_state_account",
      );
    });
  });

  describe("ZK_ELGAMAL_PROOF_PROGRAM_ID", () => {
    it("is a valid PublicKey", () => {
      expect(ZK_ELGAMAL_PROOF_PROGRAM_ID).to.be.instanceOf(PublicKey);
    });

    it("matches expected program address", () => {
      expect(ZK_ELGAMAL_PROOF_PROGRAM_ID.toBase58()).to.equal(
        "ZkE1Gama1Proof11111111111111111111111111111",
      );
    });
  });

  describe("ElGamal Key Derivation", () => {
    it("derives deterministic keypair", () => {
      const keypair1 = deriveElGamalKeypair(testWallet, testTokenAccount);
      const keypair2 = deriveElGamalKeypair(testWallet, testTokenAccount);

      expect(keypair1.publicKey).to.deep.equal(keypair2.publicKey);
      expect(keypair1.secretKey).to.deep.equal(keypair2.secretKey);
    });

    it("produces correct key sizes", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);

      expect(keypair.publicKey.length).to.equal(CRYPTO_SIZES.ELGAMAL_PUBKEY);
      expect(keypair.secretKey.length).to.equal(
        CRYPTO_SIZES.ELGAMAL_SECRET_KEY,
      );
    });

    it("derives different keypairs for different accounts", () => {
      const account1 = Keypair.generate().publicKey;
      const account2 = Keypair.generate().publicKey;

      const keypair1 = deriveElGamalKeypair(testWallet, account1);
      const keypair2 = deriveElGamalKeypair(testWallet, account2);

      expect(keypair1.publicKey).to.not.deep.equal(keypair2.publicKey);
    });

    it("derives different keypairs for different wallets", () => {
      const wallet1 = Keypair.generate();
      const wallet2 = Keypair.generate();

      const keypair1 = deriveElGamalKeypair(wallet1, testTokenAccount);
      const keypair2 = deriveElGamalKeypair(wallet2, testTokenAccount);

      expect(keypair1.publicKey).to.not.deep.equal(keypair2.publicKey);
    });
  });

  describe("AES Key Derivation", () => {
    it("derives deterministic key", () => {
      const key1 = deriveAesKey(testWallet, testTokenAccount);
      const key2 = deriveAesKey(testWallet, testTokenAccount);

      expect(key1.key).to.deep.equal(key2.key);
    });

    it("produces correct key size", () => {
      const key = deriveAesKey(testWallet, testTokenAccount);

      expect(key.key.length).to.equal(CRYPTO_SIZES.AES_KEY);
    });

    it("derives different keys for different accounts", () => {
      const account1 = Keypair.generate().publicKey;
      const account2 = Keypair.generate().publicKey;

      const key1 = deriveAesKey(testWallet, account1);
      const key2 = deriveAesKey(testWallet, account2);

      expect(key1.key).to.not.deep.equal(key2.key);
    });
  });

  describe("Decryptable Balance Operations", () => {
    let aesKey: AesKey;

    beforeEach(() => {
      aesKey = deriveAesKey(testWallet, testTokenAccount);
    });

    it("creates zero balance ciphertext", () => {
      const balance = createDecryptableZeroBalance(aesKey);

      expect(balance.ciphertext.length).to.equal(
        CRYPTO_SIZES.DECRYPTABLE_BALANCE,
      );
    });

    it("creates non-zero balance ciphertext", () => {
      const amount = new BN(1_000_000);
      const balance = createDecryptableBalance(aesKey, amount);

      expect(balance.ciphertext.length).to.equal(
        CRYPTO_SIZES.DECRYPTABLE_BALANCE,
      );
    });

    it("encrypts and decrypts zero balance", () => {
      const balance = createDecryptableZeroBalance(aesKey);
      const decrypted = decryptBalance(aesKey, balance);

      expect(decrypted.toNumber()).to.equal(0);
    });

    it("encrypts and decrypts non-zero balance", () => {
      const amount = new BN(1_000_000);
      const balance = createDecryptableBalance(aesKey, amount);
      const decrypted = decryptBalance(aesKey, balance);

      expect(decrypted.toString()).to.equal(amount.toString());
    });

    it("encrypts and decrypts large balance", () => {
      const amount = new BN("1000000000000"); // 1 trillion
      const balance = createDecryptableBalance(aesKey, amount);
      const decrypted = decryptBalance(aesKey, balance);

      expect(decrypted.toString()).to.equal(amount.toString());
    });

    it("computes new balance after withdrawal", () => {
      const currentBalance = new BN(1_000_000);
      const withdrawAmount = new BN(400_000);
      const expectedNew = new BN(600_000);

      const newBalance = computeNewDecryptableBalance(
        aesKey,
        currentBalance,
        withdrawAmount,
      );
      const decrypted = decryptBalance(aesKey, newBalance);

      expect(decrypted.toString()).to.equal(expectedNew.toString());
    });

    it("generates unique nonces for each encryption", () => {
      const amount = new BN(1000);
      const balance1 = createDecryptableBalance(aesKey, amount);
      const balance2 = createDecryptableBalance(aesKey, amount);

      // First 12 bytes are the nonce - should be different
      const nonce1 = balance1.ciphertext.slice(0, 12);
      const nonce2 = balance2.ciphertext.slice(0, 12);

      expect(nonce1).to.not.deep.equal(nonce2);
    });
  });

  describe("Byte Conversion Helpers", () => {
    it("converts ElGamal pubkey to bytes", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const bytes = elgamalPubkeyToBytes(keypair);

      expect(bytes).to.deep.equal(keypair.publicKey);
    });

    it("converts decryptable balance to bytes", () => {
      const aesKey = deriveAesKey(testWallet, testTokenAccount);
      const balance = createDecryptableZeroBalance(aesKey);
      const bytes = decryptableBalanceToBytes(balance);

      expect(bytes).to.deep.equal(balance.ciphertext);
    });
  });

  describe("PubkeyValidityProof Generation", () => {
    it("creates proof data with correct size", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createPubkeyValidityProofData(keypair);

      expect(proofData.length).to.equal(
        PROOF_DATA_SIZES.PubkeyValidityProofData,
      );
    });

    it("embeds public key in proof data", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createPubkeyValidityProofData(keypair);

      // First 32 bytes should be the public key
      const embeddedPubkey = proofData.slice(0, 32);
      expect(embeddedPubkey).to.deep.equal(keypair.publicKey);
    });

    it("generates deterministic proof for same keypair", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proof1 = createPubkeyValidityProofData(keypair);
      const proof2 = createPubkeyValidityProofData(keypair);

      expect(proof1).to.deep.equal(proof2);
    });
  });

  describe("EqualityProof Generation", () => {
    it("creates proof data with correct size", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const amount = new BN(1_000_000);
      const currentBalance = new Uint8Array(64).fill(0);

      const proofData = createEqualityProofData(
        keypair,
        amount,
        currentBalance,
      );

      expect(proofData.length).to.equal(
        PROOF_DATA_SIZES.CiphertextCommitmentEqualityProofData,
      );
    });

    it("embeds public key in proof data", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const amount = new BN(1_000_000);
      const currentBalance = new Uint8Array(64).fill(0);

      const proofData = createEqualityProofData(
        keypair,
        amount,
        currentBalance,
      );

      // First 32 bytes should be the public key
      const embeddedPubkey = proofData.slice(0, 32);
      expect(embeddedPubkey).to.deep.equal(keypair.publicKey);
    });

    it("embeds ciphertext in proof data", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const amount = new BN(1_000_000);
      const currentBalance = new Uint8Array(64);
      for (let i = 0; i < 64; i++) currentBalance[i] = i;

      const proofData = createEqualityProofData(
        keypair,
        amount,
        currentBalance,
      );

      // Bytes 32-96 should be the ciphertext
      const embeddedCiphertext = proofData.slice(32, 96);
      expect(embeddedCiphertext).to.deep.equal(currentBalance);
    });
  });

  describe("RangeProof Generation", () => {
    it("creates proof data for single amount", () => {
      const amounts = [new BN(1_000_000)];
      const blindings = [new Uint8Array(32).fill(1)];

      const proofData = createRangeProofData(amounts, blindings);

      // Base size for single amount
      expect(proofData.length).to.equal(
        PROOF_DATA_SIZES.BatchedRangeProofU64Data,
      );
    });

    it("creates larger proof for multiple amounts", () => {
      const amounts = [new BN(1_000_000), new BN(500_000)];
      const blindings = [
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ];

      const proofData = createRangeProofData(amounts, blindings);

      // Should be larger than single amount
      expect(proofData.length).to.be.greaterThan(
        PROOF_DATA_SIZES.BatchedRangeProofU64Data,
      );
    });

    it("generates deterministic proof for same inputs", () => {
      const amounts = [new BN(1_000_000)];
      const blindings = [new Uint8Array(32).fill(42)];

      const proof1 = createRangeProofData(amounts, blindings);
      const proof2 = createRangeProofData(amounts, blindings);

      expect(proof1).to.deep.equal(proof2);
    });
  });

  describe("Proof Verification Instructions", () => {
    it("creates VerifyPubkeyValidity instruction", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createPubkeyValidityProofData(keypair);

      const ix = createVerifyPubkeyValidityInstruction(proofData);

      expect(ix.programId.equals(ZK_ELGAMAL_PROOF_PROGRAM_ID)).to.be.true;
      expect(ix.data[0]).to.equal(4); // VerifyPubkeyValidity discriminator
    });

    it("creates VerifyPubkeyValidity with context account", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createPubkeyValidityProofData(keypair);
      const contextAccount = Keypair.generate().publicKey;

      const ix = createVerifyPubkeyValidityInstruction(
        proofData,
        contextAccount,
      );

      expect(ix.keys.length).to.equal(1);
      expect(ix.keys[0].pubkey.equals(contextAccount)).to.be.true;
      expect(ix.keys[0].isWritable).to.be.true;
    });

    it("creates VerifyEqualityProof instruction", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createEqualityProofData(
        keypair,
        new BN(1000),
        new Uint8Array(64),
      );

      const ix = createVerifyEqualityProofInstruction(proofData);

      expect(ix.programId.equals(ZK_ELGAMAL_PROOF_PROGRAM_ID)).to.be.true;
      expect(ix.data[0]).to.equal(3); // VerifyCiphertextCommitmentEquality discriminator
    });

    it("creates VerifyRangeProof instruction", () => {
      const proofData = createRangeProofData(
        [new BN(1000)],
        [new Uint8Array(32)],
      );

      const ix = createVerifyRangeProofInstruction(proofData);

      expect(ix.programId.equals(ZK_ELGAMAL_PROOF_PROGRAM_ID)).to.be.true;
      expect(ix.data[0]).to.equal(6); // VerifyBatchedRangeProofU64 discriminator
    });

    it("embeds proof data in instruction", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const proofData = createPubkeyValidityProofData(keypair);

      const ix = createVerifyPubkeyValidityInstruction(proofData);

      // Data should be discriminator (1 byte) + proof data
      expect(ix.data.length).to.equal(1 + proofData.length);
      expect(ix.data.slice(1)).to.deep.equal(Buffer.from(proofData));
    });
  });

  describe("Backend Configuration", () => {
    it("configures backend URL", () => {
      // Should not throw
      configureProofBackend("https://proofs.example.com");
    });

    it("configures backend with API key", () => {
      // Should not throw
      configureProofBackend("https://proofs.example.com", "test-api-key");
    });

    it("checks backend availability (offline)", async () => {
      configureProofBackend("http://localhost:99999"); // Non-existent
      const available = await isProofBackendAvailable();

      expect(available).to.be.false;
    });
  });

  describe("Type Interfaces", () => {
    it("ElGamalKeypair has correct structure", () => {
      const keypair: ElGamalKeypair = {
        publicKey: new Uint8Array(32),
        secretKey: new Uint8Array(32),
      };

      expect(keypair.publicKey.length).to.equal(32);
      expect(keypair.secretKey.length).to.equal(32);
    });

    it("AesKey has correct structure", () => {
      const key: AesKey = {
        key: new Uint8Array(16),
      };

      expect(key.key.length).to.equal(16);
    });

    it("EncryptedBalance has correct structure", () => {
      const balance: EncryptedBalance = {
        commitment: new Uint8Array(32),
        handle: new Uint8Array(32),
      };

      expect(balance.commitment.length).to.equal(32);
      expect(balance.handle.length).to.equal(32);
    });

    it("DecryptableBalance has correct structure", () => {
      const balance: DecryptableBalance = {
        ciphertext: new Uint8Array(36),
      };

      expect(balance.ciphertext.length).to.equal(36);
    });
  });

  describe("Edge Cases", () => {
    it("handles zero amount encryption", () => {
      const aesKey = deriveAesKey(testWallet, testTokenAccount);
      const balance = createDecryptableBalance(aesKey, new BN(0));
      const decrypted = decryptBalance(aesKey, balance);

      expect(decrypted.toNumber()).to.equal(0);
    });

    it("handles max u64 amount", () => {
      const aesKey = deriveAesKey(testWallet, testTokenAccount);
      const maxU64 = new BN("18446744073709551615");
      const balance = createDecryptableBalance(aesKey, maxU64);

      expect(balance.ciphertext.length).to.equal(36);
    });

    it("handles proof data with all zeros", () => {
      const keypair: ElGamalKeypair = {
        publicKey: new Uint8Array(32).fill(0),
        secretKey: new Uint8Array(32).fill(0),
      };

      const proofData = createPubkeyValidityProofData(keypair);

      expect(proofData.length).to.equal(64);
    });

    it("handles empty blinding factors in range proof", () => {
      const amounts = [new BN(1000)];
      const blindings = [new Uint8Array(0)]; // Empty blinding

      const proofData = createRangeProofData(amounts, blindings);

      expect(proofData.length).to.be.greaterThan(0);
    });
  });

  describe("Consistency Checks", () => {
    it("ElGamal and AES derive different keys from same inputs", () => {
      const elgamalKeypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const aesKey = deriveAesKey(testWallet, testTokenAccount);

      // First 16 bytes of ElGamal pubkey should differ from AES key
      const elgamalPrefix = elgamalKeypair.publicKey.slice(0, 16);
      expect(elgamalPrefix).to.not.deep.equal(aesKey.key);
    });

    it("proof data contains expected sections", () => {
      const keypair = deriveElGamalKeypair(testWallet, testTokenAccount);
      const amount = new BN(1_000_000);
      const ciphertext = new Uint8Array(64).fill(0xab);

      const equalityProof = createEqualityProofData(
        keypair,
        amount,
        ciphertext,
      );

      // Section 1: Public key (0-32)
      expect(equalityProof.slice(0, 32)).to.deep.equal(keypair.publicKey);

      // Section 2: Ciphertext (32-96)
      expect(equalityProof.slice(32, 96)).to.deep.equal(ciphertext);

      // Section 3: Commitment (96-128) - should be 32 bytes
      expect(equalityProof.slice(96, 128).length).to.equal(32);

      // Section 4: Proof (128-192) - should be 64 bytes
      expect(equalityProof.slice(128, 192).length).to.equal(64);
    });
  });
});

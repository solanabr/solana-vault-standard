/** Tests for access control: whitelist/blacklist modes, merkle proofs */

import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AccessMode,
  AccessDenialReason,
  checkAccess,
  generateMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
  addToList,
  removeFromList,
  createOpenConfig,
  createWhitelistConfig,
  createBlacklistConfig,
  isInList,
  getListSize,
  hashLeaf,
} from "../src/access-control";

describe("SDK Access Control Module", () => {
  // Generate test addresses
  const addresses: PublicKey[] = [];
  for (let i = 0; i < 10; i++) {
    addresses.push(Keypair.generate().publicKey);
  }

  const [USER_1, USER_2, USER_3, USER_4, USER_5] = addresses;
  const NOT_IN_LIST = Keypair.generate().publicKey;

  describe("Whitelist Mode (Direct)", () => {
    it("allows whitelisted address", () => {
      const config = createWhitelistConfig([USER_1, USER_2]);
      const result = checkAccess(USER_1, config);

      expect(result.allowed).to.be.true;
      expect(result.reason).to.be.undefined;
    });

    it("denies non-whitelisted address", () => {
      const config = createWhitelistConfig([USER_1, USER_2]);
      const result = checkAccess(NOT_IN_LIST, config);

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(AccessDenialReason.NotWhitelisted);
    });

    it("handles empty whitelist", () => {
      const config = createWhitelistConfig([]);
      const result = checkAccess(USER_1, config);

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(AccessDenialReason.NotWhitelisted);
    });
  });

  describe("Blacklist Mode", () => {
    it("allows non-blacklisted address", () => {
      const config = createBlacklistConfig([USER_1, USER_2]);
      const result = checkAccess(USER_3, config);

      expect(result.allowed).to.be.true;
    });

    it("denies blacklisted address", () => {
      const config = createBlacklistConfig([USER_1, USER_2]);
      const result = checkAccess(USER_1, config);

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(AccessDenialReason.Blacklisted);
    });

    it("handles empty blacklist (all allowed)", () => {
      const config = createBlacklistConfig([]);
      const result = checkAccess(USER_1, config);

      expect(result.allowed).to.be.true;
    });
  });

  describe("Open Mode", () => {
    it("allows any address", () => {
      const config = createOpenConfig();

      expect(checkAccess(USER_1, config).allowed).to.be.true;
      expect(checkAccess(USER_2, config).allowed).to.be.true;
      expect(checkAccess(NOT_IN_LIST, config).allowed).to.be.true;
    });
  });

  describe("Merkle Tree", () => {
    it("generates consistent root", () => {
      const root1 = generateMerkleRoot([USER_1, USER_2, USER_3]);
      const root2 = generateMerkleRoot([USER_1, USER_2, USER_3]);

      expect(root1.equals(root2)).to.be.true;
    });

    it("generates different roots for different lists", () => {
      const root1 = generateMerkleRoot([USER_1, USER_2]);
      const root2 = generateMerkleRoot([USER_1, USER_3]);

      expect(root1.equals(root2)).to.be.false;
    });

    it("generates proof for valid address", () => {
      const proof = generateMerkleProof(USER_1, [USER_1, USER_2, USER_3]);

      expect(proof).to.not.be.null;
      expect(proof!.proof.length).to.be.greaterThan(0);
      expect(proof!.leaf.length).to.equal(32);
    });

    it("returns null proof for address not in list", () => {
      const proof = generateMerkleProof(NOT_IN_LIST, [USER_1, USER_2]);

      expect(proof).to.be.null;
    });
  });

  describe("Merkle Proof Verification", () => {
    it("verifies valid proof", () => {
      const addresses = [USER_1, USER_2, USER_3, USER_4];
      const root = generateMerkleRoot(addresses);
      const proof = generateMerkleProof(USER_2, addresses);

      expect(proof).to.not.be.null;
      const isValid = verifyMerkleProof(USER_2, proof!, root);

      expect(isValid).to.be.true;
    });

    it("rejects invalid proof (wrong address)", () => {
      const addresses = [USER_1, USER_2, USER_3];
      const root = generateMerkleRoot(addresses);
      const proof = generateMerkleProof(USER_1, addresses);

      // Try to use USER_1's proof for USER_2
      const isValid = verifyMerkleProof(USER_2, proof!, root);

      expect(isValid).to.be.false;
    });

    it("rejects proof against wrong root", () => {
      const addresses1 = [USER_1, USER_2];
      const addresses2 = [USER_3, USER_4];
      const root2 = generateMerkleRoot(addresses2);
      const proof = generateMerkleProof(USER_1, addresses1);

      const isValid = verifyMerkleProof(USER_1, proof!, root2);

      expect(isValid).to.be.false;
    });

    it("verifies proof for single-element list", () => {
      const addresses = [USER_1];
      const root = generateMerkleRoot(addresses);
      const proof = generateMerkleProof(USER_1, addresses);

      expect(proof).to.not.be.null;
      expect(proof!.proof.length).to.equal(0); // No siblings needed
      const isValid = verifyMerkleProof(USER_1, proof!, root);

      expect(isValid).to.be.true;
    });

    it("verifies proof for power-of-2 list", () => {
      const addresses = [USER_1, USER_2, USER_3, USER_4];
      const root = generateMerkleRoot(addresses);

      // Verify each address
      for (const addr of addresses) {
        const proof = generateMerkleProof(addr, addresses);
        expect(proof).to.not.be.null;
        expect(verifyMerkleProof(addr, proof!, root)).to.be.true;
      }
    });

    it("verifies proof for non-power-of-2 list", () => {
      const addresses = [USER_1, USER_2, USER_3, USER_4, USER_5];
      const root = generateMerkleRoot(addresses);

      for (const addr of addresses) {
        const proof = generateMerkleProof(addr, addresses);
        expect(proof).to.not.be.null;
        expect(verifyMerkleProof(addr, proof!, root)).to.be.true;
      }
    });
  });

  describe("Whitelist with Merkle Proof", () => {
    it("allows address with valid merkle proof", () => {
      const whitelistAddresses = [USER_1, USER_2, USER_3];
      const config = createWhitelistConfig(whitelistAddresses, true);
      const proof = generateMerkleProof(USER_2, whitelistAddresses);

      const result = checkAccess(USER_2, config, proof!);

      expect(result.allowed).to.be.true;
    });

    it("denies address with invalid merkle proof", () => {
      const whitelistAddresses = [USER_1, USER_2];
      const config = createWhitelistConfig(whitelistAddresses, true);
      const proof = generateMerkleProof(USER_1, whitelistAddresses);

      // Try USER_1's proof for NOT_IN_LIST
      const result = checkAccess(NOT_IN_LIST, config, proof!);

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(AccessDenialReason.InvalidProof);
    });

    it("denies address without proof when merkle required", () => {
      const whitelistAddresses = [USER_1, USER_2];
      const config = createWhitelistConfig(whitelistAddresses, true);

      const result = checkAccess(USER_1, config); // No proof provided

      expect(result.allowed).to.be.false;
      expect(result.reason).to.equal(AccessDenialReason.NotWhitelisted);
    });
  });

  describe("List Management", () => {
    it("adds address to list", () => {
      let config = createWhitelistConfig([USER_1]);

      expect(isInList(config, USER_2)).to.be.false;

      config = addToList(config, USER_2);

      expect(isInList(config, USER_2)).to.be.true;
      expect(getListSize(config)).to.equal(2);
    });

    it("removes address from list", () => {
      let config = createWhitelistConfig([USER_1, USER_2]);

      expect(isInList(config, USER_2)).to.be.true;

      config = removeFromList(config, USER_2);

      expect(isInList(config, USER_2)).to.be.false;
      expect(getListSize(config)).to.equal(1);
    });

    it("adding duplicate has no effect", () => {
      let config = createWhitelistConfig([USER_1]);
      config = addToList(config, USER_1);

      expect(getListSize(config)).to.equal(1);
    });

    it("removing non-existent has no effect", () => {
      let config = createWhitelistConfig([USER_1]);
      config = removeFromList(config, USER_2);

      expect(getListSize(config)).to.equal(1);
    });

    it("maintains immutability", () => {
      const original = createWhitelistConfig([USER_1]);
      const modified = addToList(original, USER_2);

      expect(getListSize(original)).to.equal(1);
      expect(getListSize(modified)).to.equal(2);
    });
  });

  describe("Large Whitelist (1000+ addresses)", () => {
    it("generates valid root for large list", () => {
      const largeList: PublicKey[] = [];
      for (let i = 0; i < 1000; i++) {
        largeList.push(Keypair.generate().publicKey);
      }

      const root = generateMerkleRoot(largeList);

      expect(root.length).to.equal(32);
    });

    it("verifies proof for address in large list", () => {
      const largeList: PublicKey[] = [];
      for (let i = 0; i < 1000; i++) {
        largeList.push(Keypair.generate().publicKey);
      }

      const targetIndex = 500;
      const targetAddr = largeList[targetIndex];

      const root = generateMerkleRoot(largeList);
      const proof = generateMerkleProof(targetAddr, largeList);

      expect(proof).to.not.be.null;
      expect(verifyMerkleProof(targetAddr, proof!, root)).to.be.true;
    });

    it("proof size is logarithmic", () => {
      const list256: PublicKey[] = [];
      const list1024: PublicKey[] = [];

      for (let i = 0; i < 1024; i++) {
        const addr = Keypair.generate().publicKey;
        list1024.push(addr);
        if (i < 256) list256.push(addr);
      }

      const proof256 = generateMerkleProof(list256[0], list256);
      const proof1024 = generateMerkleProof(list1024[0], list1024);

      // 256 = 2^8 -> ~8 proof elements
      // 1024 = 2^10 -> ~10 proof elements
      expect(proof256!.proof.length).to.be.lessThanOrEqual(10);
      expect(proof1024!.proof.length).to.be.lessThanOrEqual(12);
    });
  });

  describe("Mode Switching", () => {
    it("switches from whitelist to blacklist", () => {
      let config = createWhitelistConfig([USER_1, USER_2]);

      // USER_3 denied in whitelist mode
      expect(checkAccess(USER_3, config).allowed).to.be.false;

      // Switch to blacklist with same addresses
      config = createBlacklistConfig([USER_1, USER_2]);

      // USER_3 allowed in blacklist mode
      expect(checkAccess(USER_3, config).allowed).to.be.true;
      // USER_1 denied in blacklist mode
      expect(checkAccess(USER_1, config).allowed).to.be.false;
    });

    it("switches from restricted to open", () => {
      let config = createWhitelistConfig([USER_1]);

      expect(checkAccess(USER_2, config).allowed).to.be.false;

      config = createOpenConfig();

      expect(checkAccess(USER_2, config).allowed).to.be.true;
    });
  });

  describe("hashLeaf", () => {
    it("produces consistent hashes", () => {
      const hash1 = hashLeaf(USER_1);
      const hash2 = hashLeaf(USER_1);

      expect(hash1.equals(hash2)).to.be.true;
    });

    it("produces different hashes for different addresses", () => {
      const hash1 = hashLeaf(USER_1);
      const hash2 = hashLeaf(USER_2);

      expect(hash1.equals(hash2)).to.be.false;
    });

    it("produces 32-byte hash", () => {
      const hash = hashLeaf(USER_1);
      expect(hash.length).to.equal(32);
    });
  });
});

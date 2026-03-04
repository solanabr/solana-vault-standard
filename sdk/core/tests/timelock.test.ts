/** Tests for timelocked admin operations: proposals, execution, cancellation */

import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TimelockAction,
  ProposalStatus,
  generateProposalId,
  createProposal,
  canExecute,
  getProposalStatus,
  getTimeRemaining,
  markExecuted,
  markCancelled,
  createTimelockConfig,
  validateTimelockConfig,
  TimelockManager,
} from "../src/timelock";

describe("SDK Timelock Module", () => {
  const ADMIN = Keypair.generate().publicKey;
  const EXECUTOR = Keypair.generate().publicKey;
  const NEW_AUTHORITY = Keypair.generate().publicKey;

  const ONE_DAY = 86400;
  const ONE_WEEK = 604800;

  const defaultConfig = createTimelockConfig(ADMIN, {
    minDelay: ONE_DAY,
    maxDelay: ONE_WEEK,
    gracePeriod: ONE_DAY,
    executor: EXECUTOR,
  });

  describe("generateProposalId", () => {
    it("generates unique IDs for different params", () => {
      const salt = Buffer.from("test");
      const id1 = generateProposalId(
        TimelockAction.TransferAuthority,
        { newAuthority: "addr1" },
        salt,
      );
      const id2 = generateProposalId(
        TimelockAction.TransferAuthority,
        { newAuthority: "addr2" },
        salt,
      );

      expect(id1).to.not.equal(id2);
    });

    it("generates unique IDs for different salts", () => {
      const params = { newAuthority: "addr1" };
      const id1 = generateProposalId(
        TimelockAction.TransferAuthority,
        params,
        Buffer.from("salt1"),
      );
      const id2 = generateProposalId(
        TimelockAction.TransferAuthority,
        params,
        Buffer.from("salt2"),
      );

      expect(id1).to.not.equal(id2);
    });

    it("generates consistent ID for same inputs", () => {
      const salt = Buffer.from("fixed");
      const params = { test: true };
      const id1 = generateProposalId(TimelockAction.Pause, params, salt);
      const id2 = generateProposalId(TimelockAction.Pause, params, salt);

      expect(id1).to.equal(id2);
    });
  });

  describe("createProposal", () => {
    it("creates proposal with minimum delay", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      expect(proposal.action).to.equal(TimelockAction.Pause);
      expect(proposal.proposedAt).to.equal(now);
      expect(proposal.executeAfter).to.equal(now + ONE_DAY);
      expect(proposal.expiresAt).to.equal(now + ONE_DAY + ONE_DAY);
      expect(proposal.status).to.equal(ProposalStatus.Pending);
    });

    it("creates proposal with custom delay", () => {
      const now = 1000000;
      const customDelay = ONE_DAY * 3;
      const proposal = createProposal(
        TimelockAction.TransferAuthority,
        { newAuthority: NEW_AUTHORITY.toBase58() },
        defaultConfig,
        now,
        customDelay,
      );

      expect(proposal.executeAfter).to.equal(now + customDelay);
    });

    it("throws for delay below minimum", () => {
      const now = 1000000;

      expect(() => {
        createProposal(TimelockAction.Pause, {}, defaultConfig, now, 100);
      }).to.throw("Delay 100 is outside bounds");
    });

    it("throws for delay above maximum", () => {
      const now = 1000000;

      expect(() => {
        createProposal(
          TimelockAction.Pause,
          {},
          defaultConfig,
          now,
          ONE_WEEK + 1,
        );
      }).to.throw("is outside bounds");
    });

    it("stores params correctly", () => {
      const params = {
        newAuthority: NEW_AUTHORITY.toBase58(),
        extra: "data",
      };
      const proposal = createProposal(
        TimelockAction.TransferAuthority,
        params,
        defaultConfig,
        1000000,
      );

      expect(proposal.params).to.deep.equal(params);
    });
  });

  describe("canExecute", () => {
    it("allows execution when ready", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );

      const result = canExecute(proposal, proposal.executeAfter + 1);

      expect(result.executable).to.be.true;
    });

    it("denies execution before delay elapsed", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const result = canExecute(proposal, now + 100);

      expect(result.executable).to.be.false;
      expect(result.reason).to.equal("Delay not elapsed");
      expect(result.waitTime).to.equal(ONE_DAY - 100);
    });

    it("denies execution after expiry", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const result = canExecute(proposal, proposal.expiresAt + 1);

      expect(result.executable).to.be.false;
      expect(result.reason).to.equal("Proposal expired");
    });

    it("denies execution of already executed proposal", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );
      const executed = markExecuted(proposal);

      const result = canExecute(executed, executed.executeAfter + 1);

      expect(result.executable).to.be.false;
      expect(result.reason).to.equal("Already executed");
    });

    it("denies execution of cancelled proposal", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );
      const cancelled = markCancelled(proposal);

      const result = canExecute(cancelled, cancelled.executeAfter + 1);

      expect(result.executable).to.be.false;
      expect(result.reason).to.equal("Proposal cancelled");
    });

    it("allows execution exactly at executeAfter", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );

      const result = canExecute(proposal, proposal.executeAfter);

      expect(result.executable).to.be.true;
    });
  });

  describe("getProposalStatus", () => {
    it("returns Pending before delay", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      expect(getProposalStatus(proposal, now + 100)).to.equal(
        ProposalStatus.Pending,
      );
    });

    it("returns Ready within execution window", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      expect(getProposalStatus(proposal, proposal.executeAfter + 100)).to.equal(
        ProposalStatus.Ready,
      );
    });

    it("returns Expired after grace period", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      expect(getProposalStatus(proposal, proposal.expiresAt + 1)).to.equal(
        ProposalStatus.Expired,
      );
    });

    it("preserves Executed status", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );
      const executed = markExecuted(proposal);

      // Even after expiry time, status should remain Executed
      expect(getProposalStatus(executed, executed.expiresAt + 1000)).to.equal(
        ProposalStatus.Executed,
      );
    });

    it("preserves Cancelled status", () => {
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        1000000,
      );
      const cancelled = markCancelled(proposal);

      expect(getProposalStatus(cancelled, cancelled.executeAfter)).to.equal(
        ProposalStatus.Cancelled,
      );
    });
  });

  describe("getTimeRemaining", () => {
    it("returns correct time to ready", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const remaining = getTimeRemaining(proposal, now + 1000);

      expect(remaining.toReady).to.equal(ONE_DAY - 1000);
    });

    it("returns zero toReady when already ready", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const remaining = getTimeRemaining(
        proposal,
        proposal.executeAfter + 1000,
      );

      expect(remaining.toReady).to.equal(0);
    });

    it("returns correct time to expiry", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const remaining = getTimeRemaining(proposal, proposal.executeAfter);

      expect(remaining.toExpiry).to.equal(ONE_DAY); // Grace period
    });

    it("returns zero when expired", () => {
      const now = 1000000;
      const proposal = createProposal(
        TimelockAction.Pause,
        {},
        defaultConfig,
        now,
      );

      const remaining = getTimeRemaining(proposal, proposal.expiresAt + 1000);

      expect(remaining.toReady).to.equal(0);
      expect(remaining.toExpiry).to.equal(0);
    });
  });

  describe("TimelockManager", () => {
    it("proposes and retrieves proposal", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const proposal = manager.propose(
        TimelockAction.TransferAuthority,
        { newAuthority: NEW_AUTHORITY.toBase58() },
        now,
      );

      const retrieved = manager.getProposal(proposal.id);

      expect(retrieved).to.not.be.null;
      expect(retrieved!.action).to.equal(TimelockAction.TransferAuthority);
    });

    it("executes ready proposal", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const proposal = manager.propose(TimelockAction.Pause, {}, now);

      const result = manager.execute(proposal.id, proposal.executeAfter);

      expect(result.executable).to.be.true;

      const updated = manager.getProposal(proposal.id);
      expect(updated!.status).to.equal(ProposalStatus.Executed);
    });

    it("rejects execution before ready", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const proposal = manager.propose(TimelockAction.Pause, {}, now);

      const result = manager.execute(proposal.id, now + 100);

      expect(result.executable).to.be.false;
      expect(result.waitTime).to.be.greaterThan(0);
    });

    it("cancels proposal", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const proposal = manager.propose(TimelockAction.Pause, {}, now);

      const cancelled = manager.cancel(proposal.id);

      expect(cancelled).to.be.true;

      const updated = manager.getProposal(proposal.id);
      expect(updated!.status).to.equal(ProposalStatus.Cancelled);
    });

    it("cannot cancel executed proposal", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const proposal = manager.propose(TimelockAction.Pause, {}, now);
      manager.execute(proposal.id, proposal.executeAfter);

      const cancelled = manager.cancel(proposal.id);

      expect(cancelled).to.be.false;
    });

    it("returns pending proposals", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      manager.propose(TimelockAction.Pause, {}, now);
      manager.propose(TimelockAction.Unpause, {}, now);

      const pending = manager.getPendingProposals(now + 100);

      expect(pending.length).to.equal(2);
    });

    it("returns ready proposals", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const p1 = manager.propose(TimelockAction.Pause, {}, now);
      const p2 = manager.propose(TimelockAction.Unpause, {}, now);

      const ready = manager.getReadyProposals(p1.executeAfter + 100);

      expect(ready.length).to.equal(2);
    });

    it("filters proposals by action", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      manager.propose(TimelockAction.Pause, {}, now);
      manager.propose(TimelockAction.Unpause, {}, now);
      manager.propose(TimelockAction.TransferAuthority, {}, now);

      const pauseProposals = manager.getAllProposals(TimelockAction.Pause);

      expect(pauseProposals.length).to.equal(1);
    });

    it("cleans up expired proposals", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      manager.propose(TimelockAction.Pause, {}, now);
      manager.propose(TimelockAction.Unpause, {}, now);

      // Fast forward past expiry
      const expiredTime = now + ONE_DAY + ONE_DAY + 1000;

      const removed = manager.cleanup(expiredTime);

      expect(removed).to.equal(2);
      expect(manager.getAllProposals().length).to.equal(0);
    });
  });

  describe("validateTimelockConfig", () => {
    it("validates correct config", () => {
      expect(validateTimelockConfig(defaultConfig)).to.be.true;
    });

    it("rejects negative minDelay", () => {
      const config = createTimelockConfig(ADMIN, { minDelay: -1 });
      expect(validateTimelockConfig(config)).to.be.false;
    });

    it("rejects maxDelay < minDelay", () => {
      const config = createTimelockConfig(ADMIN, {
        minDelay: ONE_WEEK,
        maxDelay: ONE_DAY,
      });
      expect(validateTimelockConfig(config)).to.be.false;
    });

    it("rejects negative gracePeriod", () => {
      const config = createTimelockConfig(ADMIN, { gracePeriod: -1 });
      expect(validateTimelockConfig(config)).to.be.false;
    });

    it("accepts zero delays", () => {
      const config = createTimelockConfig(ADMIN, {
        minDelay: 0,
        maxDelay: 0,
        gracePeriod: 0,
      });
      expect(validateTimelockConfig(config)).to.be.true;
    });
  });

  describe("Multiple Concurrent Proposals", () => {
    it("handles multiple proposals independently", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const p1 = manager.propose(TimelockAction.Pause, {}, now);
      const p2 = manager.propose(TimelockAction.UpdateFees, { fee: 100 }, now);
      const p3 = manager.propose(
        TimelockAction.TransferAuthority,
        { newAuthority: NEW_AUTHORITY.toBase58() },
        now,
        ONE_DAY * 3, // Longer delay
      );

      // Execute p1 and p2 (same delay)
      manager.execute(p1.id, p1.executeAfter);
      manager.execute(p2.id, p2.executeAfter);

      // p3 should still be pending
      expect(
        getProposalStatus(manager.getProposal(p3.id)!, p1.executeAfter),
      ).to.equal(ProposalStatus.Pending);

      // Execute p3 later
      manager.execute(p3.id, p3.executeAfter);

      expect(manager.getProposal(p1.id)!.status).to.equal(
        ProposalStatus.Executed,
      );
      expect(manager.getProposal(p2.id)!.status).to.equal(
        ProposalStatus.Executed,
      );
      expect(manager.getProposal(p3.id)!.status).to.equal(
        ProposalStatus.Executed,
      );
    });

    it("each proposal has unique ID", () => {
      const manager = new TimelockManager(defaultConfig);
      const now = 1000000;

      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const p = manager.propose(TimelockAction.Pause, { index: i }, now);
        ids.add(p.id);
      }

      expect(ids.size).to.equal(100);
    });
  });
});

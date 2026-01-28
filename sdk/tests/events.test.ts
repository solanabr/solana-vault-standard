import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as borsh from "borsh";

// Event interfaces matching the program's events.rs
interface VaultInitializedEvent {
  vault: PublicKey;
  authority: PublicKey;
  assetMint: PublicKey;
  sharesMint: PublicKey;
  vaultId: BN;
}

interface DepositEvent {
  vault: PublicKey;
  caller: PublicKey;
  owner: PublicKey;
  assets: BN;
  shares: BN;
}

interface WithdrawEvent {
  vault: PublicKey;
  caller: PublicKey;
  receiver: PublicKey;
  owner: PublicKey;
  assets: BN;
  shares: BN;
}

interface VaultStatusChangedEvent {
  vault: PublicKey;
  paused: boolean;
}

interface AuthorityTransferredEvent {
  vault: PublicKey;
  previousAuthority: PublicKey;
  newAuthority: PublicKey;
}

interface VaultSyncedEvent {
  vault: PublicKey;
  previousTotal: BN;
  newTotal: BN;
}

// Event discriminators (first 8 bytes of sha256("event:EventName"))
const EVENT_DISCRIMINATORS = {
  VaultInitialized: Buffer.from([
    0x4e, 0x9d, 0x7a, 0xc8, 0x5c, 0x0a, 0x8d, 0x44,
  ]),
  Deposit: Buffer.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]),
  Withdraw: Buffer.from([0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22]),
  VaultStatusChanged: Buffer.from([
    0xd3, 0x16, 0xdd, 0xfb, 0x4a, 0x79, 0xc1, 0x2f,
  ]),
  AuthorityTransferred: Buffer.from([
    0x30, 0xa9, 0x4c, 0x48, 0xe5, 0xb4, 0x37, 0xa1,
  ]),
  VaultSynced: Buffer.from([0x04, 0xdb, 0x28, 0xa4, 0x15, 0x9d, 0xbd, 0x58]),
};

describe("SDK Events Module", () => {
  // Use well-known program IDs as mock pubkeys
  const MOCK_PUBKEY_1 = new PublicKey("11111111111111111111111111111112"); // System Program
  const MOCK_PUBKEY_2 = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ); // Token Program
  const MOCK_PUBKEY_3 = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  ); // Token-2022

  describe("Event Interface Structures", () => {
    it("creates valid VaultInitializedEvent", () => {
      const event: VaultInitializedEvent = {
        vault: MOCK_PUBKEY_1,
        authority: MOCK_PUBKEY_2,
        assetMint: MOCK_PUBKEY_3,
        sharesMint: MOCK_PUBKEY_1,
        vaultId: new BN(42),
      };

      expect(event.vault).to.be.instanceOf(PublicKey);
      expect(event.authority).to.be.instanceOf(PublicKey);
      expect(event.assetMint).to.be.instanceOf(PublicKey);
      expect(event.sharesMint).to.be.instanceOf(PublicKey);
      expect(event.vaultId.toNumber()).to.equal(42);
    });

    it("creates valid DepositEvent", () => {
      const event: DepositEvent = {
        vault: MOCK_PUBKEY_1,
        caller: MOCK_PUBKEY_2,
        owner: MOCK_PUBKEY_2, // Often same as caller
        assets: new BN(1_000_000),
        shares: new BN(1_000_000_000),
      };

      expect(event.assets.toNumber()).to.equal(1_000_000);
      expect(event.shares.toNumber()).to.equal(1_000_000_000);
    });

    it("creates valid WithdrawEvent", () => {
      const event: WithdrawEvent = {
        vault: MOCK_PUBKEY_1,
        caller: MOCK_PUBKEY_2,
        receiver: MOCK_PUBKEY_3, // Can be different from caller
        owner: MOCK_PUBKEY_2,
        assets: new BN(500_000),
        shares: new BN(500_000_000),
      };

      expect(event.caller.equals(MOCK_PUBKEY_2)).to.be.true;
      expect(event.receiver.equals(MOCK_PUBKEY_3)).to.be.true;
    });

    it("creates valid VaultStatusChangedEvent", () => {
      const pauseEvent: VaultStatusChangedEvent = {
        vault: MOCK_PUBKEY_1,
        paused: true,
      };

      const unpauseEvent: VaultStatusChangedEvent = {
        vault: MOCK_PUBKEY_1,
        paused: false,
      };

      expect(pauseEvent.paused).to.be.true;
      expect(unpauseEvent.paused).to.be.false;
    });

    it("creates valid AuthorityTransferredEvent", () => {
      const event: AuthorityTransferredEvent = {
        vault: MOCK_PUBKEY_1,
        previousAuthority: MOCK_PUBKEY_2,
        newAuthority: MOCK_PUBKEY_3,
      };

      expect(event.previousAuthority.equals(MOCK_PUBKEY_2)).to.be.true;
      expect(event.newAuthority.equals(MOCK_PUBKEY_3)).to.be.true;
    });

    it("creates valid VaultSyncedEvent", () => {
      const event: VaultSyncedEvent = {
        vault: MOCK_PUBKEY_1,
        previousTotal: new BN(1_000_000),
        newTotal: new BN(1_100_000), // 10% yield
      };

      const yieldAmount = event.newTotal.sub(event.previousTotal);
      expect(yieldAmount.toNumber()).to.equal(100_000);
    });
  });

  describe("Event Discriminators", () => {
    it("has correct discriminator length", () => {
      for (const [name, discriminator] of Object.entries(
        EVENT_DISCRIMINATORS,
      )) {
        expect(discriminator.length).to.equal(
          8,
          `${name} discriminator should be 8 bytes`,
        );
      }
    });

    it("has unique discriminators", () => {
      const discriminatorStrings = Object.values(EVENT_DISCRIMINATORS).map(
        (d) => d.toString("hex"),
      );
      const uniqueDiscriminators = new Set(discriminatorStrings);
      expect(uniqueDiscriminators.size).to.equal(discriminatorStrings.length);
    });
  });

  describe("Event Parsing Helpers", () => {
    // Helper to identify event type from raw data
    const identifyEventType = (
      data: Buffer,
    ): keyof typeof EVENT_DISCRIMINATORS | null => {
      const discriminator = data.slice(0, 8);

      for (const [name, disc] of Object.entries(EVENT_DISCRIMINATORS)) {
        if (discriminator.equals(disc)) {
          return name as keyof typeof EVENT_DISCRIMINATORS;
        }
      }

      return null;
    };

    it("identifies VaultInitialized event", () => {
      const mockData = Buffer.concat([
        EVENT_DISCRIMINATORS.VaultInitialized,
        Buffer.alloc(160), // Mock event data
      ]);

      const eventType = identifyEventType(mockData);
      expect(eventType).to.equal("VaultInitialized");
    });

    it("identifies Deposit event", () => {
      const mockData = Buffer.concat([
        EVENT_DISCRIMINATORS.Deposit,
        Buffer.alloc(128),
      ]);

      const eventType = identifyEventType(mockData);
      expect(eventType).to.equal("Deposit");
    });

    it("identifies Withdraw event", () => {
      const mockData = Buffer.concat([
        EVENT_DISCRIMINATORS.Withdraw,
        Buffer.alloc(160),
      ]);

      const eventType = identifyEventType(mockData);
      expect(eventType).to.equal("Withdraw");
    });

    it("returns null for unknown discriminator", () => {
      const mockData = Buffer.alloc(100);
      const eventType = identifyEventType(mockData);
      expect(eventType).to.be.null;
    });
  });

  describe("Event Log Processing", () => {
    // Mock program log format
    interface ProgramLog {
      signature: string;
      logs: string[];
    }

    const extractEventsFromLogs = (
      logs: string[],
    ): { name: string; data: string }[] => {
      const events: { name: string; data: string }[] = [];

      for (const log of logs) {
        // Anchor emits events with "Program data: <base64>"
        if (log.startsWith("Program data: ")) {
          const base64Data = log.slice("Program data: ".length);
          // In real implementation, decode and parse
          events.push({ name: "RawEvent", data: base64Data });
        }

        // Also check for emit! macro format
        if (log.includes("emit!")) {
          const match = log.match(/emit!\((\w+)\)/);
          if (match) {
            events.push({ name: match[1], data: "" });
          }
        }
      }

      return events;
    };

    it("extracts events from program logs", () => {
      const mockLogs: ProgramLog = {
        signature: "5abc123...",
        logs: [
          "Program SVS1VauLt1111111111111111111111111111111111 invoke [1]",
          "Program log: Instruction: Deposit",
          "Program data: 8iNt...",
          "Program SVS1VauLt1111111111111111111111111111111111 consumed 50000",
          "Program SVS1VauLt1111111111111111111111111111111111 success",
        ],
      };

      const events = extractEventsFromLogs(mockLogs.logs);
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].data).to.equal("8iNt...");
    });

    it("handles logs without events", () => {
      const mockLogs: ProgramLog = {
        signature: "5xyz789...",
        logs: [
          "Program SVS1VauLt1111111111111111111111111111111111 invoke [1]",
          "Program log: No event here",
          "Program SVS1VauLt1111111111111111111111111111111111 success",
        ],
      };

      const events = extractEventsFromLogs(mockLogs.logs);
      expect(events.length).to.equal(0);
    });
  });

  describe("Event Analytics", () => {
    interface DepositSummary {
      totalDeposits: number;
      totalAssetsDeposited: BN;
      totalSharesMinted: BN;
      uniqueDepositors: Set<string>;
    }

    const summarizeDeposits = (events: DepositEvent[]): DepositSummary => {
      const summary: DepositSummary = {
        totalDeposits: 0,
        totalAssetsDeposited: new BN(0),
        totalSharesMinted: new BN(0),
        uniqueDepositors: new Set(),
      };

      for (const event of events) {
        summary.totalDeposits++;
        summary.totalAssetsDeposited = summary.totalAssetsDeposited.add(
          event.assets,
        );
        summary.totalSharesMinted = summary.totalSharesMinted.add(event.shares);
        summary.uniqueDepositors.add(event.owner.toBase58());
      }

      return summary;
    };

    it("summarizes deposit events", () => {
      const events: DepositEvent[] = [
        {
          vault: MOCK_PUBKEY_1,
          caller: MOCK_PUBKEY_2,
          owner: MOCK_PUBKEY_2,
          assets: new BN(1_000_000),
          shares: new BN(1_000_000_000),
        },
        {
          vault: MOCK_PUBKEY_1,
          caller: MOCK_PUBKEY_3,
          owner: MOCK_PUBKEY_3,
          assets: new BN(2_000_000),
          shares: new BN(2_000_000_000),
        },
        {
          vault: MOCK_PUBKEY_1,
          caller: MOCK_PUBKEY_2,
          owner: MOCK_PUBKEY_2, // Same depositor
          assets: new BN(500_000),
          shares: new BN(500_000_000),
        },
      ];

      const summary = summarizeDeposits(events);

      expect(summary.totalDeposits).to.equal(3);
      expect(summary.totalAssetsDeposited.toNumber()).to.equal(3_500_000);
      expect(summary.totalSharesMinted.toNumber()).to.equal(3_500_000_000);
      expect(summary.uniqueDepositors.size).to.equal(2);
    });

    it("handles empty events array", () => {
      const summary = summarizeDeposits([]);

      expect(summary.totalDeposits).to.equal(0);
      expect(summary.totalAssetsDeposited.toNumber()).to.equal(0);
      expect(summary.totalSharesMinted.toNumber()).to.equal(0);
      expect(summary.uniqueDepositors.size).to.equal(0);
    });
  });

  describe("Event Filtering", () => {
    interface VaultEvent {
      type: string;
      vault: PublicKey;
      timestamp?: number;
    }

    const filterEventsByVault = (
      events: VaultEvent[],
      vaultAddress: PublicKey,
    ): VaultEvent[] => {
      return events.filter((e) => e.vault.equals(vaultAddress));
    };

    const filterEventsByType = (
      events: VaultEvent[],
      eventType: string,
    ): VaultEvent[] => {
      return events.filter((e) => e.type === eventType);
    };

    it("filters events by vault address", () => {
      const events: VaultEvent[] = [
        { type: "Deposit", vault: MOCK_PUBKEY_1 },
        { type: "Deposit", vault: MOCK_PUBKEY_2 },
        { type: "Withdraw", vault: MOCK_PUBKEY_1 },
      ];

      const filtered = filterEventsByVault(events, MOCK_PUBKEY_1);
      expect(filtered.length).to.equal(2);
      expect(filtered.every((e) => e.vault.equals(MOCK_PUBKEY_1))).to.be.true;
    });

    it("filters events by type", () => {
      const events: VaultEvent[] = [
        { type: "Deposit", vault: MOCK_PUBKEY_1 },
        { type: "Deposit", vault: MOCK_PUBKEY_2 },
        { type: "Withdraw", vault: MOCK_PUBKEY_1 },
        { type: "VaultStatusChanged", vault: MOCK_PUBKEY_1 },
      ];

      const deposits = filterEventsByType(events, "Deposit");
      expect(deposits.length).to.equal(2);

      const withdraws = filterEventsByType(events, "Withdraw");
      expect(withdraws.length).to.equal(1);
    });

    it("returns empty array when no matches", () => {
      const events: VaultEvent[] = [{ type: "Deposit", vault: MOCK_PUBKEY_1 }];

      const filtered = filterEventsByVault(events, MOCK_PUBKEY_3);
      expect(filtered.length).to.equal(0);
    });
  });

  describe("Share Price Calculation from Events", () => {
    interface PricePoint {
      timestamp: number;
      assets: BN;
      shares: BN;
      pricePerShare: number;
    }

    const calculatePriceFromSync = (
      event: VaultSyncedEvent,
      totalShares: BN,
    ): number => {
      if (totalShares.isZero()) return 1.0;
      return event.newTotal.toNumber() / totalShares.toNumber();
    };

    it("calculates share price from sync event", () => {
      const event: VaultSyncedEvent = {
        vault: MOCK_PUBKEY_1,
        previousTotal: new BN(1_000_000),
        newTotal: new BN(1_100_000),
      };
      const totalShares = new BN(1_000_000_000);

      const price = calculatePriceFromSync(event, totalShares);
      expect(price).to.be.closeTo(0.0011, 0.0001);
    });

    it("returns 1.0 for empty vault", () => {
      const event: VaultSyncedEvent = {
        vault: MOCK_PUBKEY_1,
        previousTotal: new BN(0),
        newTotal: new BN(0),
      };

      const price = calculatePriceFromSync(event, new BN(0));
      expect(price).to.equal(1.0);
    });

    it("tracks price history", () => {
      const priceHistory: PricePoint[] = [];

      // Initial deposit
      priceHistory.push({
        timestamp: 1000,
        assets: new BN(1_000_000),
        shares: new BN(1_000_000_000),
        pricePerShare: 0.001, // 1 share = 0.001 asset
      });

      // After yield
      priceHistory.push({
        timestamp: 2000,
        assets: new BN(1_100_000),
        shares: new BN(1_000_000_000),
        pricePerShare: 0.0011, // 10% yield
      });

      const priceGrowth =
        priceHistory[1].pricePerShare / priceHistory[0].pricePerShare - 1;
      expect(priceGrowth).to.be.closeTo(0.1, 0.01); // 10% growth
    });
  });
});

/** Tests for SVS-10 async vault SDK types */

import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  AsyncVaultState,
  ClaimableEscrowState,
  DepositRequestState,
  OperatorApprovalState,
  RedeemRequestState,
  RequestStatus,
} from "../src/async-vault";

describe("SDK Async Vault Module", () => {
  const VAULT = new PublicKey("2iu8yL4cuJkG5aYQWpn5Tos5mJfsR1D2JibVWA8E3UiT");
  const OWNER = new PublicKey("So11111111111111111111111111111111111111112");
  const RECEIVER = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const OPERATOR = new PublicKey(
    "Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC",
  );

  it("models async vault state with pending aggregates", () => {
    const state: AsyncVaultState = {
      authority: OWNER,
      operator: OPERATOR,
      assetMint: OWNER,
      sharesMint: RECEIVER,
      assetVault: VAULT,
      shareEscrow: OPERATOR,
      totalAssets: new BN(1_000_000),
      totalShares: new BN(2_000_000),
      pendingDepositAssets: new BN(100_000),
      pendingClaimShares: new BN(50_000),
      decimalsOffset: 3,
      bump: 254,
      paused: false,
      vaultId: new BN(10),
      maxStaleness: new BN(120),
      requestExpirySecs: new BN(604_800),
    };

    expect(state.operator.equals(OPERATOR)).to.be.true;
    expect(state.pendingDepositAssets.toString()).to.equal("100000");
    expect(state.pendingClaimShares.toString()).to.equal("50000");
    expect(state.requestExpirySecs.toString()).to.equal("604800");
  });

  it("models deposit request lifecycle state", () => {
    const status: RequestStatus = "fulfilled";
    const request: DepositRequestState = {
      vault: VAULT,
      owner: OWNER,
      receiver: RECEIVER,
      assetsLocked: new BN(500_000),
      sharesClaimable: new BN(498_750),
      status,
      requestedAt: new BN(1_700_000_000),
      fulfilledAt: new BN(1_700_000_600),
      bump: 200,
    };

    expect(request.status).to.equal("fulfilled");
    expect(request.receiver.equals(RECEIVER)).to.be.true;
    expect(request.sharesClaimable.lt(request.assetsLocked)).to.be.true;
  });

  it("models redeem request lifecycle state", () => {
    const request: RedeemRequestState = {
      vault: VAULT,
      owner: OWNER,
      receiver: RECEIVER,
      sharesLocked: new BN(1_000_000),
      assetsClaimable: new BN(999_000),
      status: "pending",
      requestedAt: new BN(1_700_000_000),
      fulfilledAt: new BN(0),
      bump: 199,
    };

    expect(request.status).to.equal("pending");
    expect(request.assetsClaimable.toString()).to.equal("999000");
  });

  it("models claimable escrow and operator approval", () => {
    const escrow: ClaimableEscrowState = {
      vault: VAULT,
      owner: OWNER,
      amount: new BN(777_000),
      bump: 190,
    };
    const approval: OperatorApprovalState = {
      vault: VAULT,
      owner: OWNER,
      operator: OPERATOR,
      approved: true,
      bump: 189,
    };

    expect(escrow.amount.toString()).to.equal("777000");
    expect(approval.operator.equals(OPERATOR)).to.be.true;
    expect(approval.approved).to.be.true;
  });
});

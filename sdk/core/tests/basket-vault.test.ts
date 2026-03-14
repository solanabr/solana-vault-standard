import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import {
  BasketVault,
  BasketVaultConfig,
  AssetConfig,
  DepositSingleParams,
  DepositProportionalParams,
  RedeemSingleParams,
  RedeemProportionalParams,
  RebalanceParams,
  UpdateWeightsParams,
} from '../src/basket-vault';
import { TOKEN_PROGRAM_ID, createMint, createAccount } from '@solana/spl-token';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const RPC = 'http://127.0.0.1:8899';

function mockConnection(): Connection {
  return new Connection(RPC, 'confirmed');
}

function kp(): Keypair {
  return Keypair.generate();
}

/**
 * Build a minimal mock Anchor Program stub so we can unit-test
 * BasketVault without a live validator.
 */
function mockProgram(overrides: Record<string, unknown> = {}): anchor.Program {
  const methods: Record<string, unknown> = {
    initializeVault: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-init'),
    }),
    addAsset: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-add-asset'),
    }),
    removeAsset: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-remove-asset'),
    }),
    updateWeights: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-update-weights'),
    }),
    depositSingle: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-deposit-single'),
    }),
    depositProportional: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-deposit-prop'),
    }),
    redeemSingle: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-redeem-single'),
    }),
    redeemProportional: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-redeem-prop'),
    }),
    rebalance: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-rebalance'),
    }),
    pauseVault: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-pause'),
    }),
    resumeVault: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-resume'),
    }),
    emergencyWithdraw: vi.fn().mockReturnValue({
      accounts: vi.fn().mockReturnThis(),
      remainingAccounts: vi.fn().mockReturnThis(),
      signers: vi.fn().mockReturnThis(),
      rpc: vi.fn().mockResolvedValue('mock-tx-sig-emergency'),
    }),
  };

  const account = {
    multiAssetVault: {
      fetch: vi.fn(),
      fetchNullable: vi.fn(),
      all: vi.fn().mockResolvedValue([]),
    },
  };

  return {
    methods,
    account,
    programId: new PublicKey('SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j'),
    ...overrides,
  } as unknown as anchor.Program;
}

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

const PROGRAM_ID = new PublicKey('SVS8mAaXoGLm5wwF8q5zKnY6NxGkpVAX5yMbVqgEo7j');

function makeAssetConfig(overrides: Partial<AssetConfig> = {}): AssetConfig {
  return {
    mint: kp().publicKey,
    weight: 5000,
    oracle: kp().publicKey,
    decimals: 6,
    ...overrides,
  };
}

function makeVaultConfig(overrides: Partial<BasketVaultConfig> = {}): BasketVaultConfig {
  const assets = [
    makeAssetConfig({ weight: 5000 }),
    makeAssetConfig({ weight: 5000 }),
  ];
  return {
    vaultId: Array.from(new Uint8Array(8).fill(1)),
    assets,
    feeBps: 30,
    managementFeeBps: 100,
    manager: kp().publicKey,
    shareMint: kp().publicKey,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PDA derivation tests
// ---------------------------------------------------------------------------

describe('BasketVault — PDA derivation', () => {
  let sdk: BasketVault;
  let program: anchor.Program;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
  });

  it('derives vault PDA deterministically', () => {
    const vaultId = new Uint8Array(8).fill(42);
    const [pda1] = sdk.findVaultPDA(vaultId);
    const [pda2] = sdk.findVaultPDA(vaultId);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
  });

  it('different vaultIds produce different PDAs', () => {
    const id1 = new Uint8Array(8).fill(1);
    const id2 = new Uint8Array(8).fill(2);
    const [pda1] = sdk.findVaultPDA(id1);
    const [pda2] = sdk.findVaultPDA(id2);
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
  });

  it('derives asset vault PDA with correct seeds', () => {
    const vaultId = new Uint8Array(8).fill(3);
    const mint = kp().publicKey;
    const [pda1] = sdk.findAssetVaultPDA(vaultId, mint);
    const [pda2] = sdk.findAssetVaultPDA(vaultId, mint);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
  });

  it('derives share mint PDA with correct seeds', () => {
    const vaultId = new Uint8Array(8).fill(5);
    const [pda1] = sdk.findShareMintPDA(vaultId);
    const [pda2] = sdk.findShareMintPDA(vaultId);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
  });

  it('different mints produce different asset vault PDAs', () => {
    const vaultId = new Uint8Array(8).fill(7);
    const mint1 = kp().publicKey;
    const mint2 = kp().publicKey;
    const [pda1] = sdk.findAssetVaultPDA(vaultId, mint1);
    const [pda2] = sdk.findAssetVaultPDA(vaultId, mint2);
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
  });
});

// ---------------------------------------------------------------------------
// Weight validation tests
// ---------------------------------------------------------------------------

describe('BasketVault — weight validation', () => {
  let sdk: BasketVault;
  let program: anchor.Program;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
  });

  it('accepts weights summing to exactly 10000 bps', () => {
    const assets = [
      makeAssetConfig({ weight: 3000 }),
      makeAssetConfig({ weight: 3000 }),
      makeAssetConfig({ weight: 4000 }),
    ];
    expect(() => sdk.validateWeights(assets)).not.toThrow();
  });

  it('rejects weights not summing to 10000 bps', () => {
    const assets = [
      makeAssetConfig({ weight: 5000 }),
      makeAssetConfig({ weight: 4000 }),
    ];
    expect(() => sdk.validateWeights(assets)).toThrow(/weights must sum to 10000/i);
  });

  it('rejects empty asset list', () => {
    expect(() => sdk.validateWeights([])).toThrow();
  });

  it('rejects more than 8 assets', () => {
    const assets = Array.from({ length: 9 }, () => makeAssetConfig({ weight: 1111 }));
    expect(() => sdk.validateWeights(assets)).toThrow(/maximum 8 assets/i);
  });

  it('rejects zero weight for any asset', () => {
    const assets = [
      makeAssetConfig({ weight: 10000 }),
      makeAssetConfig({ weight: 0 }),
    ];
    expect(() => sdk.validateWeights(assets)).toThrow(/weight must be positive/i);
  });

  it('accepts single asset with 10000 bps weight', () => {
    const assets = [makeAssetConfig({ weight: 10000 })];
    expect(() => sdk.validateWeights(assets)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// initializeVault tests
// ---------------------------------------------------------------------------

describe('BasketVault — initializeVault', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let payer: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    payer = kp();
  });

  it('calls program.methods.initializeVault with correct arguments', async () => {
    const config = makeVaultConfig();
    const tx = await sdk.initializeVault(config, payer);
    expect(tx).toBe('mock-tx-sig-init');
    expect(program.methods.initializeVault).toHaveBeenCalledOnce();
  });

  it('rejects invalid weights on initializeVault', async () => {
    const config = makeVaultConfig({
      assets: [
        makeAssetConfig({ weight: 5000 }),
        makeAssetConfig({ weight: 4000 }), // sum = 9000 ≠ 10000
      ],
    });
    await expect(sdk.initializeVault(config, payer)).rejects.toThrow();
  });

  it('rejects more than 8 assets on initializeVault', async () => {
    const assets = Array.from({ length: 9 }, (_, i) =>
      makeAssetConfig({ weight: i < 8 ? 1250 : 0 })
    );
    assets[8].weight = 0; // force invalid
    const config = makeVaultConfig({ assets });
    await expect(sdk.initializeVault(config, payer)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// depositSingle tests
// ---------------------------------------------------------------------------

describe('BasketVault — depositSingle', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let user: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    user = kp();
  });

  it('calls depositSingle and returns transaction signature', async () => {
    const params: DepositSingleParams = {
      vaultId: new Uint8Array(8).fill(1),
      assetMint: kp().publicKey,
      assetIndex: 0,
      amount: new BN(1_000_000),
      minSharesOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [kp().publicKey, kp().publicKey],
    };
    const tx = await sdk.depositSingle(params, user);
    expect(tx).toBe('mock-tx-sig-deposit-single');
    expect(program.methods.depositSingle).toHaveBeenCalledOnce();
  });

  it('rejects zero amount deposit', async () => {
    const params: DepositSingleParams = {
      vaultId: new Uint8Array(8).fill(1),
      assetMint: kp().publicKey,
      assetIndex: 0,
      amount: new BN(0),
      minSharesOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [],
    };
    await expect(sdk.depositSingle(params, user)).rejects.toThrow(/amount must be positive/i);
  });

  it('rejects assetIndex >= 8', async () => {
    const params: DepositSingleParams = {
      vaultId: new Uint8Array(8).fill(1),
      assetMint: kp().publicKey,
      assetIndex: 8,
      amount: new BN(1_000_000),
      minSharesOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [],
    };
    await expect(sdk.depositSingle(params, user)).rejects.toThrow(/asset index out of range/i);
  });
});

// ---------------------------------------------------------------------------
// depositProportional tests
// ---------------------------------------------------------------------------

describe('BasketVault — depositProportional', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let user: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    user = kp();
  });

  it('calls depositProportional and returns tx signature', async () => {
    const assets = [
      { mint: kp().publicKey, userTokenAccount: kp().publicKey, oracle: kp().publicKey },
      { mint: kp().publicKey, userTokenAccount: kp().publicKey, oracle: kp().publicKey },
    ];
    const params: DepositProportionalParams = {
      vaultId: new Uint8Array(8).fill(2),
      shareAmountOut: new BN(1_000_000),
      maxAmountsIn: [new BN(500_000), new BN(500_000)],
      userShareAccount: kp().publicKey,
      assets,
    };
    const tx = await sdk.depositProportional(params, user);
    expect(tx).toBe('mock-tx-sig-deposit-prop');
    expect(program.methods.depositProportional).toHaveBeenCalledOnce();
  });

  it('rejects mismatched maxAmountsIn length', async () => {
    const assets = [
      { mint: kp().publicKey, userTokenAccount: kp().publicKey, oracle: kp().publicKey },
    ];
    const params: DepositProportionalParams = {
      vaultId: new Uint8Array(8).fill(2),
      shareAmountOut: new BN(1_000_000),
      maxAmountsIn: [new BN(500_000), new BN(500_000)], // length mismatch
      userShareAccount: kp().publicKey,
      assets,
    };
    await expect(sdk.depositProportional(params, user)).rejects.toThrow(/maxAmountsIn length/i);
  });
});

// ---------------------------------------------------------------------------
// redeemSingle tests
// ---------------------------------------------------------------------------

describe('BasketVault — redeemSingle', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let user: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    user = kp();
  });

  it('calls redeemSingle and returns tx signature', async () => {
    const params: RedeemSingleParams = {
      vaultId: new Uint8Array(8).fill(3),
      assetMint: kp().publicKey,
      assetIndex: 1,
      sharesIn: new BN(500_000),
      minAmountOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [kp().publicKey],
    };
    const tx = await sdk.redeemSingle(params, user);
    expect(tx).toBe('mock-tx-sig-redeem-single');
    expect(program.methods.redeemSingle).toHaveBeenCalledOnce();
  });

  it('rejects zero shares redemption', async () => {
    const params: RedeemSingleParams = {
      vaultId: new Uint8Array(8).fill(3),
      assetMint: kp().publicKey,
      assetIndex: 0,
      sharesIn: new BN(0),
      minAmountOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [],
    };
    await expect(sdk.redeemSingle(params, user)).rejects.toThrow(/shares must be positive/i);
  });
});

// ---------------------------------------------------------------------------
// redeemProportional tests
// ---------------------------------------------------------------------------

describe('BasketVault — redeemProportional', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let user: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    user = kp();
  });

  it('calls redeemProportional and returns tx signature', async () => {
    const assets = [
      { mint: kp().publicKey, userTokenAccount: kp().publicKey, oracle: kp().publicKey },
      { mint: kp().publicKey, userTokenAccount: kp().publicKey, oracle: kp().publicKey },
    ];
    const params: RedeemProportionalParams = {
      vaultId: new Uint8Array(8).fill(4),
      sharesIn: new BN(1_000_000),
      minAmountsOut: [new BN(0), new BN(0)],
      userShareAccount: kp().publicKey,
      assets,
    };
    const tx = await sdk.redeemProportional(params, user);
    expect(tx).toBe('mock-tx-sig-redeem-prop');
    expect(program.methods.redeemProportional).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// rebalance tests
// ---------------------------------------------------------------------------

describe('BasketVault — rebalance', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let manager: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    manager = kp();
  });

  it('calls rebalance and returns tx signature', async () => {
    const params: RebalanceParams = {
      vaultId: new Uint8Array(8).fill(5),
      fromAssetIndex: 0,
      toAssetIndex: 1,
      fromMint: kp().publicKey,
      toMint: kp().publicKey,
      amount: new BN(100_000),
      minAmountOut: new BN(0),
      oracles: [kp().publicKey, kp().publicKey],
    };
    const tx = await sdk.rebalance(params, manager);
    expect(tx).toBe('mock-tx-sig-rebalance');
    expect(program.methods.rebalance).toHaveBeenCalledOnce();
  });

  it('rejects rebalance when fromIndex === toIndex', async () => {
    const params: RebalanceParams = {
      vaultId: new Uint8Array(8).fill(5),
      fromAssetIndex: 2,
      toAssetIndex: 2, // same!
      fromMint: kp().publicKey,
      toMint: kp().publicKey,
      amount: new BN(100_000),
      minAmountOut: new BN(0),
      oracles: [],
    };
    await expect(sdk.rebalance(params, manager)).rejects.toThrow(/from and to index must differ/i);
  });
});

// ---------------------------------------------------------------------------
// updateWeights tests
// ---------------------------------------------------------------------------

describe('BasketVault — updateWeights', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let manager: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    manager = kp();
  });

  it('calls updateWeights and returns tx signature', async () => {
    const params: UpdateWeightsParams = {
      vaultId: new Uint8Array(8).fill(6),
      newWeights: [6000, 4000],
    };
    const tx = await sdk.updateWeights(params, manager);
    expect(tx).toBe('mock-tx-sig-update-weights');
    expect(program.methods.updateWeights).toHaveBeenCalledOnce();
  });

  it('rejects weights not summing to 10000', async () => {
    const params: UpdateWeightsParams = {
      vaultId: new Uint8Array(8).fill(6),
      newWeights: [4000, 4000], // sum = 8000
    };
    await expect(sdk.updateWeights(params, manager)).rejects.toThrow(/weights must sum to 10000/i);
  });
});

// ---------------------------------------------------------------------------
// pauseVault / resumeVault tests
// ---------------------------------------------------------------------------

describe('BasketVault — pause/resume', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let manager: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    manager = kp();
  });

  it('calls pauseVault and returns tx signature', async () => {
    const tx = await sdk.pauseVault(new Uint8Array(8).fill(7), manager);
    expect(tx).toBe('mock-tx-sig-pause');
    expect(program.methods.pauseVault).toHaveBeenCalledOnce();
  });

  it('calls resumeVault and returns tx signature', async () => {
    const tx = await sdk.resumeVault(new Uint8Array(8).fill(7), manager);
    expect(tx).toBe('mock-tx-sig-resume');
    expect(program.methods.resumeVault).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// emergencyWithdraw tests
// ---------------------------------------------------------------------------

describe('BasketVault — emergencyWithdraw', () => {
  let sdk: BasketVault;
  let program: anchor.Program;
  let manager: Keypair;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
    manager = kp();
  });

  it('calls emergencyWithdraw and returns tx signature', async () => {
    const assets = [
      { mint: kp().publicKey, destination: kp().publicKey },
      { mint: kp().publicKey, destination: kp().publicKey },
    ];
    const tx = await sdk.emergencyWithdraw(new Uint8Array(8).fill(8), assets, manager);
    expect(tx).toBe('mock-tx-sig-emergency');
    expect(program.methods.emergencyWithdraw).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// fetchVault tests
// ---------------------------------------------------------------------------

describe('BasketVault — fetchVault', () => {
  let sdk: BasketVault;
  let program: anchor.Program;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
  });

  it('calls account.multiAssetVault.fetch with correct PDA', async () => {
    const mockVaultData = {
      vaultId: new Uint8Array(8).fill(9),
      assets: [],
      totalShares: new BN(0),
      feeBps: 30,
      managementFeeBps: 100,
      paused: false,
    };
    (program.account.multiAssetVault.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockVaultData);

    const vaultId = new Uint8Array(8).fill(9);
    const data = await sdk.fetchVault(vaultId);
    expect(data).toEqual(mockVaultData);
    expect(program.account.multiAssetVault.fetch).toHaveBeenCalledOnce();
  });

  it('returns null when vault does not exist', async () => {
    (program.account.multiAssetVault.fetchNullable as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const vaultId = new Uint8Array(8).fill(99);
    const data = await sdk.fetchVaultNullable(vaultId);
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Math / fee computation helpers
// ---------------------------------------------------------------------------

describe('BasketVault — fee calculation helpers', () => {
  let sdk: BasketVault;

  beforeEach(() => {
    const program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
  });

  it('computes deposit fee correctly at 30 bps', () => {
    const amount = new BN(1_000_000);
    const feeBps = 30;
    const fee = sdk.computeFee(amount, feeBps);
    // 1_000_000 * 30 / 10_000 = 3_000
    expect(fee.toNumber()).toBe(3_000);
  });

  it('computes zero fee when feeBps is 0', () => {
    const fee = sdk.computeFee(new BN(1_000_000), 0);
    expect(fee.toNumber()).toBe(0);
  });

  it('rounds fee down on fractional results', () => {
    const amount = new BN(1_000_001);
    const feeBps = 30;
    const fee = sdk.computeFee(amount, feeBps);
    // 1_000_001 * 30 / 10_000 = 3000.003 → floor = 3000
    expect(fee.toNumber()).toBe(3_000);
  });

  it('computeProportionalAmounts returns correct split for 2 assets at 50/50', () => {
    const totalUsdValue = new BN(1_000_000_000); // 1000 USD in lamports
    const weights = [5000, 5000]; // 50/50
    const amounts = sdk.computeProportionalAmounts(totalUsdValue, weights);
    expect(amounts).toHaveLength(2);
    expect(amounts[0].toNumber()).toBe(500_000_000);
    expect(amounts[1].toNumber()).toBe(500_000_000);
  });

  it('computeProportionalAmounts handles 3 assets at 40/40/20', () => {
    const totalUsdValue = new BN(1_000_000);
    const weights = [4000, 4000, 2000];
    const amounts = sdk.computeProportionalAmounts(totalUsdValue, weights);
    expect(amounts[0].toNumber()).toBe(400_000);
    expect(amounts[1].toNumber()).toBe(400_000);
    expect(amounts[2].toNumber()).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('BasketVault — edge cases', () => {
  let sdk: BasketVault;
  let program: anchor.Program;

  beforeEach(() => {
    program = mockProgram();
    sdk = new BasketVault(program, PROGRAM_ID);
  });

  it('accepts maximum 8 assets in initializeVault', async () => {
    const assets = Array.from({ length: 8 }, (_, i) =>
      makeAssetConfig({ weight: 1250 }) // 8 × 1250 = 10000
    );
    const config = makeVaultConfig({ assets });
    const tx = await sdk.initializeVault(config, kp());
    expect(tx).toBe('mock-tx-sig-init');
  });

  it('handles BN amounts > u64 max gracefully', async () => {
    const MAX_U64 = new BN('18446744073709551615');
    const params: DepositSingleParams = {
      vaultId: new Uint8Array(8).fill(1),
      assetMint: kp().publicKey,
      assetIndex: 0,
      amount: MAX_U64,
      minSharesOut: new BN(0),
      userTokenAccount: kp().publicKey,
      userShareAccount: kp().publicKey,
      oracles: [],
    };
    // Should not throw — validation is on-chain
    const tx = await sdk.depositSingle(params, kp());
    expect(tx).toBe('mock-tx-sig-deposit-single');
  });

  it('constructs BasketVault with custom program ID', () => {
    const customId = kp().publicKey;
    const sdk2 = new BasketVault(program, customId);
    expect(sdk2.programId.toBase58()).toBe(customId.toBase58());
  });
});

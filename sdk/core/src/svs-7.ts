/**
 * SVS-7 Native SOL Vault SDK
 *
 * Provides a high-level interface for interacting with SVS-7 vaults.
 * Accepts native SOL directly, handles wSOL wrapping/unwrapping internally.
 *
 * @example
 * ```ts
 * import { SolVaultSDK } from "@stbr/solana-vault";
 *
 * const vault = await SolVaultSDK.load(program, 1);
 * await vault.depositSol(user, { lamports: new BN(LAMPORTS_PER_SOL), minSharesOut: new BN(0) });
 * ```
 */

import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT,
    getAssociatedTokenAddressSync,
    getAccount,
    getMint,
} from "@solana/spl-token";

// ============ Types ============

export interface SolVaultState {
    authority: PublicKey;
    sharesMint: PublicKey;
    wsolVault: PublicKey;
    totalAssets: BN;
    decimalsOffset: number;
    bump: number;
    paused: boolean;
    vaultId: BN;
    balanceModel: { live: {} } | { stored: {} };
}

export interface DepositSolParams {
    lamports: BN;
    minSharesOut: BN;
}

export interface DepositWsolParams {
    amount: BN;
    minSharesOut: BN;
}

export interface MintSolParams {
    shares: BN;
    maxLamportsIn: BN;
}

export interface WithdrawSolParams {
    lamports: BN;
    maxSharesIn: BN;
}

export interface WithdrawWsolParams {
    amount: BN;
    maxSharesIn: BN;
}

export interface RedeemSolParams {
    shares: BN;
    minLamportsOut: BN;
}

export interface RedeemWsolParams {
    shares: BN;
    minAmountOut: BN;
}

export interface CreateSolVaultParams {
    vaultId: BN | number;
    balanceModel: "live" | "stored";
    name: string;
    symbol: string;
    uri: string;
}

// ============ PDA Derivation ============

export function deriveSolVaultAddresses(
    programId: PublicKey,
    vaultId: BN | number
): {
    vault: PublicKey;
    sharesMint: PublicKey;
} {
    const id = typeof vaultId === "number" ? new BN(vaultId) : vaultId;

    const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from("sol_vault"), id.toArrayLike(Buffer, "le", 8)],
        programId
    );

    const [sharesMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("shares"), vault.toBuffer()],
        programId
    );

    return { vault, sharesMint };
}

// ============ SDK Class ============

export class SolVaultSDK {
    readonly program: Program;
    readonly provider: AnchorProvider;
    readonly vault: PublicKey;
    readonly sharesMint: PublicKey;
    readonly wsolVault: PublicKey;
    readonly vaultId: BN;

    private cachedState: SolVaultState | null = null;

    constructor(
        program: Program,
        provider: AnchorProvider,
        vault: PublicKey,
        sharesMint: PublicKey,
        wsolVault: PublicKey,
        vaultId: BN
    ) {
        this.program = program;
        this.provider = provider;
        this.vault = vault;
        this.sharesMint = sharesMint;
        this.wsolVault = wsolVault;
        this.vaultId = vaultId;
    }

    // ============ Factory Methods ============

    static async load(
        program: Program,
        vaultId: BN | number
    ): Promise<SolVaultSDK> {
        const provider = program.provider as AnchorProvider;
        const { vault, sharesMint } = deriveSolVaultAddresses(
            program.programId,
            vaultId
        );

        const vaultState = (await program.account.solVault.fetch(
            vault
        )) as unknown as SolVaultState;

        return new SolVaultSDK(
            program,
            provider,
            vault,
            sharesMint,
            vaultState.wsolVault,
            typeof vaultId === "number" ? new BN(vaultId) : vaultId
        );
    }

    static async create(
        program: Program,
        params: CreateSolVaultParams
    ): Promise<SolVaultSDK> {
        const provider = program.provider as AnchorProvider;
        const vaultId =
            typeof params.vaultId === "number"
                ? new BN(params.vaultId)
                : params.vaultId;
        const { vault, sharesMint } = deriveSolVaultAddresses(
            program.programId,
            vaultId
        );

        const wsolVault = getAssociatedTokenAddressSync(
            NATIVE_MINT,
            vault,
            true,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const balanceModel = params.balanceModel === "live" ? 0 : 1;

        await program.methods
            .initialize(vaultId, balanceModel, params.name, params.symbol, params.uri)
            .accountsStrict({
                authority: provider.wallet.publicKey,
                vault,
                nativeMint: NATIVE_MINT,
                sharesMint,
                wsolVault,
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .rpc();

        return new SolVaultSDK(
            program,
            provider,
            vault,
            sharesMint,
            wsolVault,
            vaultId
        );
    }

    // ============ State ============

    async refresh(): Promise<SolVaultState> {
        this.cachedState = (await this.program.account.solVault.fetch(
            this.vault
        )) as unknown as SolVaultState;
        return this.cachedState;
    }

    async getState(): Promise<SolVaultState> {
        if (!this.cachedState) {
            return this.refresh();
        }
        return this.cachedState;
    }

    // ============ Account Helpers ============

    getUserSharesAccount(owner: PublicKey): PublicKey {
        return getAssociatedTokenAddressSync(
            this.sharesMint,
            owner,
            false,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
    }

    // ============ Deposit ============

    async depositSol(
        user: PublicKey,
        params: DepositSolParams
    ): Promise<string> {
        return this.program.methods
            .depositSol(params.lamports, params.minSharesOut)
            .accountsStrict({
                depositor: user,
                vault: this.vault,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async depositWsol(
        user: PublicKey,
        params: DepositWsolParams,
        userWsolAccount: PublicKey
    ): Promise<string> {
        return this.program.methods
            .depositWsol(params.amount, params.minSharesOut)
            .accountsStrict({
                depositor: user,
                vault: this.vault,
                nativeMint: NATIVE_MINT,
                userWsolAccount,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async mintSol(user: PublicKey, params: MintSolParams): Promise<string> {
        return this.program.methods
            .mintSol(params.shares, params.maxLamportsIn)
            .accountsStrict({
                depositor: user,
                vault: this.vault,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    // ============ Withdraw ============

    async withdrawSol(
        user: PublicKey,
        params: WithdrawSolParams
    ): Promise<string> {
        return this.program.methods
            .withdrawSol(params.lamports, params.maxSharesIn)
            .accountsStrict({
                user,
                vault: this.vault,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async withdrawWsol(
        user: PublicKey,
        params: WithdrawWsolParams,
        userWsolAccount: PublicKey
    ): Promise<string> {
        return this.program.methods
            .withdrawWsol(params.amount, params.maxSharesIn)
            .accountsStrict({
                user,
                vault: this.vault,
                nativeMint: NATIVE_MINT,
                userWsolAccount,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();
    }

    // ============ Redeem ============

    async redeemSol(
        user: PublicKey,
        params: RedeemSolParams
    ): Promise<string> {
        return this.program.methods
            .redeemSol(params.shares, params.minLamportsOut)
            .accountsStrict({
                user,
                vault: this.vault,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    }

    async redeemWsol(
        user: PublicKey,
        params: RedeemWsolParams,
        userWsolAccount: PublicKey
    ): Promise<string> {
        return this.program.methods
            .redeemWsol(params.shares, params.minAmountOut)
            .accountsStrict({
                user,
                vault: this.vault,
                nativeMint: NATIVE_MINT,
                userWsolAccount,
                wsolVault: this.wsolVault,
                sharesMint: this.sharesMint,
                userSharesAccount: this.getUserSharesAccount(user),
                wsolTokenProgram: TOKEN_PROGRAM_ID,
                token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .rpc();
    }

    // ============ View Functions ============

    async totalAssets(): Promise<BN> {
        const account = await getAccount(
            this.provider.connection,
            this.wsolVault
        );
        return new BN(account.amount.toString());
    }

    async totalShares(): Promise<BN> {
        const mint = await getMint(
            this.provider.connection,
            this.sharesMint,
            undefined,
            TOKEN_2022_PROGRAM_ID
        );
        return new BN(mint.supply.toString());
    }

    async previewDeposit(assets: BN): Promise<BN> {
        const result = await this.program.methods
            .previewDeposit(assets)
            .accountsStrict({
                vault: this.vault,
                sharesMint: this.sharesMint,
                wsolVault: this.wsolVault,
            })
            .simulate();

        return this.parseReturnData(result);
    }

    async previewMint(shares: BN): Promise<BN> {
        const result = await this.program.methods
            .previewMint(shares)
            .accountsStrict({
                vault: this.vault,
                sharesMint: this.sharesMint,
                wsolVault: this.wsolVault,
            })
            .simulate();

        return this.parseReturnData(result);
    }

    async previewWithdraw(assets: BN): Promise<BN> {
        const result = await this.program.methods
            .previewWithdraw(assets)
            .accountsStrict({
                vault: this.vault,
                sharesMint: this.sharesMint,
                wsolVault: this.wsolVault,
            })
            .simulate();

        return this.parseReturnData(result);
    }

    async previewRedeem(shares: BN): Promise<BN> {
        const result = await this.program.methods
            .previewRedeem(shares)
            .accountsStrict({
                vault: this.vault,
                sharesMint: this.sharesMint,
                wsolVault: this.wsolVault,
            })
            .simulate();

        return this.parseReturnData(result);
    }

    // ============ Admin ============

    async pause(): Promise<string> {
        return this.program.methods
            .pause()
            .accountsStrict({
                authority: this.provider.wallet.publicKey,
                vault: this.vault,
            })
            .rpc();
    }

    async unpause(): Promise<string> {
        return this.program.methods
            .unpause()
            .accountsStrict({
                authority: this.provider.wallet.publicKey,
                vault: this.vault,
            })
            .rpc();
    }

    async sync(): Promise<string> {
        return this.program.methods
            .sync()
            .accountsStrict({
                caller: this.provider.wallet.publicKey,
                vault: this.vault,
                wsolVault: this.wsolVault,
                wsolTokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    async isPaused(): Promise<boolean> {
        const state = await this.getState();
        return state.paused;
    }

    async getAuthority(): Promise<PublicKey> {
        const state = await this.getState();
        return state.authority;
    }

    // ============ Helpers ============

    private parseReturnData(result: any): BN {
        if (result.returnData && result.returnData.data) {
            const data = Buffer.from(result.returnData.data[0], "base64");
            return new BN(data, "le");
        }
        return new BN(0);
    }
}

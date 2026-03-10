import { 
  Transaction, 
  SystemProgram, 
  PublicKey, 
  Keypair 
} from '@solana/web3.js';
import { 
  TOKEN_PROGRAM_ID, 
  TOKEN_2022_PROGRAM_ID, 
  getAssociatedTokenAddressSync,
  createInitializeAccountInstruction,
  MINT_SIZE,
  getMinimumBalanceForRentExemptAccount
} from '@solana/spl-token';
import { Program, BN } from '@coral-xyz/anchor';

// Endereço oficial do wSOL (Wrapped SOL)
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * SVS7Client: Interface de alto nível para o Solana Vault Standard 7 (Native SOL).
 * Gerencia a complexidade de wrap/unwrap de SOL nativo automaticamente.
 */
export class SVS7Client {
  constructor(public program: Program) {}

  /**
   * DEPOSIT_SOL: Transfere SOL nativo -> wraps para wSOL -> emite Shares.
   * UX simplificada para o usuário final.
   */
  async depositSol(vault: PublicKey, amount: number, minSharesOut: number = 0) {
    const user = this.program.provider.publicKey!;
    const vaultState = await this.program.account.vault.fetch(vault);
    
    const userSharesAta = getAssociatedTokenAddressSync(
      vaultState.sharesMint,
      user,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    return await this.program.methods
      .depositSol(new BN(amount), new BN(minSharesOut))
      .accounts({
        user: user,
        vault: vault,
        wsolVault: vaultState.assetVault,
        sharesMint: vaultState.sharesMint,
        userSharesAccount: userSharesAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * WITHDRAW_SOL: Queima shares -> unwrap wSOL -> recebe SOL nativo.
   * Cria e fecha uma conta temporária de wSOL de forma atômica.
   */
  async withdrawSol(vault: PublicKey, assets: number, maxSharesIn: number) {
    const user = this.program.provider.publicKey!;
    const vaultState = await this.program.account.vault.fetch(vault);
    
    // 1. Gerar conta temporária efêmera para o unwrap
    const tempWsolAccount = Keypair.generate();
    const rentExempt = await getMinimumBalanceForRentExemptAccount(this.program.provider.connection);

    // 2. Instruções para criar e inicializar a conta temporária
    const createTempAccIx = SystemProgram.createAccount({
      fromPubkey: user,
      newAccountPubkey: tempWsolAccount.publicKey,
      space: MINT_SIZE,
      lamports: rentExempt,
      programId: TOKEN_PROGRAM_ID,
    });

    const initTempAccIx = createInitializeAccountInstruction(
      tempWsolAccount.publicKey,
      WSOL_MINT,
      vault // O cofre precisa ser o owner para fechar a conta via CPI
    );

    // 3. Instrução on-chain principal
    const withdrawIx = await this.program.methods
      .withdrawSol(new BN(assets), new BN(maxSharesIn))
      .accounts({
        user: user,
        vault: vault,
        wsolVault: vaultState.assetVault,
        sharesMint: vaultState.sharesMint,
        userSharesAccount: getAssociatedTokenAddressSync(vaultState.sharesMint, user, false, TOKEN_2022_PROGRAM_ID),
        tempWsolAccount: tempWsolAccount.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // 4. Bundling atômico
    const tx = new Transaction().add(createTempAccIx, initTempAccIx, withdrawIx);

    return await this.program.provider.sendAndConfirm!(tx, [tempWsolAccount]);
  }
}
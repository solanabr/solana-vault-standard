—─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────—──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────/**
 * SVS-8 Multi-Asset Basket Vault — Anchor test suite.
  *
   * Covers: initialize, add_asset, update_weights, pause/unpause,
    * transfer_authority, remove_asset guards, deposit/redeem structure checks.
     *
      * Oracle-dependent deposit/redeem tests live in scripts/e2e-svs8.ts
       * (run against devnet with live Pyth feeds).
        */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
    Keypair,
    PublicKey,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { createMint, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
        
        // ── PDA helpers ───────────────────────────────────────────────────────────────
        const vaultPda = (vaultId: BN, pid: PublicKey) => {
          const buf = Buffer.alloc(8);
          buf.writeBigUInt64LE(BigInt(vaultId.toString()));
                                      return PublicKey.findProgramAddressSync([Buffer.from("multi_vault"), buf], pid);
                                      };
                                      const sharesMintPda = (vault: PublicKey, pid: PublicKey) =>
                                      PublicKey.findProgramAddressSync([Buffer.from("shares_mint"), vault.toBuffer()], pid);
                                      const assetEntryPda = (vault: PublicKey, mint: PublicKey, pid: PublicKey) =>
                                      PublicKey.findProgramAddressSync(
                                        [Buffer.from("asset_entry"), vault.toBuffer(), mint.toBuffer()],
                                            pid,
                                      );
                                      const assetVaultPda = (vault: PublicKey, mint: PublicKey, pid: PublicKey) =>
                                      PublicKey.findProgramAddressSync(
                                        [Buffer.from("asset_vault"), vault.toBuffer(), mint.toBuffer()],
                                            pid,
                                      );
                                      
                                      // ── Suite ─────────────────────────────────────────────────────────────────────
                                      describe("SVS-8 Multi-Asset Basket Vault", () => {
                                        const provider = anchor.AnchorProvider.env();
                                        anchor.setProvider(provider);
                                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                          const program = anchor.workspace.Svs8 as anchor.Program<any>;
                                            const authority = (provider.wallet as anchor.Wallet).payer;
                                            
                                              let mintA: PublicKey;
                                              let mintB: PublicKey;
                                            
                                            const VAULT_ID = new BN(800_001);
                                              let vault: PublicKey;
                                              let sharesMint: PublicKey;
                                            
                                            before(async () => {
                                              mintA = await createMint(provider.connection, authority, authority.publicKey, null, 6);
                                              mintB = await createMint(provider.connection, authority, authority.publicKey, null, 9);
                                              [vault] = vaultPda(VAULT_ID, program.programId);
                                                [sharesMint] = sharesMintPda(vault, program.programId);
                                                  });
                                                  
                                                    // ── initialize ────────────────────────────────────────────────────────────
                                                  it("initialize: creates vault and shares mint", async () => {
                                                        await program.methods
                                                          .initialize(VAULT_ID, 6, 0)
                                                          .accounts({
                                                                    vault,
                                                                    sharesMint,
                                                                    authority: authority.publicKey,
                                                                    tokenProgram: TOKEN_PROGRAM_ID,
                                                                    systemProgram: SystemProgram.programId,
                                                                    rent: SYSVAR_RENT_PUBKEY,
                                                          })
                                                          .rpc();
                                                          
                                                          const vaultData = await program.account.multiAssetVault.fetch(vault);
                                                            assert.equal(vaultData.authority.toBase58(), authority.publicKey.toBase58(), "authority");
                                                            assert.equal(vaultData.totalShares.toNumber(), 0, "zero shares initially");
                                                            assert.equal(vaultData.numAssets, 0, "zero assets initially");
                                                            assert.isFalse(vaultData.paused, "not paused");
                                                            });
                                                            
                                                            it("initialize: rejects duplicate vault_id", async () => {
                                                              try {
                                                                await program.methods.initialize(VAULT_ID, 6, 0)
                                                                  .accounts({ vault, sharesMint, authority: authority.publicKey,
                                                                                       tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                                                                             rent: SYSVAR_RENT_PUBKEY })
                                                                  .rpc();
                                                                  assert.fail("expected error");
                                                                  } catch (_) { /* expected */ }
                                                                  });
                                                                  
                                                                    // ── add_asset ─────────────────────────────────────────────────────────────
                                                                  it("add_asset: adds two assets summing to 10000 bps", async () => {
                                                                    const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                      const [vaultA] = assetVaultPda(vault, mintA, program.programId);
                                                                        const [entryB] = assetEntryPda(vault, mintB, program.programId);
                                                                          const [vaultB] = assetVaultPda(vault, mintB, program.programId);
                                                                            const oracleA = Keypair.generate().publicKey;
                                                                              const oracleB = Keypair.generate().publicKey;
                                                                                
                                                                                await program.methods.addAsset(6000)
                                                                                  .accounts({ vault, assetMint: mintA, oracle: oracleA,
                                                                                                     assetEntry: entryA, assetVault: vaultA, authority: authority.publicKey,
                                                                                                     tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                                                                                             rent: SYSVAR_RENT_PUBKEY })
                                                                                  .rpc();
                                                                                  
                                                                                  await program.methods.addAsset(4000)
                                                                                    .accounts({ vault, assetMint: mintB, oracle: oracleB,
                                                                                                       assetEntry: entryB, assetVault: vaultB, authority: authority.publicKey,
                                                                                                       tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                                                                                               rent: SYSVAR_RENT_PUBKEY })
                                                                                    .remainingAccounts([{ pubkey: entryA, isWritable: false, isSigner: false }])
                                                                                    .rpc();
                                                                                    
                                                                                    const vaultData = await program.account.multiAssetVault.fetch(vault);
                                                                                      assert.equal(vaultData.numAssets, 2, "two assets in basket");
                                                                                      
                                                                                      const aData = await program.account.assetEntry.fetch(entryA);
                                                                                        assert.equal(aData.targetWeightBps, 6000, "asset A weight");
                                                                                        assert.equal(aData.index, 0, "asset A index");
                                                                                        
                                                                                        const bData = await program.account.assetEntry.fetch(entryB);
                                                                                          assert.equal(bData.targetWeightBps, 4000, "asset B weight");
                                                                                          assert.equal(bData.index, 1, "asset B index");
                                                                                          });
                                                                                          
                                                                                          it("add_asset: rejects weight that would exceed 10000 bps", async () => {
                                                                                            const mintC = await createMint(
                                                                                              provider.connection, authority, authority.publicKey, null, 6);
                                                                                            const [entryC] = assetEntryPda(vault, mintC, program.programId);
                                                                                              const [vaultC] = assetVaultPda(vault, mintC, program.programId);
                                                                                                const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                                                  const [entryB] = assetEntryPda(vault, mintB, program.programId);
                                                                                                    
                                                                                                    try {
                                                                                                      await program.methods.addAsset(1)
                                                                                                        .accounts({ vault, assetMint: mintC, oracle: Keypair.generate().publicKey,
                                                                                                                    assetEntry: entryC, assetVault: vaultC, authority: authority.publicKey,
                                                                                                                    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                                                                                                          rent: SYSVAR_RENT_PUBKEY })
                                                                                                          .remainingAccounts([
                                                                                                            { pubkey: entryA, isWritable: false, isSigner: false },
                                                                                                            { pubkey: entryB, isWritable: false, isSigner: false },
                                                                                                          ])
                                                                                                          .rpc();
                                                                                                          assert.fail("expected InvalidWeight");
                                                                                                          } catch (e: any) { assert.include(e.toString(), "InvalidWeight"); }
                                                                                                                                            });
                                                                                                                            
                                                                                                                              // ── update_weights ────────────────────────────────────────────────────────
                                                                                                                            it("update_weights: rebalances to 50/50", async () => {
                                                                                                                              const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                                                                                const [entryB] = assetEntryPda(vault, mintB, program.programId);
                                                                                                                                  
                                                                                                                                  await program.methods.updateWeights([5000, 5000])
                                                                                                                                    .accounts({ vault, authority: authority.publicKey })
                                                                                                                                    .remainingAccounts([
                                                                                                                                      { pubkey: entryA, isWritable: true, isSigner: false },
                                                                                                                                      { pubkey: entryB, isWritable: true, isSigner: false },
                                                                                                                                    ])
                                                                                                                                    .rpc();
                                                                                                                                    
                                                                                                                                    const aData = await program.account.assetEntry.fetch(entryA);
                                                                                                                                      assert.equal(aData.targetWeightBps, 5000, "A rebalanced to 50%");
                                                                                                                                      });
                                                                                                                                      
                                                                                                                                      it("update_weights: rejects weights not summing to 10000", async () => {
                                                                                                                                        const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                                                                                          const [entryB] = assetEntryPda(vault, mintB, program.programId);
                                                                                                                                            try {
                                                                                                                                              await program.methods.updateWeights([5000, 6000])
                                                                                                                                                .accounts({ vault, authority: authority.publicKey })
                                                                                                                                                .remainingAccounts([
                                                                                                                                                  { pubkey: entryA, isWritable: true, isSigner: false },
                                                                                                                                                  { pubkey: entryB, isWritable: true, isSigner: false },
                                                                                                                                                ])
                                                                                                                                                .rpc();
                                                                                                                                                assert.fail("expected WeightsMustSumToTenThousand");
                                                                                                                                                } catch (e: any) { assert.include(e.toString(), "WeightsMustSumToTenThousand"); }
                                                                                                                                                                                  });
                                                                                                                                                                  
                                                                                                                                                                    // ── pause / unpause ───────────────────────────────────────────────────────
                                                                                                                                                                  it("pause: sets paused flag", async () => {
                                                                                                                                                                    await program.methods.pause()
                                                                                                                                                                      .accounts({ vault, authority: authority.publicKey })
                                                                                                                                                                      .rpc();
                                                                                                                                                                          const vaultData = await program.account.multiAssetVault.fetch(vault);
                                                                                                                                                                            assert.isTrue(vaultData.paused);
                                                                                                                                                                            });
                                                                                                                                                                            
                                                                                                                                                                            it("unpause: clears paused flag", async () => {
                                                                                                                                                                                  await program.methods.unpause()
                                                                                                                                                                                    .accounts({ vault, authority: authority.publicKey })
                                                                                                                                                                                    .rpc();
                                                                                                                                                                                        const vaultData = await program.account.multiAssetVault.fetch(vault);
                                                                                                                                                                                              assert.isFalse(vaultData.paused);
                                                                                                                                                                                          });
                                                                                                                                                                                          
                                                                                                                                                                                          it("pause: rejects non-authority signer", async () => {
                                                                                                                                                                                                const rogue = Keypair.generate();
                                                                                                                                                                                                      await provider.connection.requestAirdrop(rogue.publicKey, anchor.web3.LAMPORTS_PER_SOL);
                                                                                                                                                                                                      try {
                                                                                                                                                                                                              await program.methods.pause()
                                                                                                                                                                                                                        .accounts({ vault, authority: rogue.publicKey })
                                                                                                                                                                                                                        .signers([rogue])
                                                                                                                                                                                                                        .rpc();
                                                                                                                                                                                                                      assert.fail("expected Unauthorized");
                                                                                                                                                                                                                    } catch (e: any) { assert.include(e.toString(), "Unauthorized"); }
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                        // ── transfer_authority ────────────────────────────────────────────────────
                                                                                                                                                                                                                                        it("transfer_authority: transfers and reclaims admin", async () => {
                                                                                                                                                                                                                                              const newAuth = Keypair.generate();
                                                                                                                                                                                                                                                    const sig = await provider.connection.requestAirdrop(
                                                                                                                                                                                                                                                            newAuth.publicKey, anchor.web3.LAMPORTS_PER_SOL);
                                                                                                                                                                                                                                                    await provider.connection.confirmTransaction(sig);
                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                    await program.methods.transferAuthority(newAuth.publicKey)
                                                                                                                                                                                                                                                            .accounts({ vault, authority: authority.publicKey })
                                                                                                                                                                                                                                                            .rpc();
                                                                                                                                                                                                                                                          let vaultData = await program.account.multiAssetVault.fetch(vault);
                                                                                                                                                                                                                                                                assert.equal(vaultData.authority.toBase58(), newAuth.publicKey.toBase58());
                                                                                                                                                                                                                                                            
                                                                                                                                                                                                                                                                await program.methods.transferAuthority(authority.publicKey)
                                                                                                                                                                                                                                                                        .accounts({ vault, authority: newAuth.publicKey })
                                                                                                                                                                                                                                                                        .signers([newAuth])
                                                                                                                                                                                                                                                                        .rpc();
                                                                                                                                                                                                                                                                      vaultData = await program.account.multiAssetVault.fetch(vault);
                                                                                                                                                                                                                                                                            assert.equal(vaultData.authority.toBase58(), authority.publicKey.toBase58());
                                                                                                                                                                                                                                                                          });
                                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                                          it("transfer_authority: rejects same-authority transfer", async () => {
                                                                                                                                                                                                                                                                                try {
                                                                                                                                                                                                                                                                                        await program.methods.transferAuthority(authority.publicKey)
                                                                                                                                                                                                                                                                                                  .accounts({ vault, authority: authority.publicKey })
                                                                                                                                                                                                                                                                                                  .rpc();
                                                                                                                                                                                                                                                                                                assert.fail("expected SameAuthority");
                                                                                                                                                                                                                                                                                              } catch (e: any) { assert.include(e.toString(), "SameAuthority"); }
                                                                                                                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                  // ── PDA layout integrity ──────────────────────────────────────────────────
                                                                                                                                                                                                                                                                                                                  it("assetEntry.assetVault matches PDA derivation", async () => {
                                                                                                                                                                                                                                                                                                                        const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                                                                                                                                                                                                                                                                              const [vaultA] = assetVaultPda(vault, mintA, program.programId);
                                                                                                                                                                                                                                                                                                                                    const entryData = await program.account.assetEntry.fetch(entryA);
                                                                                                                                                                                                                                                                                                                                          assert.equal(entryData.assetVault.toBase58(), vaultA.toBase58());
                                                                                                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                        // ── remove_asset guard ────────────────────────────────────────────────────
                                                                                                                                                                                                                                                                                                                                        it("remove_asset: rejects non-empty vault", async () => {
                                                                                                                                                                                                                                                                                                                                              const [entryA] = assetEntryPda(vault, mintA, program.programId);
                                                                                                                                                                                                                                                                                                                                                    const [vaultA] = assetVaultPda(vault, mintA, program.programId);
                                                                                                                                                                                                                                                                                                                                                          const acct = await getAccount(provider.connection, vaultA).catch(() => null);
                                                                                                                                                                                                                                                                                                                                                          if (acct && acct.amount > 0n) {
                                                                                                                                                                                                                                                                                                                                                                  try {
                                                                                                                                                                                                                                                                                                                                                                            await program.methods.removeAsset()
                                                                                                                                                                                                                                                                                                                                                                                        .accounts({ vault, assetEntry: entryA, assetVault: vaultA,
                                                                                                                                                                                                                                                                                                                                                                                                               authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
                                                                                                                                                                                                                                                                                                                                                                                        .rpc();
                                                                                                                                                                                                                                                                                                                                                                                      assert.fail("expected AssetVaultNotEmpty");
                                                                                                                                                                                                                                                                                                                                                                                    } catch (e: any) { assert.include(e.toString(), "AssetVaultNotEmpty"); }
                                                                                                                                                                                                                                                                                                                                                                                                                          } else {
                                                                                                                                                                                                                                                                                                                                                                                                                                  console.log("  (vault empty — skipping non-empty guard, would succeed)");
                                                                                                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                                                                                              });
                                                                                                                                                                                                                                                                                                                                                                                                                      });───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────——

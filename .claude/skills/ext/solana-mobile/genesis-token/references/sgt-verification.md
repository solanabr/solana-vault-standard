# SGT Verification Script

Two options for verifying SGT ownership:
1. **Standard RPC** — Works with any Solana RPC (no API key required)
2. **Helius API** — Uses `getTokenAccountsByOwnerV2` for pagination (requires Helius API key)

## SGT Constants

```javascript
const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';

// The metadata mint and group mint address are intentionally the same
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
```

## Dependencies

```bash
npm install @solana/web3.js @solana/spl-token
```

## Complete Verification Script

> **Note**: Remove or replace `console.log` statements with your preferred logging framework in production.

```javascript
const { Connection, PublicKey } = require('@solana/web3.js');
const { unpackMint, getMetadataPointerState, getTokenGroupMemberState, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

async function checkWalletForSGT(walletAddress) {
  const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4';

  // The metadata mint and group mint address are intentionally the same.
  const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
  const SGT_GROUP_MINT_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';

  try {
    const connection = new Connection(HELIUS_RPC_URL);

    // Use getTokenAccountsByOwnerV2 with pagination
    let allTokenAccounts = [];
    let paginationKey = null;
    let pageCount = 0;

    console.log(`Starting paginated fetch for wallet: ${walletAddress}`);

    do {
      pageCount++;
      console.log(`Fetching page ${pageCount}...`);

      const requestPayload = {
        jsonrpc: '2.0',
        id: `page-${pageCount}`,
        method: 'getTokenAccountsByOwnerV2',
        params: [
          walletAddress,
          { "programId": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, // Token-2022 program
          {
            encoding: 'jsonParsed',
            limit: 1000, // Maximum accounts per request
            ...(paginationKey && { paginationKey })
          }
        ]
      };

      const response = await fetch(HELIUS_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`RPC error: ${data.error.message}`);
      }

      const pageResults = data.result?.value.accounts || [];
      console.log(`Page ${pageCount}: Found ${pageResults.length} token accounts`);

      if (pageResults.length > 0) {
        allTokenAccounts.push(...pageResults);
      }
      paginationKey = data.result?.paginationKey;

      // Log pagination info
      if (data.result.totalResults) {
        console.log(`Total results available: ${data.result.totalResults}`);
      }

    } while (paginationKey); // Continue until no more pages

    console.log(`\nCompleted pagination: ${pageCount} pages, ${allTokenAccounts.length} total token accounts`);

    if (allTokenAccounts.length === 0) {
      console.log("No Token-2022 accounts found for this wallet.");
      return false;
    }

    // Extract mint addresses from token accounts
    const mintPubkeys = allTokenAccounts
      .map((accountInfo) => {
        try {
          if (accountInfo?.account?.data?.parsed?.info?.mint) {
            return new PublicKey(accountInfo.account.data.parsed.info.mint);
          } else {
            console.log('No mint found for account:', accountInfo);
            return null;
          }
        } catch (error) {
          return null;
        }
      })
      .filter((mintPubkey) => mintPubkey !== null);

    console.log(`Extracted ${mintPubkeys.length} mint addresses`);

    // Fetch all mint account data in batches of 100 to avoid RPC limits
    const BATCH_SIZE = 100;
    const mintAccountInfos = [];

    for (let i = 0; i < mintPubkeys.length; i += BATCH_SIZE) {
      const batch = mintPubkeys.slice(i, i + BATCH_SIZE);
      console.log(`Fetching mint info batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(mintPubkeys.length / BATCH_SIZE)}`);

      const batchResults = await connection.getMultipleAccountsInfo(batch);
      mintAccountInfos.push(...batchResults);
    }

    // Check each mint for SGT verification
    console.log(`Checking ${mintAccountInfos.length} mints for SGT verification...`);

    for (let i = 0; i < mintAccountInfos.length; i++) {
      const mintInfo = mintAccountInfos[i];
      if (mintInfo) {
        const mintPubkey = mintPubkeys[i];

        try {
          // Unpack the raw mint account data
          const mint = unpackMint(mintPubkey, mintInfo, TOKEN_2022_PROGRAM_ID);
          const mintAuthority = mint.mintAuthority?.toBase58();

          const hasCorrectMintAuthority = mintAuthority === SGT_MINT_AUTHORITY;

          // Check for correct SGT Metadata
          const metadataPointer = getMetadataPointerState(mint);
          const hasCorrectMetadata = metadataPointer &&
              metadataPointer.authority?.toBase58() === SGT_MINT_AUTHORITY &&
              metadataPointer.metadataAddress?.toBase58() === SGT_METADATA_ADDRESS;

          // Check for correct SGT Group Member
          const tokenGroupMemberState = getTokenGroupMemberState(mint);
          const hasCorrectGroupMember = tokenGroupMemberState &&
              tokenGroupMemberState.group?.toBase58() === SGT_GROUP_MINT_ADDRESS;

          // If all extensions match and mint authority is correct, then it is an SGT
          if (hasCorrectMintAuthority && hasCorrectMetadata && hasCorrectGroupMember) {
            console.log(`\nVERIFIED SGT FOUND: Wallet holds a verified SGT (${mint.address.toBase58()}).`);
            return true;
          }
        } catch (mintError) {
          // Skip this mint if we can't unpack it
          console.log(`Warning: Could not unpack mint ${mintPubkey.toBase58()}: ${mintError.message}`);
          continue;
        }
      }
    }

    // No verified SGT found in wallet
    console.log("\nNo verified SGT found in wallet.");
    return false;

  } catch (error) {
    console.error("Error verifying SGT ownership:", error.message);
    return false;
  }
}
```

## How SGT Verification Works

The script verifies an SGT by checking three things:

1. **Mint Authority** — Must match `GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4`
2. **Metadata Pointer** — Authority and address must match expected values
3. **Token Group Member** — Must belong to the SGT group

All three conditions must be true for a token to be considered a valid SGT.

## Returning the Mint Address

To implement anti-Sybil measures, modify the function to return the mint address:

```javascript
// Instead of returning just boolean
if (hasCorrectMintAuthority && hasCorrectMetadata && hasCorrectGroupMember) {
  return {
    hasSGT: true,
    mintAddress: mint.address.toBase58()
  };
}

// ...

return { hasSGT: false, mintAddress: null };
```

Then store claimed mint addresses in your database to prevent reuse.

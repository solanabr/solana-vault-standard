# Backend Implementation Reference

Complete Express API implementation for .skr domain resolution using `@onsol/tldparser`.

## Full Backend Code

```typescript
// backend/src/index.ts
import express, { Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TldParser } from '@onsol/tldparser';
import cors from 'cors';

const app = express();
const PORT = 3000;
const RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

// Initialize Solana connection and parser
const connection = new Connection(RPC_ENDPOINT);
const parser = new TldParser(connection);

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Resolve .skr domain to wallet address
app.post('/api/resolve-domain', async (req: Request, res: Response) => {
  try {
    const { domain } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ error: 'Domain name is required' });
    }

    // Remove .skr extension if present for lookup
    const domainName = domain.replace('.skr', '');
    
    // Look up domain owner
    const owner = await parser.getOwnerFromDomainTld(domainName);

    if (!owner) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    res.json({ address: owner.toBase58() });
  } catch (error) {
    console.error('Error resolving domain:', error);
    res.status(500).json({ error: 'Failed to resolve domain' });
  }
});

// Reverse lookup: resolve wallet address to .skr domain
app.post('/api/resolve-address', async (req: Request, res: Response) => {
  try {
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Validate and convert address
    const publicKey = new PublicKey(address);
    
    // Get all .skr domains owned by this address
    const domains = await parser.getParsedAllUserDomainsFromTld(publicKey, 'skr');

    if (!domains || domains.length === 0) {
      return res.status(404).json({ error: 'No .skr domain found for this address' });
    }

    // Return the first .skr domain found
    const domainName = domains[0].domain;
    res.json({ domain: `${domainName}` });
  } catch (error) {
    console.error('Error resolving address:', error);
    res.status(500).json({ error: 'Failed to resolve address' });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
```

## Package Configuration

```json
{
  "name": "skr-backend",
  "version": "1.0.0",
  "scripts": {
    "dev": "ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@onsol/tldparser": "^0.6.7",
    "@solana/web3.js": "^1.98.4",
    "cors": "^2.8.5",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.2"
  }
}
```

## TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

## Key Implementation Notes

1. **RPC Endpoint**: Uses public Solana mainnet endpoint. For production, use a dedicated RPC provider (Helius, QuickNode) for better performance and rate limits.

2. **Domain Lookup**: `parser.getOwnerFromDomainTld(domain)` returns the wallet address that owns the domain. Pass domain name WITHOUT .skr

3. **Reverse Lookup**: `parser.getParsedAllUserDomainsFromTld(publicKey, 'skr')` returns ALL .skr domains owned by an address. Use the first one found.

4. **Error Handling**: Return 404 for "not found" cases, 400 for invalid input, 500 for server errors.

5. **CORS**: Enabled for all origins ONLY in dev mode to allow mobile app requests. Restrict in production if needed.

# Transaction Signing Implementation

Complete implementation for signing and sending transactions using Mobile Wallet Adapter.

## Basic SOL Transfer

### Simple Transfer Example

```typescript
// app/send.tsx or components/SendButton.tsx
import { useState } from 'react';
import { View, TextInput, Pressable, Text, Alert } from 'react-native';
import { useMobileWallet } from '@wallet-ui/react-native-web3js';
import { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';

export default function SendScreen() {
  const { account, connection, signAndSendTransaction } = useMobileWallet();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSend = async () => {
    if (!account) {
      Alert.alert('Error', 'Please connect your wallet first');
      return;
    }

    try {
      setLoading(true);

      // Get fresh blockhash
      const { blockhash, lastValidBlockHeight } = 
        await connection.getLatestBlockhash();

      // Convert SOL to lamports
      const lamports = Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL);

      // Create transaction
      const transaction = new Transaction({
        feePayer: account.address,
        blockhash,
        lastValidBlockHeight,
      }).add(
        SystemProgram.transfer({
          fromPubkey: account.address,
          toPubkey: new PublicKey(recipient),
          lamports,
        })
      );

      // Sign and send (SDK handles everything)
      const signature = await signAndSendTransaction(transaction);
      
      console.log('Transaction signature:', signature);

      // Confirm transaction
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      if (confirmation.value.err) {
        throw new Error('Transaction failed');
      }

      Alert.alert('Success', `Sent ${amount} SOL!`);
      
      // Clear form
      setRecipient('');
      setAmount('');
    } catch (error: any) {
      console.error('Transaction error:', error);
      Alert.alert('Error', error.message || 'Transaction failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <TextInput
        placeholder="Recipient Address"
        value={recipient}
        onChangeText={setRecipient}
        style={{ borderWidth: 1, padding: 10, marginBottom: 10 }}
      />
      <TextInput
        placeholder="Amount (SOL)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        style={{ borderWidth: 1, padding: 10, marginBottom: 10 }}
      />
      <Pressable
        onPress={handleSend}
        disabled={loading || !recipient || !amount}
        style={{
          backgroundColor: '#9945FF',
          padding: 15,
          borderRadius: 8,
          opacity: loading ? 0.6 : 1,
        }}
      >
        <Text style={{ color: 'white', textAlign: 'center', fontWeight: 'bold' }}>
          {loading ? 'Sending...' : 'Send SOL'}
        </Text>
      </Pressable>
    </View>
  );
}
```

## Error Handling

### Common Transaction Errors
if (error.message?.includes('User declined'))
if (error.message?.includes('insufficient funds'))
if (error.message?.includes('expired'))
if (error.message?.includes('network'))

## Best Practices

### 1. Validate Inputs
Check recipient address is valid PublicKey before building transaction:

```typescript
try {
  new PublicKey(recipient);
} catch (error) {
  Alert.alert('Invalid Address', 'Please enter a valid Solana address');
  return;
}
```

import { encryptSecret, decryptSecret, EncryptedPayload } from '../../src/services/security/kmsEncryption.js';

export async function runKmsEncryptionTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running KMS AES-256-GCM Encryption Test Suite ');
  console.log('=================================================');

  const secretMessage = 'xoxb-slack-bot-token-secret-12345-enterprise-key';

  // 1. Test Encryption
  const encryptedPayload = encryptSecret(secretMessage);

  if (!encryptedPayload.cipherText || !encryptedPayload.iv || !encryptedPayload.authTag) {
    console.error('❌ KMS TEST FAILED: Encryption payload missing required fields!', encryptedPayload);
    return false;
  }

  if (encryptedPayload.iv.length !== 24) { // 12 bytes = 24 hex characters
    console.error('❌ KMS TEST FAILED: IV length is not 12 bytes (24 hex characters)!', encryptedPayload.iv);
    return false;
  }

  console.log('✅ KMS TEST PASSED: Successfully encrypted secret with 12-byte IV and AES-256-GCM authTag.');

  // 2. Test Decryption
  const decryptedText = decryptSecret(encryptedPayload);

  if (decryptedText !== secretMessage) {
    console.error('❌ KMS TEST FAILED: Decrypted secret text mismatch!', { secretMessage, decryptedText });
    return false;
  }

  console.log('✅ KMS TEST PASSED: Decrypted payload matched original secret string exactly.');

  // 3. Test Tamper Resistance (GCM authTag validation failure)
  const tamperedPayload: EncryptedPayload = {
    ...encryptedPayload,
    cipherText: encryptedPayload.cipherText.replace(/[0-9a-f]/, '0'),
  };

  try {
    decryptSecret(tamperedPayload);
    console.error('❌ KMS TEST FAILED: Decrypting tampered payload did not throw authTag validation error!');
    return false;
  } catch (tamperErr: any) {
    console.log('✅ KMS TEST PASSED: AES-256-GCM authTag tamper detection successfully caught modified payload.');
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKmsEncryptionTest().then((success) => {
    if (!success) process.exit(1);
  });
}

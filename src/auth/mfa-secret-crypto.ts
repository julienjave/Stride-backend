/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// --- MAIN LOGIC --------------------------------------------------------------------------------------------

// AES-256-GCM, via Node's built-in crypto module — no new dependency needed
// for this. Deliberately AUTHENTICATED encryption, not just encryption:
// GCM produces an authTag that decryption verifies, so tampered ciphertext
// fails loudly (an exception) rather than silently decrypting to garbage.
//
// A REAL, worth-naming limitation, not a silent gap: this protects against
// someone who gains read access to the DATABASE ALONE (a leaked backup, an
// over-permissioned read replica, a narrow SQL-injection-class bug) — it
// does NOT protect against someone with full access to the server itself,
// since MFA_ENCRYPTION_KEY lives in that same server's environment. A real
// production deployment handling genuine patient data should hold this key
// in a real secrets manager / KMS (AWS KMS, HashiCorp Vault) — separate
// infrastructure from the database AND the app server — rather than a
// plain environment variable. Accepted here deliberately, for this
// deployment's actual stakes (a demo, no real patient data).
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 96 bits — the recommended IV length for GCM specifically

function getEncryptionKey(): Buffer {
  // validateEnv() already guarantees MFA_ENCRYPTION_KEY is present and
  // correctly shaped before the app ever finishes booting — the ! here is
  // genuinely safe, not just assumed.
  return Buffer.from(process.env.MFA_ENCRYPTION_KEY!, 'hex')
}

export function encryptMfaSecret(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  // getAuthTag() must be called AFTER final() — GCM only finalizes the tag
  // once encryption is complete.
  const authTag = cipher.getAuthTag()
  // Stored as iv:authTag:ciphertext, all hex — a plain, readable, delimited
  // format. Colons never appear in hex, so splitting on them is unambiguous.
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decryptMfaSecret(stored: string): string {
  const key = getEncryptionKey()
  const [ivHex, authTagHex, encryptedHex] = stored.split(':')
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Malformed encrypted MFA secret')
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  // setAuthTag() must be called BEFORE update()/final() — the opposite order
  // from encryption, since decryption needs the tag available to verify
  // against as it goes.
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(), // throws if the auth tag doesn't match — tampering, corruption, or the wrong key
  ])
  return decrypted.toString('utf8')
}

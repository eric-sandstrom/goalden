import { getFirestore } from 'firebase-admin/firestore';

// Avoid visually ambiguous chars: 0/O, 1/I/L.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) {
    raw += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Generate an invite code that does not collide with any existing
 * `leagues_public` doc. Tries up to 20 candidates.
 */
export async function generateUniqueInviteCode(): Promise<string> {
  const db = getFirestore();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomCode();
    const snap = await db.collection('leagues_public').doc(code).get();
    if (!snap.exists) return code;
  }
  throw new Error('Could not generate a unique invite code after 20 attempts');
}

const admin = require('firebase-admin');

// Verifies customer sign-in (Firebase Auth) ID tokens sent from the browser
// as "Authorization: Bearer <token>". This is separate from admin auth
// (see _lib/adminAuth.js), which uses a server-side session cookie instead.
//
// Requires these env vars in Vercel (Project Settings → Environment Variables):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY
// Get these from Firebase Console → Project Settings → Service Accounts →
// "Generate new private key" (downloads a JSON file with these three fields).
// When pasting FIREBASE_PRIVATE_KEY into Vercel, keep it as one line with
// literal \n sequences — the replace() below converts them back to real
// newlines at runtime.

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  } else {
    console.error('Firebase Admin not configured — missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env vars.');
  }
}

// Returns the decoded token (with .uid, .email, etc.) if valid, or null
// if missing/invalid/expired. Never throws — callers just check for null.
async function verifyIdToken(idToken) {
  if (!idToken || !admin.apps.length) return null;
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    console.error('ID token verification failed:', err.message);
    return null;
  }
}

module.exports = { admin, verifyIdToken };

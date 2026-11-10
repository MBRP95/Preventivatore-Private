// Config pubblica del progetto Firebase dedicato al preventivatore.
// Non riusare deviceproposer (ListinoSmartphones): utenti e regole restano separati.
// L'apiKey web non è un secret.
//
// Login su Pages: username "shop" o "admin" (+ @preventivatore.invalid se manca).
// Account Authentication (password solo in Firebase Auth):
//   shop@preventivatore.invalid
//   admin@preventivatore.invalid
// Firestore users/{uid}: { role: "seller"|"admin", active: true, app: "preventivatore" }
// Authorized domains: includi mbrp95.github.io

export const firebaseConfig = {
  apiKey: "AIzaSyCSNyacPCgffrYsvSewW5XkAJ-fTK6FVZM",
  authDomain: "preventivatore-43c03.firebaseapp.com",
  projectId: "preventivatore-43c03",
  storageBucket: "preventivatore-43c03.firebasestorage.app",
  messagingSenderId: "731758475980",
  appId: "1:731758475980:web:ec347c4cce7710d4d0a069"
};

export const FIREBASE_STAFF_EMAILS = [
  "shop@preventivatore.invalid",
  "admin@preventivatore.invalid"
];

export function firebaseConfigured() {
  return !!(
    firebaseConfig.apiKey &&
    firebaseConfig.authDomain &&
    firebaseConfig.projectId &&
    firebaseConfig.appId
  );
}

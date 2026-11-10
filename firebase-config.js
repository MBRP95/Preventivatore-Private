// Config pubblica del progetto Firebase dedicato al preventivatore.
// Non riusare deviceproposer (ListinoSmartphones): utenti e regole restano separati.
// Dopo aver creato il progetto in console.firebase.google.com, da Impostazioni progetto
// → Le tue app → app Web, copia i valori qui. L'apiKey web non è un secret.
//
// Account Authentication da creare (password solo in Firebase Auth):
//   shop@preventivatore.invalid
//   admin@preventivatore.invalid
// Firestore users/{uid}: { role: "seller"|"admin", active: true, app: "preventivatore" }

export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
  measurementId: ""
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

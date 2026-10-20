import { firebaseConfig } from "./firebase-config.js";
import { mergeGroups, toCloudGroup } from "./merge.js";

let bundle = null;

export function cloudIntent() {
  try {
    return localStorage.getItem("fairshare_cloud") === "1";
  } catch {
    return false;
  }
}

export function setCloudIntent(on) {
  localStorage.setItem("fairshare_cloud", on ? "1" : "0");
}

export async function loadFirebase() {
  if (bundle) return bundle;
  if (!firebaseConfig.apiKey) throw new Error("Firebase config is missing");
  const [appMod, authMod, fsMod, storageMod] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js")
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  bundle = {
    auth: authMod.getAuth(app),
    db: fsMod.getFirestore(app),
    storage: storageMod.getStorage(app),
    authMod,
    fsMod,
    storageMod
  };
  return bundle;
}

export function watchAuth(fx, callback) {
  return fx.authMod.onAuthStateChanged(fx.auth, callback);
}

export function signInGoogle(fx) {
  const provider = new fx.authMod.GoogleAuthProvider();
  return fx.authMod.signInWithPopup(fx.auth, provider);
}

export function signOutGoogle(fx) {
  return fx.authMod.signOut(fx.auth);
}

export function watchRequests(fx, field, email, callback) {
  const { collection, query, where, onSnapshot } = fx.fsMod;
  const q = query(collection(fx.db, "friend_requests"), where(field, "==", email));
  return onSnapshot(q, (snap) => {
    const rows = [];
    snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
    callback(rows);
  }, (err) => callback([], err));
}

export async function fetchIncoming(fx, email) {
  const { collection, query, where, getDocs } = fx.fsMod;
  const q = query(collection(fx.db, "friend_requests"), where("toEmail", "==", email));
  const snap = await getDocs(q);
  const rows = [];
  snap.forEach((docSnap) => rows.push({ id: docSnap.id, ...docSnap.data() }));
  return rows;
}

export async function setRequest(fx, id, data) {
  const { doc, setDoc } = fx.fsMod;
  await setDoc(doc(fx.db, "friend_requests", id), data);
}

export async function patchRequest(fx, id, patch) {
  const { doc, updateDoc } = fx.fsMod;
  await updateDoc(doc(fx.db, "friend_requests", id), patch);
}

export async function removeRequest(fx, id) {
  const { doc, deleteDoc } = fx.fsMod;
  await deleteDoc(doc(fx.db, "friend_requests", id));
}

export function watchGroup(fx, groupId, callback) {
  const { doc, onSnapshot } = fx.fsMod;
  return onSnapshot(doc(fx.db, "groups", groupId), (snap) => {
    callback(snap.exists() ? snap.data() : null);
  }, (err) => callback(null, err));
}

export async function commitGroup(fx, group, email) {
  const { doc, runTransaction } = fx.fsMod;
  const ref = doc(fx.db, "groups", group.id);
  let merged = null;
  await runTransaction(fx.db, async (transaction) => {
    const snap = await transaction.get(ref);
    const remote = snap.exists() ? snap.data() : null;
    merged = mergeGroups(toCloudGroup(group, email), remote);
    transaction.set(ref, {
      ...toCloudGroup(merged, email),
      updatedAt: Date.now(),
      updatedBy: String(email || "").toLowerCase()
    });
  });
  return merged;
}

export async function deleteCloudGroup(fx, groupId) {
  const { doc, deleteDoc } = fx.fsMod;
  await deleteDoc(doc(fx.db, "groups", groupId));
}

export async function publishInvite(fx, invite) {
  const { doc, setDoc } = fx.fsMod;
  await setDoc(doc(fx.db, "invites", invite.inviteId), invite);
}

export async function claimInvite(fx, { groupId, inviteId, email }) {
  const { doc, runTransaction } = fx.fsMod;
  const ref = doc(fx.db, "groups", groupId);
  await runTransaction(fx.db, async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const emails = (data.memberEmails || []).map((item) => String(item).toLowerCase());
    const mine = String(email || "").toLowerCase();
    if (emails.includes(mine)) return;
    transaction.update(ref, {
      memberEmails: [...emails, mine],
      claimInviteId: inviteId,
      updatedAt: Date.now(),
      updatedBy: mine
    });
  });
}

export async function uploadReceipt(fx, path, dataUrl) {
  const { ref, uploadString, getDownloadURL } = fx.storageMod;
  const fileRef = ref(fx.storage, path);
  await uploadString(fileRef, dataUrl, "data_url");
  const url = await getDownloadURL(fileRef);
  return { url, path };
}

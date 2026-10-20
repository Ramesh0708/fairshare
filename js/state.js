import { advanceRecurring, formatDate, newId } from "./money.js";
import { defaultState, migrateState } from "./migrate.js";

const KEY = "fairshare_state_v9";
const LEGACY_KEYS = ["fairshare_state_v6", "fairshare_state_v7", "fairshare_state_v8"];

export let appState = defaultState();

export function loadState() {
  const raw = localStorage.getItem(KEY)
    || localStorage.getItem("fairshare_state_v8")
    || localStorage.getItem("fairshare_state_v7")
    || localStorage.getItem("fairshare_state_v6");
  if (raw) {
    try {
      appState = migrateState(JSON.parse(raw));
    } catch (err) {
      console.warn("Could not parse saved FairShare state", err);
      appState = defaultState();
    }
  } else {
    appState = defaultState();
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
      appState.theme = "dark";
    }
  }
  appState.undoStack = [];
  const recurred = materializeRecurring(appState);
  const saved = persistLocal();
  for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  return { recurred, slimmed: saved.slimmed };
}

export function persistLocal() {
  const { undoStack, ...rest } = appState;
  const payload = JSON.stringify(rest);
  try {
    localStorage.setItem(KEY, payload);
    return { slimmed: false };
  } catch (err) {
    const slim = structuredClone(rest);
    for (const group of Object.values(slim.groups || {})) {
      for (const tx of group.transactions || []) delete tx.receiptDataUrl;
    }
    for (const tx of slim.directTransactions || []) delete tx.receiptDataUrl;
    localStorage.setItem(KEY, JSON.stringify(slim));
    return { slimmed: true };
  }
}

export function getGroup() {
  if (!appState.activeGroupId) return null;
  return appState.groups[appState.activeGroupId] || null;
}

export function touchGroup(group) {
  if (!group) return;
  group.localRevision = (group.localRevision || 0) + 1;
}

export function personName(id) {
  if (!id) return "Someone";
  if (id === appState.selfId) return appState.profile.displayName || "You";
  for (const group of Object.values(appState.groups || {})) {
    const member = (group.members || []).find((item) => item.id === id);
    if (member) return member.name;
  }
  const friend = (appState.friends || []).find((item) => item.id === id);
  return friend?.name || "Someone";
}

export function materializeRecurring(state, now = Date.now()) {
  let changed = false;
  const walk = (list, insert) => {
    for (const tx of [...list]) {
      if (tx.type !== "expense" || !tx.recurring?.nextDue) continue;
      let guard = 0;
      while (tx.recurring.nextDue <= now && guard < 12) {
        const due = tx.recurring.nextDue;
        const copy = structuredClone(tx);
        copy.id = newId();
        copy.timestamp = due;
        copy.updatedAt = now;
        copy.date = formatDate(new Date(due));
        copy.recurring = null;
        delete copy.receiptDataUrl;
        insert(copy);
        tx.recurring.nextDue = advanceRecurring(due, tx.recurring.freq || "monthly");
        tx.updatedAt = now;
        changed = true;
        guard += 1;
      }
    }
  };
  for (const group of Object.values(state.groups || {})) {
    if (!group.transactions) group.transactions = [];
    walk(group.transactions, (copy) => group.transactions.unshift(copy));
  }
  if (!state.directTransactions) state.directTransactions = [];
  walk(state.directTransactions, (copy) => state.directTransactions.unshift(copy));
  return changed;
}

import { formatDate, newId, rupeesToPaise } from "./money.js";

export function defaultState() {
  return {
    schemaVersion: 9,
    theme: "light",
    selfId: "self",
    profile: { displayName: "You", upiId: "" },
    activeGroupId: "group_default",
    friends: [
      { id: "friend_aryan", name: "Aryan", email: "", phone: "", type: "custom", approved: false, upiId: "", addedAt: "" },
      { id: "friend_rahul", name: "Rahul", email: "", phone: "", type: "custom", approved: false, upiId: "", addedAt: "" }
    ],
    directTransactions: [],
    groups: {
      group_default: emptyGroup("group_default", "My Group", "₹", [
        { id: "self", name: "You" },
        { id: "friend_aryan", name: "Aryan" }
      ])
    }
  };
}

export function emptyGroup(id, name, currency, members) {
  return {
    id,
    name,
    currency: currency || "₹",
    simplifyDebts: true,
    members: members || [{ id: "self", name: "You" }],
    removedMemberIds: [],
    transactions: [],
    deletedTxIds: [],
    memberEmails: [],
    localRevision: 1
  };
}

function hasLegacyShape(data) {
  if (!data || data.schemaVersion !== 9) return true;
  const groups = Object.values(data.groups || {});
  if (groups.some((group) => (group.members || []).some((member) => typeof member === "string" || !member?.id))) return true;
  const txs = groups.flatMap((group) => group.transactions || []).concat(data.directTransactions || []);
  return txs.some((tx) => tx && tx.amountPaise == null && tx.amount != null);
}

export function migrateState(input) {
  if (!input || typeof input !== "object") return defaultState();
  const next = hasLegacyShape(input) ? convertLegacy(input) : normalizeV9(input);
  if (!next.groups[next.activeGroupId]) {
    next.activeGroupId = Object.keys(next.groups)[0] || "";
  }
  next.schemaVersion = 9;
  return next;
}

function normalizeV9(input) {
  const state = {
    schemaVersion: 9,
    theme: input.theme === "dark" ? "dark" : "light",
    selfId: input.selfId || "self",
    profile: {
      displayName: input.profile?.displayName || "You",
      upiId: input.profile?.upiId || ""
    },
    activeGroupId: input.activeGroupId || "",
    friends: (input.friends || []).map(normalizeFriend),
    directTransactions: (input.directTransactions || []).map((tx) => ({ ...tx })),
    groups: {}
  };
  for (const [id, group] of Object.entries(input.groups || {})) {
    state.groups[id] = {
      ...emptyGroup(id, group.name, group.currency, []),
      ...group,
      id,
      members: (group.members || []).map((member) => ({ id: member.id, name: member.name })),
      removedMemberIds: group.removedMemberIds || [],
      transactions: group.transactions || [],
      deletedTxIds: group.deletedTxIds || [],
      memberEmails: group.memberEmails || [],
      localRevision: group.localRevision || 1,
      simplifyDebts: group.simplifyDebts !== false
    };
  }
  if (!Object.keys(state.groups).length) state.activeGroupId = "";
  return state;
}

function normalizeFriend(friend) {
  return {
    id: friend.id || newId(),
    name: friend.name || "Friend",
    email: (friend.email || "").toLowerCase(),
    phone: friend.phone || "",
    type: friend.type || (friend.email ? "google" : "custom"),
    approved: Boolean(friend.approved || friend.email),
    upiId: friend.upiId || "",
    addedAt: friend.addedAt || ""
  };
}

function convertLegacy(input) {
  const friends = (input.friends || []).map((friend) => normalizeFriend({
    ...friend,
    id: friend.id ? String(friend.id) : newId()
  }));
  const friendByName = new Map(friends.map((friend) => [friend.name.toLowerCase(), friend]));

  const ensureFriend = (name) => {
    const key = String(name || "").trim().toLowerCase();
    if (!key || key === "you") return null;
    const found = friendByName.get(key);
    if (found) return found;
    const created = normalizeFriend({ id: newId(), name: String(name).trim(), type: "custom" });
    friends.push(created);
    friendByName.set(key, created);
    return created;
  };

  const groups = {};
  for (const [id, group] of Object.entries(input.groups || {})) {
    const nameToId = new Map([["you", "self"]]);
    const members = [];
    const seen = new Set();
    const pushMember = (memberId, name) => {
      if (seen.has(memberId)) return;
      seen.add(memberId);
      members.push({ id: memberId, name });
    };
    for (const member of group.members || []) {
      if (typeof member === "string") {
        if (member.toLowerCase() === "you") {
          pushMember("self", "You");
          continue;
        }
        const friend = ensureFriend(member);
        if (friend) {
          nameToId.set(friend.name.toLowerCase(), friend.id);
          pushMember(friend.id, friend.name);
        }
      } else if (member?.id) {
        pushMember(member.id, member.name || "Member");
        nameToId.set(String(member.name || "").toLowerCase(), member.id);
      }
    }
    if (!seen.has("self")) pushMember("self", "You");

    const resolve = (nameOrId) => {
      if (!nameOrId) return "";
      const text = String(nameOrId);
      if ([...nameToId.values()].includes(text) || text === "self") return text;
      const key = text.toLowerCase();
      if (nameToId.has(key)) return nameToId.get(key);
      if (key === "you") return "self";
      const friend = ensureFriend(text);
      if (friend) {
        nameToId.set(friend.name.toLowerCase(), friend.id);
        pushMember(friend.id, friend.name);
        return friend.id;
      }
      return text;
    };

    const transactions = (group.transactions || []).map((tx) => convertTx(tx, resolve));
    groups[id] = {
      ...emptyGroup(id, group.name || "Group", group.currency || "₹", members),
      simplifyDebts: group.simplifyDebts !== false,
      members,
      transactions
    };
  }

  const directTransactions = (input.directTransactions || []).map((tx) => {
    const friend = ensureFriend(tx.friend || tx.friendName || "");
    const resolve = (nameOrId) => {
      const text = String(nameOrId || "");
      if (text === "self" || text.toLowerCase() === "you") return "self";
      if (friend && (text === friend.id || text.toLowerCase() === friend.name.toLowerCase())) return friend.id;
      return text === friend?.id ? friend.id : (text.toLowerCase() === "you" ? "self" : text);
    };
    return { ...convertTx(tx, resolve), scope: "direct", friendId: friend?.id || tx.friendId || "" };
  });

  return {
    schemaVersion: 9,
    theme: input.theme === "dark" ? "dark" : "light",
    selfId: "self",
    profile: { displayName: input.profile?.displayName || "You", upiId: input.profile?.upiId || "" },
    activeGroupId: input.activeGroupId || Object.keys(groups)[0] || "",
    friends,
    directTransactions,
    groups
  };
}

function convertTx(tx, resolve) {
  const amountPaise = tx.amountPaise != null ? Math.round(tx.amountPaise) : (rupeesToPaise(tx.amount) || 0);
  const shares = {};
  for (const [key, value] of Object.entries(tx.shares || {})) {
    const id = resolve(key);
    const paise = typeof value === "number" && tx.amountPaise != null && Number.isInteger(value)
      ? value
      : (rupeesToPaise(value) || 0);
    shares[id] = paise;
  }
  const converted = {
    id: String(tx.id || newId()),
    type: tx.type === "settlement" ? "settlement" : "expense",
    scope: tx.scope || "group",
    friendId: tx.friendId || null,
    desc: tx.desc || "",
    amountPaise,
    payerId: resolve(tx.payerId || tx.payer),
    receiverId: tx.receiverId || tx.receiver ? resolve(tx.receiverId || tx.receiver) : null,
    category: tx.category || (tx.type === "settlement" ? "Settlement" : "Other"),
    shares,
    splitMode: tx.splitMode || "equal",
    date: tx.date || formatDate(new Date(tx.timestamp || Date.now())),
    timestamp: tx.timestamp || Number(tx.id) || Date.now(),
    updatedAt: tx.updatedAt || tx.timestamp || Number(tx.id) || Date.now(),
    recurring: tx.recurring || null
  };
  if (typeof tx.receipt === "string" && tx.receipt.startsWith("data:image/")) {
    converted.receiptDataUrl = tx.receipt;
  }
  if (tx.receiptUrl) converted.receiptUrl = tx.receiptUrl;
  if (tx.receiptPath) converted.receiptPath = tx.receiptPath;
  if (tx.receiptDataUrl) converted.receiptDataUrl = tx.receiptDataUrl;
  return converted;
}

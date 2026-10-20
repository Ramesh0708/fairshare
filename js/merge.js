/** Merge two copies of a group so concurrent edits of different expenses both survive. */

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function mergeGroups(local, remote) {
  if (!remote) return clone(local);
  if (!local) return clone(remote);
  const deleted = new Set([...(local.deletedTxIds || []), ...(remote.deletedTxIds || [])]);
  const removedMembers = new Set([...(local.removedMemberIds || []), ...(remote.removedMemberIds || [])]);
  const txMap = new Map();
  const consider = (tx) => {
    if (!tx || !tx.id || deleted.has(tx.id)) return;
    const prev = txMap.get(tx.id);
    const stamp = tx.updatedAt || tx.timestamp || 0;
    const prevStamp = prev ? (prev.updatedAt || prev.timestamp || 0) : -1;
    if (!prev || stamp >= prevStamp) txMap.set(tx.id, { ...tx });
  };
  for (const tx of remote.transactions || []) consider(tx);
  for (const tx of local.transactions || []) consider(tx);

  const localWins = (local.localRevision || 0) >= (remote.localRevision || 0);
  const primary = localWins ? local : remote;
  const secondary = localWins ? remote : local;
  const members = new Map();
  for (const member of secondary.members || []) {
    if (member?.id && !removedMembers.has(member.id)) members.set(member.id, { id: member.id, name: member.name });
  }
  for (const member of primary.members || []) {
    if (member?.id && !removedMembers.has(member.id)) members.set(member.id, { id: member.id, name: member.name });
  }
  const emails = new Set(
    [...(local.memberEmails || []), ...(remote.memberEmails || [])]
      .filter(Boolean)
      .map((email) => String(email).toLowerCase())
  );
  const transactions = [...txMap.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return {
    id: local.id || remote.id,
    name: primary.name || secondary.name || "Group",
    currency: primary.currency || secondary.currency || "₹",
    simplifyDebts: primary.simplifyDebts !== false,
    members: [...members.values()],
    removedMemberIds: [...removedMembers],
    transactions,
    deletedTxIds: [...deleted].slice(-500),
    memberEmails: [...emails],
    localRevision: Math.max(local.localRevision || 0, remote.localRevision || 0)
  };
}

/** Cloud copy never includes local base64 receipts. */
export function toCloudGroup(group, email) {
  const emails = new Set((group.memberEmails || []).map((item) => String(item).toLowerCase()));
  if (email) emails.add(String(email).toLowerCase());
  return {
    id: group.id,
    name: group.name,
    currency: group.currency,
    simplifyDebts: group.simplifyDebts !== false,
    members: (group.members || []).map((member) => ({ id: member.id, name: member.name })),
    removedMemberIds: group.removedMemberIds || [],
    transactions: (group.transactions || []).map((tx) => {
      const copy = { ...tx };
      delete copy.receiptDataUrl;
      return copy;
    }),
    deletedTxIds: (group.deletedTxIds || []).slice(-500),
    memberEmails: [...emails],
    localRevision: group.localRevision || 0
  };
}

export function preserveLocalReceipts(mergedTransactions, localTransactions) {
  const localById = new Map((localTransactions || []).map((tx) => [tx.id, tx]));
  return (mergedTransactions || []).map((tx) => {
    const prev = localById.get(tx.id);
    if (prev?.receiptDataUrl && !tx.receiptDataUrl) {
      return { ...tx, receiptDataUrl: prev.receiptDataUrl };
    }
    return tx;
  });
}

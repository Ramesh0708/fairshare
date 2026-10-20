/** Integer money (paise) and debt math. 100 paise = 1.00 in the group's currency. */

export function newId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  throw new Error("crypto.randomUUID is not available");
}

export function rupeesToPaise(input) {
  if (input == null) return null;
  const text = String(input).trim().replace(/,/g, "");
  if (!text) return null;
  const neg = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(unsigned)) return null;
  const [whole, frac = ""] = unsigned.split(".");
  const frac2 = (frac + "00").slice(0, 2);
  const roundUp = Number(frac[2] || "0") >= 5;
  let paise = Number(whole) * 100 + Number(frac2);
  if (roundUp) paise += 1;
  return neg ? -paise : paise;
}

export function paiseToInput(paise) {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(paise, currency = "₹") {
  const n = Math.round(Number(paise) || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatDate(date) {
  return date.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
}

export function advanceRecurring(timestamp, freq) {
  const d = new Date(timestamp);
  if (freq === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

export function allocateEqual(totalPaise, ids) {
  if (!ids.length || totalPaise == null) return null;
  const base = Math.floor(totalPaise / ids.length);
  let rem = totalPaise - base * ids.length;
  const shares = {};
  ids.forEach((id) => {
    shares[id] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
  });
  return shares;
}

export function allocateWeighted(totalPaise, weights) {
  const usable = weights.filter((w) => w.weight > 0);
  const sum = usable.reduce((s, w) => s + w.weight, 0);
  if (!usable.length || sum <= 0 || totalPaise == null) return null;
  const shares = {};
  weights.forEach((w) => { shares[w.id] = 0; });
  let assigned = 0;
  usable.forEach((w, index) => {
    if (index === usable.length - 1) {
      shares[w.id] = totalPaise - assigned;
    } else {
      const part = Math.floor((totalPaise * w.weight) / sum);
      shares[w.id] = part;
      assigned += part;
    }
  });
  return shares;
}

export function computeBalances(members, transactions) {
  const balances = {};
  const spent = {};
  const shareOwed = {};
  for (const member of members) {
    balances[member.id] = 0;
    spent[member.id] = 0;
    shareOwed[member.id] = 0;
  }
  let expenseCount = 0;
  let settleCount = 0;
  let totalSpend = 0;
  for (const tx of transactions || []) {
    if (tx.type === "expense") {
      expenseCount += 1;
      totalSpend += tx.amountPaise || 0;
      if (spent[tx.payerId] != null) spent[tx.payerId] += tx.amountPaise || 0;
      if (balances[tx.payerId] != null) balances[tx.payerId] += tx.amountPaise || 0;
      for (const [id, share] of Object.entries(tx.shares || {})) {
        if (balances[id] != null) balances[id] -= share;
        if (shareOwed[id] != null) shareOwed[id] += share;
      }
    } else if (tx.type === "settlement") {
      settleCount += 1;
      if (balances[tx.payerId] != null) balances[tx.payerId] += tx.amountPaise || 0;
      if (balances[tx.receiverId] != null) balances[tx.receiverId] -= tx.amountPaise || 0;
    }
  }
  return { balances, spent, shareOwed, expenseCount, settleCount, totalSpend };
}

export function simplifyDebts(balances) {
  const debtors = [];
  const creditors = [];
  for (const [id, balance] of Object.entries(balances)) {
    if (balance <= -1) debtors.push({ id, amount: -balance });
    else if (balance >= 1) creditors.push({ id, amount: balance });
  }
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);
  const debts = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    if (amount >= 1) debts.push({ from: debtors[i].id, to: creditors[j].id, amountPaise: amount });
    debtors[i].amount -= amount;
    creditors[j].amount -= amount;
    if (debtors[i].amount < 1) i += 1;
    if (creditors[j].amount < 1) j += 1;
  }
  return debts;
}

/** Bilateral debts before simplification. */
export function pairwiseDebts(transactions) {
  const net = new Map();
  const owe = (from, to, paise) => {
    if (!from || !to || from === to || !paise) return;
    const flip = from > to;
    const a = flip ? to : from;
    const b = flip ? from : to;
    const key = `${a}\0${b}`;
    net.set(key, (net.get(key) || 0) + (flip ? -paise : paise));
  };
  for (const tx of transactions || []) {
    if (tx.type === "expense") {
      for (const [id, share] of Object.entries(tx.shares || {})) {
        if (id !== tx.payerId && share > 0) owe(id, tx.payerId, share);
      }
    } else if (tx.type === "settlement") {
      owe(tx.payerId, tx.receiverId, -(tx.amountPaise || 0));
    }
  }
  const debts = [];
  for (const [key, value] of net) {
    const [a, b] = key.split("\0");
    if (value >= 1) debts.push({ from: a, to: b, amountPaise: value });
    else if (value <= -1) debts.push({ from: b, to: a, amountPaise: -value });
  }
  debts.sort((a, b) => b.amountPaise - a.amountPaise);
  return debts;
}

export function owedAndOwing(debts, selfId) {
  let owed = 0;
  let owe = 0;
  for (const debt of debts) {
    if (debt.to === selfId) owed += debt.amountPaise;
    if (debt.from === selfId) owe += debt.amountPaise;
  }
  return { owed, owe };
}

export function categoryTotals(transactions) {
  const totals = {};
  for (const tx of transactions || []) {
    if (tx.type !== "expense") continue;
    const cat = tx.category || "Other";
    totals[cat] = (totals[cat] || 0) + (tx.amountPaise || 0);
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

export function personShareTotals(members, transactions) {
  return members.map((member) => {
    let paise = 0;
    for (const tx of transactions || []) {
      if (tx.type === "expense") paise += tx.shares?.[member.id] || 0;
    }
    return [member, paise];
  }).filter(([, paise]) => paise > 0).sort((a, b) => b[1] - a[1]);
}

export function timeTotals(transactions) {
  const map = new Map();
  for (const tx of transactions || []) {
    if (tx.type !== "expense") continue;
    const d = new Date(tx.timestamp || Date.now());
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    map.set(key, (map.get(key) || 0) + (tx.amountPaise || 0));
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function directBalance(transactions, friendId, selfId) {
  let bal = 0;
  for (const tx of transactions || []) {
    if (tx.friendId !== friendId) continue;
    if (tx.type === "expense") {
      const mine = tx.shares?.[selfId] || 0;
      const theirs = tx.shares?.[friendId] || 0;
      if (tx.payerId === selfId) bal += theirs;
      else if (tx.payerId === friendId) bal -= mine;
    } else if (tx.type === "settlement") {
      if (tx.payerId === friendId && tx.receiverId === selfId) bal -= tx.amountPaise || 0;
      else if (tx.payerId === selfId && tx.receiverId === friendId) bal += tx.amountPaise || 0;
    }
  }
  return bal;
}

import { CATEGORY_COLORS, CATEGORY_ICONS, predictCategory } from "./js/categories.js";
import { renderChart } from "./js/charts.js";
import { $, clear, el, safeImageSrc } from "./js/dom.js";
import {
  claimInvite, cloudIntent, commitGroup, deleteCloudGroup, fetchIncoming, loadFirebase,
  patchRequest, publishInvite, removeRequest, setCloudIntent, setRequest, signInGoogle,
  signOutGoogle, uploadReceipt, watchAuth, watchGroup, watchRequests
} from "./js/firebase.js";
import { addFriendToGroup, createFriend, getAvailableFriendsForGroup, normalizeEmail, validEmail } from "./js/friends.js";
import { mergeGroups, preserveLocalReceipts } from "./js/merge.js";
import { emptyGroup, migrateState } from "./js/migrate.js";
import {
  advanceRecurring, allocateEqual, allocateWeighted, categoryTotals, computeBalances,
  directBalance, formatDate, formatMoney, newId, owedAndOwing, paiseToInput, pairwiseDebts,
  personShareTotals, rupeesToPaise, simplifyDebts, timeTotals
} from "./js/money.js";
import { compressImage, loadTesseract, preprocessForOcr } from "./js/receipts.js";
import { appState, getGroup, loadState, persistLocal, personName, touchGroup } from "./js/state.js";
import { alertDialog, confirmDialog, promptDialog, toast } from "./js/ui.js";
import qrcode from "./js/vendor/qrcode.js";

const KNOWN = ["₹", "$", "€", "£", "¥"];
const TITLES = {
  home: "FairShare",
  "add-expense": "Add an expense — FairShare",
  balances: "Balances and settle — FairShare",
  history: "History — FairShare",
  analytics: "Spending analytics — FairShare",
  friends: "Friends and groups — FairShare"
};
const PERSON_COLORS = ["#0369a1", "#7c3aed", "#047857", "#b45309", "#be185d", "#334155", "#0f766e"];

let fx = null;
let currentUser = null;
let incoming = [];
let outgoing = [];
let stopIn = null;
let stopOut = null;
let stopGroup = null;
let pushTimer = 0;
let applyingRemote = false;
let authWatching = false;
let splitMode = "equal";
let scope = "group";
let selectedFriendId = "";
let categoryManual = false;
let pendingReceipt = null;
let editingId = "";
let historyFilter = "all";
let historyScope = "all";
let searchQuery = "";
let memberFilter = "all";
let chartKind = "pie";
let analyticsView = "category";
let pendingInvite = null;

const boot = loadState();

const cur = () => getGroup()?.currency || "₹";
const me = () => appState.selfId || "self";

function rewriteId(tx, from, to) {
  const map = (id) => (id === from ? to : id);
  if (tx.payerId) tx.payerId = map(tx.payerId);
  if (tx.receiverId) tx.receiverId = map(tx.receiverId);
  if (tx.friendId) tx.friendId = map(tx.friendId);
  if (tx.shares) {
    const shares = {};
    for (const [id, share] of Object.entries(tx.shares)) shares[map(id)] = share;
    tx.shares = shares;
  }
}

function adoptAccount(uid, name) {
  if (!uid) return;
  const label = name || appState.profile.displayName || "You";
  appState.profile.displayName = label;
  if (appState.selfId === uid) {
    for (const group of Object.values(appState.groups)) {
      const self = group.members?.find((member) => member.id === uid);
      if (self) self.name = label;
    }
    return;
  }
  const from = appState.selfId || "self";
  appState.selfId = uid;
  for (const group of Object.values(appState.groups)) {
    group.members = (group.members || []).map((member) => (
      member.id === from ? { ...member, id: uid, name: label } : member
    ));
    group.removedMemberIds = (group.removedMemberIds || []).map((id) => (id === from ? uid : id));
    for (const tx of group.transactions || []) rewriteId(tx, from, uid);
    touchGroup(group);
  }
  for (const tx of appState.directTransactions || []) rewriteId(tx, from, uid);
}

function saveState() {
  const result = persistLocal();
  if (result.slimmed) toast("Storage is nearly full, so receipt photos were kept out of the saved copy.");
  schedulePush();
}

function offerUndo(message, restore) {
  toast(message, {
    actionLabel: "Undo",
    onAction: () => {
      restore();
      saveState();
      renderAll();
    }
  });
}

function findTx(id) {
  const group = getGroup();
  const found = group?.transactions?.find((tx) => tx.id === id);
  if (found) return { tx: found, list: group.transactions, group };
  const direct = (appState.directTransactions || []).find((tx) => tx.id === id);
  if (direct) return { tx: direct, list: appState.directTransactions, group: null };
  return null;
}

function normShares(shares) {
  return Object.fromEntries(Object.entries(shares || {}).sort(([a], [b]) => a.localeCompare(b)));
}

function fingerprint(group) {
  const txs = (group.transactions || []).map((tx) => ({
    id: tx.id,
    type: tx.type,
    amountPaise: tx.amountPaise || 0,
    payerId: tx.payerId || "",
    receiverId: tx.receiverId || "",
    friendId: tx.friendId || "",
    desc: tx.desc || "",
    category: tx.category || "",
    splitMode: tx.splitMode || "",
    shares: normShares(tx.shares),
    updatedAt: tx.updatedAt || 0,
    receiptUrl: tx.receiptUrl || "",
    scope: tx.scope || "group",
    recurring: tx.recurring?.freq ? `${tx.recurring.freq}:${tx.recurring.nextDue || 0}` : ""
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({
    name: group.name || "",
    currency: group.currency || "",
    simplifyDebts: group.simplifyDebts !== false,
    members: (group.members || []).map((member) => ({ id: member.id, name: member.name })).sort((a, b) => a.id.localeCompare(b.id)),
    removed: [...(group.removedMemberIds || [])].sort(),
    deleted: [...(group.deletedTxIds || [])].sort(),
    emails: [...(group.memberEmails || [])].map((email) => String(email).toLowerCase()).sort(),
    txs
  });
}

function schedulePush() {
  if (applyingRemote || !fx || !currentUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushActiveGroup, 300);
}

async function pushActiveGroup() {
  const group = getGroup();
  if (!group || !fx || !currentUser || applyingRemote) return;
  try {
    const merged = await commitGroup(fx, group, currentUser.email);
    applyingRemote = true;
    merged.transactions = preserveLocalReceipts(merged.transactions, group.transactions);
    appState.groups[group.id] = { ...group, ...merged, transactions: merged.transactions };
    persistLocal();
  } catch (err) {
    console.warn("Cloud sync failed", err);
  } finally {
    applyingRemote = false;
  }
}

function coerceCloudGroup(groupId, remote) {
  const legacyMembers = (remote.members || []).some((member) => typeof member === "string");
  const legacyMoney = (remote.transactions || []).some((tx) => tx && tx.amountPaise == null && tx.amount != null);
  if (!legacyMembers && !legacyMoney) return remote;
  const migrated = migrateState({
    groups: { [groupId]: { ...remote, id: groupId } },
    friends: appState.friends,
    activeGroupId: groupId,
    profile: appState.profile
  });
  return migrated.groups[groupId] || remote;
}

function applyRemote(groupId, remote) {
  const local = appState.groups[groupId];
  if (!local) return;
  if (!remote) {
    schedulePush();
    return;
  }
  const cloud = coerceCloudGroup(groupId, remote);
  const merged = mergeGroups(local, cloud);
  merged.transactions = preserveLocalReceipts(merged.transactions, local.transactions);
  if (fingerprint(local) === fingerprint(merged)) return;
  applyingRemote = true;
  appState.groups[groupId] = merged;
  persistLocal();
  applyingRemote = false;
  renderAll();
  if (fingerprint(merged) !== fingerprint(cloud)) schedulePush();
}

function listenActiveGroup() {
  if (stopGroup) stopGroup();
  stopGroup = null;
  const group = getGroup();
  if (!fx || !currentUser || !group) return;
  stopGroup = watchGroup(fx, group.id, (remote, err) => {
    if (err) {
      if (err.code === "permission-denied") toast("This cloud group is only available to its members.");
      return;
    }
    applyRemote(group.id, remote);
  });
}

function stopCloud() {
  if (stopIn) stopIn();
  if (stopOut) stopOut();
  if (stopGroup) stopGroup();
  stopIn = stopOut = stopGroup = null;
  incoming = [];
  outgoing = [];
}

async function ensureCloud() {
  if (!fx) fx = await loadFirebase();
  if (!authWatching) {
    authWatching = true;
    watchAuth(fx, onAuth);
  }
  return fx;
}

function onAuth(user) {
  currentUser = user || null;
  if (user) {
    setCloudIntent(true);
    adoptAccount(user.uid, (user.displayName || "").split(" ")[0] || "You");
    persistLocal();
    startCloud(user);
  } else {
    stopCloud();
  }
  renderAuth();
  renderAll();
}

function startCloud(user) {
  stopCloud();
  const email = user.email.toLowerCase();
  stopIn = watchRequests(fx, "toEmail", email, (rows, err) => {
    if (err) return;
    incoming = rows.filter((row) => row.status === "pending");
    renderFriendRequests();
  });
  stopOut = watchRequests(fx, "fromEmail", email, (rows, err) => {
    if (err) return;
    outgoing = rows.filter((row) => row.status === "pending");
    for (const row of rows) {
      if (row.status === "accepted") addApproved(row.toEmail, row.acceptedByName || row.toEmail.split("@")[0], false);
    }
    renderFriendRequests();
    renderFriends();
  });
  listenActiveGroup();
}

function renderAuth() {
  const signed = Boolean(currentUser);
  const label = $("#auth-btn-label");
  if (label) {
    clear(label);
    if (signed) {
      label.append(el("span", { attrs: { "aria-hidden": "true" }, text: "👤 " }), `${(currentUser.displayName || "You").split(" ")[0]} (Sign out)`);
    } else label.textContent = "G Sign In";
  }
  const account = $("#my-display-account");
  if (account) {
    account.textContent = signed
      ? `${currentUser.displayName || "Signed in"} (${currentUser.email})`
      : "Not signed in";
  }
  document.querySelectorAll("[data-needs-auth]").forEach((node) => {
    node.disabled = !signed;
  });
  document.querySelectorAll("[data-auth-pill]").forEach((node) => {
    node.hidden = signed;
  });
  const note = $("#receipt-auth-note");
  if (note) note.hidden = signed;
  $("#friends-stack")?.classList.toggle("signed-out", !signed);
  const upi = $("#profile-upi");
  if (upi && document.activeElement !== upi) upi.value = appState.profile.upiId || "";
}

function navigateTo(page) {
  showPage(page);
  if (location.hash !== `#${page}`) location.hash = page;
}

function showPage(page) {
  const known = TITLES[page] ? page : "home";
  document.querySelectorAll(".app-page").forEach((section) => {
    section.classList.toggle("active", section.id === `page-${known}`);
  });
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.classList.toggle("active", button.dataset.nav === known);
  });
  document.title = TITLES[known];
  if (known === "analytics") renderAnalytics();
}

function applyTheme() {
  document.documentElement.dataset.theme = appState.theme === "dark" ? "dark" : "light";
  const text = $("#theme-btn-text");
  const toggle = $("#btn-theme-toggle");
  const dark = appState.theme === "dark";
  if (text) text.textContent = dark ? "Light mode" : "Dark mode";
  if (toggle) toggle.setAttribute("aria-pressed", dark ? "true" : "false");
}

function participants() {
  if (scope === "friend") {
    const friend = appState.friends.find((item) => item.id === selectedFriendId);
    return [{ id: me(), name: personName(me()) }, ...(friend ? [{ id: friend.id, name: friend.name }] : [])];
  }
  return getGroup()?.members || [];
}

function fillPeople(select, people, previous) {
  if (!select) return;
  clear(select);
  for (const person of people) {
    select.append(el("option", { value: person.id, text: person.name }));
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
}

function renderSelectors() {
  const select = $("#group-selector");
  const group = getGroup();
  const groups = Object.values(appState.groups);
  if (select) {
    const previous = select.value;
    clear(select);
    if (!groups.length) select.append(el("option", { value: "", text: "No groups yet" }));
    for (const item of groups) {
      select.append(el("option", { value: item.id, text: `${item.name} (${item.currency})` }));
    }
    if (group) select.value = group.id;
    else if (previous) select.value = previous;
  }
  const choose = $("#group-choose-hint");
  const empty = $("#group-empty-hint");
  const panel = $("#group-manage-panel");
  if (choose) choose.hidden = !(groups.length && !group);
  if (empty) empty.hidden = groups.length > 0;
  if (panel) panel.hidden = !group;
  const currencySelect = $("#currency-select");
  if (currencySelect && group && document.activeElement !== currencySelect) {
    [...currencySelect.options].forEach((option) => {
      if (option.dataset.custom === "1") option.remove();
    });
    if (!KNOWN.includes(group.currency)) {
      const option = el("option", { value: group.currency, text: group.currency });
      option.dataset.custom = "1";
      currencySelect.append(option);
    }
    currencySelect.value = KNOWN.includes(group.currency) || [...currencySelect.options].some((option) => option.value === group.currency)
      ? group.currency
      : "₹";
  }
  document.querySelectorAll(".currency-label").forEach((node) => { node.textContent = cur(); });
  if ($("#home-group-name")) $("#home-group-name").textContent = group?.name || "No group";
  if ($("#add-page-group-label")) {
    $("#add-page-group-label").textContent = scope === "friend"
      ? "1-on-1 split"
      : `Active group: ${group?.name || "none"}`;
  }
  const friendPick = $("#friend-picker-select");
  if (friendPick && group) {
    clear(friendPick);
    friendPick.append(el("option", { value: "", text: "Choose a friend" }));
    const available = getAvailableFriendsForGroup(appState.friends, group.members);
    for (const friend of available) {
      friendPick.append(el("option", { value: friend.id, text: friend.email ? `${friend.name} (${friend.email})` : friend.name }));
    }
  }
}

function renderMembers() {
  const group = getGroup();
  const box = $("#members-container");
  const homeChips = $("#home-members-chips");
  if ($("#member-count")) $("#member-count").textContent = String(group?.members.length || 0);
  if (box) {
    clear(box);
    for (const member of group?.members || []) {
      const remove = el("button", {
        type: "button",
        class: "chip-remove",
        text: "×",
        attrs: { "aria-label": `Remove ${member.name}` },
        on: { click: () => removeMember(member.id) }
      });
      box.append(el("span", { class: "chip" }, [el("span", { text: member.name }), remove]));
    }
  }
  if (homeChips) {
    clear(homeChips);
    for (const member of group?.members || []) homeChips.append(el("span", { class: "chip", text: member.name }));
  }
  const people = scope === "group" ? (group?.members || []) : participants();
  if (!($("#expense-form")?.contains(document.activeElement))) {
    fillPeople($("#payer-select"), people, $("#payer-select")?.value);
    renderSplit();
  }
  fillPeople($("#settle-payer"), group?.members || [], $("#settle-payer")?.value);
  fillPeople($("#settle-receiver"), group?.members || [], $("#settle-receiver")?.value);
  const filter = $("#filter-member-select");
  if (filter && document.activeElement !== filter) {
    const previous = memberFilter;
    clear(filter);
    filter.append(el("option", { value: "all", text: "All members" }));
    for (const member of group?.members || []) filter.append(el("option", { value: member.id, text: member.name }));
    filter.value = [...filter.options].some((option) => option.value === previous) ? previous : "all";
  }
}

function renderSplit() {
  const box = $("#split-breakdown-container");
  if (!box) return;
  clear(box);
  const people = participants();
  const intro = scope === "friend" ? "1-on-1 split" : "Group split";
  if (splitMode === "equal") {
    box.append(el("div", { class: "transaction-meta", text: `Select who shares this bill (${intro}).` }));
    for (const person of people) {
      const input = el("input", { type: "checkbox", class: "split-equal-check", value: person.id, checked: true });
      input.addEventListener("change", updateSplitPreview);
      const amount = el("span", { class: "equal-val", text: formatMoney(0, cur()) });
      amount.dataset.for = person.id;
      box.append(el("div", { class: "split-row" }, [
        el("label", {}, [input, document.createTextNode(` ${person.name}`)]),
        amount
      ]));
    }
  } else if (splitMode === "exact" || splitMode === "percent" || splitMode === "ratio") {
    const labels = { exact: "Exact amount each person owes", percent: "Percentages, totalling 100", ratio: "Weight shares, such as 1 each" };
    box.append(el("div", { class: "transaction-meta", text: labels[splitMode] }));
    for (const person of people) {
      const input = el("input", {
        type: "number",
        class: `split-${splitMode}-input`,
        value: splitMode === "ratio" ? "1" : "",
        attrs: { step: splitMode === "exact" ? "0.01" : "1", min: "0", "data-member": person.id }
      });
      input.addEventListener("input", updateSplitPreview);
      const suffix = splitMode === "exact" ? cur() : (splitMode === "percent" ? "%" : "share(s)");
      box.append(el("div", { class: "split-row" }, [
        el("label", { text: person.name }),
        el("div", { style: "display:flex;align-items:center;gap:4px;" }, [
          splitMode === "exact" ? el("span", { text: suffix }) : input,
          splitMode === "exact" ? input : el("span", { text: suffix })
        ])
      ]));
    }
    box.append(el("div", { id: "split-diff-msg", class: "split-validation-msg" }));
  }
  updateSplitPreview();
}

function checkedIds() {
  return [...document.querySelectorAll(".split-equal-check:checked")].map((node) => node.value);
}

function updateSplitPreview() {
  const total = rupeesToPaise($("#amount")?.value) || 0;
  if (splitMode === "equal") {
    const ids = checkedIds();
    const shares = ids.length ? allocateEqual(total, ids) : {};
    document.querySelectorAll(".equal-val").forEach((node) => {
      const share = shares?.[node.dataset.for] || 0;
      node.textContent = formatMoney(share, cur());
    });
    return;
  }
  const msg = $("#split-diff-msg");
  if (!msg) return;
  if (splitMode === "exact") {
    let sum = 0;
    document.querySelectorAll(".split-exact-input").forEach((input) => { sum += rupeesToPaise(input.value) || 0; });
    const diff = total - sum;
    msg.textContent = diff === 0 ? "Amounts match the total." : `Remaining to allocate: ${formatMoney(diff, cur())}`;
    msg.className = `split-validation-msg ${diff === 0 ? "msg-valid" : "msg-invalid"}`;
  } else if (splitMode === "percent") {
    let sum = 0;
    document.querySelectorAll(".split-percent-input").forEach((input) => { sum += Number(input.value) || 0; });
    const ok = Math.abs(sum - 100) < 0.5;
    msg.textContent = ok ? "Percentages total 100." : `Total allocated: ${sum}. Needs ${100 - sum}.`;
    msg.className = `split-validation-msg ${ok ? "msg-valid" : "msg-invalid"}`;
  } else msg.textContent = "";
}

function collectShares(total) {
  const people = participants();
  if (splitMode === "equal") {
    const ids = checkedIds();
    if (!ids.length) return null;
    return allocateEqual(total, ids);
  }
  if (splitMode === "exact") {
    const shares = {};
    let sum = 0;
    document.querySelectorAll(".split-exact-input").forEach((input) => {
      const paise = rupeesToPaise(input.value) || 0;
      shares[input.dataset.member] = paise;
      sum += paise;
    });
    people.forEach((person) => { if (shares[person.id] == null) shares[person.id] = 0; });
    if (sum !== total) return null;
    return shares;
  }
  if (splitMode === "percent") {
    const weights = [];
    let sum = 0;
    document.querySelectorAll(".split-percent-input").forEach((input) => {
      const weight = Number(input.value) || 0;
      sum += weight;
      weights.push({ id: input.dataset.member, weight });
    });
    if (Math.abs(sum - 100) > 0.5) return null;
    return allocateWeighted(total, weights);
  }
  const weights = [...document.querySelectorAll(".split-ratio-input")].map((input) => ({
    id: input.dataset.member,
    weight: Number(input.value) || 0
  }));
  return allocateWeighted(total, weights);
}

function setScope(next) {
  scope = next;
  const groupBtn = $("#btn-scope-group");
  const friendBtn = $("#btn-scope-friend");
  const box = $("#direct-friend-box");
  const on = "var(--primary)";
  if (groupBtn && friendBtn) {
    groupBtn.style.background = next === "group" ? on : "transparent";
    groupBtn.style.color = next === "group" ? "#fff" : "var(--text)";
    friendBtn.style.background = next === "friend" ? on : "transparent";
    friendBtn.style.color = next === "friend" ? "#fff" : "var(--text)";
  }
  if (box) box.hidden = next !== "friend";
  if (!editingId && $("#form-heading")) $("#form-heading").textContent = next === "friend" ? "Add a 1-on-1 expense" : "Add an expense";
  if (next === "friend") renderDirectFriends();
  renderMembers();
  if ($("#add-page-group-label")) {
    $("#add-page-group-label").textContent = next === "friend" ? "1-on-1 split" : `Active group: ${getGroup()?.name || "none"}`;
  }
}

function renderDirectFriends() {
  const select = $("#direct-friend-select");
  if (!select) return;
  clear(select);
  if (!appState.friends.length) {
    select.append(el("option", { value: "", text: "No friends yet — type a new name" }));
    selectedFriendId = "";
  } else {
    for (const friend of appState.friends) {
      const option = el("option", { value: friend.id, text: friend.email ? `${friend.name} (${friend.email})` : friend.name });
      select.append(option);
    }
    if (!appState.friends.some((friend) => friend.id === selectedFriendId)) selectedFriendId = appState.friends[0].id;
    select.value = selectedFriendId;
  }
  fillPeople($("#payer-select"), participants(), $("#payer-select")?.value);
}

function debtsFor(group) {
  if (!group) return [];
  const { balances } = computeBalances(group.members, group.transactions);
  return group.simplifyDebts === false ? pairwiseDebts(group.transactions) : simplifyDebts(balances);
}

function homeNumbers() {
  const parts = owedAndOwing(debtsFor(getGroup()), me());
  for (const friend of appState.friends) {
    const balance = directBalance(appState.directTransactions, friend.id, me());
    if (balance > 0) parts.owed += balance;
    else parts.owe += -balance;
  }
  return parts;
}

function renderHome() {
  const numbers = homeNumbers();
  const symbol = cur();
  if ($("#home-owed")) $("#home-owed").textContent = formatMoney(numbers.owed, symbol);
  if ($("#home-owe")) $("#home-owe").textContent = formatMoney(numbers.owe, symbol);
  const net = numbers.owed - numbers.owe;
  const standing = $("#home-standing-text");
  const sub = $("#home-standing-sub");
  if (standing) {
    if (Math.abs(net) < 1) standing.textContent = "All settled up";
    else if (net > 0) standing.textContent = `Ahead ${formatMoney(net, symbol)}`;
    else standing.textContent = `Short ${formatMoney(-net, symbol)}`;
  }
  if (sub) {
    sub.textContent = getGroup()
      ? "Across the active group and direct bills."
      : "Create a group, or add a friend for a 1-on-1 bill.";
  }
  const list = $("#home-settle-list");
  if (list) {
    clear(list);
    const debts = debtsFor(getGroup()).slice(0, 3);
    for (const debt of debts) list.append(settlementRow(debt, true));
  }
  const group = getGroup();
  const expenseCount = (group?.transactions || []).filter((tx) => tx.type === "expense").length;
  const total = (group?.transactions || []).filter((tx) => tx.type === "expense").reduce((sum, tx) => sum + (tx.amountPaise || 0), 0);
  if ($("#home-group-stats")) {
    $("#home-group-stats").textContent = group
      ? `${group.members.length} members · ${formatMoney(total, group.currency)} spent`
      : "No active group";
  }
  if ($("#dash-history-desc")) $("#dash-history-desc").textContent = `${(group?.transactions.length || 0) + (appState.directTransactions?.length || 0)} transactions recorded`;
  if ($("#dash-settle-desc")) $("#dash-settle-desc").textContent = debtsFor(group).length ? `${debtsFor(group).length} payments to settle` : "Nothing waiting to settle";
  if ($("#dash-friends-desc")) $("#dash-friends-desc").textContent = `${appState.friends.length} friends`;
}

function settlementRow(debt, compact) {
  const actions = el("div", { class: "settle-actions" });
  actions.append(el("button", {
    type: "button",
    class: "btn-quick-settle",
    text: "Settle",
    on: { click: () => quickSettle(debt.from, debt.to, debt.amountPaise) }
  }));
  if (cur() === "₹") {
    actions.append(el("button", {
      type: "button",
      class: "btn btn-secondary",
      text: "UPI",
      attrs: { "aria-label": `UPI payment from ${personName(debt.from)} to ${personName(debt.to)}` },
      on: { click: () => openUpi({ payeeId: debt.to, amountPaise: debt.amountPaise, note: `${personName(debt.from)} pays ${personName(debt.to)}` }) }
    }));
  }
  return el(compact ? "li" : "li", { class: "settlement-item" }, [
    el("div", { class: "settlement-copy" }, [
      el("strong", { text: personName(debt.from) }),
      document.createTextNode(" pays "),
      el("strong", { text: personName(debt.to) })
    ]),
    el("div", { class: "settle-actions" }, [
      el("span", { class: "settle-badge", text: formatMoney(debt.amountPaise, cur()) }),
      actions
    ])
  ]);
}

function renderBalances() {
  const group = getGroup();
  const symbol = cur();
  const stats = group ? computeBalances(group.members, group.transactions) : { balances: {}, spent: {}, shareOwed: {}, expenseCount: 0, settleCount: 0, totalSpend: 0 };
  if ($("#total-spent")) $("#total-spent").textContent = formatMoney(stats.totalSpend, symbol);
  if ($("#total-expense-count")) $("#total-expense-count").textContent = String(stats.expenseCount || 0);
  if ($("#total-settle-count")) $("#total-settle-count").textContent = String(stats.settleCount || 0);
  const body = $("#member-spend-tbody");
  if (body) {
    clear(body);
    for (const member of group?.members || []) {
      const balance = stats.balances[member.id] || 0;
      const row = el("tr");
      row.append(el("td", {}, [el("strong", { text: member.name })]));
      row.append(el("td", { text: formatMoney(stats.spent[member.id] || 0, symbol), style: "text-align:right" }));
      row.append(el("td", { text: formatMoney(stats.shareOwed[member.id] || 0, symbol), style: "text-align:right" }));
      const balCell = el("td", {
        class: balance > 0 ? "text-success" : (balance < 0 ? "text-danger" : "text-muted"),
        text: `${balance > 0 ? "+" : ""}${formatMoney(balance, symbol)}`,
        style: "text-align:right;font-weight:700"
      });
      row.append(balCell);
      const button = el("button", { type: "button", class: "btn btn-secondary", text: "View", on: { click: () => openMember(member.id) } });
      button.style.padding = "4px 8px";
      row.append(el("td", { style: "text-align:center" }, [button]));
      body.append(row);
    }
  }
  const select = $("#member-inspect-select");
  if (select && document.activeElement !== select) {
    clear(select);
    select.append(el("option", { value: "", text: "Inspect member…" }));
    for (const member of group?.members || []) select.append(el("option", { value: member.id, text: member.name }));
  }
  const list = $("#settlement-list");
  const debts = debtsFor(group);
  if ($("#simplify-desc")) {
    $("#simplify-desc").textContent = group?.simplifyDebts === false
      ? "Off: each pair keeps their own bill, without combining through a third person."
      : "On: minimizes payments. If A owes B and B owes C, A pays C directly.";
  }
  if ($("#settlement-header-label")) {
    $("#settlement-header-label").textContent = group?.simplifyDebts === false ? "Individual debts" : "Suggested debt settlements";
  }
  const toggle = $("#toggle-simplify");
  if (toggle && document.activeElement !== toggle) toggle.checked = group ? group.simplifyDebts !== false : true;
  if (list) {
    clear(list);
    if (!group) list.append(el("li", { class: "settlement-item", text: "Create a group to see shared balances." }));
    else if (!debts.length) list.append(el("li", { class: "settlement-item", text: "Everyone is settled up." }));
    else debts.forEach((debt) => list.append(settlementRow(debt)));
  }
  renderDirectBalances();
}

function renderDirectBalances() {
  const box = $("#direct-balances-list");
  if (!box) return;
  clear(box);
  if (!appState.friends.length) {
    box.append(el("div", { class: "empty-state", text: "No friends yet. Add someone to split a 1-on-1 bill." }));
    return;
  }
  for (const friend of appState.friends) {
    const balance = directBalance(appState.directTransactions, friend.id, me());
    const status = Math.abs(balance) < 1
      ? "Settled up"
      : (balance > 0 ? `Owes you ${formatMoney(balance, cur())}` : `You owe ${formatMoney(-balance, cur())}`);
    const actions = el("div", { class: "settle-actions" });
    actions.append(el("button", { type: "button", class: "btn btn-secondary", text: "Split", on: { click: () => startDirectExpense(friend.id) } }));
    if (Math.abs(balance) >= 1) {
      actions.append(el("button", { type: "button", class: "btn btn-settle", text: "Settle", on: { click: () => settleDirect(friend.id, balance) } }));
      if (cur() === "₹") {
        const payee = balance > 0 ? me() : friend.id;
        actions.append(el("button", {
          type: "button",
          class: "btn btn-secondary",
          text: "UPI",
          attrs: { "aria-label": "Show UPI payment QR" },
          on: { click: () => openUpi({ payeeId: payee, amountPaise: Math.abs(balance), note: `FairShare with ${friend.name}` }) }
        }));
      }
    }
    box.append(el("div", { class: "settlement-item" }, [
      el("div", { class: "settlement-copy" }, [
        el("strong", { text: friend.name }),
        friend.email ? el("span", { class: "transaction-meta", text: friend.email }) : null,
        el("span", { class: balance > 0 ? "text-success" : (balance < 0 ? "text-danger" : "text-muted"), text: status, style: "display:block;font-weight:700" })
      ]),
      actions
    ]));
  }
}

function renderHistory() {
  const list = $("#transaction-list");
  const empty = $("#empty-msg");
  if (!list) return;
  clear(list);
  const group = getGroup();
  let rows = [
    ...(group?.transactions || []).map((tx) => ({ ...tx, where: group.name })),
    ...(appState.directTransactions || []).map((tx) => ({ ...tx, where: `1-on-1: ${personName(tx.friendId)}` }))
  ];
  if (historyScope === "group") rows = rows.filter((tx) => tx.scope !== "direct");
  if (historyScope === "direct") rows = rows.filter((tx) => tx.scope === "direct");
  if (historyFilter === "expenses") rows = rows.filter((tx) => tx.type === "expense");
  if (historyFilter === "settlements") rows = rows.filter((tx) => tx.type === "settlement");
  if (memberFilter !== "all") {
    rows = rows.filter((tx) => tx.payerId === memberFilter || tx.receiverId === memberFilter || (tx.shares && tx.shares[memberFilter] > 0));
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    rows = rows.filter((tx) => `${tx.desc} ${personName(tx.payerId)} ${tx.category || ""}`.toLowerCase().includes(q));
  }
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  if (empty) empty.hidden = rows.length > 0;
  const recent = $("#home-recent-list");
  const recentEmpty = $("#home-recent-empty");
  if (recent) clear(recent);
  const recentRows = (group?.transactions || []).slice(0, 3);
  if (recentEmpty) recentEmpty.hidden = recentRows.length > 0;
  for (const tx of recentRows) recent?.append(txButton(tx, false));
  for (const tx of rows) list.append(txButton(tx, true));
}

function txButton(tx, showWhere) {
  const icon = tx.type === "settlement" ? "🤝" : (CATEGORY_ICONS[tx.category] || "📦");
  const button = el("button", { type: "button", class: "transaction-item", on: { click: () => openDetail(tx.id) } });
  const title = el("strong", { text: tx.desc || "Expense" });
  if (tx.recurring) title.append(el("span", { class: "repeat-badge", text: tx.recurring.freq === "weekly" ? "Weekly" : "Monthly" }));
  const meta = `${tx.date || ""} · ${tx.type === "settlement" ? `${personName(tx.payerId)} paid ${personName(tx.receiverId)}` : `Paid by ${personName(tx.payerId)}`}${tx.receiptDataUrl || tx.receiptUrl ? " · Receipt" : ""}${showWhere && tx.where ? ` · ${tx.where}` : ""}`;
  button.append(
    el("div", { class: "transaction-main" }, [
      el("span", { class: "transaction-icon", attrs: { "aria-hidden": "true" }, text: icon }),
      el("span", { class: "transaction-copy" }, [title, el("span", { class: "transaction-meta", text: meta })])
    ]),
    el("span", { class: "transaction-amount", text: formatMoney(tx.amountPaise, cur()) })
  );
  return button;
}

function renderFriends() {
  if ($("#global-friends-count")) $("#global-friends-count").textContent = String(appState.friends.length);
  const list = $("#friends-list-container");
  if (!list) return;
  clear(list);
  if (!appState.friends.length) {
    list.append(el("div", { class: "empty-state", text: "No saved friends yet. Add a name above." }));
    return;
  }
  for (const friend of appState.friends) {
    const balance = directBalance(appState.directTransactions, friend.id, me());
    const row = el("div", { class: "friend-row" });
    const info = el("div", {}, [
      el("strong", { text: friend.name }),
      el("span", { class: friend.approved ? "approved-pill" : "request-pending-pill", text: friend.approved ? "Approved" : "Local" }),
      Math.abs(balance) >= 1 ? el("span", { class: balance > 0 ? "text-success" : "text-danger", text: balance > 0 ? ` Owes you ${formatMoney(balance, cur())}` : ` You owe ${formatMoney(-balance, cur())}` }) : null,
      el("span", { class: "transaction-meta", text: friend.email || "Saved name" })
    ]);
    const actions = el("div", { class: "settle-actions" });
    actions.append(el("button", { type: "button", class: "btn btn-secondary", text: "Split", on: { click: () => startDirectExpense(friend.id) } }));
    if (Math.abs(balance) >= 1) actions.append(el("button", { type: "button", class: "btn btn-settle", text: "Settle", on: { click: () => settleDirect(friend.id, balance) } }));
    actions.append(el("button", {
      type: "button",
      class: "btn-delete",
      text: "×",
      attrs: { "aria-label": `Remove ${friend.name}` },
      on: { click: () => deleteFriend(friend.id) }
    }));
    row.append(info, actions);
    list.append(row);
  }
}

function renderFriendRequests() {
  const count = incoming.length;
  for (const id of ["incoming-badge-count", "desktop-requests-badge", "mobile-requests-badge"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.textContent = String(count);
    node.hidden = count === 0;
  }
  const inBox = $("#incoming-requests-container");
  if (inBox) {
    clear(inBox);
    if (!currentUser) {
      inBox.append(el("div", { class: "empty-state", text: "Sign in with Google to approve requests sent to your email." }));
    } else if (!incoming.length) {
      inBox.append(el("div", { class: "empty-state", text: `No pending requests for ${currentUser.email}.` }));
    } else {
      for (const req of incoming) {
        const approve = el("button", { type: "button", class: "btn btn-approve", text: "Approve", on: { click: () => approveRequest(req) } });
        const decline = el("button", { type: "button", class: "btn btn-decline", text: "Decline", on: { click: () => declineRequest(req.id) } });
        inBox.append(el("div", { class: "incoming-request-card" }, [
          el("div", { class: "request-info" }, [
            el("div", { class: "request-avatar", attrs: { "aria-hidden": "true" }, text: "👤" }),
            el("div", {}, [
              el("strong", { text: req.fromName || "Friend" }),
              el("div", { class: "transaction-meta", text: req.fromEmail || "" }),
              el("span", { class: "request-pending-pill", text: "Wants to connect" })
            ])
          ]),
          el("div", { class: "request-actions" }, [approve, decline])
        ]));
      }
    }
  }
  const outBox = $("#outgoing-requests-container");
  if (outBox) {
    clear(outBox);
    if (!outgoing.length) outBox.append(el("div", { class: "transaction-meta", text: "No pending sent requests." }));
    for (const req of outgoing) {
      outBox.append(el("div", { class: "outgoing-request-row" }, [
        el("div", {}, [
          el("span", { text: `Request to ${req.toEmail || ""}` }),
          el("span", { class: "request-pending-pill", text: "Pending" })
        ]),
        el("button", { type: "button", class: "btn btn-secondary", text: "Cancel", on: { click: () => cancelRequest(req.id) } })
      ]));
    }
  }
}

function renderAnalytics() {
  const group = getGroup();
  const subtitle = $("#analytics-subtitle");
  if (subtitle) subtitle.textContent = group ? group.name : "Create a group to see spending.";
  const styleTabs = $("#chart-style-tabs");
  if (styleTabs) styleTabs.hidden = analyticsView !== "category";
  let entries = [];
  let emptyText = "No category spending yet. Add an expense to see analytics.";
  if (analyticsView === "category") {
    entries = categoryTotals(group?.transactions).map(([label, value]) => ({
      label: `${CATEGORY_ICONS[label] || "📦"} ${label}`,
      value,
      color: CATEGORY_COLORS[label] || "#475569"
    }));
  } else if (analyticsView === "person") {
    emptyText = "No per-person shares yet.";
    entries = personShareTotals(group?.members || [], group?.transactions).map(([member, value], index) => ({
      label: member.name,
      value,
      color: PERSON_COLORS[index % PERSON_COLORS.length]
    }));
  } else {
    emptyText = "No spending over time yet.";
    entries = timeTotals(group?.transactions).map(([label, value]) => ({ label, value, color: "#0369a1" }));
  }
  renderChart({
    visual: $("#chart-visual"),
    legend: $("#chart-legend"),
    empty: $("#chart-empty"),
    area: $("#chart-area"),
    kind: analyticsView === "category" ? chartKind : "bar",
    entries,
    currency: cur(),
    emptyText
  });
}

function renderAll() {
  applyTheme();
  renderAuth();
  renderSelectors();
  renderMembers();
  renderHome();
  renderBalances();
  renderHistory();
  renderFriends();
  renderFriendRequests();
  if ($("#page-analytics")?.classList.contains("active")) renderAnalytics();
}

async function addMemberByName(name) {
  const group = getGroup();
  const clean = name.trim();
  if (!group) return toast("Create a group first.");
  if (!clean) return toast("Enter a name.");
  let friend = appState.friends.find((item) => item.name.toLowerCase() === clean.toLowerCase());
  if (!friend) {
    friend = createFriend(clean);
    appState.friends.push(friend);
  }
  if (!addFriendToGroup(group, friend)) return toast(`${clean} is already in this group.`);
  touchGroup(group);
  saveState();
  renderAll();
  toast(`${clean} added to ${group.name}.`);
}

async function removeMember(id) {
  const group = getGroup();
  if (!group) return;
  if (group.members.length <= 1) return toast("Keep at least one member in the group.");
  const member = group.members.find((item) => item.id === id);
  if (!member) return;
  const used = group.transactions.some((tx) => tx.payerId === id || tx.receiverId === id || (tx.shares && tx.shares[id] > 0));
  const ok = await confirmDialog({
    title: "Remove member",
    message: used
      ? `${member.name} is part of existing expenses. Removing them changes the balance sheet. Remove anyway?`
      : `Remove ${member.name} from this group?`,
    confirmLabel: "Remove",
    danger: true
  });
  if (!ok) return;
  group.members = group.members.filter((item) => item.id !== id);
  group.removedMemberIds = [...new Set([...(group.removedMemberIds || []), id])];
  touchGroup(group);
  saveState();
  renderAll();
}

async function deleteFriend(id) {
  const friend = appState.friends.find((item) => item.id === id);
  if (!friend) return;
  const ok = await confirmDialog({ title: "Remove friend", message: `Remove ${friend.name} from your roster?`, confirmLabel: "Remove", danger: true });
  if (!ok) return;
  appState.friends = appState.friends.filter((item) => item.id !== id);
  saveState();
  renderAll();
}

function addApproved(email, name, announce = true) {
  const em = String(email || "").toLowerCase().trim();
  if (!em) return null;
  let friend = appState.friends.find((item) => item.email === em);
  if (!friend) {
    friend = createFriend(name || em.split("@")[0], em);
    friend.approved = true;
    friend.type = "google";
    appState.friends.push(friend);
    saveState();
    if (announce) toast(`${friend.name} is now a connected friend.`);
  } else if (!friend.approved) {
    friend.approved = true;
    saveState();
  }
  return friend;
}

async function sendFriendRequest() {
  if (!currentUser) return toast("Sign in to send an in-app request.");
  const raw = $("#input-friend-email")?.value.trim() || "";
  if (!validEmail(raw)) return toast("Enter your friend's Google email address.");
  const target = raw.toLowerCase();
  const mine = currentUser.email.toLowerCase();
  if (target === mine) return toast("That is your own email address.");
  if (appState.friends.some((friend) => friend.email === target)) return toast(`${target} is already connected.`);
  const mutual = incoming.find((row) => (row.fromEmail || "").toLowerCase() === target);
  if (mutual) {
    await approveRequest(mutual);
    $("#input-friend-email").value = "";
    return toast(`You and ${target} are now connected.`);
  }
  if (!fx) return toast("Sign in is still connecting. Try again in a moment.");
  const id = `req_${normalizeEmail(mine)}_to_${normalizeEmail(target)}`.replace(/[^a-z0-9_]/g, "_");
  const data = {
    fromEmail: mine,
    fromEmailNormalized: normalizeEmail(mine),
    fromName: currentUser.displayName || mine.split("@")[0],
    toEmail: target,
    toEmailNormalized: normalizeEmail(target),
    status: "pending",
    createdAt: Date.now()
  };
  try {
    await setRequest(fx, id, data);
    $("#input-friend-email").value = "";
    toast(`Friend request sent to ${target}.`);
  } catch (err) {
    toast(`Could not send the request. ${err.message || ""}`.trim());
  }
}

async function approveRequest(req) {
  if (!currentUser) return;
  incoming = incoming.filter((row) => row.id !== req.id);
  addApproved(req.fromEmail, req.fromName || req.fromEmail?.split("@")[0]);
  renderFriendRequests();
  renderFriends();
  if (fx) {
    try {
      await patchRequest(fx, req.id, {
        status: "accepted",
        acceptedByEmail: currentUser.email.toLowerCase(),
        acceptedByName: currentUser.displayName || currentUser.email.split("@")[0],
        acceptedAt: Date.now()
      });
    } catch (err) {
      toast("Saved locally. The cloud update did not go through.");
    }
  }
}

async function declineRequest(id) {
  const ok = await confirmDialog({ title: "Decline request", message: "Decline this friend request?", confirmLabel: "Decline", danger: true });
  if (!ok) return;
  incoming = incoming.filter((row) => row.id !== id);
  renderFriendRequests();
  if (fx) patchRequest(fx, id, { status: "declined", declinedAt: Date.now() }).catch(() => {});
}

async function cancelRequest(id) {
  const ok = await confirmDialog({ title: "Cancel request", message: "Cancel this outgoing friend request?", confirmLabel: "Cancel request" });
  if (!ok) return;
  outgoing = outgoing.filter((row) => row.id !== id);
  renderFriendRequests();
  if (fx) removeRequest(fx, id).catch(() => {});
}

async function checkIncoming() {
  if (!currentUser || !fx) return toast("Sign in with Google before checking for requests.");
  try {
    const rows = await fetchIncoming(fx, currentUser.email.toLowerCase());
    incoming = rows.filter((row) => row.status === "pending");
    renderFriendRequests();
    toast(incoming.length ? `Found ${incoming.length} pending request${incoming.length === 1 ? "" : "s"}.` : "No pending requests for your signed-in email.");
  } catch (err) {
    toast(`Cloud check failed. ${err.message || ""}`.trim());
  }
}

function applyPreset(desc, category) {
  $("#desc").value = desc;
  $("#category-select").value = category;
  categoryManual = true;
  updateCatBadge("manual");
  $("#amount").focus();
}

function updateCatBadge(type) {
  const badge = $("#cat-detect-badge");
  if (!badge) return;
  badge.hidden = !type;
  badge.className = `cat-badge ${type === "auto" ? "cat-badge-auto" : "cat-badge-manual"}`;
  badge.textContent = type === "auto" ? "Auto" : "Manual";
}

function resetForm() {
  editingId = "";
  pendingReceipt = null;
  categoryManual = false;
  $("#editing-tx-id").value = "";
  $("#form-heading").textContent = scope === "friend" ? "Add a 1-on-1 expense" : "Add an expense";
  $("#btn-submit-expense").textContent = "Save expense";
  $("#desc").value = "";
  $("#amount").value = "";
  $("#recurring-select").value = "";
  $("#receipt-file").value = "";
  $("#receipt-upload-preview").hidden = true;
  $("#btn-clear-receipt").hidden = true;
  updateCatBadge(null);
  renderSplit();
}

async function onReceipt(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("Choose an image of the bill.");
  if (file.size > 15 * 1024 * 1024) return toast("That image is too large to attach.");
  const raw = await readFile(file);
  const dataUrl = await compressImage(raw);
  pendingReceipt = dataUrl;
  $("#receipt-thumb").src = dataUrl;
  $("#receipt-thumb").alt = "Receipt preview";
  $("#receipt-upload-preview").hidden = false;
  $("#btn-clear-receipt").hidden = false;
  if (!currentUser) {
    $("#scan-status-title").textContent = "Photo saved on this device";
    $("#scan-status-detail").textContent = "Sign in to scan the total from the bill.";
    return;
  }
  scanReceipt(dataUrl);
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

async function scanReceipt(dataUrl) {
  $("#scan-status-title").textContent = "Scanning the bill…";
  $("#scan-status-detail").textContent = "Reading amounts. This stays in your browser.";
  try {
    const Tesseract = await loadTesseract();
    const prepared = await preprocessForOcr(dataUrl);
    const result = await Tesseract.recognize(prepared, "eng");
    parseReceiptText(result.data?.text || "");
  } catch (err) {
    $("#scan-status-title").textContent = "Bill photo attached";
    $("#scan-status-detail").textContent = "The scanner did not load. Enter the amount yourself.";
  }
}

function parseReceiptText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    $("#scan-status-title").textContent = "No readable text in that photo";
    $("#scan-status-detail").textContent = "Enter the amount yourself.";
    return;
  }
  if (!$("#desc").value.trim()) {
    for (const line of lines.slice(0, 4)) {
      if (line.length > 2 && !/invoice|receipt|date|bill|gst|tax|order|table|cashier|welcome/i.test(line)) {
        $("#desc").value = line.replace(/[^a-zA-Z0-9 &'-]/g, "").trim();
        if (!categoryManual) {
          const detected = predictCategory($("#desc").value);
          if (detected) {
            $("#category-select").value = detected;
            updateCatBadge("auto");
          }
        }
        break;
      }
    }
  }
  const ignore = /gstin|date|time|table|order\s*no|invoice\s*no|fssai|phone|tel|mobile|cashier|pin/i;
  const totalWords = /grand\s*total|net\s*amount|total\s*amount|bill\s*amount|amount\s*payable|balance\s*due|total|subtotal|paid|sum/i;
  const amountRe = /(?:₹|Rs\.?|INR|\$|€|£)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})|[0-9]+(?:\.[0-9]{1,2}))/g;
  const prices = [];
  const candidates = [];
  for (const line of lines) {
    if (ignore.test(line)) continue;
    const nums = [];
    for (const match of line.matchAll(amountRe)) {
      const value = rupeesToPaise(match[1]);
      if (value > 0 && value < 50000000) nums.push(value);
    }
    prices.push(...nums);
    if (totalWords.test(line) && nums.length) {
      candidates.push({ weight: /grand\s*total|payable|net\s*amount/i.test(line) ? 3 : 2, amount: Math.max(...nums) });
    }
  }
  const detected = candidates.sort((a, b) => b.weight - a.weight || b.amount - a.amount)[0]?.amount
    || (prices.length ? Math.max(...prices) : null);
  if (detected) {
    $("#amount").value = paiseToInput(detected);
    updateSplitPreview();
    $("#scan-status-title").textContent = `Scanned total ${formatMoney(detected, cur())}`;
    $("#scan-status-detail").textContent = "Amount filled in. You can still change it.";
  } else {
    $("#scan-status-title").textContent = "Bill photo attached";
    $("#scan-status-detail").textContent = "Could not pinpoint the total.";
  }
  const chips = $("#detected-amounts-chips");
  const unique = [...new Set(prices)].sort((a, b) => b - a).slice(0, 6);
  clear(chips);
  $("#detected-amounts-wrapper").hidden = unique.length === 0;
  for (const amount of unique) {
    chips.append(el("button", {
      type: "button",
      class: "chip",
      text: formatMoney(amount, cur()),
      on: { click: () => { $("#amount").value = paiseToInput(amount); updateSplitPreview(); } }
    }));
  }
}

async function saveExpense(event) {
  event.preventDefault();
  const desc = $("#desc").value.trim();
  const amountPaise = rupeesToPaise($("#amount").value);
  const payerId = $("#payer-select").value;
  const category = $("#category-select").value || "Other";
  if (!desc || !amountPaise || amountPaise <= 0 || !payerId) return toast("Add a description, amount, and who paid.");
  if (scope === "group" && !getGroup()) return toast("Create a group, or switch to a 1-on-1 split.");
  if (scope === "friend" && !selectedFriendId) return toast("Choose a friend for this 1-on-1 split.");
  const shares = collectShares(amountPaise);
  if (!shares) return toast("The split does not add up to the total yet.");
  const freq = $("#recurring-select").value;
  let receiptDataUrl = pendingReceipt;
  let receiptUrl = null;
  let receiptPath = null;
  const id = editingId || newId();
  if (currentUser && fx && receiptDataUrl && scope === "group" && getGroup()) {
    try {
      const uploaded = await uploadReceipt(fx, `receipts/${getGroup().id}/${id}.jpg`, receiptDataUrl);
      receiptUrl = uploaded.url;
      receiptPath = uploaded.path;
    } catch (err) {
      toast("The photo is saved on this device. Cloud upload did not finish.");
    }
  }
  const base = {
    id,
    type: "expense",
    scope,
    friendId: scope === "friend" ? selectedFriendId : null,
    desc,
    amountPaise,
    payerId,
    receiverId: null,
    category,
    shares,
    splitMode,
    date: formatDate(new Date()),
    timestamp: Date.now(),
    updatedAt: Date.now(),
    recurring: freq ? { freq, nextDue: advanceRecurring(Date.now(), freq) } : null,
    receiptDataUrl,
    receiptUrl,
    receiptPath
  };
  if (editingId) {
    const located = findTx(editingId);
    if (!located) return toast("That expense is no longer here.");
    const previous = structuredClone(located.tx);
    Object.assign(located.tx, base, { id: located.tx.id, timestamp: located.tx.timestamp, date: located.tx.date });
    if (!receiptDataUrl && !receiptUrl) {
      located.tx.receiptDataUrl = previous.receiptDataUrl;
      located.tx.receiptUrl = previous.receiptUrl;
      located.tx.receiptPath = previous.receiptPath;
    }
    if (located.group) touchGroup(located.group);
    offerUndo("Expense updated", () => {
      const again = findTx(previous.id);
      if (again) Object.assign(again.tx, previous);
    });
  } else if (scope === "friend") {
    appState.directTransactions.unshift(base);
    toast("1-on-1 expense saved.");
  } else {
    const group = getGroup();
    group.transactions.unshift(base);
    touchGroup(group);
    toast("Expense saved.");
  }
  saveState();
  resetForm();
  renderAll();
  navigateTo("balances");
}

function startEdit(id) {
  const located = findTx(id);
  if (!located || located.tx.type !== "expense") return;
  const tx = located.tx;
  closeModal("#detail-modal");
  editingId = tx.id;
  $("#editing-tx-id").value = tx.id;
  scope = tx.scope === "direct" ? "friend" : "group";
  selectedFriendId = tx.friendId || "";
  setScope(scope);
  $("#form-heading").textContent = "Edit expense";
  $("#btn-submit-expense").textContent = "Update expense";
  $("#desc").value = tx.desc || "";
  $("#amount").value = paiseToInput(tx.amountPaise);
  $("#category-select").value = tx.category || "Other";
  $("#recurring-select").value = tx.recurring?.freq || "";
  categoryManual = true;
  updateCatBadge("manual");
  splitMode = tx.splitMode || "equal";
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === splitMode));
  renderSplit();
  restoreSplit(tx);
  if ($("#payer-select")) $("#payer-select").value = tx.payerId;
  pendingReceipt = tx.receiptDataUrl || null;
  const src = safeImageSrc(tx.receiptDataUrl || tx.receiptUrl);
  $("#receipt-upload-preview").hidden = !src;
  $("#btn-clear-receipt").hidden = !src;
  if (src) $("#receipt-thumb").src = src;
  navigateTo("add-expense");
}

function restoreSplit(tx) {
  const shares = tx.shares || {};
  if (splitMode === "equal") {
    document.querySelectorAll(".split-equal-check").forEach((input) => { input.checked = (shares[input.value] || 0) > 0; });
  } else if (splitMode === "exact") {
    document.querySelectorAll(".split-exact-input").forEach((input) => { input.value = paiseToInput(shares[input.dataset.member] || 0); });
  } else if (splitMode === "percent") {
    const total = tx.amountPaise || 1;
    document.querySelectorAll(".split-percent-input").forEach((input) => {
      input.value = String(Math.round(((shares[input.dataset.member] || 0) / total) * 100));
    });
  }
  updateSplitPreview();
}

async function deleteTx(id) {
  const located = findTx(id);
  if (!located) return;
  const ok = await confirmDialog({ title: "Delete record", message: "Delete this record?", confirmLabel: "Delete", danger: true });
  if (!ok) return;
  const snapshot = structuredClone(located.tx);
  const index = located.list.findIndex((tx) => tx.id === id);
  located.list.splice(index, 1);
  if (located.group) {
    located.group.deletedTxIds = [...new Set([...(located.group.deletedTxIds || []), id])].slice(-500);
    touchGroup(located.group);
  }
  closeModal("#detail-modal");
  saveState();
  renderAll();
  offerUndo("Record deleted", () => {
    located.list.splice(index, 0, snapshot);
    if (located.group) located.group.deletedTxIds = (located.group.deletedTxIds || []).filter((item) => item !== id);
  });
}

function quickSettle(from, to, amountPaise) {
  navigateTo("balances");
  const box = $("#settle-up-box");
  box.hidden = false;
  box.classList.add("active");
  $("#settle-payer").value = from;
  $("#settle-receiver").value = to;
  $("#settle-amount").value = paiseToInput(amountPaise);
  $("#btn-toggle-settle-form").textContent = "Hide settle up";
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

function saveSettlement(event) {
  event.preventDefault();
  const group = getGroup();
  if (!group) return toast("Create a group before recording a group settlement.");
  const payerId = $("#settle-payer").value;
  const receiverId = $("#settle-receiver").value;
  const amountPaise = rupeesToPaise($("#settle-amount").value);
  if (!payerId || !receiverId || !amountPaise || amountPaise <= 0) return toast("Enter who paid, who received it, and the amount.");
  if (payerId === receiverId) return toast("Payer and receiver need to be different people.");
  group.transactions.unshift({
    id: newId(),
    type: "settlement",
    scope: "group",
    desc: `${personName(payerId)} paid ${personName(receiverId)}`,
    payerId,
    receiverId,
    amountPaise,
    category: "Settlement",
    shares: {},
    date: formatDate(new Date()),
    timestamp: Date.now(),
    updatedAt: Date.now()
  });
  touchGroup(group);
  $("#settle-amount").value = "";
  $("#settle-up-box").hidden = true;
  $("#btn-toggle-settle-form").textContent = "+ Custom settlement";
  saveState();
  renderAll();
  burst();
  toast("Settlement recorded.");
}

async function settleDirect(friendId, balance) {
  const friend = appState.friends.find((item) => item.id === friendId);
  if (!friend) return;
  const owedToMe = balance > 0;
  const payerId = owedToMe ? friendId : me();
  const receiverId = owedToMe ? me() : friendId;
  const ok = await confirmDialog({
    title: "Record settlement",
    message: owedToMe
      ? `Record that ${friend.name} paid you ${formatMoney(balance, cur())}?`
      : `Record that you paid ${friend.name} ${formatMoney(-balance, cur())}?`,
    confirmLabel: "Record"
  });
  if (!ok) return;
  appState.directTransactions.unshift({
    id: newId(),
    type: "settlement",
    scope: "direct",
    friendId,
    desc: `${personName(payerId)} paid ${personName(receiverId)}`,
    payerId,
    receiverId,
    amountPaise: Math.abs(balance),
    category: "Settlement",
    shares: {},
    date: formatDate(new Date()),
    timestamp: Date.now(),
    updatedAt: Date.now()
  });
  saveState();
  renderAll();
  burst();
  navigateTo("balances");
}

function startDirectExpense(friendId) {
  selectedFriendId = friendId;
  navigateTo("add-expense");
  setScope("friend");
  const select = $("#direct-friend-select");
  if (select) select.value = friendId;
  renderDirectFriends();
  renderSplit();
}

function openDetail(id) {
  const located = findTx(id);
  if (!located) return;
  const tx = located.tx;
  const body = $("#modal-body");
  clear(body);
  const symbol = cur();
  if (tx.type === "settlement") {
    body.append(
      el("h3", { text: "Debt settlement" }),
      el("p", { class: "transaction-meta", text: tx.date || "" }),
      line("Paid by", personName(tx.payerId)),
      line("Received by", personName(tx.receiverId)),
      line("Amount", formatMoney(tx.amountPaise, symbol))
    );
  } else {
    body.append(
      el("h3", { text: tx.desc || "Expense" }),
      el("p", { class: "transaction-meta", text: `${tx.date || ""} · ${tx.category || "Other"}${tx.recurring ? ` · Repeats ${tx.recurring.freq}` : ""}` }),
      el("p", { style: "font-size:1.3rem;font-weight:800", text: formatMoney(tx.amountPaise, symbol) }),
      line("Paid by", personName(tx.payerId)),
      line("Split", (tx.splitMode || "equal").toUpperCase())
    );
    const src = safeImageSrc(tx.receiptDataUrl || tx.receiptUrl);
    if (src) {
      const img = el("img", { src, alt: "Bill receipt" });
      img.addEventListener("click", () => window.open(src, "_blank", "noopener"));
      body.append(el("h4", { text: "Receipt" }), el("div", { class: "receipt-preview-box" }, [img]));
    }
    const table = el("table", { class: "member-spend-table" });
    const head = el("tr", {}, [el("th", { text: "Participant" }), el("th", { text: "Share", style: "text-align:right" })]);
    table.append(el("thead", {}, [head]));
    const tbody = el("tbody");
    for (const [memberId, share] of Object.entries(tx.shares || {})) {
      if (!share) continue;
      tbody.append(el("tr", {}, [
        el("td", { text: `${personName(memberId)}${memberId === tx.payerId ? " (payer)" : ""}` }),
        el("td", { text: formatMoney(share, symbol), style: "text-align:right" })
      ]));
    }
    table.append(tbody);
    body.append(el("h4", { text: "Shares" }), table);
  }
  const controls = el("div", { class: "upi-actions", style: "margin-top:16px" });
  controls.append(el("button", { type: "button", class: "btn btn-danger", text: "Delete", on: { click: () => deleteTx(tx.id) } }));
  if (tx.type === "expense") controls.append(el("button", { type: "button", class: "btn btn-secondary", text: "Edit", on: { click: () => startEdit(tx.id) } }));
  controls.append(el("button", { type: "button", class: "btn", text: "Close", on: { click: () => closeModal("#detail-modal") } }));
  body.append(controls);
  openModal("#detail-modal");
}

function line(label, value) {
  return el("div", { class: "split-row" }, [el("span", { text: label }), el("strong", { text: value })]);
}

function openMember(id) {
  const group = getGroup();
  if (!group || !id) return;
  const body = $("#member-modal-body");
  clear(body);
  body.append(el("h3", { text: `${personName(id)}'s statement` }));
  const rows = group.transactions.filter((tx) => tx.payerId === id || tx.receiverId === id || (tx.shares && tx.shares[id] > 0));
  if (!rows.length) body.append(el("p", { class: "empty-state", text: "No records for this member yet." }));
  for (const tx of rows) {
    body.append(el("button", {
      type: "button",
      class: "transaction-item",
      on: { click: () => { closeModal("#member-modal"); openDetail(tx.id); } }
    }, [
      el("span", { class: "transaction-copy" }, [
        el("strong", { text: tx.desc || "Record" }),
        el("span", { class: "transaction-meta", text: tx.date || "" })
      ]),
      el("span", { class: "transaction-amount", text: formatMoney(tx.amountPaise, cur()) })
    ]));
  }
  openModal("#member-modal");
}

function openModal(sel) {
  const node = $(sel);
  if (!node) return;
  node.hidden = false;
  node.classList.add("active");
}

function closeModal(sel) {
  const node = $(sel);
  if (!node) return;
  node.classList.remove("active");
  node.hidden = true;
}

function exportCsv() {
  const group = getGroup();
  const rows = [...(group?.transactions || []), ...(appState.directTransactions || [])];
  if (!rows.length) return toast("Nothing to export yet.");
  const header = "Date,Type,Description,Amount,Currency,Payer,Other,Category,Scope\n";
  const body = rows.map((tx) => {
    const other = tx.type === "settlement" ? personName(tx.receiverId) : Object.keys(tx.shares || {}).map(personName).join("; ");
    return [tx.date, tx.type, tx.desc, paiseToInput(tx.amountPaise), cur(), personName(tx.payerId), other, tx.category || "", tx.scope || "group"]
      .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
      .join(",");
  }).join("\n");
  const blob = new Blob([header + body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url });
  link.download = `FairShare_${(group?.name || "ledger").replace(/\s+/g, "_")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyText(value, success) {
  try {
    await navigator.clipboard.writeText(value);
    toast(success);
  } catch {
    await promptDialog({ title: "Copy", message: "Copy this text.", defaultValue: value });
  }
}

function shareText() {
  const group = getGroup();
  const mine = personName(me());
  const link = group ? inviteUrl(group, newId()) : location.href;
  return { group, mine, link };
}

function mailtoInvite() {
  const email = $("#input-friend-email")?.value.trim() || "";
  const { group, mine, link } = shareText();
  const subject = encodeURIComponent(`Split expenses on FairShare with ${mine}`);
  const body = encodeURIComponent(`I'm using FairShare to split expenses${group ? ` for ${group.name}` : ""}.\n\n${link}`);
  window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`, "_blank", "noopener");
}

function whatsAppInvite() {
  const { link } = shareText();
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(`Join me on FairShare: ${link}`)}`, "_blank", "noopener");
}

function inviteUrl(group, inviteId) {
  const url = new URL(location.href);
  url.hash = "friends";
  url.search = "";
  url.searchParams.set("joinGroup", group.id);
  url.searchParams.set("groupName", group.name);
  url.searchParams.set("by", personName(me()));
  url.searchParams.set("invite", inviteId);
  if (currentUser?.email) url.searchParams.set("byEmail", currentUser.email);
  return url.toString();
}

async function shareGroupInvite() {
  const group = getGroup();
  if (!group) return toast("Create a group before sharing an invite.");
  const inviteId = newId();
  const url = inviteUrl(group, inviteId);
  if (currentUser) {
    try {
      const loaded = await ensureCloud();
      await publishInvite(loaded, {
        inviteId,
        groupId: group.id,
        groupName: group.name,
        createdBy: currentUser.email.toLowerCase(),
        by: personName(me())
      });
    } catch {
      toast("The link still works on this device. Publishing it to the cloud failed.");
    }
  }
  await copyText(url, "Invite link copied.");
}

function checkInvite() {
  const params = new URLSearchParams(location.search);
  const id = params.get("joinGroup");
  if (!id) return;
  pendingInvite = {
    id,
    name: params.get("groupName") || "Shared group",
    by: params.get("by") || "A friend",
    byEmail: params.get("byEmail") || "",
    inviteId: params.get("invite") || ""
  };
  $("#invite-modal-title").textContent = `Join "${pendingInvite.name}"`;
  $("#invite-modal-desc").textContent = `${pendingInvite.by}${pendingInvite.byEmail ? ` (${pendingInvite.byEmail})` : ""} invited you to join "${pendingInvite.name}".`;
  openModal("#group-invite-modal");
}

async function acceptInvite() {
  if (!pendingInvite) return;
  const data = pendingInvite;
  if (!appState.groups[data.id]) appState.groups[data.id] = emptyGroup(data.id, data.name, "₹", []);
  const group = appState.groups[data.id];
  if (!group.members.some((member) => member.id === me())) group.members.push({ id: me(), name: personName(me()) });
  if (data.byEmail) {
    const friend = addApproved(data.byEmail, data.by, false);
    if (friend) addFriendToGroup(group, friend);
  } else if (data.by) {
    let friend = appState.friends.find((item) => item.name.toLowerCase() === data.by.toLowerCase());
    if (!friend) {
      friend = createFriend(data.by);
      appState.friends.push(friend);
    }
    addFriendToGroup(group, friend);
  }
  appState.activeGroupId = group.id;
  touchGroup(group);
  saveState();
  closeModal("#group-invite-modal");
  history.replaceState({}, "", `${location.pathname}#friends`);
  pendingInvite = null;
  toast(`You joined ${group.name}.`);
  if (currentUser && data.inviteId) {
    try {
      const loaded = await ensureCloud();
      await claimInvite(loaded, { groupId: group.id, inviteId: data.inviteId, email: currentUser.email });
    } catch {
      toast("Joined on this device. Cloud membership updates when the group is shared with your account.");
    }
  }
  listenActiveGroup();
  renderAll();
}

function declineInvite() {
  pendingInvite = null;
  closeModal("#group-invite-modal");
  history.replaceState({}, "", `${location.pathname}#friends`);
}

async function openUpi({ payeeId, amountPaise, note }) {
  const friend = appState.friends.find((item) => item.id === payeeId);
  const stored = payeeId === me() ? (appState.profile.upiId || "") : (friend?.upiId || "");
  $("#upi-summary").textContent = `${formatMoney(amountPaise, "₹")} · ${note}`;
  $("#upi-id").value = stored;
  $("#upi-note").value = note;
  $("#upi-amount").value = String(amountPaise);
  $("#upi-payee").value = payeeId;
  drawUpi();
  openModal("#upi-modal");
  $("#upi-id").focus();
}

function drawUpi() {
  const pa = $("#upi-id").value.trim();
  const amountPaise = Number($("#upi-amount").value) || 0;
  const note = $("#upi-note").value.trim() || "FairShare";
  const img = $("#upi-qr");
  const link = $("#upi-link");
  if (!pa || !pa.includes("@")) {
    img.removeAttribute("src");
    img.alt = "Enter a UPI ID to show a QR code";
    link.hidden = true;
    return;
  }
  const href = `upi://pay?${new URLSearchParams({ pa, pn: personName($("#upi-payee").value) || "Friend", am: paiseToInput(amountPaise), cu: "INR", tn: note })}`;
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const qr = qrcode(0, "M");
  qr.addData(href);
  qr.make();
  img.src = qr.createDataURL(5, 2);
  img.alt = `UPI QR code for ${pa}`;
  link.href = href;
  link.hidden = false;
  const payeeId = $("#upi-payee").value;
  if (payeeId === me()) appState.profile.upiId = pa;
  else {
    const friend = appState.friends.find((item) => item.id === payeeId);
    if (friend) friend.upiId = pa;
  }
}

function burst() {
  const canvas = $("#confetti-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const colors = ["#0284c7", "#15803d", "#6366f1", "#d97706", "#db2777"];
  const particles = Array.from({ length: 70 }, () => ({
    x: canvas.width / 2,
    y: canvas.height / 2,
    w: Math.random() * 8 + 4,
    h: Math.random() * 6 + 3,
    vx: (Math.random() - 0.5) * 14,
    vy: (Math.random() - 0.8) * 16,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * 6,
    vr: (Math.random() - 0.5) * 0.2,
    life: 1
  }));
  const frame = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;
      p.rot += p.vr;
      p.life -= 0.012;
      if (p.life <= 0) continue;
      alive += 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive) requestAnimationFrame(frame);
  };
  frame();
}

function authError(error) {
  const code = error?.code || "";
  if (code === "auth/unauthorized-domain") {
    return alertDialog({
      title: "Authorize this domain",
      message: "In Firebase Console → Authentication → Settings → Authorized domains, add this site's domain (and localhost if you are testing). Then try Google sign-in again."
    });
  }
  if (code === "auth/popup-blocked") return toast("The sign-in popup was blocked. Allow popups for this site and try again.");
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
  toast(error?.message || "Google sign-in did not finish. You can keep using FairShare on this device.");
}

function bind() {
  document.body.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) navigateTo(nav.dataset.nav);
    const preset = event.target.closest("[data-preset-desc]");
    if (preset) applyPreset(preset.dataset.presetDesc, preset.dataset.presetCat);
  });
  $("#btn-theme-toggle").addEventListener("click", () => {
    appState.theme = appState.theme === "dark" ? "light" : "dark";
    applyTheme();
    saveState();
    renderAnalytics();
  });
  $("#btn-export-csv").addEventListener("click", exportCsv);
  $("#btn-google-auth").addEventListener("click", async () => {
    try {
      const loaded = await ensureCloud();
      if (currentUser) {
        const ok = await confirmDialog({ title: "Sign out", message: `Sign out of ${currentUser.email}? Local data stays on this device.`, confirmLabel: "Sign out" });
        if (!ok) return;
        setCloudIntent(false);
        await signOutGoogle(loaded);
      } else {
        setCloudIntent(true);
        await signInGoogle(loaded);
      }
    } catch (err) {
      authError(err);
    }
  });
  $("#btn-scope-group").addEventListener("click", () => setScope("group"));
  $("#btn-scope-friend").addEventListener("click", () => setScope("friend"));
  $("#direct-friend-select").addEventListener("change", (event) => {
    selectedFriendId = event.target.value;
    renderDirectFriends();
    renderSplit();
  });
  $("#btn-quick-friend").addEventListener("click", async () => {
    const name = await promptDialog({ title: "New friend", message: "Who are you splitting with?", placeholder: "Name" });
    if (!name || !name.trim()) return;
    const clean = name.trim();
    let friend = appState.friends.find((item) => item.name.toLowerCase() === clean.toLowerCase());
    if (!friend) {
      friend = createFriend(clean);
      appState.friends.push(friend);
      saveState();
    }
    selectedFriendId = friend.id;
    renderDirectFriends();
    renderFriends();
    renderSplit();
  });
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-mode]").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      splitMode = button.dataset.mode;
      renderSplit();
    });
  });
  $("#amount").addEventListener("input", updateSplitPreview);
  $("#desc").addEventListener("input", () => {
    const text = $("#desc").value.trim();
    if (!text) {
      categoryManual = false;
      updateCatBadge(null);
      return;
    }
    if (!categoryManual) {
      const detected = predictCategory(text);
      if (detected) {
        $("#category-select").value = detected;
        updateCatBadge("auto");
      }
    }
  });
  $("#category-select").addEventListener("change", () => {
    categoryManual = true;
    updateCatBadge("manual");
  });
  $("#expense-form").addEventListener("submit", saveExpense);
  $("#btn-cancel-edit").addEventListener("click", () => {
    resetForm();
    navigateTo("home");
  });
  $("#receipt-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) onReceipt(file).catch(() => toast("Could not read that image."));
  });
  $("#btn-clear-receipt").addEventListener("click", () => {
    pendingReceipt = null;
    $("#receipt-file").value = "";
    $("#receipt-upload-preview").hidden = true;
    $("#btn-clear-receipt").hidden = true;
    $("#detected-amounts-wrapper").hidden = true;
  });
  $("#btn-toggle-settle-form").addEventListener("click", () => {
    const box = $("#settle-up-box");
    const open = box.hidden;
    box.hidden = !open;
    box.classList.toggle("active", open);
    $("#btn-toggle-settle-form").textContent = open ? "Hide settle up" : "+ Custom settlement";
  });
  $("#btn-cancel-settle").addEventListener("click", () => {
    $("#settle-up-box").hidden = true;
    $("#btn-toggle-settle-form").textContent = "+ Custom settlement";
  });
  $("#settle-form").addEventListener("submit", saveSettlement);
  $("#toggle-simplify").addEventListener("change", () => {
    const group = getGroup();
    if (!group) return;
    group.simplifyDebts = $("#toggle-simplify").checked;
    touchGroup(group);
    saveState();
    renderBalances();
    renderHome();
  });
  $("#group-selector").addEventListener("change", (event) => {
    appState.activeGroupId = event.target.value;
    saveState();
    resetForm();
    listenActiveGroup();
    renderAll();
  });
  $("#btn-rename-group").addEventListener("click", async () => {
    const group = getGroup();
    if (!group) return;
    const name = await promptDialog({ title: "Rename group", message: "Group name", defaultValue: group.name });
    if (!name || !name.trim()) return;
    group.name = name.trim();
    touchGroup(group);
    saveState();
    renderAll();
  });
  $("#btn-delete-group").addEventListener("click", async () => {
    const group = getGroup();
    if (!group) return;
    const ok = await confirmDialog({
      title: "Delete group",
      message: `Delete ${group.name} and its expenses on this device?`,
      confirmLabel: "Delete group",
      danger: true
    });
    if (!ok) return;
    const id = group.id;
    delete appState.groups[id];
    appState.activeGroupId = Object.keys(appState.groups)[0] || "";
    saveState();
    if (fx && currentUser) deleteCloudGroup(fx, id).catch(() => {});
    listenActiveGroup();
    renderAll();
  });
  $("#btn-share-group-invite").addEventListener("click", shareGroupInvite);
  $("#btn-add-custom-member").addEventListener("click", () => {
    addMemberByName($("#input-new-member-name").value);
    $("#input-new-member-name").value = "";
  });
  $("#input-new-member-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#btn-add-custom-member").click();
    }
  });
  $("#btn-add-friend-to-group").addEventListener("click", () => {
    const id = $("#friend-picker-select").value;
    const friend = appState.friends.find((item) => item.id === id);
    if (!friend) return toast("Choose a friend, or type a name.");
    const group = getGroup();
    if (!group) return toast("Create a group first.");
    if (!addFriendToGroup(group, friend)) return toast(`${friend.name} is already in this group.`);
    touchGroup(group);
    saveState();
    renderAll();
  });
  $("#currency-select").addEventListener("change", () => {
    const group = getGroup();
    if (!group) return;
    group.currency = $("#currency-select").value;
    touchGroup(group);
    saveState();
    renderAll();
  });
  $("#btn-custom-currency").addEventListener("click", async () => {
    const group = getGroup();
    if (!group) return;
    const value = await promptDialog({ title: "Custom currency", message: "Symbol or code, such as AUD or AED.", defaultValue: group.currency || "₹" });
    if (!value || !value.trim()) return;
    group.currency = value.trim();
    touchGroup(group);
    saveState();
    renderAll();
  });
  $("#btn-new-group-modal").addEventListener("click", () => {
    $("#modal-group-name").value = "";
    const box = $("#modal-friends-checkboxes");
    clear(box);
    if (!appState.friends.length) box.append(el("span", { class: "transaction-meta", text: "No saved friends yet. You can add them later." }));
    for (const friend of appState.friends) {
      const input = el("input", { type: "checkbox", class: "modal-friend-check", value: friend.id });
      box.append(el("label", { style: "display:flex;gap:8px;align-items:center;padding:4px 0" }, [input, document.createTextNode(friend.name)]));
    }
    openModal("#new-group-modal");
    $("#modal-group-name").focus();
  });
  $("#new-group-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#modal-group-name").value.trim();
    if (!name) return;
    const id = newId();
    const members = [{ id: me(), name: personName(me()) }];
    document.querySelectorAll(".modal-friend-check:checked").forEach((input) => {
      const friend = appState.friends.find((item) => item.id === input.value);
      if (friend) members.push({ id: friend.id, name: friend.name });
    });
    appState.groups[id] = emptyGroup(id, name, $("#modal-group-currency").value || "₹", members);
    appState.activeGroupId = id;
    saveState();
    closeModal("#new-group-modal");
    listenActiveGroup();
    renderAll();
    navigateTo("home");
    toast(`${name} is ready.`);
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });
  $("#btn-accept-invite").addEventListener("click", acceptInvite);
  $("#btn-decline-invite").addEventListener("click", declineInvite);
  $("#btn-save-friend").addEventListener("click", () => {
    const name = $("#new-friend-name").value.trim();
    if (!name) return toast("Enter a friend name.");
    if (appState.friends.some((friend) => friend.name.toLowerCase() === name.toLowerCase())) return toast(`${name} is already on your roster.`);
    appState.friends.push(createFriend(name));
    $("#new-friend-name").value = "";
    saveState();
    renderAll();
  });
  $("#new-friend-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#btn-save-friend").click();
    }
  });
  $("#btn-send-friend-request").addEventListener("click", sendFriendRequest);
  $("#btn-check-requests").addEventListener("click", checkIncoming);
  $("#btn-copy-my-email").addEventListener("click", () => {
    if (!currentUser?.email) return toast("Sign in to copy your Google email.");
    copyText(currentUser.email, "Email copied. Share it so friends can send a request.");
  });
  $("#btn-gmail").addEventListener("click", mailtoInvite);
  $("#btn-whatsapp").addEventListener("click", whatsAppInvite);
  $("#profile-upi").addEventListener("change", () => {
    appState.profile.upiId = $("#profile-upi").value.trim();
    saveState();
  });
  $("#filter-all").addEventListener("click", () => setHistory("all"));
  $("#filter-expenses").addEventListener("click", () => setHistory("expenses"));
  $("#filter-settlements").addEventListener("click", () => setHistory("settlements"));
  document.querySelectorAll("[data-history-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      historyScope = button.dataset.historyScope;
      document.querySelectorAll("[data-history-scope]").forEach((item) => item.classList.toggle("active", item === button));
      renderHistory();
    });
  });
  $("#search-query").addEventListener("input", (event) => {
    searchQuery = event.target.value.trim();
    renderHistory();
  });
  $("#filter-member-select").addEventListener("change", (event) => {
    memberFilter = event.target.value;
    renderHistory();
  });
  $("#btn-clear-all").addEventListener("click", async () => {
    const group = getGroup();
    if (!group?.transactions.length) return toast("This group has no records to clear.");
    const ok = await confirmDialog({ title: "Clear history", message: `Remove every record in ${group.name}?`, confirmLabel: "Clear", danger: true });
    if (!ok) return;
    const previous = structuredClone(group.transactions);
    const deleted = [...(group.deletedTxIds || [])];
    group.deletedTxIds = [...new Set([...deleted, ...group.transactions.map((tx) => tx.id)])].slice(-500);
    group.transactions = [];
    touchGroup(group);
    saveState();
    renderAll();
    offerUndo("Group history cleared", () => {
      group.transactions = previous;
      group.deletedTxIds = deleted;
    });
  });
  $("#member-inspect-select").addEventListener("change", (event) => {
    if (event.target.value) openMember(event.target.value);
    event.target.value = "";
  });
  document.querySelectorAll("[data-analytics-view]").forEach((button) => {
    button.addEventListener("click", () => {
      analyticsView = button.dataset.analyticsView;
      document.querySelectorAll("[data-analytics-view]").forEach((item) => item.classList.toggle("active", item === button));
      renderAnalytics();
    });
  });
  $("#btn-chart-pie").addEventListener("click", () => {
    chartKind = "pie";
    $("#btn-chart-pie").classList.add("active");
    $("#btn-chart-bar").classList.remove("active");
    renderAnalytics();
  });
  $("#btn-chart-bar").addEventListener("click", () => {
    chartKind = "bar";
    $("#btn-chart-bar").classList.add("active");
    $("#btn-chart-pie").classList.remove("active");
    renderAnalytics();
  });
  $("#upi-id").addEventListener("input", () => {
    drawUpi();
  });
  $("#upi-save").addEventListener("click", () => {
    drawUpi();
    saveState();
    toast("UPI ID saved on this device.");
  });
  $("#upi-copy").addEventListener("click", async () => {
    drawUpi();
    const href = $("#upi-link").href;
    if (!$("#upi-link").hidden) await copyText(href, "UPI link copied.");
    else toast("Enter a UPI ID such as name@okbank.");
  });
  document.querySelectorAll(".modal-backdrop").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(`#${modal.id}`);
    });
  });
  window.addEventListener("hashchange", () => showPage(location.hash.replace("#", "") || "home"));
}

function setHistory(filter) {
  historyFilter = filter;
  for (const id of ["filter-all", "filter-expenses", "filter-settlements"]) {
    const button = document.getElementById(id);
    if (button) button.classList.toggle("active", button.id === `filter-${filter === "all" ? "all" : filter}`);
  }
  renderHistory();
}

function bootCloud() {
  if (!cloudIntent()) return;
  ensureCloud().catch(() => toast("Google is unreachable. FairShare still works on this device."));
}

bind();
setScope("group");
renderAll();
const initial = location.hash.replace("#", "") || "home";
showPage(initial);
if (!location.hash) history.replaceState({}, "", "#home");
checkInvite();
if (boot.recurred) toast("A repeating expense was added.");
if (boot.slimmed) toast("Storage is nearly full, so some receipt photos were left out of the saved copy.");
bootCloud();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

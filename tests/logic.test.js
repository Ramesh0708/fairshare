import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allocateEqual,
  allocateWeighted,
  formatMoney,
  pairwiseDebts,
  rupeesToPaise,
  simplifyDebts
} from "../js/money.js";
import { migrateState } from "../js/migrate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rupees convert to integer paise with half-up rounding", () => {
  assert.equal(rupeesToPaise(200), 20000);
  assert.equal(rupeesToPaise("10.005"), 1001);
  assert.equal(rupeesToPaise("10.004"), 1000);
  assert.equal(rupeesToPaise("1,200.50"), 120050);
  assert.equal(formatMoney(20000, "₹"), "₹200.00");
});

test("equal and weighted splits use integer remainder", () => {
  assert.deepEqual(allocateEqual(100, ["a", "b", "c"]), { a: 34, b: 33, c: 33 });
  assert.deepEqual(allocateWeighted(100, [
    { id: "a", weight: 3 },
    { id: "b", weight: 1 }
  ]), { a: 75, b: 25 });
});

test("simplify collapses a chain while pairwise keeps both debts", () => {
  const txs = [
    { type: "expense", payerId: "B", amountPaise: 1000, shares: { A: 1000 } },
    { type: "expense", payerId: "C", amountPaise: 1000, shares: { B: 1000 } }
  ];
  const pair = pairwiseDebts(txs);
  assert.equal(pair.length, 2);
  assert.deepEqual(
    pair.map((debt) => [debt.from, debt.to, debt.amountPaise]).sort(),
    [["A", "B", 1000], ["B", "C", 1000]].sort()
  );
  assert.deepEqual(simplifyDebts({ A: -1000, B: 0, C: 1000 }), [
    { from: "A", to: "C", amountPaise: 1000 }
  ]);
});

test("legacy v6-shaped state migrates once to paise and stable ids", () => {
  const legacy = {
    theme: "light",
    activeGroupId: "g1",
    friends: [{ id: "friend_aryan", name: "Aryan" }],
    groups: {
      g1: {
        name: "Trip",
        currency: "₹",
        members: ["You", "Aryan"],
        transactions: [
          {
            id: "1",
            type: "expense",
            desc: "Dinner <script>alert(1)</script>",
            amount: 200,
            payer: "You",
            shares: { You: 100, Aryan: 100 },
            category: "Food"
          },
          { id: "2", type: "settlement", amount: 50, payer: "Aryan", receiver: "You" }
        ]
      }
    },
    directTransactions: [
      {
        id: "d1",
        type: "expense",
        friend: "Rahul",
        amount: 40,
        payer: "You",
        shares: { You: 20, Rahul: 20 },
        receipt: "data:image/png;base64,abc"
      }
    ]
  };
  const once = migrateState(legacy);
  const expense = once.groups.g1.transactions.find((tx) => tx.id === "1");
  const settlement = once.groups.g1.transactions.find((tx) => tx.id === "2");
  assert.equal(once.schemaVersion, 9);
  assert.equal(expense.desc, "Dinner <script>alert(1)</script>");
  assert.equal(expense.amountPaise, 20000);
  assert.equal(expense.payerId, "self");
  assert.equal(expense.shares.self, 10000);
  assert.equal(expense.shares.friend_aryan, 10000);
  assert.equal(settlement.payerId, "friend_aryan");
  assert.equal(settlement.receiverId, "self");
  assert.equal(settlement.amountPaise, 5000);
  assert.equal(once.groups.g1.members.some((member) => member.id === "self"), true);
  const direct = once.directTransactions[0];
  assert.equal(direct.receiptDataUrl, "data:image/png;base64,abc");
  assert.equal(direct.amountPaise, 4000);
  const rahul = once.friends.find((friend) => friend.name === "Rahul");
  assert.equal(direct.friendId, rahul.id);
  assert.equal(direct.shares[rahul.id], 2000);

  const twice = migrateState(once);
  assert.equal(twice.groups.g1.transactions.find((tx) => tx.id === "1").amountPaise, 20000);
  assert.equal(twice.directTransactions[0].amountPaise, 4000);
});

test("a signed-in self id survives a second migration", () => {
  const state = migrateState({
    schemaVersion: 9,
    selfId: "firebase-uid-1",
    profile: { displayName: "Ramesh", upiId: "" },
    activeGroupId: "g",
    friends: [],
    directTransactions: [],
    groups: {
      g: {
        id: "g",
        name: "Trip",
        currency: "₹",
        members: [{ id: "firebase-uid-1", name: "Ramesh" }],
        transactions: [{ id: "t", type: "expense", amountPaise: 100, payerId: "firebase-uid-1", shares: { "firebase-uid-1": 100 } }]
      }
    }
  });
  assert.equal(state.selfId, "firebase-uid-1");
  assert.equal(state.groups.g.transactions[0].amountPaise, 100);
});

test("recurring expenses materialize one overdue copy, then stop", async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  const stateMod = await import("../js/state.js");
  const { materializeRecurring, loadState } = stateMod;
  const now = Date.UTC(2026, 9, 20);
  const state = {
    groups: {
      g: {
        transactions: [{
          id: "template",
          type: "expense",
          amountPaise: 1000,
          payerId: "self",
          shares: { self: 1000 },
          timestamp: now - 10 * 86400000,
          recurring: { freq: "weekly", nextDue: now - 3 * 86400000 }
        }]
      }
    },
    directTransactions: []
  };
  assert.equal(materializeRecurring(state, now), true);
  assert.equal(state.groups.g.transactions.length, 2);
  const template = state.groups.g.transactions.find((tx) => tx.id === "template");
  const copy = state.groups.g.transactions.find((tx) => tx.id !== "template");
  assert.equal(copy.recurring, null);
  assert.equal(copy.amountPaise, 1000);
  assert.ok(template.recurring.nextDue > now);
  assert.equal(materializeRecurring(state, now), false);
  assert.equal(state.groups.g.transactions.length, 2);

  const current = {
    schemaVersion: 9,
    selfId: "self",
    theme: "light",
    profile: { displayName: "You", upiId: "" },
    activeGroupId: "group_default",
    friends: [],
    directTransactions: [],
    groups: {
      group_default: {
        id: "group_default",
        name: "Kept",
        currency: "₹",
        members: [{ id: "self", name: "You" }],
        transactions: []
      }
    }
  };
  store.set("fairshare_state_v9", JSON.stringify(current));
  store.set("fairshare_state_v6", JSON.stringify({ groups: { old: { name: "Old", members: ["You"], transactions: [{ amount: 9, payer: "You", shares: { You: 9 } }] } } }));
  store.set("fairshare_state_v7", "{}");
  store.set("fairshare_state_v8", "{}");
  loadState();
  assert.equal(stateMod.appState.groups.group_default.name, "Kept");
  assert.equal(store.has("fairshare_state_v6"), false);
  assert.equal(store.has("fairshare_state_v7"), false);
  assert.equal(store.has("fairshare_state_v8"), false);
  assert.equal(store.has("fairshare_state_v9"), true);
});

test("app sources do not inject HTML or call blocking dialogs", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "vendor" || name === "node_modules" || name === "icons") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(name) && !full.includes(`${path.sep}tests${path.sep}`)) files.push(full);
    }
  };
  walk(root);
  const banned = [
    [/innerHTML/, "innerHTML"],
    [/onclick\s*=/, "onclick="],
    [/\balert\s*\(/, "alert("],
    [/\bprompt\s*\(/, "prompt("],
    [/\bconfirm\s*\(/, "confirm("]
  ];
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [pattern, label] of banned) {
      if (pattern.test(text)) hits.push(`${path.relative(root, file)}: ${label}`);
    }
  }
  assert.deepEqual(hits, []);
  assert.ok(files.some((file) => file.endsWith("app.js")));
});

# FairShare

Shared expenses made simple and fair. FairShare is a single-page expense splitter that runs in the browser. You can use it with no account. Sign in with Google only when you want live group sync, friend requests, or an invite link that other people can open.

## Run it

Serve the folder over HTTP. A service worker and the Google scripts expect a real origin, so opening `index.html` as a file is unreliable.

```bash
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/`.

The app is a progressive web app. `manifest.json` supplies the name and icon. `sw.js` caches `index.html`, `fairshare.css`, the logo, and the manifest (`fairshare-v8`) so a later visit can load without a network. Firebase, Google fonts, and the receipt reader still need a connection the first time they are used.

## Files

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, navigation, ledger math, storage, and Firebase |
| `fairshare.css` | Layout, theme, and motion |
| `sw.js` | Offline cache |
| `manifest.json` | Installable app metadata |
| `fairshare_logo.jpg` | Icon |
| `friends_logic.js` | An unused earlier module. The live friend and group code is in `index.html` |

## Screens

The desktop sidebar and the phone tab bar both call `navigateTo(pageId)`, which shows one `.app-page`, updates the hash, and scrolls to the top.

- **Home.** Net standing for the member named `You`, shortcuts to add an expense, settle, or copy an invite link, and live previews of debts, the ledger, category mix, and people.
- **Add expense.** Amount, presets, group or 1-on-1 scope, payer, date, notes, optional receipt, and the split.
- **Balances.** Total spend, expense count, settlement count, simplify toggle, who pays whom, the member sheet, and separate 1-on-1 balances.
- **History.** Group and 1-on-1 rows, grouped by date, with search, type filters, and a member filter. Open a row to edit or delete it.
- **Analytics.** Category donut and bars together on a wide screen. One chart at a time on a phone.
- **Friends.** Group name, currency, members, and invites on the left. Google account, incoming requests, email or WhatsApp invites, and the friend roster on the right.

On a phone the six destinations sit in the bottom bar. On a desktop a scroll pill at the bottom shows the current page and can jump to any of them.

## Adding an expense

1. Choose **Group expense** or **1-on-1 with a friend**.
2. Enter an amount and a description. Presets fill the description, pick a category, and focus the amount.
3. The description is matched against a keyword list (dinner, uber, grocery, movie, wifi, and similar words). A match sets the category and shows **Auto**. Changing the category yourself shows **Manual** and stops further guessing.
4. Pick who paid, the date, and optional notes.
5. Choose a split and save.

A receipt photo is optional. Drop or browse an image. The file stays in the expense as a data URL, and [Tesseract.js](https://github.com/naptha/tesseract.js) tries to read a total from the image into the amount field. You can clear the photo before saving.

### Split methods

Shares are computed in `computeSplitShares` and must add up to the amount.

| Method | Rule |
| --- | --- |
| Equally | The amount is divided across the people whose boxes are checked |
| Exact amounts | The typed amounts must match the total within 5 paise |
| Percentages | The percents must add up to 100 within half a percent |
| Shares / ratio | Each person gets `amount × their weight / sum of weights` |

Group expenses are stored on the active group. 1-on-1 expenses are stored in `directTransactions` and do not change the group balance sheet. They do appear in History, Analytics, the home feed, CSV export, and the Direct 1-on-1 list.

## How balances work

For each group member, start at zero and walk the group's transactions:

- **Expense.** Add the full amount to the payer (they covered it). Subtract each person's share. A positive result means the group owes that person. A negative result means they owe the group.
- **Settlement.** Add the amount to the person who paid, and subtract it from the person who received it. Settlements are not counted in total spend.

**Simplify debts** is on by default. On, FairShare collapses the net balances into the fewest payments (if A owes B and B owes C, A can pay C). Off, it lists each pair from the raw expenses and settlements without routing money through a third person. Either way, a **Settle** button records a settlement for that suggested amount. **Custom settlement** records any payment you type.

The home line "You are all settled up" looks only at the member named `You` in the active group. 1-on-1 debts are shown on their own card.

Changing the currency symbol does not convert existing numbers. A dinner of 900 stays 900 if you switch from ₹ to $.

## History, charts, and export

History searches description, payer, category, and notes, and highlights the match. **Clear all** wipes the active group's transactions and the 1-on-1 list after a confirmation. It does not delete groups or friends.

Analytics sums expense amounts by category for the active group and for 1-on-1 bills. **Load sample demo data** replaces the active group's expenses with five sample bills so the charts can be tried on an empty group.

**Export CSV** downloads the active group's transactions plus 1-on-1 bills. Columns: ID, date, scope, type, description, notes, amount, currency, payer, receiver or split participants, and category.

## Groups, friends, and invites

Everything starts in a local group called **My Group**, with the member `You`. The active group is the one selected in the sidebar. Its id is unique. The old shared id `group_default` is renamed the first time a signed-in user syncs, so two people do not accidentally write the same cloud document.

- **New group** asks for a name, a currency, and which saved friends to include. `You` is always a member.
- **Rename** and **Delete** act on the active group. The trash control asks you to confirm. The last remaining group cannot be deleted.
- Members can be added by name with no account. Removing a member drops them from future splits. It does not rewrite old expenses.
- The friend roster is local. **In-app request** needs both people to be signed in. It writes a `friend_requests` document addressed to the other person's Google email. They approve or decline on Friends. **Open in Gmail** and **Share via WhatsApp** only open those apps with a prefilled message.
- **Invite link** copies a URL shaped like `?joinGroup=<group id>&groupName=<name>&by=<your name>#friends`. Opening it shows a join dialog. Approving adds that group locally and adds you as a member. Sign in afterward if you want the expenses to sync.

Direct 1-on-1 balances are the net of bills and settlements with one saved friend, outside any group.

## What is saved

`localStorage` key `fairshare_state_v9`. Older keys `v6` through `v8` are read once if `v9` is missing.

```text
theme                  light or dark
activeGroupId
friends[]              { id, name, email?, approved?, type? }
directTransactions[]   1-on-1 expenses and settlements
groups[id]
  name, currency, members[], simplifyDebts
  transactions[]
```

An expense looks like this:

```text
id, type: "expense", scope, friend, desc, amount, payer,
category, shares, splitMode, date, dateISO, notes,
timestamp, receipt
```

A settlement uses `type: "settlement"` plus `payer`, `receiver`, and `amount`.

The person using the app on this browser is the member named `You`. Signing in does not rename that member inside groups you already have.

## Google sign-in

Sign-in is optional. The Firebase web config lives in `index.html` for the `fairshare-app-ba160` project. When you are signed in:

- The active group's name, currency, members, and transactions are written to Firestore at `groups/{groupId}`.
- A listener applies remote changes back into this browser. That listener does not immediately write them again, which avoids an update loop.
- Friend requests are queried by your Google email.

If Firebase cannot load, or the popup is blocked, the app stays fully usable offline. The domain you host on must be listed under Firebase Authentication authorized domains, or Google will refuse the popup.

## Interface notes

Light and dark themes are stored in the same state object. The first visit with no saved state follows the operating system.

Some motion is adapted from [Rare UI](https://www.rareui.com/components): the phone tab bar, the rolling balance figures, the scroll jumper, the confirm-to-delete control, and the request bell. The footer links back there, which their license requires.

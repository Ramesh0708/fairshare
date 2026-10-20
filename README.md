# FairShare

FairShare is a Splitwise-style expense splitter. It is a static site: one HTML page, a stylesheet, and ES modules. Balances, friends, and receipts stay in `localStorage`, so the app works with no account. Google sign-in is optional and syncs groups through Firestore.

Money is stored as integer paise (100 paise = 1.00) so splits do not drift on floating-point rounding.

## Run it locally

Serve the folder over HTTP. Opening `index.html` as a file will not register the service worker or load ES modules reliably.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Deploy on GitHub Pages

1. Push this repository to GitHub.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch that contains this site and the folder **`/ (root)`**.
5. Save. GitHub serves `index.html` from the site root. A `.nojekyll` file is included so folders such as `js/` are not processed by Jekyll.

The site uses relative URLs and hash routes (`#home`, `#balances`, …), so it works from a project site such as `https://<user>.github.io/fairshare/` and from a user site.

If the public URL is not `https://ramesh0708.github.io/fairshare/`, update the canonical, Open Graph, and Twitter URLs in `index.html`.

## Firebase (optional)

The app does not load Firebase until you click **G Sign In**. Offline use does not need a project.

1. Create a Firebase project.
2. Enable **Authentication → Google**.
3. Create a **Cloud Firestore** database and **Storage**.
4. Register a web app and copy its config into `js/firebase-config.js`.
5. Deploy the rules in this repo:

```bash
npx firebase-tools deploy --only firestore:rules,storage --project <your-project-id>
```

`firebase.json` points at `firestore.rules` and `storage.rules`.

### What the rules allow

- A group document can be read, updated, or deleted only when the signed-in email is in `memberEmails`. Listing every group is denied.
- An invite can add only the caller’s own email, and only when an invite document for that group exists.
- A friend request can be created by the sender and read by the sender or the recipient.
- Receipt files under `receipts/{groupId}/` can be read or written only by group members, must be images, and must be under 1 MB.

Friend-request addresses are compared to the Google account email exactly. Use the mailbox you sign in with.

### Restrict the API key

The web API key in `js/firebase-config.js` is visible to anyone who can load the site. In **Google Cloud Console → APIs & Services → Credentials**, open that key and set an **HTTP referrer** restriction. Allow only the origins that serve FairShare, for example:

- `http://localhost:8080/*`
- `http://127.0.0.1:8080/*`
- `https://<user>.github.io/*`
- your custom domain, if you add one

### Authorized domains

Google sign-in fails until the host is allowed. In **Firebase Console → Authentication → Settings → Authorized domains**, add:

- `localhost`
- `<user>.github.io`
- any custom domain you use

## Receipts

Photos are resized in the browser before they are kept. While you are signed in, a group receipt is uploaded to Firebase Storage and the group document stores the URL. The base64 copy stays on this device so the bill still opens offline. Direct 1-on-1 expenses are not synced, and their photos stay local.

## Privacy

Without sign-in, expenses, names, and receipt photos stay in this browser. With sign-in, group ledgers (without the local photo bytes) sync to the Firebase project in `js/firebase-config.js`, and receipt images for those groups go to Storage. Friend requests store the sender and recipient email addresses. You can keep using the app after you sign out; the on-device copy remains.

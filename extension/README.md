# Extension: The Wallet in the Side Panel

> **Chrome Manifest V3, version 0.4.2. Chrome, Brave and Edge.**

The Opaque wallet in the browser's side panel. It is not a second codebase: the panel shows `frontend/app.html`, the same page served at opaque.credit, from the same Vite build. The side panel stays open while a deposit or payment runs, where a popup would close on the first click outside it.

It needs no other wallet. You fund your Opaque account by sending USDC to its address from anywhere (a wallet, an exchange, the faucet), and the first deposit deploys the account and deposits in one operation its post-quantum key signs. After that, deposits, payments and withdrawals need no popup at all.

## Install from the Zip

The Chrome Web Store listing is in review. Until it is live, install in Developer mode:

1. Download [opaque-extension.zip](https://www.opaque.credit/opaque-extension.zip).
2. Unzip it: double-click on a Mac, or right-click and choose **Extract All** on Windows. Keep the folder; the browser runs the extension from it.
3. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
4. Turn on **Developer mode**, top right.
5. Click **Load unpacked** and choose the unzipped folder, the one with `manifest.json` inside. The zip itself shows greyed out: the browser loads folders, not zips.
6. Pin Opaque from the puzzle-piece menu and click it. The wallet opens in the side panel.

**To update,** unzip the new download into the same folder and click the reload arrow on Opaque's card. The browser ties an unpacked extension's id, and so its wallet, to the folder. Loaded from a different folder, it opens as a new extension with an empty wallet. Move an account between installs with **Backup** and **Restore**.

## Build

```bash
cd frontend && npm install && npm run ext
```

That builds the page against the hosted backend (`VITE_STACK_URL`, by default the Railway stack) and writes:

| Output | What |
|---|---|
| `extension/dist/` | The folder to load unpacked |
| `extension/opaque-extension-<version>.zip` | The Chrome Web Store upload |
| `frontend/public/opaque-extension.zip` | The same zip under a stable name, for the landing page download |

`dist/` and the versioned zip are generated and git-ignored.

## Folder Structure

```
extension/
├── manifest.json       # Manifest V3; the sidePanel permission only
├── background.js       # Opens the side panel on the toolbar click, or a tab where there is none
├── build.mjs           # Assembles dist/ from frontend/dist, with the checks below
├── make-icons.mjs      # Draws the icons
├── icons/              # 16, 32, 48 and 128 px
└── store/              # Chrome Web Store listing text, screenshots and promo tile
```

## What the Build Checks

- **The Manifest V3 CSP.** Inline `<script>` and inline handlers such as `onclick=` are banned, and the symptom of breaking the rule is a silently blank panel. `build.mjs` scans the built HTML and refuses to assemble `dist/` if it finds either.
- **Only what the page loads.** It copies `app.html`, then follows names from the HTML into the JS and CSS: the proof worker, viem's lazy chunks, the fonts. The landing page's photography stays out, and the extension is about 290 KB zipped.
- **A backend.** A build without `VITE_STACK_URL` would look for `stack.json` inside the extension and never start, so the build refuses it.
- **No remote fonts.** A wallet that fetched fonts from a CDN on every open would tell that CDN each time someone reached for a private payment. The build strips the import and then fails if any reference survives.
- **Two rewrites.** It removes Vite's `crossorigin`, which turns same-origin loads into CORS requests on a `chrome-extension://` origin, and points the wordmark's link at opaque.credit.

## Permissions

`sidePanel` only. No host permissions and no content scripts: the wallet injects no provider into pages and reads no site.

## Publish on the Chrome Web Store

Brave and Edge install from the Chrome Web Store too. Everything the listing asks for is in [`store/`](store/): [`listing.md`](store/listing.md) has the text for every field (description, single purpose, the `sidePanel` justification, data-use answers, reviewer test steps), next to the 1280×800 screenshots and the 440×280 promo tile. The privacy policy is [opaque.credit/privacy.html](https://www.opaque.credit/privacy.html).

Bump `version` in `manifest.json` for every upload, then `npm run ext`. Wallet extensions get a manual review, usually several days. A store install has a different extension id from an unpacked one, so it starts with empty storage: use **Backup** and **Restore**.

## Not Done

**Key rotation** is still paid for by a funding wallet, which the extension does not have. Each deposit or withdrawal uses one of the account key's 32 signatures, and the panel shows how many are left. Until rotation goes through the account itself, rotate by restoring a backup on opaque.credit, rotating there with MetaMask, and restoring back.

## Icons

`icons/*.png` are drawn by `make-icons.mjs`: the ring of eight in the wallet's orange, rendered into a pixel buffer and encoded with Node's built-in zlib.

```bash
node extension/make-icons.mjs
```

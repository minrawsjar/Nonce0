# Chrome Web Store listing, field by field

Upload `extension/opaque-extension-<version>.zip` (`cd frontend && npm run ext`),
then fill in each tab of the item in the developer dashboard with the text below.

## Store listing

**Description**

> Opaque is a wallet for private USDC payments on the Arc testnet, in your
> browser's side panel. It handles testnet funds only, which have no value.
>
> Deposit USDC and it becomes notes of 1, 2, 5, 10, 20, 50 or 100 USDC. Each
> note sits in a pool with others of its size. When you pay, the wallet proves
> on your device that you own one note out of a ring of eight, without saying
> which one. The payment is sealed, then sent through three relays, so no single
> party links your device to what you paid. Anyone can see deposits and
> settlements on chain, but not which deposit paid which recipient.
>
> Your account is secured by a post-quantum, hash-based (FORS+C) key that never
> leaves your browser. Deposits and withdrawals are signed by that key, and no
> other wallet is needed: fund your Opaque address from any wallet or exchange.
>
> - Private sends of any whole amount, using the fewest notes
> - Post-quantum account key, with a visible signature budget and key rotation
> - Payments and account reads routed through a three-hop relay mesh
> - Encrypted backup and restore
> - No accounts, no analytics, no trackers
>
> This is a testnet build, and some parts are stand-ins that are labelled as
> such: the service that opens sealed payments runs as an ordinary server
> process rather than in a secure enclave, and all six relays are run by one
> operator. Do not use it for real funds.
>
> Open source: https://github.com/minrawsjar/Opaque

**Category:** Privacy & Security (or Tools, if that is not offered)

**Language:** English

**Store icon:** `extension/icons/128.png`

**Screenshots** (1280×800): `extension/store/1-home.png`, `2-send.png`,
`3-privacy.png`, `4-activity.png`

**Small promo tile** (440×280): `extension/store/promo-440x280.png`

**Marquee promo tile** (1400×560): `extension/store/marquee-1400x560.png`

**Global promo video:** leave empty.

**Official URL:** leave as None (it needs a site verified in Search Console).

**Mature content:** No.

**Homepage URL:** https://www.opaque.credit

**Support URL:** https://github.com/minrawsjar/Opaque/issues

## Privacy practices

**Single purpose**

> A wallet for private USDC payments on the Arc testnet, opened in the
> browser's side panel.

**Permission justification: sidePanel**

> Opens the wallet in the browser's side panel when the toolbar icon is
> clicked. It is the extension's only permission. It has no host permissions
> and no content scripts, and it does not read or change any website.

**Remote code:** No, I am not using remote code.

> All JavaScript ships in the package. The extension fetches configuration
> (the relay list and public keys) and data as JSON, never code.

**Data usage.** Tick:

- **Financial and payment information.** Payments, balances and recipient
  addresses. Payments are sealed to the service; the recipient is sent to its
  credential authority.
- **Personally identifiable information.** The conservative reading: the
  service and its host see IP addresses, and account addresses are
  identifiers.

Leave the rest unticked. Keys, note secrets and the backup passphrase never
leave the device.

Then certify all three:

- I do not sell or transfer user data to third parties, outside of the
  approved use cases
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes

**Privacy policy URL:** https://www.opaque.credit/privacy.html

## Test instructions (for the reviewer)

> No login or account is needed. Click the toolbar icon: the wallet opens in
> the side panel and creates a local account.
>
> To see a payment end to end (Arc testnet, no real funds):
> 1. Get testnet USDC at https://faucet.circle.com (network: Arc testnet).
> 2. In the wallet, press Receive, and send about 2 USDC to the address shown.
> 3. Set Deposit amount to 1 and press Deposit. The first deposit also sets up
>    the account on chain. About a minute.
> 4. Open Send, enter any Arc address and 1 USDC, and press Review private
>    transfer. It settles in under a minute. Activity links the settlement on
>    testnet.arcscan.app.

## Distribution

Public, or Unlisted to share it by link only while it is a testnet demo.
Brave and Edge users install from the Chrome Web Store too.

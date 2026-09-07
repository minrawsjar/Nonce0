# nonce0

**Find out which of your keys a quantum computer would break, before it exists.**

---

## The problem, in plain terms

Every crypto account is built on a pair of numbers. A private key you keep secret, and a public key derived from it. Today, working backwards from the public key to the private one is impossible. A large quantum computer would make it easy.

The part most people miss: your address is not your public key. It is a hash of it. A hash is a one-way fingerprint, and a quantum computer cannot attack a fingerprint. It needs the real key.

So when does the real key become visible? **The first time your account sends a transaction.** The signature on that transaction mathematically reveals the public key to anyone who looks. Before that first send, your key is genuinely hidden. After it, it is public forever.

That is the whole idea behind the name. In Ethereum, the *nonce* is a counter of how many transactions an account has sent. Nonce 0 means it has never sent one, so nothing has leaked. Anything above zero means the key is out there.

## The part nobody is checking

Here is what makes this urgent rather than theoretical.

The same key controls the same address on **every** chain. Ethereum, Base, Arbitrum, Polygon, and every testnet.

So your protocol's admin key can show nonce 0 on Ethereum, look completely safe, and be fully exposed because a developer used that same key once on Sepolia during testing two years ago. One throwaway testnet transaction publishes the key permanently, on every chain at once.

Nobody audits for this. It is invisible if you only look at the chain you deployed on.

## What nonce0 does

It answers three questions about any protocol.

**Which of your keys are exposed?** It walks your ownership structure, finds every account that ultimately controls your contracts, and checks all of them across every chain. Not just the one you deployed on.

**What could someone take with them?** A protocol usually has a handful of admin keys that can upgrade the code or move the treasury. Break those and you take everything, no clever exploit needed. nonce0 traces those paths and shows you the chain: this Safe, owned by these three people, controls this upgrade function, which controls this much money.

**What can you actually fix?** This is the part that matters most, and it is covered in its own section below.

## Three ways to use it

### The command line

```
npx nonce0 scan .              # your source code, before you deploy
npx nonce0 scan 0xProtocol     # a live protocol, after you deployed
```

No installation, no account, no configuration. Point it at a folder and it reads your code. Point it at an address and it reads the chain.

Add it to your CI and it fails the build when someone introduces a new critical finding. Results appear in your GitHub Security tab alongside your other scanners, so nobody has to remember to visit a dashboard.

### From an AI assistant

nonce0 ships an MCP server, which means Claude, Cursor, and ChatGPT can use it directly. You ask a question in normal language and the assistant runs the scan and explains the result.

> *"Is Aave's admin structure exposed to quantum attack?"*
>
> *"Compare the key hygiene of these four protocols I'm considering depositing into."*
>
> *"My deploy script has a hardcoded owner address. Has that key ever signed anything, anywhere?"*

This matters because the people who most need the answer are not always the people who want to read a security report. An assistant that can check for them removes the whole barrier.

### The dashboard

For seeing rather than reading. Your ownership structure drawn as a graph, exposed keys in red, safe ones in green, with the transaction that first leaked each key linked so you can see exactly when it happened.

There is also a guided setup for adding protection, and a console showing the status once it is in place.

## The honest part: what is fixable and what is not

Most security tools hand you a wall of red and let you sort it out. nonce0 ranks by **what you can still do something about**, which sometimes means a lower-severity finding sits at the top.

**Fixable.** Anything where a key authorises an action. You add a second lock: a signature built from hashing, which quantum computers do not break. Your existing signature still applies. The new one applies *in addition*. Three transactions, no changes to your existing contracts, no migration.

Because it only ever adds a requirement, this second lock can never approve something on its own. The worst case if it malfunctions is that your admin actions get stuck and you use the recovery timer. It cannot lose your money.

**Not fixable, only containable.** Some verification contracts cannot be changed after deployment. If quantum breaks the math they rely on, there is no patch. What you can do is cap how fast value leaves and add a delay on large withdrawals, turning an instant drain into something you have hours to notice.

**Not fixable at all.** Anything encrypted and published on chain in the past is already lost. An attacker copies it today and decrypts it years from now. No tool changes that, and anyone claiming otherwise is selling something.

Sorting by this is the point. It tells a team the true order of work: the permanent problems need a plan starting now, the fixable ones are an afternoon.

## What you get out of it

A ranked list of findings, each with a file and line or a contract address, and a specific next step.

A **cryptographic bill of materials**: a machine-readable inventory of every cryptographic algorithm your project uses and where. You commit it, diff it between releases, and watch your own migration progress. It is the same format security and compliance teams already ingest, which matters because government agencies are now required to inventory exactly this.

And, if you want it, the second lock installed.

## Who this is for

**Protocol teams** who have never audited their admin keys for this and do not know where to start.

**Auditors** who want a fast inventory before a manual review.

**Depositors** who want to know what governs the pool they are about to put money into. In Uniswap v4, for example, pools are governed by hooks that LPs did not write, owned by keys they have never inspected.

**Anyone holding a multisig**, because a Safe with three exposed owner keys is the single most valuable target a quantum adversary would have.

## Timing

Nobody knows when a quantum computer capable of this arrives. Estimates run from the 2030s onward, and Ethereum's own roadmap targets its core post-quantum work around 2029.

That does not make this early. Two reasons.

Encrypted data is being harvested today to be decrypted later, so anything private you publish now is on a clock that has already started.

And migrations take years. A protocol that has not begun inventorying its exposure will not finish in time once the deadline is visible. The first step is knowing what you have, which is the step nonce0 makes take about thirty seconds.

---

*nonce0 is the scanner. PQGuard is the contract suite it installs. The scanner finds the keys, the guard protects them.*

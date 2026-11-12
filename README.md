# Merge Bounty

GEN bounties on GitHub issues, paid out when the fixing pull request is merged. The escrow is a GenLayer Intelligent Contract written in Rust; when a contributor claims, every validator reads the pull request from the GitHub API itself, and the payout happens only if they agree on the facts.

- **App:** https://brossxnft.github.io/genlayer-merge-bounty/
- **Contract (Bradbury testnet):** `0x8036b2ffeedb94837546c66e1af6bc3909c1c0a6` ([explorer](https://scan.bradbury.genlayer.com/address/0x8036b2ffeedb94837546c66e1af6bc3909c1c0a6))
- **Language:** Rust, `genlayer_sdk` (genvm-executor `v0.3-dev` @ `6ec6c39`), deployed with [genlayer-chunked-deploy](https://github.com/brossXnft/genlayer-chunked-deploy)

## The problem

Open-source bounties run on trust in a middleman. A platform holds the money, someone decides whether the work is "done", and contributors hope to be paid. Maintainers who post bounties directly face the reverse problem: contributors have to trust them to pay after merging. The fact that actually settles a bounty is public and mechanical, namely that a PR fixing the issue was merged. GenLayer can read that fact from GitHub under consensus and move the money itself.

## What it does

1. **Create.** `create(repo, issue, days)` with GEN attached. Validators confirm through the GitHub API that the issue exists, is an issue and not a PR, and is open. The title is stored with the bounty. Anyone can add GEN with `fund(id)`.
2. **Fix.** The contributor opens a PR in that repository whose description contains a GitHub closing keyword for the issue (`Closes #12`, `fixes owner/repo#12`, `resolves https://github.com/owner/repo/issues/12`) and a line `genlayer-payout: 0x<address>`. The app generates both lines.
3. **Merge.** The maintainer reviews and merges as usual. Merging is the acceptance; nobody else judges the work.
4. **Claim.** The payout address calls `claim(id, pr)`. The leader and each validator fetch `GET /repos/<repo>/pulls/<pr>` and extract `merged`, `merged_at`, the base repository, the author, the merge commit, whether the body closes the issue, and the payout address. Validators vote *agree* only if every extracted fact equals the leader's. Deterministic code then requires: merged, base repository equals the bounty's, merged between creation and the deadline, closes the issue, payout line present and equal to the caller. The escrow is sent to that address.
5. **Refund.** If nobody claims by the deadline plus 3 days of grace, each contributor calls `refund(id)` to take back their own contribution.

### Trust model

| Question | Answer |
|---|---|
| Who decides the work is done? | The maintainer, by merging. The contract only checks that the merge happened, in the right repo, in time, and closes the issue. |
| Can the leader lie about GitHub? | No. Each validator reads GitHub itself; any differing fact means no consensus and no payout. |
| Can someone redirect the payout? | The payout line lives in the PR description, which only the PR author and the repository's maintainers can edit, and only that payout address can claim. |
| Can someone grief the payout? | GEN leaves the contract as an *external message*, and GenLayer only executes it if the transaction carries a message-fee budget. We measured on Bradbury that without one the call still succeeds but the transfer never happens. So every transfer (claim, refund) can only be triggered by its own recipient, and the app always attaches a budget (0.01 GEN, mostly refunded). |
| Where is the money? | In the contract's ghost account on GenLayer Chain. It can only go to the payout address of a qualifying merged PR, or back to each funder. |

## The app

Plain HTML and ES modules, no build step, no third-party scripts. It talks to the chain directly:

- **Reads** use `gen_call` (`type: "read"`) on the contract's views: `list`, `stats`, `get`.
- **Before every write** it simulates the exact call on a node (`gen_call` `type: "write"`, including attached value), which runs the leader's GitHub fetch. Problems such as "PR not merged", "issue closed" or "wrong payout address" show up before the user signs anything.
- **Writes** are signed in the user's wallet (EIP-1193) as `addTransaction` on ConsensusMain, with `userValue` for funding and `totalMessageFees` for payouts.
- **The lifecycle panel** follows each transaction: simulate, sign, mined, leader executes, validators commit, validators reveal, accepted, finalized. It shows the validators' votes and links the GenLayer transaction. A call that validators agree has failed is reported as such.

Run it locally with any static server: `python -m http.server` in the repository root.

## Contract methods

| Method | Kind | Notes |
|---|---|---|
| `create(repo, issue, days)` | write, payable, nondet | min 0.001 GEN, 1 to 365 days |
| `fund(id)` | write, payable | while open and before the deadline; up to 20 contributors |
| `claim(id, pr)` | write, nondet | payout address only; needs a message-fee budget |
| `refund(id)` | write | own contribution, after deadline + 3 days; needs a message-fee budget |
| `get(id)`, `list(offset, limit)`, `stats()`, `recent()` | view | |
| `pr_template(id, payout)` | view | the two lines to paste in the PR |

## Deployment

| | |
|---|---|
| Network | GenLayer Bradbury testnet (chain 4221) |
| Contract | [`0x8036b2ffeedb94837546c66e1af6bc3909c1c0a6`](https://scan.bradbury.genlayer.com/address/0x8036b2ffeedb94837546c66e1af6bc3909c1c0a6) |
| Code | `dist/merge-bounty.wasm`, 263,446 bytes, SHA-256 `7d659b368d128414615d715a76d965c33a6f9ec280a34d77565cf1702ff4680c` |
| Activation tx | [`0xbb454f17b7830503…`](https://scan.bradbury.genlayer.com/tx/0xbb454f17b7830503686c22c0ca44ca14dedc826df0dc4986391454a9cddfff5d) |

`tools/build.sh` rebuilds the same bytes (Rust 1.98.1, binaryen version_133) so the SHA-256 can be compared with the code the chain runs, for example with the verifier at https://brossxnft.github.io/genlayer-chunked-deploy/.

## Build, test, deploy

```bash
cargo test                                  # closing-keyword and payout-line parsing, decimal helpers
cargo build --release --target wasm32-wasip1
wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
  --enable-nontrapping-float-to-int target/wasm32-wasip1/release/merge-bounty.wasm -o merge-bounty.wasm
python tools/wasm_strip.py merge-bounty.wasm merge-bounty.wasm --version v0.3.0
python tools/chunked_deploy.py merge-bounty.wasm --test-method version --send
node --test web/test/*.test.mjs                    # calldata / transaction encoding vectors
```

Then put the address in `web/config.js`.

## Limits and next steps

- GitHub's unauthenticated API allows 60 requests per hour per IP; each validator uses its own IP.
- The PR must be merged before the deadline; a PR merged later cannot claim even if no one else did.
- Next: bounties on GitLab and Codeberg (same pattern, different API), splitting a bounty between co-authors listed in the PR, and an optional reviewer-approval requirement read from the PR reviews API.

## License

MIT

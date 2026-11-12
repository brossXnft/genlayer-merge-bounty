# Contributing

Thanks for helping. Issues in this repository may carry a Merge Bounty: GEN escrowed on Bradbury that pays the contributor whose pull request closes the issue.

## Working on a bounty

1. Open the app, find the bounty, and press **Claim with merged PR** with the wallet that should receive the payout. The dialog shows two lines.
2. Put both lines in your pull request description:

   ```
   Closes #<issue>

   genlayer-payout: 0x<your address>
   ```

   The first line is GitHub's normal closing keyword (`fixes` and `resolves` work too). The second tells the contract where to pay. Only you, as the PR author, and the maintainers can edit it.
3. Wait for review. When a maintainer merges the PR, go back to the dialog, enter the PR number, press **Check PR**, then **Claim**. Validators read the PR from GitHub and the escrow is sent to your address when the transaction finalizes.

The PR has to be merged into this repository before the bounty's deadline.

## Code

- Contract: `contract/src/main.rs` (Rust, `genlayer_sdk`). `cargo test` runs the parsing tests.
- Web app: `index.html` and `web/`, plain ES modules. `node --test web/test/*.test.mjs` runs the encoding tests.
- Floating point is forbidden in deterministic GenVM code, including `BigInt::to_string()`. Use the integer helpers in `glkit` (`int_text`, `parse_int`, `f_i64`).

Keep pull requests small and describe what you changed and how you checked it.

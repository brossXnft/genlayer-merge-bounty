// Deployment this page talks to. Change CONTRACT after deploying your own copy.
export const CONTRACT = "0x8036b2ffeedb94837546c66e1af6bc3909c1c0a6";
export const REPO_URL = "https://github.com/brossXnft/genlayer-merge-bounty";
// Message-fee budget attached to calls that send GEN out (claim, refund).
// Without it GenLayer does not execute the transfer. Unused budget is refunded.
export const MSG_FEES = 10n ** 16n; // 0.01 GEN

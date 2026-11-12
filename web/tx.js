// Wallet connection and the full GenLayer write lifecycle, with no DOM access:
// simulate -> sign -> mined -> Pending/Proposing/Committing/Revealing -> Accepted -> Finalized.
import { callCalldata, toHex } from "./codec.js";
import { CHAIN, CONSENSUS_MAIN, EVENT, EXEC_RETURN, FEE_TEMPLATE, MAX_TX_GAS, STATUS_NAME, encodeAddTransaction, txValue } from "./chain.js";

const hex = (v) => "0x" + BigInt(v).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TxError extends Error {
  constructor(stage, message, extra = {}) {
    super(message);
    this.name = "TxError";
    this.stage = stage;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- wallet

export class Wallet {
  constructor(provider = globalThis.ethereum) {
    this.provider = provider;
    this.account = null;
  }

  get available() {
    return Boolean(this.provider);
  }

  request(args) {
    if (!this.provider) throw new TxError("wallet", "No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
    return this.provider.request(args);
  }

  async connect() {
    const [account] = await this.request({ method: "eth_requestAccounts" });
    await this.ensureChain();
    this.account = account;
    return account;
  }

  async restore() {
    if (!this.provider) return null;
    const [account] = await this.request({ method: "eth_accounts" });
    this.account = account ?? null;
    return this.account;
  }

  async ensureChain() {
    const id = Number(await this.request({ method: "eth_chainId" }));
    if (id === CHAIN.id) return;
    try {
      await this.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.idHex }] });
    } catch (e) {
      if (e.code !== 4902) throw new TxError("wallet", `Switch your wallet to ${CHAIN.name} (chain ${CHAIN.id}).`);
      await this.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CHAIN.idHex,
          chainName: CHAIN.name,
          nativeCurrency: { name: "GEN", symbol: CHAIN.symbol, decimals: 18 },
          rpcUrls: [CHAIN.walletRpc],
          blockExplorerUrls: [CHAIN.explorer],
        }],
      });
    }
  }

  onChange(cb) {
    if (!this.provider?.on) return;
    this.provider.on("accountsChanged", (a) => { this.account = a[0] ?? null; cb(); });
    this.provider.on("chainChanged", () => cb());
  }
}

// ---------------------------------------------------------------- lifecycle

export const STAGES = [
  ["simulate", "Simulate on a node"],
  ["sign", "Sign in wallet"],
  ["mining", "Mined on GenLayer Chain"],
  ["proposing", "Leader executes"],
  ["committing", "Validators commit votes"],
  ["revealing", "Validators reveal votes"],
  ["accepted", "Accepted by consensus"],
  ["finalized", "Finalized"],
];

const DONE_STATUS = new Set(["Accepted", "Finalized"]);
const BAD_STATUS = new Set(["Undetermined", "Canceled", "ValidatorsTimeout", "LeaderTimeout"]);

// Vote codes in roundsData.validatorVotes.
export const VOTE = { 0: "not voted", 1: "agree", 2: "disagree", 3: "timeout", 4: "deterministic violation" };

export function summarizeVotes(rounds) {
  const last = rounds?.[rounds.length - 1];
  if (!last) return null;
  const count = {};
  for (const v of last.votes) count[VOTE[Number(v)] ?? `vote ${v}`] = (count[VOTE[Number(v)] ?? `vote ${v}`] ?? 0) + 1;
  return { validators: last.validators.length, count, round: rounds.length };
}

/**
 * Send one write. `onUpdate({stage, ...})` is called on every step.
 * Resolves with {txId, hash, preview, status, votes} once Finalized (or Accepted
 * when needFinal=false). Throws TxError with `stage` set on any failure.
 */
export async function sendWrite({ rpc, wallet, contract, method, args = [], value = 0n, msgFees = 0n, needFinal = true, onUpdate = () => {}, pollMs = 4000, patienceMs = 30 * 60_000 }) {
  const account = wallet.account;
  if (!account) throw new TxError("wallet", "Connect a wallet first.");
  const state = { stage: "simulate", method };
  const update = (stage, extra = {}) => { Object.assign(state, extra, { stage }); onUpdate({ ...state }); };

  update("simulate");
  const sim = await rpc.simulate(account, contract, method, args, "write", value);
  if (!sim.ok) throw new TxError("simulate", sim.error, { simulated: true });
  state.preview = sim.value;

  await wallet.ensureChain();
  const latest = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  const data = toHex(encodeAddTransaction({
    sender: account,
    recipient: contract,
    validUntil: Number(latest.timestamp) + FEE_TEMPLATE.validFor,
    txCalldata: callCalldata(method, args),
    userValue: value,
    msgFees,
  }));
  const call = { from: account, to: CONSENSUS_MAIN, value: hex(txValue({ userValue: value, msgFees })), data };
  let gas;
  try {
    gas = BigInt(await rpc.call("eth_estimateGas", [call]));
  } catch (e) {
    throw new TxError("sign", `The network refused this transaction (${e.message}). Check that your wallet holds enough GEN.`);
  }
  gas = (gas * 12n) / 10n;

  update("sign");
  let hash;
  try {
    hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [{ ...call, gas: hex(gas < MAX_TX_GAS ? gas : MAX_TX_GAS), maxFeePerGas: hex(BigInt(latest.baseFeePerGas) * 3n), maxPriorityFeePerGas: "0x0", type: "0x2" }],
    });
  } catch (e) {
    if (e.code === 4001) throw new TxError("sign", "You rejected the signature.");
    throw new TxError("sign", "The wallet could not send this transaction: " + (e.message || e));
  }

  update("mining", { hash });
  let receipt = null;
  for (let i = 0; i < 180 && !receipt; i++) {
    receipt = await rpc.call("eth_getTransactionReceipt", [hash]);
    if (!receipt) await sleep(1000);
  }
  if (!receipt) throw new TxError("mining", "Not mined within 3 minutes.", { hash });
  if (receipt.status !== "0x1") throw new TxError("mining", "The transaction reverted on GenLayer Chain.", { hash });
  const created = receipt.logs.find((l) => l.topics[0] === EVENT.CREATED);
  const announced = receipt.logs.find((l) => l.topics[0] === EVENT.NEW);
  const txId = (created ?? announced)?.topics[1];
  if (!txId) throw new TxError("mining", "The receipt has no GenLayer transaction id.", { hash });
  state.txId = txId;

  return trackTransaction({ rpc, txId, needFinal, pollMs, patienceMs, state, update });
}

/** Follow an existing GenLayer transaction until it settles. */
export async function trackTransaction({ rpc, txId, needFinal = true, pollMs = 4000, patienceMs = 30 * 60_000, state = { txId }, update = () => {} }) {
  const deadline = Date.now() + patienceMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    let d;
    try {
      d = await rpc.transactionData(txId);
    } catch {
      await sleep(pollMs);
      continue;
    }
    const status = STATUS_NAME[d.status] ?? `status ${d.status}`;
    const votes = summarizeVotes(d.rounds);
    if (status !== lastStatus || votes?.count?.agree !== state.votes?.count?.agree) {
      lastStatus = status;
      const stage = status === "Pending" ? "mining" : status.toLowerCase().replace(/^appeal/, "");
      update(STAGES.some(([s]) => s === stage) ? stage : state.stage, { status, votes, execution: d.execution, txId });
    }
    if (BAD_STATUS.has(status)) throw new TxError("consensus", `Consensus ended as ${status}.`, { txId, status, votes });
    if (DONE_STATUS.has(status)) {
      if (d.execution !== EXEC_RETURN) {
        throw new TxError("contract", "Validators agreed that the contract call failed; nothing was changed.", { txId, status, votes });
      }
      if (status === "Finalized" || !needFinal) return { ...state, status, votes };
    }
    await sleep(pollMs);
  }
  throw new TxError("consensus", "Still waiting for validators. The transaction keeps going; check the explorer.", { txId });
}

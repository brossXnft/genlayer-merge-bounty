import { Rpc, addressUrl, isAddress } from "./chain.js";
import { TxError, Wallet, sendWrite } from "./tx.js";
import { $, LifecyclePanel, el, formatGen, link, parseGen, relative, short, when } from "./ui.js";
import { CONTRACT, MSG_FEES, REPO_URL } from "./config.js";

const rpc = new Rpc();
const wallet = new Wallet();
const READER = "0x0000000000000000000000000000000000000001";
let busy = false;

const read = async (method, args = []) => {
  const r = await rpc.simulate(wallet.account ?? READER, CONTRACT, method, args, "read");
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

// ---------------------------------------------------------------- wallet

async function refreshWallet() {
  const btn = $("connect");
  if (!wallet.available) {
    btn.textContent = "No wallet found";
    btn.disabled = true;
    return;
  }
  if (wallet.account) {
    const bal = BigInt(await rpc.call("eth_getBalance", [wallet.account, "latest"]));
    btn.textContent = `${short(wallet.account)} · ${formatGen(bal, 2)}`;
  } else {
    btn.textContent = "Connect wallet";
  }
}

$("connect").onclick = async () => {
  try {
    await wallet.connect();
  } catch (e) {
    toast(e.message || String(e), true);
  }
  refreshWallet();
  render();
};
wallet.onChange(() => { refreshWallet(); render(); });

function toast(text, bad = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = bad ? "toast bad" : "toast";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 7000);
}

// ---------------------------------------------------------------- actions

async function run(title, opts, after) {
  if (busy) return toast("Another transaction is in progress.", true);
  if (!wallet.account) {
    try { await wallet.connect(); await refreshWallet(); } catch (e) { return toast(e.message, true); }
  }
  busy = true;
  const panel = new LifecyclePanel($("activity"), title);
  $("activity").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const res = await sendWrite({ rpc, wallet, contract: CONTRACT, ...opts, onUpdate: (s) => panel.update(s) });
    panel.done(after ? after(res.preview) : "Done.");
  } catch (e) {
    panel.fail(e instanceof TxError ? e : new TxError("simulate", e.message || String(e)));
  } finally {
    busy = false;
    refreshWallet();
    render();
  }
}

$("create-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const repo = $("c-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const issue = Number($("c-issue").value);
  const days = Number($("c-days").value);
  let value;
  try {
    value = parseGen($("c-amount").value);
  } catch (e) {
    return toast(e.message, true);
  }
  run(`Create bounty on ${repo}#${issue}`, { method: "create", args: [repo, issue, days], value }, (b) =>
    `Bounty #${b?.id} is open: ${formatGen(b?.amount)} on “${b?.title}”.`);
};

$("c-check").onclick = async () => {
  const repo = $("c-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const issue = Number($("c-issue").value);
  const out = $("c-preview");
  out.className = "hint";
  out.textContent = "Asking a node to read the issue from GitHub…";
  const r = await rpc.simulate(wallet.account ?? READER, CONTRACT, "create", [repo, issue, 30], "write", 10n ** 15n);
  out.textContent = r.ok ? `OK: issue “${r.value?.title}” is open.` : `Not accepted: ${r.error}`;
  out.className = r.ok ? "hint ok" : "hint bad";
};

function claimDialog(b) {
  const d = $("claim-dialog");
  $("cl-title").textContent = `Claim bounty #${b.id}: ${b.repo}#${b.issue}`;
  const payout = wallet.account ?? "0xYOUR_ADDRESS";
  $("cl-who").textContent = wallet.account
    ? `Payout address: ${wallet.account}. Only this wallet can claim, so keep it connected.`
    : "Connect the wallet that should receive the bounty first; its address goes in the PR.";
  $("cl-template").value = `Closes #${b.issue}\n\ngenlayer-payout: ${payout.toLowerCase()}`;
  $("cl-pr").value = "";
  $("cl-preview").textContent = "";
  $("cl-check").onclick = async () => {
    const pr = Number($("cl-pr").value);
    $("cl-preview").textContent = "Asking a node to read the PR from GitHub…";
    const r = await rpc.simulate(wallet.account ?? READER, CONTRACT, "claim", [b.id, pr], "write");
    $("cl-preview").textContent = r.ok ? `Eligible: pays ${formatGen(b.amount)} to ${r.value?.paid_to}.` : `Not eligible yet: ${r.error}`;
    $("cl-preview").className = r.ok ? "hint ok" : "hint bad";
  };
  $("cl-submit").onclick = () => {
    const pr = Number($("cl-pr").value);
    d.close();
    run(`Claim bounty #${b.id} with PR #${pr}`, { method: "claim", args: [b.id, pr], msgFees: MSG_FEES }, (x) =>
      `Paid ${formatGen(x?.amount)} to ${x?.paid_to}. The GEN transfer executes when this transaction finalizes.`);
  };
  $("cl-copy").onclick = () => navigator.clipboard?.writeText($("cl-template").value).then(() => toast("Copied."));
  d.showModal();
}

function fundDialog(b) {
  const amount = prompt(`Add GEN to bounty #${b.id} (${b.repo}#${b.issue}):`, "1");
  if (!amount) return;
  let value;
  try { value = parseGen(amount); } catch (e) { return toast(e.message, true); }
  run(`Fund bounty #${b.id}`, { method: "fund", args: [b.id], value }, (x) => `Bounty #${b.id} now holds ${formatGen(x?.amount)}.`);
}

// ---------------------------------------------------------------- render

const STATUS_LABEL = { open: "Open", paid: "Paid", refunded: "Refunded", refunding: "Refunding" };

function card(b, now) {
  const issueUrl = `https://github.com/${b.repo}/issues/${b.issue}`;
  const status = b.expired && b.status === "open" ? "expired" : b.status;
  const actions = el("div", { class: "actions" });
  if (b.status === "open" && !b.expired) {
    actions.append(
      el("button", { class: "primary", onclick: () => claimDialog(b) }, "Claim with merged PR"),
      el("button", { onclick: () => fundDialog(b) }, "Add GEN"),
    );
  }
  const me = wallet.account?.toLowerCase();
  const mine = (b.contributions ?? []).find((c) => c.from?.toLowerCase() === me && !c.refunded);
  const refundable = (b.status === "open" || b.status === "refunding") && now > Number(b.refundable_at);
  if (refundable && mine) {
    actions.append(el("button", { onclick: () => run(`Refund my ${formatGen(mine.amount)} from bounty #${b.id}`, { method: "refund", args: [b.id], msgFees: MSG_FEES }, () => `Refunded ${formatGen(mine.amount)}. The transfer executes when this transaction finalizes.`) }, "Refund my contribution"));
  } else if (refundable) {
    actions.append(el("span", { class: "muted" }, "Refunds are open: each contributor withdraws their own share."));
  } else if (b.status === "open" && b.expired) {
    actions.append(el("span", { class: "muted" }, `Refunds open ${relative(b.refundable_at, now)}. A PR merged before the deadline can still claim.`));
  }
  const facts = el("dl", { class: "facts" },
    el("dt", {}, "Escrow"), el("dd", {}, formatGen(b.amount)),
    el("dt", {}, "Deadline"), el("dd", {}, `${when(b.deadline)} (${relative(b.deadline, now)})`),
    el("dt", {}, "Funded by"), el("dd", {}, link(addressUrl(b.funder), short(b.funder)), (b.contributions?.length ?? 1) > 1 ? ` + ${b.contributions.length - 1} more` : ""),
  );
  if (b.status === "paid") {
    facts.append(
      el("dt", {}, "Paid to"), el("dd", {}, link(addressUrl(b.paid_to), short(b.paid_to))),
      el("dt", {}, "Merged PR"), el("dd", {}, link(`https://github.com/${b.repo}/pull/${b.pr}`, `#${b.pr} by @${b.pr_author}`), ` · ${when(b.merged_at)}`),
    );
  }
  return el("article", { class: "item" },
    el("header", {},
      el("span", { class: `badge ${status}` }, STATUS_LABEL[status] ?? "Expired"),
      el("span", { class: "muted" }, `#${b.id}`)),
    el("h3", {}, link(issueUrl, `${b.repo}#${b.issue}`)),
    el("p", { class: "title" }, b.title),
    facts,
    actions);
}

async function render() {
  try {
    const [list, stats] = await Promise.all([read("list", [0, 50]), read("stats")]);
    $("s-count").textContent = stats.bounties;
    $("s-escrow").textContent = formatGen(stats.escrowed, 2);
    $("s-paid").textContent = formatGen(stats.paid, 2);
    const now = Date.now() / 1000;
    const items = list.items ?? [];
    $("bounties").replaceChildren(...(items.length ? items.map((b) => card(b, now)) : [el("p", { class: "muted" }, "No bounties yet. Create the first one below.")]));
  } catch (e) {
    $("bounties").replaceChildren(el("p", { class: "error" }, "Could not read the contract: " + e.message));
  }
}

// ---------------------------------------------------------------- boot

$("contract-link").href = addressUrl(CONTRACT);
$("contract-link").textContent = short(CONTRACT);
$("repo-link").href = REPO_URL;
if (!isAddress(CONTRACT)) toast("config.js has no contract address.", true);
wallet.restore().then(refreshWallet).catch(() => {});
render();
setInterval(render, 30_000);

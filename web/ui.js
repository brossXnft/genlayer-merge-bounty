// DOM helpers shared by the app pages. Chain data only ever goes through textContent.
import { CHAIN, addressUrl, txUrl } from "./chain.js";
import { STAGES } from "./tx.js";

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

export const link = (href, text) => el("a", { href, target: "_blank", rel: "noopener" }, text);
export const short = (s) => (s && s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s ?? "");
export const addrLink = (a) => link(addressUrl(a), short(a));
export const txLink = (id, text = short(id)) => link(txUrl(id), text);

export const WEI = 10n ** 18n;

/** "1.5" -> 1500000000000000000n; throws on bad input. */
export function parseGen(text) {
  const t = String(text).trim();
  if (!/^\d+(\.\d{0,18})?$/.test(t)) throw new Error("Enter an amount like 1 or 0.25");
  const [i, f = ""] = t.split(".");
  return BigInt(i) * WEI + BigInt((f + "0".repeat(18)).slice(0, 18));
}

export function formatGen(wei, digits = 4) {
  const v = BigInt(wei ?? 0);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const i = a / WEI;
  let f = (a % WEI).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${i.toLocaleString("en-US")}${f ? "." + f : ""} GEN`;
}

export function when(unix) {
  const n = Number(unix);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function relative(unix, now = Date.now() / 1000) {
  const d = Number(unix) - now;
  const a = Math.abs(d);
  const u = a < 3600 ? [Math.round(a / 60), "min"] : a < 172800 ? [Math.round(a / 3600), "h"] : [Math.round(a / 86400), "d"];
  return d >= 0 ? `in ${u[0]} ${u[1]}` : `${u[0]} ${u[1]} ago`;
}

/**
 * A panel that shows one write moving through the GenLayer lifecycle.
 * Call `panel.update(state)` from sendWrite's onUpdate and `panel.fail(err)` on errors.
 */
export class LifecyclePanel {
  constructor(container, title) {
    this.root = el("section", { class: "lifecycle", "aria-live": "polite" });
    this.head = el("h3", {}, title);
    this.list = el("ol", { class: "stages" });
    this.meta = el("div", { class: "lc-meta" });
    this.msg = el("p", { class: "lc-msg" });
    this.items = new Map();
    for (const [id, label] of STAGES) {
      const li = el("li", { class: "todo" }, el("span", { class: "dot" }), el("span", {}, label));
      this.items.set(id, li);
      this.list.append(li);
    }
    this.root.append(this.head, this.list, this.meta, this.msg);
    container.prepend(this.root);
  }

  update(s) {
    const order = STAGES.map(([id]) => id);
    const at = order.indexOf(s.stage);
    order.forEach((id, i) => {
      const li = this.items.get(id);
      li.className = i < at ? "done" : i === at ? (s.stage === "finalized" ? "done" : "now") : "todo";
    });
    const bits = [];
    if (s.txId) bits.push(el("span", {}, "GenLayer tx ", txLink(s.txId)));
    if (s.votes) {
      const c = s.votes.count;
      bits.push(el("span", {}, `Votes: ${c.agree ?? 0} agree · ${c.disagree ?? 0} disagree · ${(c["not voted"] ?? 0) + (c.timeout ?? 0)} pending/timeout of ${s.votes.validators}`));
    }
    if (s.status) bits.push(el("span", {}, `Status: ${s.status}`));
    this.meta.replaceChildren(...bits);
    this.msg.className = "lc-msg";
    this.msg.textContent = s.stage === "finalized" ? "Done. The result is final." : s.stage === "accepted" ? "Accepted. Waiting for the finality window." : "";
  }

  fail(err) {
    const li = this.items.get(err.stage) ?? this.items.get("accepted");
    if (li) li.className = "bad";
    this.msg.className = "lc-msg error";
    this.msg.textContent = err.message;
    if (err.txId) this.meta.append(el("span", {}, "GenLayer tx ", txLink(err.txId)));
  }

  done(text) {
    this.msg.className = "lc-msg ok";
    this.msg.textContent = text;
  }
}

export function networkBadge() {
  return el("span", { class: "net" }, `${CHAIN.name} · chain ${CHAIN.id}`);
}

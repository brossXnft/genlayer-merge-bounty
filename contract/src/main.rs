//! Merge Bounty: GEN bounties on GitHub issues, paid out when the fixing PR is merged.
//!
//! 1. `create(repo, issue, days)` (payable) escrows GEN on an open issue.
//!    Validators confirm through the GitHub API that the issue exists and is open.
//! 2. The contributor opens a PR in that repo whose description contains
//!    `Closes #<issue>` (any GitHub closing keyword) and a line
//!    `genlayer-payout: 0x<address>`.
//! 3. After the maintainer merges it, the payout address calls `claim(id, pr)`.
//!    Every validator reads the PR from GitHub itself; if it is merged into the
//!    bounty repo before the deadline and closes the issue, the contract sends
//!    the escrow to the payout address. Merging is the maintainer's acceptance,
//!    and only the PR author or a maintainer can edit the payout line.
//! 4. Unclaimed after deadline + 3 days grace: each contributor calls
//!    `refund(id)` to take back their own contribution.
//!
//! GEN leaves the contract as an external message, which GenLayer executes only
//! if the transaction carries a message-fee budget (`totalMessageFees`); without
//! one the call succeeds but the transfer never happens. Every transfer is
//! therefore triggered by its own recipient, and the web app always attaches a budget.

use glkit::genlayer_sdk::abi::entry::MessageData;
use glkit::genlayer_sdk::abi::entry::contract_def::{ConsensusStageData, Contract, ContractExt};
use glkit::genlayer_sdk::storage::{DynArray, Root};
use glkit::*;

glkit::genlayer_sdk::record!(State {
    bounties: Records,
    count: u32,
    escrowed: U256,
    paid: U256,
    log: DynArray<Vec<u8>>,
});

fn state() -> State {
    Root::<State>::get().contract_instance().get()
}

const UA: &str = "merge-bounty/1.0 (+https://github.com/brossXnft/genlayer-merge-bounty)";
const GRACE_S: i64 = 3 * 86_400;
const MIN_WEI: u64 = 1_000_000_000_000_000; // 0.001 GEN
const MAX_CONTRIBUTIONS: usize = 20;
const CLOSING: [&str; 9] = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

fn bid(n: u64) -> String {
    format!("{n:08}")
}

fn gh(path: &str) -> R<serde_json::Value> {
    get_json(&format!("https://api.github.com/{path}"), &[("User-Agent", UA), ("Accept", "application/vnd.github+json")])
}

fn check_repo(s: &str) -> R<String> {
    let r = s.trim().trim_start_matches("https://github.com/").trim_end_matches('/').to_ascii_lowercase();
    let parts: Vec<&str> = r.split('/').collect();
    let ok = parts.len() == 2
        && parts.iter().all(|p| !p.is_empty() && p.len() <= 100 && p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)));
    if ok { Ok(r) } else { Err("repo must be `owner/name`".into()) }
}

// ------------------------------------------------------------------ PR body parsing (deterministic)

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// True if `body` has a GitHub closing keyword that references `repo#issue`.
fn closes_issue(body: &str, repo: &str, issue: u64) -> bool {
    let b = body.to_ascii_lowercase();
    let bytes = b.as_bytes();
    let refs = [
        format!("#{issue}"),
        format!("{repo}#{issue}"),
        format!("https://github.com/{repo}/issues/{issue}"),
    ];
    for kw in CLOSING {
        let mut from = 0;
        while let Some(pos) = b[from..].find(kw) {
            let start = from + pos;
            let end = start + kw.len();
            from = end;
            if start > 0 && is_word(bytes[start - 1]) {
                continue;
            }
            if end < bytes.len() && is_word(bytes[end]) {
                continue;
            }
            let mut rest = &b[end..];
            rest = rest.strip_prefix(':').unwrap_or(rest);
            let rest = rest.trim_start();
            for r in &refs {
                if let Some(after) = rest.strip_prefix(r.as_str()) {
                    if after.bytes().next().map(|c| !c.is_ascii_digit()).unwrap_or(true) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// First `genlayer-payout: 0x...` line in the PR body.
fn payout_address(body: &str) -> Option<String> {
    for line in body.lines() {
        let l = line.trim().trim_start_matches(['-', '*', '>', ' ']).trim();
        let low = l.to_ascii_lowercase();
        if let Some(rest) = low.strip_prefix("genlayer-payout") {
            let rest = rest.trim_start().strip_prefix(':')?.trim();
            let addr: String = rest.chars().take(42).collect();
            return parse_address(&addr).map(|a| addr_hex(&a));
        }
    }
    None
}

// ------------------------------------------------------------------ GitHub facts (nondet only)

fn issue_facts(repo: &str, issue: u64) -> R<Value> {
    let j = gh(&format!("repos/{repo}/issues/{issue}"))?;
    Ok(map([
        ("number", Value::from(json_path(&j, "number").and_then(|v| v.as_u64()).unwrap_or(0))),
        ("state", Value::Str(json_path(&j, "state").and_then(|v| v.as_str()).unwrap_or("").to_owned())),
        ("is_pr", Value::Bool(json_path(&j, "pull_request").is_some())),
        ("title", Value::Str(json_path(&j, "title").and_then(|v| v.as_str()).unwrap_or("").chars().take(140).collect())),
    ]))
}

fn pr_facts(repo: &str, issue: u64, pr: u64) -> R<Value> {
    let j = gh(&format!("repos/{repo}/pulls/{pr}"))?;
    let body = json_path(&j, "body").and_then(|v| v.as_str()).unwrap_or("");
    let merged_at = json_path(&j, "merged_at").and_then(|v| v.as_str()).and_then(parse_rfc3339_utc).unwrap_or(0);
    Ok(map([
        ("merged", Value::Bool(json_path(&j, "merged").and_then(|v| v.as_bool()).unwrap_or(false))),
        ("merged_at", Value::from(merged_at)),
        ("base", Value::Str(json_path(&j, "base.repo.full_name").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase())),
        ("author", Value::Str(json_path(&j, "user.login").and_then(|v| v.as_str()).unwrap_or("").to_owned())),
        ("merge_sha", Value::Str(json_path(&j, "merge_commit_sha").and_then(|v| v.as_str()).unwrap_or("").to_owned())),
        ("closes", Value::Bool(closes_issue(body, repo, issue))),
        ("payout", payout_address(body).map(Value::Str).unwrap_or(Value::Null)),
    ]))
}

// ------------------------------------------------------------------ contract

fn get(id: u64) -> R<Value> {
    rec_get(&state().bounties(), &bid(id)).ok_or_else(|| format!("no bounty #{id}"))
}

fn amount(b: &Value) -> R<U256> {
    u256_from_bigint(&f_num(b, "amount"))
}

fn log_event(m: &MessageData, ev: &str, id: u64, extra: Value) {
    let rec = with(&with(&with(&extra, "event", ev.into()), "id", Value::from(id)), "at", Value::from(tx_time(m)));
    state().log().append_slot().store(&calldata::encode(&rec));
}

fn view(b: &Value, now: i64) -> Value {
    let deadline = f_i64(b, "deadline");
    let mut v = with(b, "refundable_at", Value::from(deadline + GRACE_S));
    if f_str(b, "status") == "open" && now > deadline {
        v = with(&v, "expired", Value::Bool(true));
    }
    v
}

#[derive(Default)]
pub struct MergeBounty;

impl MergeBounty {
    fn create(&self, m: &MessageData, args: &[Value]) -> R<Value> {
        let value = u256_from_bigint(&m.value)?;
        if value < U256::from(MIN_WEI) {
            return Err("attach at least 0.001 GEN".into());
        }
        let repo = check_repo(&arg_str(args, 0, "repo")?)?;
        let issue = arg_u64(args, 1, "issue")?;
        let days = arg_u64(args, 2, "days")?;
        if issue == 0 || !(1..=365).contains(&days) {
            return Err("issue must be > 0 and days 1-365".into());
        }
        let facts = run_nondet(&map([("op", "issue".into()), ("repo", repo.clone().into()), ("issue", Value::from(issue))]))?;
        if f_bool(&facts, "is_pr") {
            return Err(format!("#{issue} is a pull request, not an issue"));
        }
        if f_str(&facts, "state") != "open" {
            return Err(format!("issue #{issue} is not open"));
        }
        let st = state();
        let id = st.count().get() as u64 + 1;
        st.count().set(id as u32);
        let now = tx_time(m);
        let b = map([
            ("id", Value::from(id)),
            ("repo", repo.clone().into()),
            ("issue", Value::from(issue)),
            ("title", Value::Str(f_str(&facts, "title"))),
            ("funder", Value::Address(m.sender_address)),
            ("amount", Value::from(value)),
            ("contributions", Value::Array(vec![map([("from", Value::Address(m.sender_address)), ("amount", Value::from(value))])])),
            ("created_at", Value::from(now)),
            ("deadline", Value::from(now + days as i64 * 86_400)),
            ("status", "open".into()),
        ]);
        rec_put(&st.bounties(), &bid(id), &b);
        st.escrowed().set(st.escrowed().get() + value);
        log_event(m, "created", id, map([("amount", Value::from(value)), ("repo", repo.into()), ("issue", Value::from(issue))]));
        Ok(view(&b, now))
    }

    fn fund(&self, m: &MessageData, args: &[Value]) -> R<Value> {
        let value = u256_from_bigint(&m.value)?;
        if value < U256::from(MIN_WEI) {
            return Err("attach at least 0.001 GEN".into());
        }
        let id = arg_u64(args, 0, "id")?;
        let b = get(id)?;
        let now = tx_time(m);
        if f_str(&b, "status") != "open" || now > f_i64(&b, "deadline") {
            return Err(format!("bounty #{id} is not open for funding"));
        }
        let mut contribs = f(&b, "contributions").and_then(|c| c.as_array()).map(|a| a.to_vec()).unwrap_or_default();
        if let Some(c) = contribs.iter_mut().find(|c| f_addr(c, "from").map(|a| a.raw()) == Some(m.sender_address.raw())) {
            let total = u256_from_bigint(&f_num(c, "amount"))? + value;
            *c = with(c, "amount", Value::from(total));
        } else {
            if contribs.len() >= MAX_CONTRIBUTIONS {
                return Err("too many contributors on this bounty".into());
            }
            contribs.push(map([("from", Value::Address(m.sender_address)), ("amount", Value::from(value))]));
        }
        let b = with(&with(&b, "contributions", Value::Array(contribs)), "amount", Value::from(amount(&b)? + value));
        let st = state();
        rec_put(&st.bounties(), &bid(id), &b);
        st.escrowed().set(st.escrowed().get() + value);
        log_event(m, "funded", id, map([("amount", Value::from(value)), ("from", Value::Address(m.sender_address))]));
        Ok(view(&b, now))
    }

    fn claim(&self, m: &MessageData, args: &[Value]) -> R<Value> {
        no_value(m)?;
        let id = arg_u64(args, 0, "id")?;
        let pr = arg_u64(args, 1, "pr")?;
        let b = get(id)?;
        if f_str(&b, "status") != "open" {
            return Err(format!("bounty #{id} is {}", f_str(&b, "status")));
        }
        let repo = f_str(&b, "repo");
        let issue = f_u64(&b, "issue");
        let facts = run_nondet(&map([
            ("op", "pr".into()),
            ("repo", repo.clone().into()),
            ("issue", Value::from(issue)),
            ("pr", Value::from(pr)),
        ]))?;
        let created = f_i64(&b, "created_at");
        let deadline = f_i64(&b, "deadline");
        let merged_at = f_i64(&facts, "merged_at");
        if !f_bool(&facts, "merged") {
            return Err(format!("PR #{pr} is not merged"));
        }
        if f_str(&facts, "base") != repo {
            return Err(format!("PR #{pr} was merged into {}, not {repo}", f_str(&facts, "base")));
        }
        if merged_at < created || merged_at > deadline {
            return Err(format!("PR #{pr} was merged outside the bounty window"));
        }
        if !f_bool(&facts, "closes") {
            return Err(format!("PR #{pr} does not say `Closes #{issue}` (or fixes/resolves)"));
        }
        let payout = parse_address(&f_str(&facts, "payout"))
            .ok_or_else(|| format!("PR #{pr} has no `genlayer-payout: 0x...` line"))?;
        // The payout is pushed as an external message, which only executes if the
        // transaction carries a message-fee budget. Letting only the recipient
        // trigger it means nobody else can claim without a budget and strand the payout.
        if payout.raw() != m.sender_address.raw() {
            return Err(format!("only the payout address in PR #{pr} ({}) can claim; connect that wallet", addr_hex(&payout)));
        }
        let amt = amount(&b)?;
        let now = tx_time(m);
        let b = map([
            ("status", "paid".into()),
            ("paid_to", Value::Address(payout)),
            ("pr", Value::from(pr)),
            ("pr_author", Value::Str(f_str(&facts, "author"))),
            ("merge_sha", Value::Str(f_str(&facts, "merge_sha"))),
            ("merged_at", Value::from(merged_at)),
            ("paid_at", Value::from(now)),
            ("claimed_by", Value::Address(m.sender_address)),
        ])
        .as_map()
        .unwrap()
        .iter()
        .fold(b, |acc, (k, v)| with(&acc, k, v.clone()));
        let st = state();
        rec_put(&st.bounties(), &bid(id), &b);
        st.escrowed().set(st.escrowed().get().saturating_sub(amt));
        st.paid().set(st.paid().get() + amt);
        transfer_to_eoa(payout, amt)?;
        log_event(m, "paid", id, map([("amount", Value::from(amt)), ("to", Value::Address(payout)), ("pr", Value::from(pr))]));
        Ok(view(&b, now))
    }

    /// Each contributor withdraws their own contribution (pull, so nobody can
    /// trigger someone else's refund without a message budget).
    fn refund(&self, m: &MessageData, args: &[Value]) -> R<Value> {
        no_value(m)?;
        let id = arg_u64(args, 0, "id")?;
        let b = get(id)?;
        let status = f_str(&b, "status");
        if status != "open" && status != "refunding" {
            return Err(format!("bounty #{id} is {status}"));
        }
        let now = tx_time(m);
        let deadline = f_i64(&b, "deadline");
        if now <= deadline + GRACE_S {
            return Err(format!("refunds open at {} (deadline + 3 days)", deadline + GRACE_S));
        }
        let mut contribs = f(&b, "contributions").and_then(|c| c.as_array()).map(|a| a.to_vec()).unwrap_or_default();
        let Some(c) = contribs
            .iter_mut()
            .find(|c| f_addr(c, "from").map(|a| a.raw()) == Some(m.sender_address.raw()) && !f_bool(c, "refunded"))
        else {
            return Err("this address has nothing to refund on this bounty".into());
        };
        let mine = u256_from_bigint(&f_num(c, "amount"))?;
        *c = with(&with(c, "refunded", Value::Bool(true)), "refunded_at", Value::from(now));
        let all_done = contribs.iter().all(|c| f_bool(c, "refunded"));
        let left = amount(&b)?.saturating_sub(mine);
        let mut b = with(&with(&b, "contributions", Value::Array(contribs)), "amount", Value::from(left));
        b = with(&b, "status", if all_done { "refunded".into() } else { "refunding".into() });
        if all_done {
            b = with(&b, "refunded_at", Value::from(now));
        }
        let st = state();
        rec_put(&st.bounties(), &bid(id), &b);
        st.escrowed().set(st.escrowed().get().saturating_sub(mine));
        transfer_to_eoa(m.sender_address, mine)?;
        log_event(m, "refunded", id, map([("amount", Value::from(mine)), ("to", Value::Address(m.sender_address))]));
        Ok(view(&b, now))
    }
}

impl ContractExt for MergeBounty {
    type Error = String;

    fn handle_deploy(&mut self, _m: MessageData, _a: Vec<Value>, _k: calldata::Map) -> R<Value> {
        Ok(Value::Null)
    }

    fn handle_method(&mut self, m: MessageData, method: String, args: Vec<Value>, _k: calldata::Map) -> R<Value> {
        let now = tx_time(&m);
        match method.as_str() {
            "create" => self.create(&m, &args),
            "fund" => self.fund(&m, &args),
            "claim" => self.claim(&m, &args),
            "refund" => self.refund(&m, &args),
            "get" => Ok(view(&get(arg_u64(&args, 0, "id")?)?, now)),
            "list" => {
                let st = state();
                let n = st.count().get() as u64;
                let offset = args.first().and_then(|v| v.as_number()).and_then(|b| u64::try_from(b.clone()).ok()).unwrap_or(0);
                let limit = args.get(1).and_then(|v| v.as_number()).and_then(|b| u64::try_from(b.clone()).ok()).unwrap_or(50).min(100);
                // newest first
                let mut out = Vec::new();
                let mut i = n.saturating_sub(offset);
                while i >= 1 && (out.len() as u64) < limit {
                    if let Some(b) = rec_get(&st.bounties(), &bid(i)) {
                        out.push(view(&b, now));
                    }
                    i -= 1;
                }
                Ok(map([("total", Value::from(n)), ("items", Value::Array(out))]))
            }
            "stats" => {
                let st = state();
                Ok(map([
                    ("bounties", Value::from(st.count().get())),
                    ("escrowed", Value::from(st.escrowed().get())),
                    ("paid", Value::from(st.paid().get())),
                    ("balance", Value::from(self_balance()?)),
                ]))
            }
            "recent" => {
                let log = state().log();
                let mut out = Vec::new();
                let mut i = log.len();
                while i > 0 && out.len() < 30 {
                    i -= 1;
                    if let Ok(v) = calldata::decode(&log.index(i).load()) {
                        out.push(v);
                    }
                }
                Ok(Value::Array(out))
            }
            "pr_template" => {
                let b = get(arg_u64(&args, 0, "id")?)?;
                let who = arg_address(&args, 1, "payout")?;
                Ok(format!("Closes #{}\n\ngenlayer-payout: {}", f_u64(&b, "issue"), addr_hex(&who)).into())
            }
            "version" => Ok("merge-bounty 1.0.0".into()),
            _ => Err(format!("unknown method: {method}")),
        }
    }
}

impl Contract for MergeBounty {
    fn handle_main(&mut self, message: MessageData, data: bytes::Bytes) -> Result<Value, String> {
        ContractExt::handle_main(self, message, data.to_vec())
    }

    fn handle_sandbox(&mut self, _m: MessageData, _d: bytes::Bytes) -> Result<Vec<u8>, String> {
        Err("sandbox not supported".into())
    }

    fn handle_consensus_stage(&mut self, _m: MessageData, data: bytes::Bytes, stage: ConsensusStageData) -> Result<Value, String> {
        let req = calldata::decode(&data).map_err(|e| format!("{e:?}"))?;
        let repo = f_str(&req, "repo");
        let issue = f_u64(&req, "issue");
        let mine = match f_str(&req, "op").as_str() {
            "issue" => issue_facts(&repo, issue),
            "pr" => pr_facts(&repo, issue, f_u64(&req, "pr")),
            _ => Err("unknown nondet op".into()),
        };
        match Stage::from(stage) {
            Stage::Leader => mine,
            // Every fact the contract acts on must match what this validator read from GitHub.
            Stage::Validator(lr) => Ok(Value::Bool(match (leader_value(&lr), mine) {
                (Some(l), Ok(v)) => *l == v,
                (None, Err(_)) => leader_user_error(&lr).is_some(),
                _ => false,
            })),
        }
    }
}

glkit::genlayer_sdk::contract_main!(MergeBounty);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_keywords() {
        assert!(closes_issue("Fixes #12", "a/b", 12));
        assert!(closes_issue("this resolves: #12.", "a/b", 12));
        assert!(closes_issue("Closes a/b#12", "a/b", 12));
        assert!(closes_issue("closed https://github.com/a/b/issues/12", "a/b", 12));
        assert!(!closes_issue("Fixes #123", "a/b", 12));
        assert!(!closes_issue("prefixes #12", "a/b", 12));
        assert!(!closes_issue("see #12", "a/b", 12));
        assert!(!closes_issue("Closes c/d#12", "a/b", 12));
    }

    #[test]
    fn payout_line() {
        let a = "0x70b4941eb04d153d87bb29bb8a5884af77d3401b";
        assert_eq!(payout_address(&format!("Closes #1\n\ngenlayer-payout: {a}")).unwrap(), a);
        assert_eq!(payout_address(&format!("- GenLayer-Payout:{}", a.to_uppercase().replace("0X", "0x"))).unwrap(), a);
        assert!(payout_address("genlayer-payout: 0x123").is_none());
        assert!(payout_address("nothing").is_none());
    }
}

#!/usr/bin/env python3
"""Write/read helper on top of gl_tx.py with payable value and message-fee budget.

  glcall.py call <addr> <method> '<json args>' [--value GEN] [--msgfees GEN] [--send] [--wait MIN]
  glcall.py read <addr> <method> '<json args>'
  glcall.py sim  <addr> <method> '<json args>' [--value GEN]   (simulate a write on one node)

--value   GEN sent to a payable method (addTransaction userValue).
--msgfees GEN budget for messages the contract emits (feesDistribution.totalMessageFees),
          e.g. a GEN transfer to an EOA. Default 0.
Default = dry run (eth_estimateGas only). Key never printed.
"""
import importlib.util as u
import os
import sys
from decimal import Decimal

import rlp

HERE = os.path.dirname(os.path.abspath(__file__))
s = u.spec_from_file_location("g", os.path.join(HERE, "gl_tx.py")); g = u.module_from_spec(s); s.loader.exec_module(g)


def wei(x):
    return int(Decimal(x) * 10**18)


def opt(a, name, default=None):
    return a[a.index(name) + 1] if name in a else default


def explain(err):
    """Turn a gen_call 'execution failed: &genvm.VMResult{... ReturnData:[]uint8{...}}' into readable text."""
    import re
    s = str(err)
    m = re.search(r"ReturnData:\[\]uint8\{([^}]*)\}", s)
    if not m:
        return s[:400]
    raw = bytes(int(x, 16) for x in re.findall(r"0x([0-9a-fA-F]+)", m.group(1)))
    try:
        v = g.cd_decode(raw)
    except Exception:
        return raw.decode("utf-8", "replace")[:600]
    if isinstance(v, dict) and "data" in v:
        return str(v["data"])[:800]
    return str(v)[:800]


def simulate(to, method, args, user_value=0, typ="write", sender=None):
    """gen_call on one node. Returns (ok, value_or_error_text)."""
    data = rlp.encode([g.cd_encode(g.call_obj(method, args)), b"\x00"])
    req = {"type": typ, "to": to, "from": sender or g.account().address, "data": "0x" + data.hex(),
           "transaction_hash_variant": "latest-nonfinal"}
    if user_value:
        req["value"] = hex(user_value)
    try:
        r = g.rpc("gen_call", [req], url=g.GEN_RPC)
    except RuntimeError as e:
        return False, explain(e)
    d = r.get("data") or ""
    val = g.cd_decode(bytes.fromhex(d.removeprefix("0x"))) if d else None
    if (r.get("status") or {}).get("code"):
        return False, val or (r.get("stderr") or "")[-400:]
    return True, val


def build(acct, to, txcd, tpl, user_value, msg_fees):
    types, sel, _ = g.load_abi()
    now = int(g.rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
    fees = list(tpl["fees"]); fees[5] = msg_fees
    params = (acct.address, to, tpl["nval"], tpl["maxrot"], now + tpl["valid"], 0, user_value, tuple(fees), txcd, [])
    return sel + g.encode(types, [params])


def call(to, method, args, user_value=0, msg_fees=0, send=False, wait=15, label=None):
    acct = g.account()
    tpl = dict(g.CALL_T)
    tpl["value"] = g.CALL_T["value"] + msg_fees + user_value
    txcd = rlp.encode([g.cd_encode(g.call_obj(method, args)), b"\x00"])
    r = g.send(acct, build(acct, to, txcd, tpl, user_value, msg_fees), tpl, not send, label or f"call {method}")
    if r and r["ok"]:
        r["outcome"] = g.watch(r["tx_id"], r["block"], wait)
        print("outcome:", r["outcome"])
    return r


def main():
    a = sys.argv[1:]
    if len(a) < 3:
        print(__doc__); sys.exit(1)
    cmd, to, method = a[0], a[1], a[2]
    args = g.parse_args(a[3] if len(a) > 3 and not a[3].startswith("--") else "")
    if cmd in ("read", "sim"):
        ok, res = simulate(to, method, args, wei(opt(a, "--value", "0")), "read" if cmd == "read" else "write")
        s = ("" if ok else "FAILED: ") + repr(res)
        print(s if len(s) < 3000 else s[:3000] + f"... ({len(s)} chars)")
    elif cmd == "call":
        call(to, method, args, wei(opt(a, "--value", "0")), wei(opt(a, "--msgfees", "0")),
             "--send" in a, float(opt(a, "--wait", "15")))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()

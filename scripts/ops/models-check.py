#!/usr/bin/env python3
"""models-check — is every model a running Agent uses still offered? (daily, phase D of deps-audit-cron.sh)

Plan: openclaw-dashboard docs/plans/active/model-catalog-check.md (Rev 5). On each server one probe
(PROBE, piped to `python3 -` over SSH) reads the running Agents' model settings and the live model
lists their credentials see: OpenAI per effective key, ChatGPT per account. Venice and OpenRouter
are public and read once, here. Then:

  * findings  — P1 an Agent's primary model is no longer offered, P2 any other model field,
                P2 a curated dashboard OpenAI model no key serves, P3 a list that could not be read;
  * push      — every ChatGPT account list that passed the gate goes to the dashboard
                (POST /api/cron/model-lists, Bearer $CRON_SECRET), which keeps the picker to them.

Invariants (plan §4): the probe never refreshes a ChatGPT token (I1) — it only uses an access token
with more than 10 minutes left, one GET, no retry; no token or key leaves the host (I2) — the probe
prints model ids, 16-hex fingerprints and statuses, and parse_probe() drops any other line; a list
is "read" only if it passes the gate (I7) — expected shape, no pagination marker, at least one
usable entry, and not shrunk below half of the last accepted one; "dead" needs a list that was
read (I4); a ChatGPT ref is judged only against the Agent's own accounts (I5).

    models-check.py --report R --issues I --state S [--hosts eu,us,dev,team1] [--dash-repo DIR] [--no-post]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import inspect
import json
import os
import re
import subprocess
import sys
import urllib.request

# ponytail: same map as versions-check.py HOSTS; one more host means one more line in both.
HOSTS = {"eu": "89.167.70.46", "us": "5.161.84.219", "dev": "204.168.223.245", "team1": "2.31.40.68"}
SSH_KEY = os.environ.get("SSH_KEY", os.path.expanduser("~/.ssh/hetzner-openclaw"))
DASH_URL = os.environ.get("DASH_URL", "https://app.agentglob.com")
# type=all: the default answer holds text models only, and a non-text id is not a retired one.
VENICE_URL = "https://api.venice.ai/api/v1/models?type=all"
OPENROUTER_URL = "https://openrouter.ai/api/v1/models"
CODEX = "openai-codex"

FP_RE = re.compile(r"^[0-9a-f]{16}$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$")
REF_RE = re.compile(r"^[a-z0-9][a-z0-9-]*/\S+$", re.I)
PATH_RE = re.compile(r"^agents(\.[A-Za-z0-9_-]+|\[\d+\])*$")
MODEL_KEYS = ("model", "primary", "fallbacks", "imageModel")
PAGINATION_KEYS = ("has_more", "next", "next_page", "cursor", "next_cursor")
MAX_PUSH_ACCOUNTS = 50
# Why a ref could not be checked when there was no credential to read a list with at all.
NO_CREDENTIAL = {(CODEX, "none"): "the Agent has no ChatGPT login",
                 (CODEX, "?"): "a ChatGPT login without an account id",
                 ("openai", ""): "no OpenAI key on the Agent or its server"}

# ── the probe: runs ON each server, as root, with only the stdlib ─────────────────────────────
# The ChatGPT client_version matters: with 0.99.0 the list held only a hidden model
# (measured 2026-10-16); 0.162.0 returned the full list. A hidden-only answer is caught by the
# gate as "no usable entry — bump CODEX_CLIENT_VERSION".
PROBE_HEAD = r'''from __future__ import annotations
import hashlib, json, os, re, subprocess, sys, time, urllib.request
REF_RE = re.compile(r"^[a-z0-9][a-z0-9-]*/\S+$", re.I)
MODEL_KEYS = ("model", "primary", "fallbacks", "imageModel")
'''
PROBE_BODY = r'''
CODEX_CLIENT_VERSION = "0.162.0"
AGENTS = "/root/.openclaw/agents"
PAGINATION_KEYS = ("has_more", "next", "next_page", "cursor", "next_cursor")
def fp(s): return hashlib.sha256(s.encode()).hexdigest()[:16]
def clean(s): return " ".join(str(s).replace("|", " ").split())[:80]
def out(*f): print("|".join(str(x) for x in f))
def envval(path, name):
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            k, _, v = line.strip().partition("=")
            if k.strip() == name and v.strip():
                return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""
def get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())
def paginated(d):
    return isinstance(d, dict) and any(d.get(k) for k in PAGINATION_KEYS)

running = set()
try:
    ps = subprocess.run(["docker", "ps", "--format", "{{.Names}}"], capture_output=True, text=True, timeout=30)
    if ps.returncode != 0:
        out("HOSTERR", clean("docker ps exit %s: %s" % (ps.returncode, ps.stderr.strip()[-100:])))
    running = {n[: -len("-openclaw-gateway-1")] for n in ps.stdout.split() if n.endswith("-openclaw-gateway-1")}
except Exception as e:
    out("HOSTERR", clean("docker ps: %s" % e))

gkey = envval("/opt/openclaw/.env", "OPENAI_API_KEY")
keys = {}            # keyfp -> key   (never printed)
tokens = {}          # acct  -> access token with > 10 min left (never printed)
accts_seen = set()
# The host's global key is read with only once an Agent on the official endpoint selects it
# (#191 r6 F1): an Agent behind a custom baseUrl sends it there, never to api.openai.com.
now_ms = time.time() * 1000

def ordered(store, cfg, provider):
    """The gateway's resolveAuthProfileOrder base order: store.order, else cfg auth.order, else
    cfg auth.profiles for the provider, else every stored profile for it."""
    profiles = store.get("profiles") or {}
    order = (store.get("order") or {}).get(provider)
    if order is None:
        order = ((cfg.get("auth") or {}).get("order") or {}).get(provider)
    if order is None:
        order = [pid for pid, p in ((cfg.get("auth") or {}).get("profiles") or {}).items()
                 if isinstance(p, dict) and p.get("provider") == provider]
        order = order or [pid for pid, p in profiles.items() if isinstance(p, dict) and p.get("provider") == provider]
    def usable(pid):
        cred = profiles.get(pid)
        if not isinstance(cred, dict) or cred.get("provider") != provider:
            return False
        conf = ((cfg.get("auth") or {}).get("profiles") or {}).get(pid)
        if isinstance(conf, dict):
            # A configured profile must agree on provider and mode (oauth also accepts a stored token).
            if conf.get("provider") != provider:
                return False
            if conf.get("mode") != cred.get("type") and not (conf.get("mode") == "oauth" and cred.get("type") == "token"):
                return False
        return True
    return [profiles[pid] for pid in order if usable(pid)]

JSON5_JS = ("const J=require('/app/node_modules/json5');process.stdout.write(JSON.stringify("
            "J.parse(require('fs').readFileSync('/home/node/.openclaw/openclaw.json','utf8'))))")

def load_config(a, path):
    """Plain JSON, else JSON5 (comments, trailing commas) parsed by the gateway's own json5 inside
    its container, so the probe accepts what the runtime accepts (src/config/io.ts, #191 r5 F1)."""
    raw = open(path, encoding="utf-8").read()
    try:
        return json.loads(raw)
    except ValueError:
        pass
    r = subprocess.run(["docker", "exec", a + "-openclaw-gateway-1", "node", "-e", JSON5_JS],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise ValueError("json5 parse failed")
    return json.loads(r.stdout)

for a in sorted(running):
    base = os.path.join(AGENTS, a)
    try:
        cfg = load_config(a, os.path.join(base, "openclaw.json"))
    except Exception:
        out("CFGERR", a)
        continue
    out("AGENT", a)
    agents_cfg = cfg.get("agents") or {}
    if '"$include"' in json.dumps(cfg):
        out("INCLUDE", a)  # the effective config is assembled from other files: not modelled
        continue
    if "${" in json.dumps(agents_cfg):
        out("ENVREF", a)  # a ${VAR} in a model setting resolves only inside the gateway
    for path, ref in collect_model_refs(agents_cfg):  # only refs leave the host (I2)
        if "|" not in ref:
            out("REF", a, path, ref)
    if any(isinstance(e, dict) for e in (agents_cfg.get("list") or [])):
        # Several agents in one gateway: each may run on its own credentials and inherit models and
        # profiles from the main one (resolveDefaultModelForAgent, ensureAuthProfileStore). Not
        # modelled: its OpenAI/ChatGPT refs are reported unverified, never judged (#191 r3).
        out("MULTI", a)
        continue
    providers = (cfg.get("models") or {}).get("providers") or {}
    def custom_endpoint(provider, official):
        """A baseUrl the gateway sends this provider's credentials to, other than the official one:
        those credentials are never sent anywhere by this probe (#191 r4 F1)."""
        bu = str((providers.get(provider) or {}).get("baseUrl") or "").strip()
        host = bu.split("//", 1)[-1].split("/", 1)[0].lower()
        return bool(bu) and host != official
    own = envval(os.path.join(base, "docker.env"), "OPENAI_API_KEY")
    cfg_key = str((providers.get("openai") or {}).get("apiKey") or "").strip()
    # The single default agent, `main`: <state>/agents/main/agent (resolveAgentDir).
    try:
        store = json.load(open(os.path.join(base, "agents/main/agent/auth-profiles.json")))
    except Exception:
        store = {}
    # OpenAI credentials in the gateway's order (src/agents/model-auth.ts resolveApiKeyForProvider):
    # every usable `openai` profile in the configured order (it may fail over between them), else
    # the env key (the Agent's docker.env, else the host global), else a literal config apiKey.
    prof_keys = []
    for prof in ordered(store, cfg, "openai"):
        if prof.get("type") == "api_key":
            v = str(prof.get("key") or "").strip()
        elif prof.get("type") == "token" and not (isinstance(prof.get("expires"), (int, float)) and 0 < prof["expires"] <= now_ms):
            v = str(prof.get("token") or "").strip()
        else:
            v = ""
        if v and not v.startswith("${"):
            prof_keys.append(v)
    for prov, official in (("venice", "api.venice.ai"), ("openrouter", "openrouter.ai")):
        if custom_endpoint(prov, official):
            out("CUSTOM", a, prov)  # a private service: the public list says nothing about it (#191 r6 F2)
    if custom_endpoint("openai", "api.openai.com"):
        out("CUSTOM", a, "openai")
        cands = []
    elif prof_keys:
        cands = [(k, "profile") for k in prof_keys]
    elif own or gkey:
        cands = [(own, "own")] if own else [(gkey, "global")]
    elif cfg_key and not cfg_key.startswith("${"):
        cands = [(cfg_key, "config")]
    else:
        cands = []
    for k, src in cands:
        if src == "global" and fp(k) not in keys:
            out("GLOBALKEY", fp(k))
        keys[fp(k)] = k
        out("KEY", a, fp(k), src)
    codex_custom = custom_endpoint("openai-codex", "chatgpt.com")
    if codex_custom:
        out("CUSTOM", a, "openai-codex")
    for prof in ([] if codex_custom else ordered(store, cfg, "openai-codex")):
        if prof.get("type") != "oauth":
            continue
        if not (str(prof.get("access") or "").strip() or str(prof.get("refresh") or "").strip()):
            continue
        acc = str(prof.get("accountId") or "").strip()
        acct = fp(acc) if acc else "?"
        out("ACCT", a, acct)
        if acct == "?":
            continue
        accts_seen.add(acct)
        exp = prof.get("expires")
        tok = str(prof.get("access") or "").strip()
        # I1: only a token with more than 10 minutes left; never the refresh token, never a refresh.
        if tok and isinstance(exp, (int, float)) and exp - now_ms > 10 * 60 * 1000 and acct not in tokens:
            tokens[acct] = (tok, acc)

for keyfp, key in sorted(keys.items()):
    try:
        d = get("https://api.openai.com/v1/models", {"Authorization": "Bearer " + key})
        if paginated(d) or not isinstance(d.get("data"), list):
            out("UNVERIFIED", "openai", keyfp, "unexpected shape or a pagination marker")
            continue
        ids = [m.get("id") for m in d["data"] if isinstance(m, dict) and isinstance(m.get("id"), str)]
        for i in ids:
            out("LIST", "openai", keyfp, i)
        out("READ", "openai", keyfp, len(ids))
    except Exception as e:
        out("UNVERIFIED", "openai", keyfp, clean("%s" % (getattr(e, "code", "") or type(e).__name__)))

for acct in sorted(accts_seen):
    if acct not in tokens:
        out("UNVERIFIED", "openai-codex", acct, "no access token with more than 10 minutes left")
        continue
    tok, acc = tokens[acct]
    try:
        d = get("https://chatgpt.com/backend-api/codex/models?client_version=" + CODEX_CLIENT_VERSION, {
            "Authorization": "Bearer " + tok, "ChatGPT-Account-Id": acc,
            "originator": "codex_cli_rs", "User-Agent": "codex_cli_rs/" + CODEX_CLIENT_VERSION})
        if paginated(d) or not isinstance(d.get("models"), list):
            out("UNVERIFIED", "openai-codex", acct, "unexpected shape or a pagination marker")
            continue
        n = 0
        for m in d["models"]:
            if isinstance(m, dict) and m.get("visibility") == "list" and isinstance(m.get("slug"), str):
                cw = m.get("context_window")
                out("LIST", "openai-codex", acct, m["slug"], clean(m.get("display_name") or m["slug"]),
                    cw if isinstance(cw, int) and 0 < cw <= 10_000_000 else "")
                n += 1
        out("READ", "openai-codex", acct, n)
    except Exception as e:
        # One GET, no retry: a 401 is "unverified", never a reason to refresh (I1).
        out("UNVERIFIED", "openai-codex", acct, clean("%s" % (getattr(e, "code", "") or type(e).__name__)))
'''


# ── parsing the probe (I2: only known shapes survive) ────────────────────────────────────────

def parse_probe(host: str, stdout: str) -> dict:
    """The probe's lines → a host survey. Any line that is not exactly one of the known shapes, or
    whose fingerprint / id fields fail their pattern, is dropped and counted — never passed on."""
    s = {"host": host, "agents": {}, "keys": {}, "global_keys": set(), "accts": {}, "lists": {},
         "read": {}, "unverified": {}, "errors": [], "host_errors": [], "multi": set(), "custom": set(), "notes": [], "dropped": 0}
    for line in stdout.splitlines():
        f = line.split("|")
        t = f[0]
        try:
            if t == "AGENT" and len(f) == 2:
                s["agents"].setdefault(f[1], [])
            elif t == "REF" and len(f) == 4 and f[1] in s["agents"] and PATH_RE.match(f[2]) and REF_RE.match(f[3]):
                s["agents"][f[1]].append((f[2], f[3]))
            elif t == "KEY" and len(f) == 4 and FP_RE.match(f[2]) and f[3] in ("profile", "own", "global", "config"):
                s["keys"].setdefault(f[1], set()).add(f[2])
            elif t == "GLOBALKEY" and len(f) == 2 and FP_RE.match(f[1]):
                s["global_keys"].add(f[1])
            elif t == "ACCT" and len(f) == 3 and (FP_RE.match(f[2]) or f[2] == "?"):
                s["accts"].setdefault(f[1], set()).add(f[2])
            elif t == "MULTI" and len(f) == 2 and f[1] in s["agents"]:
                s["multi"].add(f[1])
            elif t in ("INCLUDE", "ENVREF") and len(f) == 2 and f[1] in s["agents"]:
                s["notes"].append((f[1], t))
            elif t == "CUSTOM" and len(f) == 3 and f[1] in s["agents"] and f[2] in ("openai", CODEX, "venice", "openrouter"):
                s["custom"].add((f[1], f[2]))
            elif t == "LIST" and len(f) == 4 and f[1] == "openai" and FP_RE.match(f[2]) and ID_RE.match(f[3]):
                s["lists"].setdefault(("openai", f[2]), []).append({"id": f[3]})
            elif t == "LIST" and len(f) == 6 and f[1] == CODEX and FP_RE.match(f[2]) and ID_RE.match(f[3]):
                e = {"id": f[3], "label": f[4][:80]}
                if f[5].isdigit() and 0 < int(f[5]) <= 10_000_000:
                    e["contextLength"] = int(f[5])
                s["lists"].setdefault((CODEX, f[2]), []).append(e)
            elif t == "READ" and len(f) == 4 and f[1] in ("openai", CODEX) and FP_RE.match(f[2]) and f[3].isdigit():
                s["read"][(f[1], f[2])] = int(f[3])
            elif t == "UNVERIFIED" and len(f) == 4 and f[1] in ("openai", CODEX) and FP_RE.match(f[2]):
                s["unverified"][(f[1], f[2])] = f[3][:120]
            elif t == "HOSTERR" and len(f) == 2:
                s["host_errors"].append(f[1][:120])
            elif t == "CFGERR" and len(f) == 2:
                s["errors"].append(f"openclaw.json unreadable for {f[1][:80]}")
            else:
                s["dropped"] += 1
        except ValueError:
            s["dropped"] += 1
    return s


def survey_host(host: str, timeout: int = 120) -> dict:
    try:
        r = subprocess.run(
            ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
             "-o", "StrictHostKeyChecking=accept-new", f"root@{HOSTS[host]}", "python3 -"],
            input=PROBE, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        s = parse_probe(host, "")
        s["host_errors"].append(f"timed out after {timeout}s")
        return s
    s = parse_probe(host, r.stdout)
    if r.returncode != 0:
        s["host_errors"].append(f"ssh exit {r.returncode}: {(r.stderr or '').strip()[-120:] or 'no output'}")
    return s


# ── the pure core ────────────────────────────────────────────────────────────────────────────

def collect_model_refs(agents: object) -> list[tuple[str, str]]:
    """(json path, ref) for every string under a model / primary / fallbacks / imageModel key in the
    `agents` subtree — the twin of collectModelRefs in the dashboard's lib/codex-model-lists.ts (I8).
    Strings without a provider/ prefix are skipped."""
    out: list[tuple[str, str]] = []

    def take(v, path):
        if isinstance(v, str):
            if REF_RE.match(v):
                out.append((path, v))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                take(x, f"{path}[{i}]")
        else:
            walk(v, path)

    def walk(v, path):
        if isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}[{i}]")
        elif isinstance(v, dict):
            for k, x in v.items():
                (take if k in MODEL_KEYS else walk)(x, f"{path}.{k}")

    walk(agents, "agents")
    return out


def is_primary(path: str) -> bool:
    """agents.defaults.model(.primary) or one agents.list[] entry's model(.primary)."""
    return bool(re.fullmatch(r"agents\.(defaults|list\[\d+\])\.model(\.primary)?", path))


def gate(ids: list[str] | None, prev: list[str] | None, provider: str) -> tuple[bool, str]:
    """I7: accept a list only if it has a usable entry and has not shrunk below half the last one."""
    if ids is None:
        return False, "not read"
    if not ids:
        why = "no usable entry"
        return False, why + (" — bump CODEX_CLIENT_VERSION in models-check.py" if provider == CODEX else "")
    if prev and len(ids) * 2 < len(prev):
        return False, f"list shrank from {len(prev)} to {len(ids)} — check by hand"
    return True, ""


def codex_verdict(model_id: str, accts: list[str], lists: dict, now_h: float = 0.0, fresh_h: float = 72.0) -> str:
    """The one rule, same as codexVerdict in the dashboard (I5, r3 F1). `lists` maps acct ->
    {"models": [ids], "ageHours": h}; an account missing from it was not read."""
    if not accts:
        return "unverified"
    if any(model_id in (lists.get(a) or {}).get("models", []) for a in accts):
        return "ok"
    if all(a in lists and now_h + lists[a].get("ageHours", 0) < fresh_h for a in accts):
        return "dead"
    return "unverified"


# The probe carries the same walker, so a model setting is read on the host and only refs travel.
PROBE = PROBE_HEAD + inspect.getsource(collect_model_refs) + PROBE_BODY


def any_serves(model_id: str, creds: list[tuple[str, str]], accepted: dict) -> str:
    """ok if any credential's accepted list has the id; dead only if every credential's list was
    accepted and none has it; else unverified. ChatGPT's codex_verdict is the same rule with ages."""
    if not creds:
        return "unverified"
    if any(model_id in {e["id"] for e in accepted.get(c, [])} for c in creds):
        return "ok"
    return "dead" if all(c in accepted for c in creds) else "unverified"


def lacking(model_id: str, creds: list[tuple[str, str]], accepted: dict) -> list[str]:
    """The credentials whose list was read and does NOT have the id. With "ok" from the rule above,
    a non-empty answer means only some of the Agent's credentials offer the model: the gateway may
    pick one that lacks it, and a model-not-found does not fail over (#191 r4 F2)."""
    return [c[1] for c in creds if c in accepted and model_id not in {e["id"] for e in accepted[c]}]


def read_public(url: str) -> tuple[list[str] | None, str]:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "agentglob-models-check"}),
                                    timeout=20) as r:
            d = json.loads(r.read().decode())
    except Exception as e:
        return None, f"{getattr(e, 'code', '') or type(e).__name__}"
    if not isinstance(d, dict) or not isinstance(d.get("data"), list) or any(d.get(k) for k in PAGINATION_KEYS):
        return None, "unexpected shape or a pagination marker"
    return [m["id"] for m in d["data"] if isinstance(m, dict) and isinstance(m.get("id"), str)], ""


def parse_curated(src: str) -> list[str] | None:
    """The `openai: ( [...] ).map` block of STATIC_MODELS in lib/model-availability.ts → bare ids.
    None when the block is not found or holds no id: the list could not be read (#191 r5 F3)."""
    m = re.search(r"\n  openai: \(\n(.*?)\n  \)\.map", src, re.S)
    ids = re.findall(r'\["openai/([^"]+)"', m.group(1)) if m else []
    return ids or None


def curated_openai_ids(dash_repo: str) -> list[str] | None:
    """STATIC_MODELS.openai ids from the dashboard's origin/main (never a work tree); None on failure."""
    try:
        r = subprocess.run(["git", "-C", dash_repo, "show", "origin/main:lib/model-availability.ts"],
                           capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    return parse_curated(r.stdout) if r.returncode == 0 else None


class Issue:
    def __init__(self, pri: str, host: str, agent: str, title: str, detail: str):
        self.pri, self.host, self.agent, self.title, self.detail = pri, host, agent, title, detail

    def line(self) -> str:
        f = [self.pri, self.host, self.agent, self.title, self.detail]
        return "ISSUE|" + "|".join(re.sub(r"[|\r\n]+", " ", x).strip() for x in f)


def analyse(surveys: list[dict], public: dict, state: dict, curated: list[str] | None):
    """→ (issues, report lines, ChatGPT lists to push {acct: entries}, new state)."""
    issues: list[Issue] = []
    new_state = dict(state)
    accepted: dict[tuple[str, str], list[dict]] = {}
    why_not: dict[tuple[str, str], str] = {}

    def judge(key, entries, reason=""):
        ids = None if entries is None else [e["id"] for e in entries]
        skey = f"{key[0]}:{key[1]}"
        ok, why = gate(ids, state.get(skey), key[0])
        if ok:
            accepted[key] = entries
            new_state[skey] = ids
        else:
            why_not[key] = reason or why

    for prov, (ids, err) in public.items():
        judge((prov, "-"), None if ids is None else [{"id": i} for i in ids], err)
    for s in surveys:
        for key in set(s["read"]) | set(s["unverified"]):
            # The same credential on two hosts: the first accepted list wins, and a later success
            # replaces an earlier failure (#191 r3 F3) — one host's 401 never hides another's read.
            if key in accepted:
                continue
            if key in s["unverified"]:
                why_not.setdefault(key, s["unverified"][key])
            elif len(s["lists"].get(key, [])) != s["read"][key]:
                why_not.setdefault(key, f"{s['read'][key]} entries read, {len(s['lists'].get(key, []))} parsed — lines dropped")
            else:
                why_not.pop(key, None)
                judge(key, s["lists"].get(key, []))
        for e in s["host_errors"]:
            # The whole server went unchecked — never a quiet "0 Agents" (#191 r1 F2).
            issues.append(Issue("P2", s["host"], "-", "Models check could not survey this server", e))
        for e in s["errors"]:
            issues.append(Issue("P3", s["host"], "-", "Models check probe problem", e))
        for agent, kind in s["notes"]:
            issues.append(Issue("P3", s["host"], agent, "Models not checked" if kind == "INCLUDE" else "Some model settings not checked",
                                "its openclaw.json uses $include, so the check does not know its effective models"
                                if kind == "INCLUDE" else
                                "a model setting uses ${…}, which only the gateway resolves; that setting is not checked"))
        if s["dropped"]:
            issues.append(Issue("P3", s["host"], "-", "Models check dropped probe lines",
                                f"{s['dropped']} line(s) did not match a known shape and were discarded (I2)."))

    codex_lists = {a: {"models": [e["id"] for e in v], "ageHours": 0}
                   for (p, a), v in accepted.items() if p == CODEX}
    dead = unverified_refs = checked = 0
    blocked_by: dict[tuple[str, str], set[str]] = {}
    for s in surveys:
        for agent, refs in sorted(s["agents"].items()):
            for path, ref in refs:
                prov, _, mid = ref.partition("/")
                accts = sorted(s["accts"].get(agent, set()))
                if agent in s["multi"] and prov in (CODEX, "openai"):
                    unverified_refs += 1
                    blocked_by.setdefault(("multi", agent), set()).add(agent)
                    continue
                if (agent, prov) in s["custom"]:
                    unverified_refs += 1
                    blocked_by.setdefault(("custom", f"{agent} {prov}"), set()).add(agent)
                    continue
                some = []
                if prov == CODEX:
                    v = codex_verdict(mid, accts, codex_lists)
                    if v == "ok":
                        some = lacking(mid, [(CODEX, a) for a in accts], accepted)
                    if v == "unverified":
                        for a in accts or ["none"]:
                            if a not in codex_lists:
                                blocked_by.setdefault((CODEX, a), set()).add(agent)
                elif prov == "openai":
                    # Same rule as ChatGPT: the gateway may use any of the Agent's OpenAI keys.
                    fps = sorted(s["keys"].get(agent, set()))
                    v = any_serves(mid, [("openai", k) for k in fps], accepted)
                    if v == "ok":
                        some = lacking(mid, [("openai", k) for k in fps], accepted)
                    if v == "unverified":
                        for k in fps or [""]:
                            if ("openai", k) not in accepted:
                                blocked_by.setdefault(("openai", k), set()).add(agent)
                elif prov in ("venice", "openrouter"):
                    key = (prov, "-")
                    if key in accepted:
                        v = "ok" if mid in {e["id"] for e in accepted[key]} else "dead"
                    else:
                        v = "unverified"
                        blocked_by.setdefault(key, set()).add(agent)
                else:
                    continue  # nvidia, anthropic, ...: no list we read
                checked += 1
                if some:
                    issues.append(Issue("P2", s["host"], agent, "Model offered by only some credentials",
                                        f"{ref} at {path}: {len(some)} of this Agent's {prov} credentials do not "
                                        f"offer it, and the gateway may use one of them — pick a model all of them "
                                        f"offer, or remove the credential that lacks it."))
                if v == "dead":
                    dead += 1
                    pri = "P1" if is_primary(path) else "P2"
                    what = "primary model" if pri == "P1" else f"model at {path}"
                    issues.append(Issue(pri, s["host"], agent, "Model no longer offered",
                                        f"{what} {ref} is no longer offered by {prov} for this Agent's "
                                        f"credential — pick another in the Agent's LLM Models card."))
                elif v == "unverified":
                    unverified_refs += 1

    for key, agents in sorted(blocked_by.items()):
        if key[0] == "custom":
            issues.append(Issue("P3", "models", key[1].split()[0], "Models on a custom endpoint not checked",
                                f"{key[1]}: this Agent sends these models to its own baseUrl, so the check never "
                                f"sends that credential anywhere and does not judge them."))
            continue
        if key[0] == "multi":
            issues.append(Issue("P3", "models", key[1], "OpenAI/ChatGPT models not checked",
                                "this Agent defines several agents (agents.list), each with its own credentials; "
                                "the models check does not model that, so these models were not judged."))
            continue
        why = why_not.get(key) or NO_CREDENTIAL.get(key, "not read")
        label = "ChatGPT account" if key[0] == CODEX else f"{key[0]} list"
        cred = f" {key[1]}" if key[1] not in ("-", "") else ""
        issues.append(Issue("P3", "models", "-", f"Could not check a {label}",
                            f"{label}{cred}: {why}. Agents not checked: {', '.join(sorted(agents))}."))

    # The curated OpenAI list (r2 F1, r3 F3): remove only when NO effective key serves it.
    eff = sorted({k for s in surveys for k in set().union(*s["keys"].values(), s["global_keys"]) if k})
    eff_lists = [{e["id"] for e in accepted[("openai", k)]} for k in eff if ("openai", k) in accepted]
    all_read = bool(eff) and len(eff_lists) == len(eff)
    if curated is None:
        issues.append(Issue("P2", "models", "-", "Dashboard OpenAI list not read",
                            "STATIC_MODELS.openai could not be read from the dashboard's origin/main "
                            "lib/model-availability.ts (git failed, or the list moved or changed shape), so "
                            "its OpenAI models were not checked — update parse_curated in models-check.py."))
    for mid in curated or []:
        if any(mid in l for l in eff_lists):
            continue
        if all_read:
            issues.append(Issue("P2", "models", "-", "Dashboard offers a retired OpenAI model",
                                f"openai/{mid} is served by none of the {len(eff)} OpenAI keys in use — "
                                f"remove it from STATIC_MODELS.openai in lib/model-availability.ts."))
        elif eff:
            issues.append(Issue("P3", "models", "-", "Could not confirm a dashboard OpenAI model",
                                f"openai/{mid} is not in any OpenAI list that was read, but "
                                f"{len(eff) - len(eff_lists)} key(s) could not be checked — no edit suggested."))

    push = {a: v for (p, a), v in accepted.items() if p == CODEX}
    lines = [f"Models check — {len(surveys)} server(s), {sum(len(s['agents']) for s in surveys)} running Agents, "
             f"{checked} model settings checked: {dead} no longer offered, {unverified_refs} not verifiable.",
             f"Lists read: {len(accepted)} accepted, {len(why_not)} not; ChatGPT accounts to push: {len(push)}.",
             *(f"  not read: {p} {c}: {w}" for (p, c), w in sorted(why_not.items()))]
    return issues, lines, push, new_state


def post_lists(push: dict, secret: str) -> str:
    """POST in chunks of 50 accounts; '' on success, else the reason."""
    accts = sorted(push)
    for i in range(0, len(accts), MAX_PUSH_ACCOUNTS):
        body = {CODEX: {a: push[a] for a in accts[i:i + MAX_PUSH_ACCOUNTS]}}
        req = urllib.request.Request(DASH_URL + "/api/cron/model-lists", data=json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"},
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if r.status != 200:
                    return f"HTTP {r.status}"
        except Exception as e:
            return f"{getattr(e, 'code', '') or type(e).__name__}"
    return ""


def write(path: str, text: str) -> None:
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--report", required=True)
    ap.add_argument("--issues", required=True)
    ap.add_argument("--state", required=True, help="JSON: the last accepted list per (provider, credential)")
    ap.add_argument("--hosts", default="eu,us,dev,team1")
    ap.add_argument("--dash-repo", default="/root/AgentGlob_Apps/openclaw-dashboard")
    ap.add_argument("--no-post", action="store_true")
    a = ap.parse_args(argv)
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    state = {}
    if os.path.exists(a.state):
        try:
            with open(a.state, encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError):
            state = {}  # a broken state file only disables the shrink check for one day
    hosts = [h for h in a.hosts.split(",") if h in HOSTS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(hosts) + 2) as ex:
        surveys_f = [ex.submit(survey_host, h) for h in hosts]
        venice_f = ex.submit(read_public, VENICE_URL)
        openrouter_f = ex.submit(read_public, OPENROUTER_URL)
        surveys = [f.result() for f in surveys_f]
        public = {"venice": venice_f.result(), "openrouter": openrouter_f.result()}
    issues, lines, push, new_state = analyse(surveys, public, state, curated_openai_ids(a.dash_repo))

    if push and not a.no_post:
        secret = os.environ.get("CRON_SECRET", "")
        err = post_lists(push, secret) if secret else "CRON_SECRET not set"
        if err:
            issues.append(Issue("P2", "models", "-", "Model lists not delivered to the dashboard",
                                f"POST /api/cron/model-lists failed ({err}); the picker keeps its last lists."))
        else:
            lines.append(f"Delivered {len(push)} ChatGPT account list(s) to the dashboard.")
    write(a.state, json.dumps(new_state, indent=1, sort_keys=True))
    write(a.issues, "".join(i.line() + "\n" for i in issues))
    report = [f"Models check — {today}", *lines, *(f"  {i.pri} {i.host}/{i.agent}: {i.title} — {i.detail}" for i in issues)]
    write(a.report, "\n".join(report) + "\n")
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())

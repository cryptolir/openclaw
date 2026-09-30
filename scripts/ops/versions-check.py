#!/usr/bin/env python3
"""versions-check — is every runtime component on its Target (daily), and is each Target current (weekly)?

Targets live in the "Pinned versions" table of the dashboard's docs/DEPENDENCIES.md, one row per
component (ID, Target, Hold until, Note). This script reads what every server and running container
actually has (over SSH), what the stable gateway image contains (a local copy on the dev server), and
the newest upstream version of each component. What runs is read on every run (daily, from the 05:45
dependency audit), so a fix or a hold shows the next morning; the newest upstream versions are looked
up once a week (Mondays, or when a cached one is over 7 days old; see --latest-cache). It writes two
files that deps-audit-cron.sh passes on
to the 06:00 diagnostic: a report for the email and ISSUE|… lines for the AUTOSCAN block of
bug_list.md. The human decision happens there: update, roll or promote, or hold the row (Hold until
+ Note), which drops its findings to P3 until that date.

Read-only everywhere: `docker ps`, `docker exec <version command>`, `apt-get -s` (a simulation), and
one `docker run --rm --network none` of the stable image on the dev server.

    versions-check.py --doc DEPENDENCIES.md --report R --issues I [--latest-cache C] [--hosts eu,us,dev] [--no-latest]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request

# ponytail: same map as agents_server_diagnostic.sh host_ip(); one more host means one more line in both.
HOSTS = {"eu": "89.167.70.46", "us": "5.161.84.219", "dev": "204.168.223.245"}
REGISTRY = "europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway"
SSH_KEY = os.environ.get("SSH_KEY", os.path.expanduser("~/.ssh/hetzner-openclaw"))

# Components read from inside a gateway image (they move with the image tag, so they are compared
# with the stable image and with upstream, never agent by agent).
IMAGE_KEYS = ("openclaw", "node", "playwright", "chrome", "python")
# Every row this script knows how to check. A doc row outside this set is reported, and so is a
# missing one: a component must never drop out of the check silently.
KNOWN = ("gateway-image", *IMAGE_KEYS, "hermes", "sidecar-chromium", "docker", "compose", "host-security")

# Runs inside a gateway container (docker exec) or the stable image (docker run). No quotes survive
# to the caller: each value is `key=<command output>;`.
IMAGE_PROBE = r"""cd /app 2>/dev/null
printf 'node=%s;' "$(node --version 2>/dev/null)"
printf 'openclaw=%s;' "$(node -p 'require("/app/package.json").version' 2>/dev/null)"
printf 'playwright=%s;' "$(node -p 'require("playwright-core/package.json").version' 2>/dev/null)"
printf 'chrome=%s;' "$(for c in /opt/pw-browsers/chromium-*/chrome-linux64/chrome; do "$c" --version; done 2>/dev/null | head -1)"
printf 'python=%s' "$(python3 --version 2>&1 | head -1)"
"""

# Runs on each server as root. One line per fact; nothing is written anywhere.
HOST_PROBE = r"""set -u
echo "HOST|docker|$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
echo "HOST|compose|$(docker compose version --short 2>/dev/null)"
echo "HOST|os|$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-}")"
if up=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null); then
  echo "HOST|security_updates|$(printf '%s\n' "$up" | grep -c '^Inst .*-security')"
else
  echo "HOST|security_updates|error"  # a broken apt must not read as "0 pending"
fi
echo "HOST|reboot_required|$([ -f /var/run/reboot-required ] && echo yes || echo no)"
IMG_PROBE=$(cat <<'PROBE'
""" + IMAGE_PROBE + r"""PROBE
)
seen=" "
docker ps --format '{{.Names}}|{{.Image}}|{{.Label "com.docker.compose.service"}}|{{.Label "agentglob.sidecar-of"}}' | sort | while IFS='|' read -r n img svc side; do
  if [ "$svc" = openclaw-gateway ]; then
    echo "AGENT|openclaw|$n|$img|"
    case "$seen" in *" $img "*) ;; *) seen="$seen$img "; echo "IMAGE|$img|$(docker exec "$n" sh -c "$IMG_PROBE" 2>/dev/null | tr -d '\n|')";; esac
  elif [ "$svc" = hermes-gateway ]; then
    echo "AGENT|hermes|$n|$img|$(docker exec "$n" hermes --version 2>/dev/null | head -1 | tr -d '|')"
  elif [ -n "$side" ]; then
    echo "AGENT|sidecar|$n|$img|$(docker exec "$n" chromium --version 2>/dev/null | head -1 | tr -d '|')"
  fi
done
"""


# ── versions ──────────────────────────────────────────────────────────────────────────────────────

def nums(v: str | None) -> tuple[int, ...]:
    """'v2026.09.09.1' -> (2026, 9, 9, 1); 'Hermes Agent v0.20.4 (2026.8.18)' -> (2026, 8, 18)."""
    if not v:
        return ()
    dated = re.search(r"\((\d{4}\.\d+\.\d+)\)", v)  # Hermes reports its release date in brackets
    m = re.search(r"\d+(?:\.\d+)*", dated.group(1) if dated else v)
    return tuple(int(x) for x in m.group(0).split(".")) if m else ()


def clean(v: str | None) -> str:
    """The version part of a command's output, for the report: 'Google Chrome for Testing 145.0' -> '145.0'."""
    if not v:
        return ""
    dated = re.search(r"\((\d{4}\.\d+\.\d+)\)", v)
    if dated:
        return dated.group(1)
    m = re.search(r"v?\d+(?:\.\d+)*", v.strip())
    return m.group(0) if m else v.strip()


def cmp(a: str | None, b: str | None) -> int | None:
    """-1 / 0 / 1, or None when either side has no version."""
    x, y = nums(a), nums(b)
    if not x or not y:
        return None
    n = max(len(x), len(y))
    x, y = x + (0,) * (n - len(x)), y + (0,) * (n - len(y))
    return (x > y) - (x < y)


def gap(target: str, latest: str) -> str | None:
    """How far `latest` is ahead of `target`: 'major', 'minor', 'patch', or None when it is not."""
    if cmp(latest, target) != 1:
        return None
    t, l = nums(target), nums(latest)
    n = max(len(t), len(l), 3)
    t, l = t + (0,) * (n - len(t)), l + (0,) * (n - len(l))
    return "major" if l[0] > t[0] else "minor" if l[1] > t[1] else "patch"


def image_tag(ref: str) -> str:
    """'europe-west1-docker.pkg.dev/…/gateway:v2026.9.1.1' -> 'v2026.9.1.1'. '' for a digest (…@sha256:…)
    or no tag."""
    last = ref.rsplit("/", 1)[-1]
    if "@" in last:
        return ""
    return last.split(":", 1)[1] if ":" in last else ""


def version_tag(ref: str) -> str:
    """The image's tag when it is a version (v2026.9.1.1), else '' (latest, pr-123, a digest): those are
    listed in the report, never compared."""
    t = image_tag(ref)
    return t if re.fullmatch(r"v?\d+(\.\d+)+", t) else ""


# ── the pins table ────────────────────────────────────────────────────────────────────────────────

def real_date(s: str) -> bool:
    """'2026-12-01' yes; '2026-02-30', 'next week' no."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return False
    return True


@dataclasses.dataclass
class Pin:
    id: str
    target: str
    hold: str = ""
    note: str = ""


def parse_pins(doc: str) -> dict[str, Pin]:
    """The table under '## Pinned versions'. Columns are found by header name, so their order is free.
    Raises ValueError with the reason when the table is missing or a row cannot be read."""
    m = re.search(r"^## Pinned versions.*?$(.*?)(?=^## |\Z)", doc, re.M | re.S)
    if not m:
        raise ValueError('no "## Pinned versions" section')
    tables: list[list[str]] = [[]]  # the section may hold other tables (priorities); take the one with an ID column
    for l in m.group(1).splitlines():
        if l.strip().startswith("|"):
            tables[-1].append(l.strip())
        elif tables[-1]:
            tables.append([])
    lines = next((t for t in tables if t and re.search(r"\|\s*ID\s*\|", t[0], re.I)), [])
    if len(lines) < 3:
        raise ValueError("the Pinned versions section has no table with an ID column and rows")
    def cells(line: str) -> list[str]:  # split on | but not on an escaped \\|
        return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]

    head = [c.lower() for c in cells(lines[0])]
    try:
        ci, ct, ch, cn = (head.index(k) for k in ("id", "target", "hold until", "note"))
    except ValueError:
        raise ValueError(f"the table needs the columns ID, Target, Hold until and Note (has: {', '.join(head)})")
    pins: dict[str, Pin] = {}
    for line in lines[2:]:
        row = cells(line)
        if len(row) != len(head):
            raise ValueError(f"row has {len(row)} cells, header has {len(head)}: {line[:80]}")
        pid, target, hold = (row[i].strip("`* ") for i in (ci, ct, ch))
        if not re.fullmatch(r"[a-z0-9-]+", pid) or not target:
            raise ValueError(f"row needs an ID (lowercase-hyphen) and a Target: {line[:80]}")
        if hold and not real_date(hold):
            raise ValueError(f"{pid}: Hold until must be a real date, YYYY-MM-DD, not {hold!r}")
        pins[pid] = Pin(pid, target, hold, row[cn])
    return pins


# ── reading the servers ───────────────────────────────────────────────────────────────────────────

@dataclasses.dataclass
class Survey:
    host: str
    facts: dict[str, str] = dataclasses.field(default_factory=dict)
    agents: list[tuple[str, str, str, str]] = dataclasses.field(default_factory=list)  # kind, name, image, version
    images: dict[str, dict[str, str]] = dataclasses.field(default_factory=dict)       # image ref -> component -> version
    error: str = ""


def parse_kv(s: str) -> dict[str, str]:
    """'node=v24.20.0;openclaw=2026.2.19;…' -> {'node': 'v24.20.0', …}."""
    out = {}
    for part in s.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def parse_probe(host: str, stdout: str) -> Survey:
    s = Survey(host)
    for line in stdout.splitlines():
        f = line.split("|")
        if f[0] == "HOST" and len(f) >= 3:
            s.facts[f[1]] = "|".join(f[2:]).strip()
        elif f[0] == "AGENT" and len(f) >= 5:
            s.agents.append((f[1], f[2], f[3], f[4].strip()))
        elif f[0] == "IMAGE" and len(f) >= 3:
            s.images[f[1]] = parse_kv(f[2])
    if not s.facts and not s.agents:
        s.error = "no answer"
    return s


def survey_host(host: str, timeout: int = 150) -> Survey:
    ip = HOSTS[host]
    try:
        r = subprocess.run(
            ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes",
             "-o", "StrictHostKeyChecking=accept-new", f"root@{ip}", "bash -s"],
            input=HOST_PROBE, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return Survey(host, error=f"timed out after {timeout}s")
    s = parse_probe(host, r.stdout)
    if s.error:
        s.error = f"ssh exit {r.returncode}: {(r.stderr or '').strip()[:120] or 'no output'}"
    return s


def probe_stable_image(tag: str) -> tuple[str, dict[str, str]]:
    """The stable image's components, from a local copy on this (dev) server. ('', {}) when none."""
    try:
        refs = subprocess.run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
                              capture_output=True, text=True, timeout=30).stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        return "", {}
    local = sorted((r for r in refs if image_tag(r) == tag), key=lambda r: not r.startswith(REGISTRY))
    if not local:
        return "", {}
    try:
        out = subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "sh", local[0],
                              "-c", IMAGE_PROBE], capture_output=True, text=True, timeout=120).stdout
    except subprocess.TimeoutExpired:
        return local[0], {}
    return local[0], parse_kv(out.replace("\n", ""))


# ── upstream ──────────────────────────────────────────────────────────────────────────────────────

@dataclasses.dataclass
class Latest:
    version: str = ""
    security: bool = False  # a newer release is marked as a security release by its publisher
    note: str = ""
    error: str = ""
    at: str = ""        # the day it was looked up (the weekly cache)
    target: str = ""    # the Target it was judged against (node's security flag depends on it)


LATEST_EVERY_DAYS = 7  # a cached upstream answer is asked again after this many days (and every Monday)
LATEST_KEEP_DAYS = 8   # …and still used, while a new lookup fails, up to this age


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "agentglob-versions-check",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode()


def latest_node(target: str) -> Latest:
    rel = json.loads(_get("https://nodejs.org/dist/index.json"))
    major = nums(target)[:1]
    line = [r for r in rel if nums(r["version"])[:1] == major]
    newest = max(line, key=lambda r: nums(r["version"]))["version"].lstrip("v")
    security = any(r.get("security") and cmp(r["version"], target) == 1 for r in line)
    lts = max((nums(r["version"])[0] for r in rel if r.get("lts")), default=0)
    note = f"Node {lts} is the newest LTS line." if major and lts > major[0] else ""
    return Latest(newest, security, note)


def latest_npm(pkg: str) -> Latest:
    return Latest(json.loads(_get(f"https://registry.npmjs.org/{pkg}/latest"))["version"])


def latest_github(repo: str) -> Latest:
    return Latest(json.loads(_get(f"https://api.github.com/repos/{repo}/releases/latest"))["tag_name"].lstrip("v"))


def latest_chrome() -> Latest:
    return Latest(json.loads(_get(
        "https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions"))["versions"][0]["version"])


def latest_docker() -> Latest:
    found = re.findall(r"docker-(\d+\.\d+\.\d+)\.tgz", _get("https://download.docker.com/linux/static/stable/x86_64/"))
    return Latest(max(found, key=nums))


def latest_registry() -> Latest:
    out = subprocess.run(["gcloud", "artifacts", "docker", "tags", "list", REGISTRY, "--format=value(tag)",
                          "--limit=1000"], capture_output=True, text=True, timeout=90).stdout.split()
    tags = [t for t in out if re.fullmatch(r"v\d+(\.\d+)+", t)]
    if not tags:
        raise RuntimeError("no version tags listed")
    return Latest(max(tags, key=nums))


def fetch_latest(pins: dict[str, Pin], only: list[str] | None = None) -> dict[str, Latest]:
    """Newest upstream version per row that has one (python and host-security have none)."""
    jobs = {
        "gateway-image": latest_registry,
        "openclaw": lambda: latest_github("openclaw/openclaw"),
        "node": lambda: latest_node(pins["node"].target) if "node" in pins else Latest(error="no node row"),
        "playwright": lambda: latest_npm("playwright-core"),
        "chrome": latest_chrome,
        "hermes": lambda: latest_github("NousResearch/hermes-agent"),
        "sidecar-chromium": latest_chrome,
        "docker": latest_docker,
        "compose": lambda: latest_github("docker/compose"),
    }
    if only is not None:
        jobs = {k: f for k, f in jobs.items() if k in only}
    if not jobs:
        return {}
    out: dict[str, Latest] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        for k, f in futs.items():
            try:
                out[k] = f.result(timeout=100)
            except Exception as e:  # one dead source must not hide the other rows
                out[k] = Latest(error=f"{type(e).__name__}: {str(e)[:100]}")
    return out


LATEST_SOURCES = ("gateway-image", "openclaw", "node", "playwright", "chrome", "hermes", "sidecar-chromium",
                  "docker", "compose")


def resolve_latest(pins: dict[str, Pin], cache: dict, today: datetime.date,
                   fetch=fetch_latest) -> tuple[dict[str, Latest], dict]:
    """The weekly part: every source is asked again on a Monday (once that day), and on other days
    only a source whose cached answer is missing, over 7 days old, or judged against a Target that
    has since changed. A failed lookup keeps a cached answer up to 8 days old and is retried the next
    day. Returns (answers, new cache)."""
    def age(c: dict | None) -> int | None:
        try:
            return (today - datetime.date.fromisoformat(c["at"])).days if c else None
        except (KeyError, TypeError, ValueError):
            return None

    def due(k: str) -> bool:
        c, a = cache.get(k), age(cache.get(k))
        if a is None or a >= LATEST_EVERY_DAYS or (today.weekday() == 0 and a != 0):
            return True
        return k in pins and c.get("target", "") != pins[k].target

    fetched = fetch(pins, [k for k in LATEST_SOURCES if due(k)])
    out: dict[str, Latest] = {}
    new_cache = dict(cache)
    for k in LATEST_SOURCES:
        f, c = fetched.get(k), cache.get(k)
        if f is not None and not f.error:
            f.at, f.target = today.isoformat(), pins[k].target if k in pins else ""
            out[k] = f
            new_cache[k] = dataclasses.asdict(f)
        elif c and (age(c) or 0) <= LATEST_KEEP_DAYS:
            known = {f.name for f in dataclasses.fields(Latest)}
            out[k] = Latest(**{x: v for x, v in c.items() if x in known and x != "error"})  # not due, or the lookup failed
        else:
            out[k] = f if f is not None else Latest(error="not looked up")
    return out, new_cache


# ── findings ──────────────────────────────────────────────────────────────────────────────────────

@dataclasses.dataclass
class Issue:
    pri: str
    host: str
    agent: str
    title: str
    detail: str
    row: str = ""  # the pins row it belongs to, for holds

    def line(self) -> str:
        f = [self.pri, self.host, self.agent, self.title, self.detail]
        return "ISSUE|" + "|".join(re.sub(r"[|\r\n]+", " ", x).strip() for x in f)


HOLD_HOW = "hold it in docs/DEPENDENCIES.md (Hold until + Note)"
# What "update" means differs by where a component lives.
_IMAGE_HOW = "update the pin in the fork, build a gateway image, pilot it on one Agent, then promote it"
_HOST_HOW = ("upgrade it on each server in a quiet hour (a Docker upgrade restarts every Agent on that server), "
             "then raise the Target")
UPDATE_HOW = {
    "gateway-image": "pilot it on one Agent, then promote it (Platform, Releases)",
    **{k: _IMAGE_HOW for k in IMAGE_KEYS},
    "chrome": "update Playwright (Chrome comes with it), build a gateway image, pilot it on one Agent, then promote it",
    "hermes": "rebuild hermes-agent on the new release, pilot it on one Hermes Agent, then roll",
    "sidecar-chromium": "rebuild the sidecar image (it takes Debian's current Chromium), then re-run the Agent's provisioning",
    "docker": _HOST_HOW,
    "compose": _HOST_HOW,
}


def months_apart(target: str, latest: str) -> int | None:
    """For date versions (2026.2.19 -> 2026.9.7): whole months between them; None for other versions."""
    t, l = nums(target), nums(latest)
    if len(t) < 2 or len(l) < 2 or t[0] < 2000:
        return None
    return (l[0] - t[0]) * 12 + (l[1] - t[1])


def names(xs: list[str], limit: int = 8) -> str:
    short = [x.replace("-openclaw-gateway-1", "").replace("-hermes-gateway-1", "") for x in xs]
    return ", ".join(short[:limit]) + (f" and {len(short) - limit} more" if len(short) > limit else "")


def analyse(pins: dict[str, Pin], surveys: list[Survey], stable: tuple[str, dict[str, str]] | None,
            latest: dict[str, Latest] | None, today: datetime.date) -> tuple[list[Issue], list[str]]:
    issues: list[Issue] = []
    add = issues.append

    for pid in pins:
        if pid not in KNOWN:
            add(Issue("P3", "versions", "-", f"No check for the {pid} row",
                      f"docs/DEPENDENCIES.md has a Pinned versions row {pid!r} that versions-check.py does not know. "
                      "Add a detector and a latest-version source for it, or remove the row.", pid))
    for pid in KNOWN:
        if pid not in pins:
            add(Issue("P3", "versions", "-", f"No Pinned versions row for {pid}",
                      f"versions-check.py checks {pid} but docs/DEPENDENCIES.md has no row for it, so it has no Target. "
                      "Add the row.", pid))

    def target(pid: str) -> str:
        return pins[pid].target if pid in pins else ""

    # 1. What runs, against the Target (agents, sidecars, servers).
    gw = target("gateway-image")
    for s in surveys:
        if s.error:
            add(Issue("P3", s.host, "-", "Versions not read", f"The version survey could not read {s.host}: {s.error}.", ""))
            continue
        behind: dict[str, list[str]] = {}
        for kind, name, image, ver in s.agents:
            if kind == "openclaw" and gw and version_tag(image) and cmp(version_tag(image), gw) == -1:
                behind.setdefault(version_tag(image), []).append(name)
        if behind:
            n = sum(len(v) for v in behind.values())
            groups = "; ".join(f"{t}: {names(v)} ({len(v)})" for t, v in sorted(behind.items(), key=lambda kv: nums(kv[0])))
            # Not deploy.sh: it rolls EVERY Agent on a server, pilots and stopped ones included.
            add(Issue("P2", s.host, f"{n} agents", "Agents on an older gateway image than the stable release",
                      f"Stable is {gw}. {groups}. Decide: upgrade them one at a time from the dashboard "
                      "(each Agent's Upgrade moves it to the latest stable, under its deploy lock), or "
                      f"{HOLD_HOW}.", "gateway-image"))
        for kind, pid, label in (("hermes", "hermes", "Hermes"), ("sidecar", "sidecar-chromium", "sidecar Chromium")):
            old = [name for k, name, _i, ver in s.agents if k == kind and target(pid) and cmp(ver, target(pid)) == -1]
            if old:
                add(Issue("P2", s.host, f"{len(old)} agents", f"Older {label} than the Target",
                          f"Target {target(pid)}. Behind: {names(old)}. Decide: rebuild and restart them, or {HOLD_HOW}.", pid))
        for pid, key in (("docker", "docker"), ("compose", "compose")):
            have = s.facts.get(key, "")
            if target(pid) and have and cmp(have, target(pid)) == -1:
                add(Issue("P2", s.host, "-", f"{pid.capitalize()} older than the Target",
                          f"{s.host} has {have}, Target {target(pid)}. Decide: upgrade the package on {s.host}, or {HOLD_HOW}.", pid))
        sec_s = s.facts.get("security_updates", "")
        if sec_s == "error":
            add(Issue("P3", s.host, "-", "Pending updates not read",
                      f"apt-get -s dist-upgrade failed on {s.host} (a broken apt state or unmet dependencies), so its "
                      f"security updates could not be counted. Check apt on {s.host}.", "host-security"))
        sec = int(sec_s) if sec_s.isdigit() else 0
        if sec:
            add(Issue("P2", s.host, "-", "Security updates pending",
                      f"{sec} security update(s) not installed on {s.host} (apt-get -s dist-upgrade). Decide: apt-get upgrade "
                      f"in a quiet hour, or {HOLD_HOW}.", "host-security"))
        if s.facts.get("reboot_required") == "yes":
            add(Issue("P3", s.host, "-", "Reboot pending",
                      f"{s.host} has installed updates that need a reboot (/var/run/reboot-required). Every Agent there "
                      "restarts with it. Decide when, or " + HOLD_HOW + ".", "host-security"))

    # 2. The stable image against the Targets of the image rows (keeps this doc true).
    if stable is not None and gw:
        ref, have = stable
        if not have:
            add(Issue("P3", "versions", "-", "Stable image contents not read",
                      f"No usable local copy of {gw} on the dev server, so the image rows could not be compared with it."
                      " Their Targets are compared with upstream only.", ""))
        for pid in IMAGE_KEYS:
            if have and target(pid) and not clean(have.get(pid)):
                add(Issue("P3", "versions", "-", f"The stable image has no {pid}",
                          f"{gw} reports no {pid}; the row says {target(pid)}. Whatever needs it on an Agent "
                          "(for chrome: the browser tool) fails there. Rebuild the image with it, or correct the row.", pid))
            elif have and target(pid) and cmp(have.get(pid), target(pid)) not in (0, None):
                add(Issue("P3", "versions", "-", f"DEPENDENCIES.md {pid} Target differs from the stable image",
                          f"The row says {target(pid)}; {gw} contains {clean(have.get(pid))}. Correct the row.", pid))

    # 3. Each Target against the newest upstream release.
    for pid, lat in (latest or {}).items():
        if pid not in pins:
            continue
        if lat.error:
            add(Issue("P3", "versions", "-", f"Latest {pid} not read", f"Could not read the newest {pid}: {lat.error}.", pid))
            continue
        if pid == "node" and lat.note:  # a newer LTS line is its own decision (a major upgrade)
            add(Issue("P3", "versions", "-", "Newer Node LTS line", f"{lat.note} Target {pins[pid].target}. "
                      f"Decide: plan the move (base image in the fork's Dockerfile), or {HOLD_HOW}.", pid))
        g = gap(pins[pid].target, lat.version)
        if not g:
            continue
        pri = {"major": "P2", "minor": "P2", "patch": "P3"}[g]
        why = f"a {g} version behind"
        months = months_apart(pins[pid].target, lat.version)
        if months is not None:  # date versions: say how old, and 3 months is where it starts to matter
            pri = "P2" if months >= 3 else "P3"
            why = f"about {months} months newer" if months > 1 else "a newer release"
        if lat.security:
            pri, why = "P1", "a SECURITY release is available"
        if pid in ("chrome", "sidecar-chromium"):
            majors = nums(lat.version)[0] - nums(pins[pid].target)[0]
            if majors >= 2:
                pri, why = "P1", f"{majors} major versions behind Chrome stable (security fixes missing)"
        what = "Newer gateway image than the stable release" if pid == "gateway-image" else f"{pid} update available"
        how = UPDATE_HOW.get(pid, "update it, pilot it on one Agent, then roll")
        add(Issue(pri, "versions", "-", what,
                  f"Target {pins[pid].target}, newest {lat.version}: {why}. Decide: {how}, or {HOLD_HOW}.", pid))

    # Holds: a held row's findings drop to P3 and carry the decision, until the date passes.
    for i in issues:
        p = pins.get(i.row)
        if p and p.hold and today <= datetime.date.fromisoformat(p.hold):
            i.pri, i.title = "P3", f"(held) {i.title}"
            i.detail += f" Held until {p.hold}: {p.note or 'no reason given'}."
    issues.sort(key=lambda i: (i.pri, i.host, i.title))
    return issues, report(pins, surveys, stable, latest or {}, issues, today)


def report(pins, surveys, stable, latest, issues, today) -> list[str]:
    out = [f"Version check — {today.isoformat()} (Targets from docs/DEPENDENCIES.md, Pinned versions)",
           "Servers and containers: read today. Newest versions: looked up weekly (Mondays); 'as of' is the lookup day.", ""]
    out.append(f"{'component':17} {'target':15} {'newest':15} {'as of':11} {'hold':11} status")
    for pid in KNOWN:
        if pid not in pins:
            continue
        lat = latest.get(pid)
        newest = "-" if lat is None else ("?" if lat.error else lat.version)
        asof = (lat.at or "-") if lat is not None and not lat.error else "-"
        mine = [i for i in issues if i.row == pid and i.host == "versions"]
        status = ", ".join(f"{i.pri} {i.title}" for i in mine) or "ok"
        out.append(f"{pid:17} {pins[pid].target:15} {newest:15} {asof:11} {pins[pid].hold or '-':11} {status}")
    out += ["", "Agents by gateway image (behind / at / ahead of the stable release):"]
    gw = pins.get("gateway-image").target if "gateway-image" in pins else ""
    for s in surveys:
        if s.error:
            out.append(f"  {s.host}: not read ({s.error})")
            continue
        count: dict[str, int] = {}
        for kind, _n, image, _v in s.agents:
            if kind == "openclaw":
                key = version_tag(image) or f"{image} (unversioned)"
                count[key] = count.get(key, 0) + 1
        mark = {-1: "behind", 0: "stable", 1: "ahead"}
        parts = [f"{t} ×{c}" + (f" ({mark.get(cmp(t, gw), '?')})" if "(unversioned)" not in t else "")
                 for t, c in sorted(count.items(), key=lambda kv: nums(kv[0]))]
        out.append(f"  {s.host}: " + ("; ".join(parts) or "no OpenClaw Agents"))
        for kind, n, _i, v in s.agents:
            if kind in ("hermes", "sidecar"):
                out.append(f"    {kind} {n}: {clean(v) or '?'}")
    out += ["", "Image contents (what running containers report, per image):"]
    seen = set()
    for s in surveys:
        for ref, comp in s.images.items():
            if ref in seen:
                continue
            seen.add(ref)
            out.append(f"  {image_tag(ref) or ref}: " + " · ".join(f"{k} {clean(comp.get(k)) or 'none'}" for k in IMAGE_KEYS))
    if stable:
        ref, have = stable
        out.append(f"  stable {gw} (local copy {ref or 'none'}): "
                   + (" · ".join(f"{k} {clean(have.get(k)) or 'none'}" for k in IMAGE_KEYS) if have else "not read"))
    out += ["", "Servers:"]
    for s in surveys:
        if not s.error:
            f = s.facts
            out.append(f"  {s.host}: docker {f.get('docker', '?')} · compose {f.get('compose', '?')} · {f.get('os', '?')}"
                       f" · {f.get('security_updates', '?')} security update(s) · reboot {'pending' if f.get('reboot_required') == 'yes' else 'no'}")
    return out


# ── main ──────────────────────────────────────────────────────────────────────────────────────────

def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--doc", required=True, help="docs/DEPENDENCIES.md, or - for stdin")
    ap.add_argument("--report", required=True)
    ap.add_argument("--issues", required=True)
    ap.add_argument("--hosts", default="eu,us,dev")
    ap.add_argument("--no-latest", action="store_true", help="skip the upstream lookups")
    ap.add_argument("--latest-cache", default="", help="JSON file keeping the weekly upstream answers")
    ap.add_argument("--today", default="", help="YYYY-MM-DD, for holds (default: today, UTC)")
    a = ap.parse_args(argv)
    today = datetime.date.fromisoformat(a.today) if a.today else datetime.datetime.now(datetime.timezone.utc).date()

    if a.doc == "-":
        doc = sys.stdin.read()
    else:
        with open(a.doc, encoding="utf-8") as f:
            doc = f.read()
    try:
        pins = parse_pins(doc)
    except ValueError as e:
        issue = Issue("P2", "versions", "-", "Pinned versions table unreadable",
                      f"docs/DEPENDENCIES.md: {e}. The weekly version check did not run.")
        write(a.issues, issue.line() + "\n")
        write(a.report, f"Version check — {today}: NOT RUN, {e}\n")
        return 0

    hosts = [h for h in a.hosts.split(",") if h in HOSTS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(hosts) + 2) as ex:
        surveys_f = [ex.submit(survey_host, h) for h in hosts]
        stable_f = ex.submit(probe_stable_image, pins["gateway-image"].target) if "gateway-image" in pins else None
        cache = {}
        if a.latest_cache and os.path.exists(a.latest_cache):
            try:
                with open(a.latest_cache, encoding="utf-8") as f:
                    cache = json.load(f)
            except (OSError, ValueError):
                cache = {}  # a broken cache means one extra week of lookups, nothing else
        latest_f = None if a.no_latest else ex.submit(resolve_latest, pins, cache, today)
        surveys = [f.result() for f in surveys_f]
        stable = stable_f.result() if stable_f else None
        latest, new_cache = latest_f.result() if latest_f else (None, None)
    if a.latest_cache and new_cache is not None:
        write(a.latest_cache + ".tmp", json.dumps(new_cache, indent=1, sort_keys=True))
        os.replace(a.latest_cache + ".tmp", a.latest_cache)
    issues, lines = analyse(pins, surveys, stable, latest, today)
    write(a.issues, "".join(i.line() + "\n" for i in issues))
    write(a.report, "\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())

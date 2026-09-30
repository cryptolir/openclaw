#!/usr/bin/env python3
"""Tests for versions-check.py: no network, no SSH. Run: python3 scripts/ops/test_versions_check.py"""

import datetime
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("versions_check", os.path.join(HERE, "versions-check.py"))
vc = importlib.util.module_from_spec(spec)
sys.modules["versions_check"] = vc  # dataclasses look their module up by name
spec.loader.exec_module(vc)

TODAY = datetime.date(2026, 9, 30)

DOC = """# Agent Runtime Dependencies

## Pinned versions — what each runtime component should run

Some prose.

| Priority | When |
|---|---|
| P1 | a security release |

| ID | Component | Target | Checked on | Pinned in | Latest from | Hold until | Note |
|---|---|---|---|---|---|---|---|
| `gateway-image` | Gateway image | `v2026.09.09.1` | every Agent | stable release | registry | | |
| `openclaw` | OpenClaw | `2026.2.19` | stable image | fork package.json | github | | |
| `node` | Node.js | `24.20.0` | stable image | Dockerfile | nodejs.org | | |
| `playwright` | Playwright | `1.58.2` | stable image | package.json | npm | | |
| `chrome` | Chrome for Testing | `145.0.7632.6` | stable image | follows playwright | Chrome stable | | |
| `python` | Python | `3.11.2` | stable image | Debian | — | | |
| `hermes` | Hermes | `2026.8.18` | every Hermes Agent | hermes-agent | github | | |
| `sidecar-chromium` | Sidecar Chromium | `154.0.8037.57` | every sidecar | Dockerfile.sandbox-browser | Chrome stable | | |
| `docker` | Docker Engine | `29.3.0` | every server | apt | download.docker.com | | |
| `compose` | Docker Compose | `5.1.0` | every server | apt | github | | |
| `host-security` | Security updates | `0` | every server | apt | — | | |

## Next section
"""

R = "europe-west1-docker.pkg.dev/gold-verve-459312-e7/openclaw-gateway/gateway"
STABLE_OK = {"node": "v24.20.0", "openclaw": "2026.2.19", "playwright": "1.58.2",
             "chrome": "Google Chrome for Testing 145.0.7632.6", "python": "Python 3.11.2"}


def survey(host="eu", agents=(), facts=None, images=None):
    s = vc.Survey(host)
    s.facts = facts if facts is not None else {"docker": "29.3.0", "compose": "5.1.0", "os": "Ubuntu 24.04",
                                               "security_updates": "0", "reboot_required": "no"}
    s.agents = list(agents)
    s.images = images or {}
    return s


def run(pins=None, surveys=(), stable=("x", STABLE_OK), latest=None, today=TODAY):
    return vc.analyse(pins if pins is not None else vc.parse_pins(DOC), list(surveys), stable, latest or {}, today)


def titles(issues):
    return {(i.pri, i.host, i.title) for i in issues}


class Versions(unittest.TestCase):
    def test_numbers_zero_padding_hermes_dates_and_tool_output(self):
        self.assertEqual(vc.nums("v2026.09.09.1"), (2026, 9, 9, 1))
        self.assertEqual(vc.cmp("v2026.9.1.1", "v2026.09.09.1"), -1)
        self.assertEqual(vc.cmp("v2026.09.29.1", "v2026.09.09.1"), 1)
        self.assertEqual(vc.nums("Hermes Agent v0.20.4 (2026.8.18)"), (2026, 8, 18))
        self.assertEqual(vc.clean("Chromium 154.0.8037.57 built on Debian GNU/Linux 12 (bookworm)"), "154.0.8037.57")
        self.assertEqual(vc.clean("Google Chrome for Testing 145.0.7632.6 "), "145.0.7632.6")
        self.assertIsNone(vc.cmp("", "1.0"))

    def test_gap(self):
        self.assertEqual(vc.gap("1.58.2", "1.63.0"), "minor")
        self.assertEqual(vc.gap("24.20.0", "24.21.0"), "minor")
        self.assertEqual(vc.gap("145.0.7632.6", "154.0.8037.92"), "major")
        self.assertEqual(vc.gap("v2026.09.09.1", "v2026.09.29.1"), "patch")
        self.assertIsNone(vc.gap("5.1.0", "5.1.0"))
        self.assertIsNone(vc.gap("5.1.0", "5.0.9"))

    def test_image_tag(self):
        self.assertEqual(vc.image_tag(f"{R}@sha256:5f3a" + "0" * 60), "")
        self.assertEqual(vc.version_tag(f"{R}:pr-123"), "")
        self.assertEqual(vc.version_tag(f"{R}:latest"), "")
        self.assertEqual(vc.version_tag("openclaw:v2026.09.30.2"), "v2026.09.30.2")
        self.assertEqual(vc.image_tag(f"{R}:v2026.9.1.1"), "v2026.9.1.1")
        self.assertEqual(vc.image_tag("openclaw:v2026.09.30.2"), "v2026.09.30.2")
        self.assertEqual(vc.image_tag("localhost:5000/gw"), "")


class Pins(unittest.TestCase):
    def test_reads_the_table_by_header_name(self):
        pins = vc.parse_pins(DOC)
        self.assertEqual(set(pins), set(vc.KNOWN))
        self.assertEqual(pins["gateway-image"].target, "v2026.09.09.1")
        def swap(line):  # every table line: ID and Target change places
            if not line.startswith("|"):
                return line
            c = line.split("|")
            c[1], c[3] = c[3], c[1]
            return "|".join(c)
        shuffled = "\n".join(swap(l) for l in DOC.splitlines())
        self.assertIn("| Target | Component | ID |", shuffled)
        self.assertEqual(vc.parse_pins(shuffled)["node"].target, "24.20.0")

    def test_refuses_a_broken_table_with_the_reason(self):
        with self.assertRaisesRegex(ValueError, "no \"## Pinned versions\" section"):
            vc.parse_pins("# nothing here\n")
        with self.assertRaisesRegex(ValueError, "Hold until must be a real date"):
            vc.parse_pins(DOC.replace("| `docker` | Docker Engine | `29.3.0` | every server | apt | download.docker.com | | |",
                                      "| `docker` | Docker Engine | `29.3.0` | every server | apt | download.docker.com | next week | |"))
        with self.assertRaisesRegex(ValueError, "needs the columns"):
            vc.parse_pins(DOC.replace("Hold until", "Deferred"))

    def test_an_impossible_hold_date_is_refused_while_parsing_not_later(self):
        with self.assertRaisesRegex(ValueError, "must be a real date"):
            vc.parse_pins(DOC.replace("| `compose` | Docker Compose | `5.1.0` | every server | apt | github | | |",
                                      "| `compose` | Docker Compose | `5.1.0` | every server | apt | github | 2026-02-30 | |"))

    def test_an_escaped_pipe_stays_in_its_cell(self):
        doc = DOC.replace("| `python` | Python | `3.11.2` | stable image | Debian | — | | |",
                          "| `python` | Python | `3.11.2` | stable image | Debian \\| bookworm | — | | a \\| b |")
        self.assertEqual(vc.parse_pins(doc)["python"].note, "a | b")

    def test_an_unreadable_table_still_reaches_the_bug_list(self):
        with tempfile.TemporaryDirectory() as d:
            doc, rep, iss = (os.path.join(d, x) for x in ("doc.md", "r.txt", "i.txt"))
            with open(doc, "w") as f:
                f.write("# no table\n")
            self.assertEqual(vc.main(["--doc", doc, "--report", rep, "--issues", iss, "--today", "2026-09-30"]), 0)
            with open(iss) as f:
                line = f.read()
            self.assertTrue(line.startswith("ISSUE|P2|versions|-|Pinned versions table unreadable|"), line)
            with open(rep) as f:
                self.assertIn("NOT RUN", f.read())


class Findings(unittest.TestCase):
    def test_agents_behind_the_stable_image_are_one_finding_per_server_and_pilots_are_not_flagged(self):
        s = survey(agents=[("openclaw", "agent-1-openclaw-gateway-1", f"{R}:v2026.9.1.1", ""),
                           ("openclaw", "cashtronics-openclaw-gateway-1", f"{R}:v2026.9.1.1", ""),
                           ("openclaw", "testingbot-openclaw-gateway-1", f"{R}:v2026.9.7.1", ""),
                           ("openclaw", "ok-openclaw-gateway-1", f"{R}:v2026.09.09.1", ""),
                           ("openclaw", "gems-openclaw-gateway-1", f"{R}:v2026.09.29.1", "")])
        issues, report = run(surveys=[s])
        roll = [i for i in issues if i.title.startswith("Agents on an older gateway image")]
        self.assertEqual(len(roll), 1)
        self.assertEqual((roll[0].pri, roll[0].host, roll[0].agent), ("P2", "eu", "3 agents"))
        self.assertIn("v2026.9.1.1: agent-1, cashtronics (2); v2026.9.7.1: testingbot (1)", roll[0].detail)
        self.assertNotIn("gems", roll[0].detail)
        self.assertIn("Upgrade", roll[0].detail)
        self.assertTrue(any("v2026.09.29.1 ×1 (ahead)" in l for l in report))

    def test_hermes_sidecar_and_server_tools_against_their_targets(self):
        s = survey("us", agents=[("hermes", "hermi-hermes-gateway-1", "hermes-agent:v1", "Hermes Agent v0.19.0 (2026.7.1)"),
                                 ("sidecar", "bob-browser", "sb:1", "Chromium 150.0.1.1 built on Debian")],
                   facts={"docker": "29.2.1", "compose": "5.0.2", "security_updates": "2", "reboot_required": "yes"})
        t = titles(run(surveys=[s])[0])
        for want in [("P2", "us", "Older Hermes than the Target"), ("P2", "us", "Older sidecar Chromium than the Target"),
                     ("P2", "us", "Docker older than the Target"), ("P2", "us", "Compose older than the Target"),
                     ("P2", "us", "Security updates pending"), ("P3", "us", "Reboot pending")]:
            self.assertIn(want, t)

    def test_digest_and_unversioned_images_are_listed_not_called_behind(self):
        s = survey(agents=[("openclaw", "d-openclaw-gateway-1", f"{R}@sha256:5f3a" + "0" * 60, ""),
                           ("openclaw", "p-openclaw-gateway-1", f"{R}:pr-123", "")])
        issues, report = run(surveys=[s])
        self.assertFalse([i for i in issues if i.title.startswith("Agents on")])
        self.assertTrue(any("(unversioned)" in l for l in report))

    def test_a_broken_apt_is_not_read_as_clean(self):
        s = survey(facts={"docker": "29.3.0", "compose": "5.1.0", "security_updates": "error", "reboot_required": "no"})
        t = titles(run(surveys=[s])[0])
        self.assertIn(("P3", "eu", "Pending updates not read"), t)
        self.assertNotIn(("P2", "eu", "Security updates pending"), t)

    def test_a_component_missing_from_the_stable_image_is_reported(self):
        t = titles(run(stable=("openclaw:v2026.09.09.1", dict(STABLE_OK, chrome="")))[0])
        self.assertIn(("P3", "versions", "The stable image has no chrome"), t)

    def test_a_clean_fleet_on_current_targets_has_no_findings(self):
        s = survey(agents=[("openclaw", "a-openclaw-gateway-1", f"{R}:v2026.09.09.1", ""),
                           ("hermes", "h-hermes-gateway-1", "hermes-agent:v1", "Hermes Agent v0.20.4 (2026.8.18)")])
        latest = {"gateway-image": vc.Latest("v2026.09.09.1"), "node": vc.Latest("24.20.0"),
                  "playwright": vc.Latest("1.58.2"), "chrome": vc.Latest("145.0.7632.6"), "openclaw": vc.Latest("2026.2.19"),
                  "hermes": vc.Latest("2026.8.18"), "sidecar-chromium": vc.Latest("154.0.8037.57"),
                  "docker": vc.Latest("29.3.0"), "compose": vc.Latest("5.1.0")}
        issues, _ = run(surveys=[s], latest=latest)
        self.assertEqual(issues, [])

    def test_upstream_priorities(self):
        latest = {"node": vc.Latest("24.21.0", security=True), "chrome": vc.Latest("154.0.8037.92"),
                  "sidecar-chromium": vc.Latest("154.0.8037.92"), "openclaw": vc.Latest("2026.9.7"),
                  "gateway-image": vc.Latest("v2026.09.29.1"), "playwright": vc.Latest(error="URLError: timed out")}
        t = titles(run(latest=latest)[0])
        self.assertIn(("P1", "versions", "node update available"), t)                 # the publisher's security flag
        self.assertIn(("P1", "versions", "chrome update available"), t)               # 9 majors behind stable
        self.assertIn(("P3", "versions", "sidecar-chromium update available"), t)     # same major: a patch
        self.assertIn(("P2", "versions", "openclaw update available"), t)
        self.assertIn(("P3", "versions", "Newer gateway image than the stable release"), t)
        self.assertIn(("P3", "versions", "Latest playwright not read"), t)

    def test_date_versions_say_how_old_and_matter_from_three_months(self):
        issues = run(latest={"openclaw": vc.Latest("2026.9.7"), "hermes": vc.Latest("2026.9.24")})[0]
        by = {i.title: i for i in issues}
        self.assertEqual(by["openclaw update available"].pri, "P2")
        self.assertIn("about 7 months newer", by["openclaw update available"].detail)
        self.assertEqual(by["hermes update available"].pri, "P3")
        self.assertIn("a newer release", by["hermes update available"].detail)

    def test_the_advice_matches_where_the_component_lives(self):
        issues = run(latest={"docker": vc.Latest("29.8.1"), "playwright": vc.Latest("1.63.0"),
                             "sidecar-chromium": vc.Latest("155.0.1.1")})[0]
        by = {i.title: i.detail for i in issues}
        self.assertIn("on each server in a quiet hour", by["docker update available"])
        self.assertIn("build a gateway image", by["playwright update available"])
        self.assertIn("rebuild the sidecar image", by["sidecar-chromium update available"])
        s = survey(agents=[("openclaw", "a-openclaw-gateway-1", f"{R}:v2026.9.1.1", "")])
        roll = [i for i in run(surveys=[s])[0] if i.title.startswith("Agents on")][0]
        self.assertIn("each Agent's Upgrade moves it to the latest stable", roll.detail)
        self.assertNotIn("deploy.sh", roll.detail)  # it rolls EVERY Agent on a server, pilots included

    def test_a_newer_node_lts_line_is_its_own_finding(self):
        t = titles(run(latest={"node": vc.Latest("24.20.0", note="Node 26 is the newest LTS line.")})[0])
        self.assertIn(("P3", "versions", "Newer Node LTS line"), t)

    def test_a_hold_drops_the_rows_findings_to_p3_until_its_date(self):
        doc = DOC.replace("| `openclaw` | OpenClaw | `2026.2.19` | stable image | fork package.json | github | | |",
                          "| `openclaw` | OpenClaw | `2026.2.19` | stable image | fork package.json | github | 2026-12-01 | fork catch-up is its own project |")
        latest = {"openclaw": vc.Latest("2026.9.7")}
        held = [i for i in run(pins=vc.parse_pins(doc), latest=latest)[0] if "openclaw" in i.title]
        self.assertEqual([(i.pri, i.title) for i in held], [("P3", "(held) openclaw update available")])
        self.assertIn("Held until 2026-12-01: fork catch-up is its own project.", held[0].detail)
        later = [i for i in run(pins=vc.parse_pins(doc), latest=latest, today=datetime.date(2026, 12, 2))[0] if "openclaw" in i.title]
        self.assertEqual([(i.pri, i.title) for i in later], [("P2", "openclaw update available")])

    def test_the_doc_is_checked_against_the_stable_image(self):
        drift = dict(STABLE_OK, node="v24.19.0")
        t = titles(run(stable=("openclaw:v2026.09.09.1", drift))[0])
        self.assertIn(("P3", "versions", "DEPENDENCIES.md node Target differs from the stable image"), t)
        self.assertEqual(len([x for x in t if "differs from the stable image" in x[2]]), 1)
        self.assertIn(("P3", "versions", "Stable image contents not read"), titles(run(stable=("", {}))[0]))

    def test_rows_and_checks_never_drift_apart_silently(self):
        pins = vc.parse_pins(DOC)
        pins["redis"] = vc.Pin("redis", "8.0")
        del pins["compose"]
        t = titles(run(pins=pins)[0])
        self.assertIn(("P3", "versions", "No check for the redis row"), t)
        self.assertIn(("P3", "versions", "No Pinned versions row for compose"), t)

    def test_an_unreachable_server_is_said(self):
        self.assertIn(("P3", "dev", "Versions not read"), titles(run(surveys=[vc.Survey("dev", error="ssh exit 255: refused")])[0]))

    def test_issue_lines_are_six_clean_fields(self):
        i = vc.Issue("P2", "eu", "-", "a | title\n", "detail | with\nbreaks")
        line = i.line()
        self.assertEqual(len(line.split("|")), 6, line)
        self.assertNotIn("\n", line)


class Probe(unittest.TestCase):
    def test_parse_probe_output(self):
        out = "\n".join([
            "HOST|docker|29.2.1", "HOST|compose|5.0.2", "HOST|os|Ubuntu 24.04.4 LTS",
            "HOST|security_updates|1", "HOST|reboot_required|yes",
            f"AGENT|openclaw|agent-1-openclaw-gateway-1|{R}:v2026.9.1.1|",
            f"IMAGE|{R}:v2026.9.1.1|node=v22.22.0;openclaw=2026.2.19;playwright=1.58.2;chrome=Google Chrome for Testing 145.0.7632.6;python=Python 3.11.2",
            "AGENT|hermes|hermes007-hermes-gateway-1|hermes-agent:v1|Hermes Agent v0.20.4 (2026.8.18)",
            "AGENT|sidecar|social-bob-browser|openclaw-sandbox-browser:a4e3d67|Chromium 154.0.8037.57 built on Debian GNU/Linux 12 (bookworm)",
        ])
        s = vc.parse_probe("eu", out)
        self.assertEqual(s.error, "")
        self.assertEqual(s.facts["security_updates"], "1")
        self.assertEqual(len(s.agents), 3)
        self.assertEqual(s.images[f"{R}:v2026.9.1.1"]["node"], "v22.22.0")
        self.assertEqual(vc.parse_probe("eu", "").error, "no answer")

    def test_the_shell_probes_parse(self):
        for shell, script in (("bash", vc.HOST_PROBE), ("sh", vc.IMAGE_PROBE)):
            r = subprocess.run([shell, "-n"], input=script, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{shell}: {r.stderr}")
        self.assertIn("IMG_PROBE=$(cat <<'PROBE'\ncd /app", vc.HOST_PROBE)
        self.assertIn("\nPROBE\n)", vc.HOST_PROBE)



class WeeklyLookups(unittest.TestCase):
    """What runs is read daily; the newest upstream versions are looked up weekly (resolve_latest)."""

    def setUp(self):
        self.pins = vc.parse_pins(DOC)
        self.asked = []

    def fetch(self, answer=None, fail=()):
        def f(pins, only):
            self.asked.append(sorted(only))
            return {k: (vc.Latest(error="URLError") if k in fail else vc.Latest((answer or {}).get(k, "9.9.9")))
                    for k in only}
        return f

    def test_the_first_run_asks_every_source_and_caches_the_answers(self):
        out, cache = vc.resolve_latest(self.pins, {}, datetime.date(2026, 9, 30), self.fetch())
        self.assertEqual(self.asked, [sorted(vc.LATEST_SOURCES)])
        self.assertEqual(cache["node"]["at"], "2026-09-30")
        self.assertEqual(cache["node"]["target"], "24.20.0")
        self.assertEqual(out["docker"].version, "9.9.9")

    def test_other_days_use_the_cache_and_mondays_ask_again(self):
        _, cache = vc.resolve_latest(self.pins, {}, datetime.date(2026, 9, 30), self.fetch())
        self.asked.clear()
        out, _ = vc.resolve_latest(self.pins, cache, datetime.date(2026, 10, 2), self.fetch({"docker": "1.0"}))
        self.assertEqual(self.asked, [[]])                       # Friday: nothing due
        self.assertEqual(out["docker"].version, "9.9.9")          # the cached answer
        self.asked.clear()
        vc.resolve_latest(self.pins, cache, datetime.date(2026, 10, 5), self.fetch())
        self.assertEqual(self.asked, [sorted(vc.LATEST_SOURCES)])  # Monday: everything
        self.asked.clear()
        _, cache2 = vc.resolve_latest(self.pins, cache, datetime.date(2026, 10, 5), self.fetch())
        vc.resolve_latest(self.pins, cache2, datetime.date(2026, 10, 5), self.fetch())
        self.assertEqual(self.asked[-1], [])                     # …once that Monday

    def test_a_failed_lookup_keeps_a_recent_answer_and_is_retried_the_next_day(self):
        _, cache = vc.resolve_latest(self.pins, {}, datetime.date(2026, 9, 28), self.fetch())
        out, cache2 = vc.resolve_latest(self.pins, cache, datetime.date(2026, 10, 5), self.fetch(fail=("docker",)))
        self.assertEqual(out["docker"].version, "9.9.9")          # last week's answer stands
        self.assertEqual(out["docker"].error, "")
        self.assertEqual(cache2["docker"]["at"], "2026-09-28")    # the failure was not cached
        self.asked.clear()
        vc.resolve_latest(self.pins, cache2, datetime.date(2026, 10, 6), self.fetch())
        self.assertEqual(self.asked, [["docker"]])               # Tuesday: only the failed one again
        out, _ = vc.resolve_latest(self.pins, {}, datetime.date(2026, 10, 6), self.fetch(fail=("docker",)))
        self.assertEqual(out["docker"].error, "URLError")         # nothing cached: said, not hidden

    def test_a_changed_target_is_judged_again(self):
        _, cache = vc.resolve_latest(self.pins, {}, datetime.date(2026, 9, 30), self.fetch())
        self.pins["node"].target = "24.21.0"
        self.asked.clear()
        vc.resolve_latest(self.pins, cache, datetime.date(2026, 10, 1), self.fetch())
        self.assertEqual(self.asked, [["node"]])


class PhaseC(unittest.TestCase):
    """The deps-audit-cron.sh block that runs the check every day and passes its findings on."""

    def run_block(self, stub_exit, old_issues=None, doc="x"):
        with open(os.path.join(HERE, "deps-audit-cron.sh"), encoding="utf-8") as f:
            src = f.read()
        block = src[src.index("# ── Phase C — versions"):src.index("# ── Emit + state files")]
        with tempfile.TemporaryDirectory() as d:
            stub = os.path.join(d, "stub.py")
            with open(stub, "w") as f:
                f.write("import sys\n"
                        f"if {stub_exit}: sys.exit({stub_exit})\n"
                        f"open({os.path.join(d, 'i')!r}, 'w').write('ISSUE|P2|versions|-|fresh finding|x\\n')\n"
                        f"open({os.path.join(d, 'r')!r}, 'w').write('fresh report')\n")
            if old_issues is not None:
                with open(os.path.join(d, "i"), "w") as f:
                    f.write("ISSUE|P3|versions|-|last good finding|x\n")
                with open(os.path.join(d, "r"), "w") as f:
                    f.write("last good report")
                os.utime(os.path.join(d, "i"), (old_issues, old_issues))
            harness = (f"set -uo pipefail\nissues=''; versions_report=''; iss(){{ issues=\"${{issues}}$1\"$'\\n'; }}\n"
                       f"DOC={doc!r}; SSH_KEY=k; VERSIONS_REPORT={d}/r; VERSIONS_ISSUES={d}/i; VERSIONS_CACHE={d}/c; "
                       f"VERSIONS_CHECK={stub}\n{block}\nprintf '%s' \"$issues\"; echo '@@'; printf '%s' \"$versions_report\"\n")
            r = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            issues, report = r.stdout.split("@@\n")
            return issues, report

    def test_a_good_run_passes_its_findings_and_report_on(self):
        issues, report = self.run_block(0)
        self.assertIn("ISSUE|P2|versions|-|fresh finding|x", issues)
        self.assertNotIn("Version check failed", issues)
        self.assertEqual(report, "fresh report")

    def test_a_failed_run_says_so_and_last_good_findings_stand_in(self):
        import time
        issues, report = self.run_block(1, old_issues=time.time() - 2 * 86400)
        self.assertIn("Version check failed", issues)
        self.assertIn("last good finding", issues)
        self.assertEqual(report, "last good report")

    def test_last_good_findings_expire_after_eight_days(self):
        import time
        issues, report = self.run_block(1, old_issues=time.time() - 9 * 86400)
        self.assertIn("Version check failed", issues)
        self.assertNotIn("last good finding", issues)
        self.assertEqual(report, "")

    def test_no_doc_means_no_run_and_says_so(self):
        issues, _ = self.run_block(0, doc="")
        self.assertIn("Version check failed", issues)
        self.assertNotIn("fresh finding", issues)


if __name__ == "__main__":
    unittest.main()

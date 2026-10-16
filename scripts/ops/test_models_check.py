#!/usr/bin/env python3
"""Tests for models-check.py: no network, no SSH. Run: python3 scripts/ops/test_models_check.py

Plan: openclaw-dashboard docs/plans/active/model-catalog-check.md (Rev 6). Test names carry the
review finding they pin ("r1 F2" = Codex round 1, finding 2). The probe tests run the real PROBE
source against a temp directory, a stub `docker` and a fake urlopen that records every call.
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("models_check", os.path.join(HERE, "models-check.py"))
mc = importlib.util.module_from_spec(spec)
sys.modules["models_check"] = mc
spec.loader.exec_module(mc)

with open(os.path.join(HERE, "testdata", "codex-model-lists.fixture.json"), encoding="utf-8") as f:
    FIXTURE = json.load(f)

A, B, C = "a" * 16, "b" * 16, "c" * 16
K1, K2 = "1" * 16, "2" * 16


def survey(host="eu", agents=None, keys=None, global_keys=(), accts=None, lists=None, unverified=None,
           multi=()):
    """A host survey as parse_probe() would build it; READ counts follow the lists."""
    lists = lists or {}
    return {"host": host, "agents": agents or {}, "global_keys": set(global_keys),
            "accts": {a: set(v) for a, v in (accts or {}).items()},
            "keys": {a: ({v} if isinstance(v, str) else set(v)) for a, v in (keys or {}).items()},
            "lists": {k: [{"id": i} for i in v] for k, v in lists.items()},
            "read": {k: len(v) for k, v in lists.items()}, "unverified": unverified or {},
            "errors": [], "host_errors": [], "multi": set(multi), "dropped": 0}


PUBLIC_OK = {"venice": (["kimi-k3", "claude-sonnet-5"], ""), "openrouter": (["openrouter/free"], "")}


def pri(issues, p):
    return [i for i in issues if i.pri == p]


class SharedFixture(unittest.TestCase):
    def test_r1_F3_collect_model_refs_matches_the_dashboard(self):
        refs = sorted({r for _, r in mc.collect_model_refs(FIXTURE["config"]["agents"])})
        self.assertEqual(refs, FIXTURE["refs"])

    def test_paths_mark_the_primary(self):
        paths = dict((r, p) for p, r in mc.collect_model_refs(FIXTURE["config"]["agents"]))
        self.assertTrue(mc.is_primary(paths["openai-codex/gpt-5.5"]))       # defaults.model.primary
        self.assertTrue(mc.is_primary(paths["nvidia/llama-4"]))             # agents.list[0].model
        self.assertTrue(mc.is_primary(paths["openai-codex/gpt-5.6-sol"]))   # agents.list[1].model.primary
        self.assertFalse(mc.is_primary(paths["openai-codex/gpt-6-luna"]))   # subagents.model
        self.assertFalse(mc.is_primary(paths["venice/claude-sonnet-5"]))    # a fallback

    def test_r3_F1_codex_verdict_table_matches_the_dashboard(self):
        for c in FIXTURE["verdicts"]:
            self.assertEqual(mc.codex_verdict(c["id"], c["accts"], c["lists"]), c["expect"], c["name"])


class Gate(unittest.TestCase):
    def test_r1_F2_the_measured_hidden_only_answer_is_unverified(self):
        ok, why = mc.gate([], None, "openai-codex")
        self.assertFalse(ok)
        self.assertIn("bump CODEX_CLIENT_VERSION", why)

    def test_r1_F2_shrink_below_half_is_unverified_and_state_is_kept(self):
        prev = [f"m{i}" for i in range(8)]
        s = survey(agents={"bot": [("agents.defaults.model.primary", "openai-codex/m1")]},
                   accts={"bot": {A}}, lists={("openai-codex", A): ["m1", "m2", "m3"]})
        issues, _, push, state = mc.analyse([s], PUBLIC_OK, {f"openai-codex:{A}": prev}, [])
        self.assertEqual(push, {})
        self.assertEqual(state[f"openai-codex:{A}"], prev)
        self.assertFalse(pri(issues, "P1"))
        self.assertTrue(any("shrank from 8 to 3" in i.detail for i in pri(issues, "P3")))

    def test_dropped_list_lines_make_the_list_unverified(self):
        s = survey(agents={"bot": [("agents.defaults.model.primary", "openai-codex/gpt-6-luna")]},
                   accts={"bot": {A}}, lists={("openai-codex", A): ["gpt-5.6-sol"]})
        s["read"][("openai-codex", A)] = 2  # the probe said 2, one line was dropped
        issues, _, push, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual(push, {})
        self.assertFalse(pri(issues, "P1"))

    def test_I3_an_empty_provider_list_is_never_pushed(self):
        s = survey(accts={"bot": {A}}, lists={("openai-codex", A): []})
        _, _, push, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual(push, {})


class Findings(unittest.TestCase):
    def test_primary_dead_is_P1_fallback_dead_is_P2_unverified_is_P3(self):
        s = survey(agents={"jojo": [("agents.defaults.model.primary", "openai-codex/gpt-5.5"),
                                    ("agents.defaults.model.fallbacks[0]", "venice/grok-41-fast"),
                                    ("agents.defaults.heartbeat.model", "openai/gpt-4o")]},
                   accts={"jojo": {A}}, keys={"jojo": K1},
                   lists={("openai-codex", A): ["gpt-6-luna", "gpt-5.6-sol"]},
                   unverified={("openai", K1): "401"})
        issues, _, push, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual([(i.agent, i.title) for i in pri(issues, "P1")], [("jojo", "Model no longer offered")])
        self.assertIn("openai-codex/gpt-5.5", pri(issues, "P1")[0].detail)
        self.assertEqual(len(pri(issues, "P2")), 1)
        self.assertIn("venice/grok-41-fast", pri(issues, "P2")[0].detail)
        self.assertTrue(any("jojo" in i.detail and "401" in i.detail for i in pri(issues, "P3")))
        self.assertEqual(sorted(push), [A])

    def test_r1_F1_two_accounts_one_host_each_agent_judged_by_its_own(self):
        s = survey(agents={"on-a": [("agents.defaults.model.primary", "openai-codex/x")],
                           "on-b": [("agents.defaults.model.primary", "openai-codex/x")]},
                   accts={"on-a": {A}, "on-b": {B}},
                   lists={("openai-codex", A): ["x"], ("openai-codex", B): ["y"]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual([i.agent for i in pri(issues, "P1")], ["on-b"])

    def test_r1_F1_two_openai_keys_each_agent_judged_by_its_own_key(self):
        s = survey(agents={"k1": [("agents.defaults.model.primary", "openai/gpt-4o")],
                           "k2": [("agents.defaults.model.primary", "openai/gpt-4o")]},
                   keys={"k1": K1, "k2": K2}, lists={("openai", K1): ["gpt-4o"], ("openai", K2): ["gpt-4.1"]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual([i.agent for i in pri(issues, "P1")], ["k2"])

    def test_191_r1_F1_openai_keys_any_serves_rule(self):
        # profile keys K1 and K2 (the gateway may fail over between them): ok if either serves it
        s = survey(agents={"two": [("agents.defaults.model.primary", "openai/gpt-4o")],
                           "one": [("agents.defaults.model.primary", "openai/gpt-4o")]},
                   keys={"two": [K1, K2], "one": [K2]},
                   lists={("openai", K1): ["gpt-4o"], ("openai", K2): ["o3"]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual([i.agent for i in pri(issues, "P1")], ["one"])

    def test_191_r3_a_multi_agent_config_is_never_judged(self):
        s = survey(agents={"multi": [("agents.defaults.model.primary", "openai-codex/gpt-5.5"),
                                     ("agents.list[0].model", "openai/gpt-4o"),
                                     ("agents.list[1].model", "venice/gone")]},
                   accts={"multi": {A}}, keys={"multi": K1},
                   lists={("openai-codex", A): ["gpt-6-luna"], ("openai", K1): ["o3"]}, multi=["multi"])
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        # its OpenAI/ChatGPT refs are not judged; a public-list ref (Venice) still is
        self.assertEqual([(i.pri, i.title) for i in issues if i.agent == "multi"],
                         [("P1", "Model no longer offered"), ("P3", "OpenAI/ChatGPT models not checked")])
        self.assertIn("venice/gone", pri(issues, "P1")[0].detail)  # agents.list[1].model is that entry's primary

    def test_191_r3_F3_a_later_host_success_replaces_an_earlier_failure(self):
        eu = survey("eu", accts={"x": {A}}, unverified={("openai-codex", A): "401"})
        us = survey("us", agents={"y": [("agents.defaults.model.primary", "openai-codex/gpt-5.5")]},
                    accts={"y": {A}}, lists={("openai-codex", A): ["gpt-6-luna"]})
        issues, lines, push, _ = mc.analyse([eu, us], PUBLIC_OK, {}, [])
        self.assertEqual(sorted(push), [A])
        self.assertEqual([i.agent for i in pri(issues, "P1")], ["y"])
        self.assertFalse(any("401" in l for l in lines))

    def test_r3_F1_multi_profile_agent_ok_when_any_account_serves_it(self):
        s = survey(agents={"two": [("agents.defaults.model.primary", "openai-codex/x")]},
                   accts={"two": {A, B}}, lists={("openai-codex", A): ["y"], ("openai-codex", B): ["x"]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertFalse(pri(issues, "P1"))

    def test_r4_F1_two_accounts_two_separate_push_lists(self):
        s = survey(accts={"x": {A}, "y": {B}},
                   lists={("openai-codex", A): ["m1"], ("openai-codex", B): ["m2", "m3"]})
        _, _, push, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual({a: [e["id"] for e in v] for a, v in push.items()}, {A: ["m1"], B: ["m2", "m3"]})

    def test_no_login_and_no_key_are_P3_with_a_clear_reason(self):
        s = survey(agents={"bare": [("agents.defaults.model.primary", "openai-codex/x"),
                                    ("agents.defaults.model.fallbacks[0]", "openai/gpt-4o")]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        details = " ".join(i.detail for i in pri(issues, "P3"))
        self.assertIn("no ChatGPT login", details)
        self.assertIn("no OpenAI key", details)
        self.assertFalse(pri(issues, "P1"))


class HostErrors(unittest.TestCase):
    def test_191_r1_F2_a_failed_docker_ps_is_a_P2_not_zero_agents(self):
        s = mc.parse_probe("us", "HOSTERR|docker ps exit 1: Cannot connect to the Docker daemon")
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, [])
        self.assertEqual([(i.pri, i.host, i.title) for i in issues],
                         [("P2", "us", "Models check could not survey this server")])


class CuratedOpenAI(unittest.TestCase):
    SRC = """export const STATIC_MODELS = {
  openai: (
    [
      ["openai/gpt-4o", "GPT-4o"],
      ["openai/o3", "o3"],
    ] as const
  ).map(([ref, label]) => ({ ref, label, free: false })),
  anthropic: (
    [
      ["anthropic/claude-haiku-3-5", "Claude Haiku 3.5"],
    ] as const
  ).map(([ref, label]) => ({ ref, label, free: false })),
"""

    def test_parse_curated_reads_only_the_openai_block(self):
        self.assertEqual(mc.parse_curated(self.SRC), ["gpt-4o", "o3"])

    def test_r2_F1_two_hosts_P2_only_when_both_global_keys_lack_it(self):
        eu = survey("eu", global_keys=[K1], lists={("openai", K1): ["gpt-4o"]})
        us = survey("us", global_keys=[K2], lists={("openai", K2): ["gpt-4o", "o3"]})
        issues, _, push, _ = mc.analyse([eu, us], PUBLIC_OK, {}, ["gpt-4o", "o3", "gpt-3"])
        p2 = [i.detail for i in pri(issues, "P2")]
        self.assertEqual(len(p2), 1)
        self.assertIn("openai/gpt-3", p2[0])
        self.assertEqual(push, {})  # OpenAI lists are never pushed

    def test_r3_F3_served_by_one_agents_own_key_is_not_reported(self):
        s = survey(global_keys=[K1], keys={"own": K2},
                   lists={("openai", K1): ["gpt-4o"], ("openai", K2): ["o3"]})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, ["gpt-4o", "o3"])
        self.assertFalse(pri(issues, "P2"))

    def test_r3_F3_one_key_unverified_is_P3_without_an_edit(self):
        s = survey(global_keys=[K1], keys={"own": K2}, lists={("openai", K1): ["gpt-4o"]},
                   unverified={("openai", K2): "429"})
        issues, _, _, _ = mc.analyse([s], PUBLIC_OK, {}, ["gpt-4o", "o3"])
        self.assertFalse(pri(issues, "P2"))
        p3 = [i for i in pri(issues, "P3") if "openai/o3" in i.detail]
        self.assertEqual(len(p3), 1)
        self.assertIn("no edit suggested", p3[0].detail)


class ProbeOutput(unittest.TestCase):
    def test_I2_parse_probe_drops_every_unknown_or_malformed_line(self):
        out = "\n".join([
            "AGENT|bot",
            "REF|bot|agents.defaults.model.primary|openai-codex/gpt-6-luna",
            "REF|bot|agents.defaults.model.primary|sk-proj-not-a-ref",   # no provider/ prefix
            "REF|ghost|agents.defaults.model.primary|venice/x",          # agent never announced
            "LIST|openai|sk-SECRETKEY12345|gpt-4o",                      # not a fingerprint
            "TOKEN|eyJhbGciOi",                                          # unknown shape
            f"LIST|openai-codex|{A}|gpt-6-luna|GPT-6-Luna|272000",
            f"KEY|bot|{K1}|profile",
            f"KEY|bot|{K1}|stolen",                                       # unknown source
            f"READ|openai-codex|{A}|1",
        ])
        s = mc.parse_probe("eu", out)
        self.assertEqual(s["agents"], {"bot": [("agents.defaults.model.primary", "openai-codex/gpt-6-luna")]})
        self.assertEqual(s["dropped"], 5)
        self.assertEqual(s["keys"], {"bot": {K1}})
        self.assertEqual(s["lists"], {("openai-codex", A): [{"id": "gpt-6-luna", "label": "GPT-6-Luna",
                                                               "contextLength": 272000}]})
        self.assertNotIn("SECRET", repr(s))


# ── the real probe, on a temp tree ───────────────────────────────────────────────────────────

FAKE_NET = r'''
import io, json, os, sys, urllib.request
LOG = os.environ["FAKE_NET_LOG"]
ANS = json.loads(os.environ["FAKE_NET_ANSWERS"])
def fake(req, timeout=None):
    url = req.full_url
    with open(LOG, "a") as f:
        f.write(json.dumps({"url": url, "headers": dict(req.header_items())}) + "\n")
    for prefix, body in ANS.items():
        if url.startswith(prefix):
            return io.BytesIO(json.dumps(body).encode())
    raise OSError("no fake answer for " + url)
urllib.request.urlopen = fake
src = sys.stdin.read()
exec(compile(src, "probe", "exec"), {"__name__": "__main__"})
'''

CODEX_URL = "https://chatgpt.com/backend-api/codex/models"
OPENAI_URL = "https://api.openai.com/v1/models"


class RealProbe(unittest.TestCase):
    def run_probe(self, profiles_by_agent, answers, global_key="sk-GLOBALKEY-xyz", docker_exit=0,
                  order=None, agents_list=None):
        tmp = tempfile.mkdtemp()
        agents = os.path.join(tmp, "agents")
        for name, profiles in profiles_by_agent.items():
            base = os.path.join(agents, name)
            os.makedirs(os.path.join(base, "agents/main/agent"))
            with open(os.path.join(base, "openclaw.json"), "w") as f:
                agents_cfg = {"defaults": {"model": {"primary": "openai-codex/gpt-5.5"}}}
                if agents_list is not None:
                    agents_cfg["list"] = agents_list
                json.dump({"agents": agents_cfg, "gateway": {"auth": {"token": "GW-TOKEN-must-not-leak"}}}, f)
            with open(os.path.join(base, "agents/main/agent/auth-profiles.json"), "w") as f:
                json.dump({"profiles": profiles, **({"order": order} if order is not None else {})}, f)
        env_file = os.path.join(tmp, "global.env")
        with open(env_file, "w") as f:
            f.write(f"OPENAI_API_KEY={global_key}\n")
        stub = os.path.join(tmp, "bin")
        os.makedirs(stub)
        with open(os.path.join(stub, "docker"), "w") as f:
            f.write("#!/bin/sh\n" + "".join(f"echo {n}-openclaw-gateway-1\n" for n in profiles_by_agent)
                    + (f"echo daemon down >&2\nexit {docker_exit}\n" if docker_exit else ""))
        os.chmod(os.path.join(stub, "docker"), 0o755)

        probe = mc.PROBE
        for literal, repl in (('AGENTS = "/root/.openclaw/agents"', f'AGENTS = "{agents}"'),
                              ('"/opt/openclaw/.env"', f'"{env_file}"')):
            self.assertIn(literal, probe, "probe literal moved — update this test")
            probe = probe.replace(literal, repl)
        log = os.path.join(tmp, "net.log")
        env = {"PATH": stub + os.pathsep + "/usr/bin:/bin", "FAKE_NET_LOG": log,
               "FAKE_NET_ANSWERS": json.dumps(answers)}
        r = subprocess.run([sys.executable, "-c", FAKE_NET], input=probe, capture_output=True, text=True,
                           env=env, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = []
        if os.path.exists(log):
            with open(log) as f:
                calls = [json.loads(line) for line in f]
        return r.stdout, calls

    def profile(self, account, minutes_left, access="ACCESS-TOKEN-must-not-leak"):
        return {"type": "oauth", "provider": "openai-codex", "access": access, "refresh": "REFRESH-must-not-leak",
                "accountId": account, "expires": int((time.time() + minutes_left * 60) * 1000)}

    def test_I1_a_token_with_5_minutes_left_is_never_used(self):
        out, calls = self.run_probe({"bot": {"openai-codex:default": self.profile("acc-1", 5)}},
                                    {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}})
        self.assertFalse([c for c in calls if c["url"].startswith(CODEX_URL)])
        self.assertIn("no access token with more than 10 minutes left", out)
        self.assertNotIn("auth.openai.com", json.dumps(calls))  # never a refresh

    def test_live_token_one_get_lists_only_visible_models_and_nothing_secret_leaves(self):
        answers = {CODEX_URL: {"models": [{"slug": "gpt-6-luna", "visibility": "list", "display_name": "GPT-6-Luna",
                                           "context_window": 272000},
                                          {"slug": "codex-auto-review", "visibility": "hide"}]},
                   OPENAI_URL: {"data": [{"id": "gpt-4o"}]}}
        out, calls = self.run_probe({"bot": {"openai-codex:default": self.profile("acc-1", 120)}}, answers)
        codex = [c for c in calls if c["url"].startswith(CODEX_URL)]
        self.assertEqual(len(codex), 1)
        self.assertIn("client_version=0.162.0", codex[0]["url"])
        s = mc.parse_probe("eu", out)
        self.assertEqual(s["dropped"], 0, out)
        ((_, entries),) = [(k, v) for k, v in s["lists"].items() if k[0] == "openai-codex"]
        self.assertEqual([e["id"] for e in entries], ["gpt-6-luna"])
        self.assertEqual(s["agents"]["bot"], [("agents.defaults.model.primary", "openai-codex/gpt-5.5")])
        for secret in ("ACCESS-TOKEN", "REFRESH", "GW-TOKEN", "sk-GLOBALKEY-xyz", "acc-1"):
            self.assertNotIn(secret, out)

    def test_r1_F2_a_paginated_or_hidden_only_answer_is_unverified(self):
        for body, why in (({"models": [{"slug": "x", "visibility": "list"}], "has_more": True}, "pagination"),
                          ({"models": [{"slug": "codex-auto-review", "visibility": "hide"}]}, None)):
            out, _ = self.run_probe({"bot": {"openai-codex:default": self.profile("acc-1", 120)}},
                                    {CODEX_URL: body, OPENAI_URL: {"data": [{"id": "gpt-4o"}]}})
            s = mc.parse_probe("eu", out)
            if why:
                self.assertTrue(any(why in v for v in s["unverified"].values()), out)
            else:
                # hidden-only: READ 0, which the gate turns into "bump CODEX_CLIENT_VERSION"
                (key,) = [k for k in s["read"] if k[0] == "openai-codex"]
                self.assertEqual(s["read"][key], 0)
                issues, _, push, _ = mc.analyse([s], PUBLIC_OK, {}, [])
                self.assertEqual(push, {})
                self.assertTrue(any("bump CODEX_CLIENT_VERSION" in i.detail for i in issues))

    def test_191_r1_F1_an_openai_profile_key_wins_over_the_env_key(self):
        profiles = {"openai:default": {"type": "api_key", "provider": "openai", "key": "sk-PROFILE-must-not-leak"}}
        out, calls = self.run_probe({"bot": profiles}, {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}})
        s = mc.parse_probe("eu", out)
        self.assertEqual(s["dropped"], 0, out)
        self.assertEqual(len(s["keys"]["bot"]), 1)
        self.assertNotIn(next(iter(s["global_keys"])), s["keys"]["bot"])  # not the env/global key
        self.assertIn("|profile", out)
        self.assertNotIn("sk-PROFILE", out)
        self.assertIn("Bearer sk-PROFILE-must-not-leak", json.dumps(calls))  # the list was read with it

    def test_191_r2_F2_a_profile_left_out_of_the_order_is_never_used(self):
        profiles = {"openai:a": {"type": "api_key", "provider": "openai", "key": "sk-IN-ORDER"},
                    "openai:b": {"type": "api_key", "provider": "openai", "key": "sk-EXCLUDED"}}
        out, calls = self.run_probe({"bot": profiles}, {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}},
                                    order={"openai": ["openai:a"]})
        s = mc.parse_probe("eu", out)
        self.assertEqual(len(s["keys"]["bot"]), 1)
        sent = json.dumps(calls)
        self.assertIn("sk-IN-ORDER", sent)
        self.assertNotIn("sk-EXCLUDED", sent)

    def test_191_r3_agents_list_marks_the_agent_multi_and_reads_no_credentials(self):
        profiles = {"openai:default": {"type": "api_key", "provider": "openai", "key": "sk-NOT-READ"}}
        out, calls = self.run_probe({"bot": profiles}, {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}},
                                    agents_list=[{"id": "main"}, {"id": "other", "agentDir": "/elsewhere/agent"}])
        s = mc.parse_probe("eu", out)
        self.assertEqual(s["multi"], {"bot"})
        self.assertNotIn("bot", s["keys"])
        self.assertNotIn("sk-NOT-READ", json.dumps(calls))

    def test_191_r1_F2_docker_ps_failing_reports_a_host_error(self):
        out, _ = self.run_probe({"bot": {}}, {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}}, docker_exit=1)
        self.assertTrue(mc.parse_probe("eu", out)["host_errors"], out)

    def test_a_401_is_unverified_and_never_retried(self):
        out, calls = self.run_probe({"bot": {"openai-codex:default": self.profile("acc-1", 120)}},
                                    {OPENAI_URL: {"data": [{"id": "gpt-4o"}]}})  # no codex answer → error
        self.assertEqual(len([c for c in calls if c["url"].startswith(CODEX_URL)]), 1)
        self.assertTrue(any(k[0] == "openai-codex" for k in mc.parse_probe("eu", out)["unverified"]))


if __name__ == "__main__":
    unittest.main()

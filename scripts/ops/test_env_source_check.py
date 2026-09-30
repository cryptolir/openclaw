#!/usr/bin/env python3
"""The diagnostic's D4 block: every container value comes from the agent's own docker.env
(agents_server_diagnostic.sh, the PYENV block; dashboard plan agent-keys-own-file-only, HK3).

Runs the block's real code, cut out of the script, against a stubbed `docker` that answers
`ps`, `inspect` and `compose config` from fixtures. The block reads secret values on a production
host, so the property that matters as much as what it flags is that it prints NAMES only.

Run: python3 scripts/ops/test_env_source_check.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "agents_server_diagnostic.sh")

STUB = r'''#!/usr/bin/env python3
import json, os, sys
fx = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.json")))
a = sys.argv[1:]
if a[:2] == ["ps", "-a"]:
    print("\n".join(fx["containers"]))
    sys.exit(fx.get("ps_exit", 0))
elif a[0] == "inspect":
    c = fx["containers"][a[1]]
    if c is None:
        sys.exit(1)
    print(json.dumps([{"Config": {"Env": c["env"], "Labels": c.get("labels")}}]))
elif a[0] == "compose":
    # the render must be asked for with an EMPTY environment, or it proves nothing
    leaked = sorted(k for k in os.environ if k not in ("PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_", "LC_CTYPE", "__CF_USER_TEXT_ENCODING"))
    if leaked:
        sys.exit("compose was given " + " ".join(leaked))
    r = fx["renders"].get(a[a.index("--project-name") + 1])
    if r is None:
        sys.exit(14)
    svc = "hermes-gateway" if "/.hermes/" in a[a.index("--env-file") + 1] else "openclaw-gateway"
    print(json.dumps({"services": {svc: {"environment": r}}}))
'''

RENDER = {"HOME": "/home/node", "OPENAI_API_KEY": "sk-file", "HERE_NOW": "file-value", "DOLLAR": "pa$$word",
          "GMAIL_APP_PASSWORD": "", "BARE": None, "OPENCLAW_GATEWAY_BIND": "lan"}
CLEAN = ["HOME=/home/node", "OPENAI_API_KEY=sk-file", "HERE_NOW=file-value", "DOLLAR=pa$word",
         "GMAIL_APP_PASSWORD=", "OPENCLAW_GATEWAY_BIND=lan", "NODE_VERSION=24.1.0", "UNLISTED=set-by-the-image"]
FOREIGN = [e for e in CLEAN if not e.startswith(("GMAIL_APP_PASSWORD=", "HERE_NOW="))] + [
    "GMAIL_APP_PASSWORD=FOREIGN-SECRET-1", "HERE_NOW=FOREIGN-SECRET-2", "BARE=FOREIGN-SECRET-3"]
COUNT = "gateway containers compared with their own docker.env"


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def check_code():
    with open(SCRIPT, encoding="utf-8") as f:
        text = f.read()
    start = text.index("<<'PYENV'")
    return text[text.index("\n", start) + 1:text.index("\nPYENV\n", start)]


def run(containers, renders, files, ps_exit=0):
    """containers: name -> {env, labels?} or None; renders: agent -> environment; files: own docker.env paths."""
    with tempfile.TemporaryDirectory() as d:
        bin_ = os.path.join(d, "bin")
        os.makedirs(bin_)
        for c in containers.values():
            if c is not None and "labels" not in c:
                c["labels"] = {"com.docker.compose.project.working_dir": d}
        write(os.path.join(bin_, "fixture.json"), json.dumps({"containers": containers, "renders": renders, "ps_exit": ps_exit}))
        write(os.path.join(bin_, "docker"), STUB)
        os.chmod(os.path.join(bin_, "docker"), 0o755)
        for rel in files:
            os.makedirs(os.path.dirname(os.path.join(d, rel)), exist_ok=True)
            write(os.path.join(d, rel), "SECRET_IN_THE_FILE=sk-file\n")
        write(os.path.join(d, "check.py"), check_code())
        env = {**os.environ, "PATH": bin_ + os.pathsep + os.environ["PATH"], "ENV_SOURCE_ROOT": d,
               "AIRTABLE_TOKEN": "exported-in-the-scanner's-own-shell"}
        r = subprocess.run([sys.executable, os.path.join(d, "check.py"), "dev"], capture_output=True, text=True, env=env)
        return r, [ln.split("|") for ln in r.stdout.splitlines()]


def own(agent, kind="openclaw"):
    return f".{kind}/agents/{agent}/docker.env"


class ContainerValuesComeFromTheAgentsOwnFile(unittest.TestCase):
    def test_a_container_made_from_its_own_file_is_quiet_and_counted(self):
        r, lines = run({"a-openclaw-gateway-1": {"env": CLEAN}, "h-hermes-gateway-1": {"env": CLEAN}, "postgres-1": {"env": FOREIGN}},
                       {"a": RENDER, "h": RENDER}, [own("a"), own("h", "hermes")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(lines, [["METRIC", "dev", "env-source", f"2 of 2 {COUNT}", "ok"]],
                         "equal, empty, `$`-escaped, defaulted and image-set values raise nothing; both kinds of gateway are compared, other containers are not")

    def test_a_value_the_file_does_not_hold_is_a_p1_by_name(self):
        r, lines = run({"a-openclaw-gateway-1": {"env": FOREIGN}}, {"a": RENDER}, [own("a")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(lines), 2, r.stdout)
        self.assertEqual(lines[0][:5], ["ISSUE", "P1", "dev", "a", "Container holds a value its own docker.env does not"])
        self.assertIn(": BARE GMAIL_APP_PASSWORD HERE_NOW - ", lines[0][5],
                      "a bare name the shell filled, a key the file lacks, and a key whose value differs")
        self.assertEqual(lines[1][3], f"1 of 1 {COUNT}")

    def test_a_value_that_is_empty_or_missing_in_the_container_is_not_compared(self):
        # A key the container lacks is the file -> container check's finding. Comparing it here
        # would also report every line added to the Compose file after the container was made.
        live = [e for e in CLEAN if not e.startswith(("OPENAI_API_KEY=", "HERE_NOW="))] + ["HERE_NOW="]
        r, lines = run({"a-openclaw-gateway-1": {"env": live}}, {"a": RENDER}, [own("a")])
        self.assertEqual(lines, [["METRIC", "dev", "env-source", f"1 of 1 {COUNT}", "ok"]], r.stdout)

    def test_it_prints_names_never_values(self):
        r, lines = run({"a-openclaw-gateway-1": {"env": FOREIGN}, "b-openclaw-gateway-1": {"env": CLEAN}}, {"a": RENDER}, [own("a"), own("b")])
        self.assertEqual([ln[4] for ln in lines[:2]], ["Container holds a value its own docker.env does not", "Env source check failed"])
        for leaked in ("FOREIGN-SECRET", "sk-file", "file-value", "pa$"):
            self.assertNotIn(leaked, r.stdout + r.stderr, "neither the container's value nor the file's is ever printed")

    def test_a_container_without_its_own_file_is_a_finding_not_a_skip(self):
        r, lines = run({"a-openclaw-gateway-1": {"env": CLEAN}}, {"a": RENDER}, [])
        self.assertEqual(lines[0][:5], ["ISSUE", "P1", "dev", "a", "Container has no docker.env of its own"])
        self.assertEqual(lines[1][3:], [f"0 of 1 {COUNT}", "warn"])

    def test_one_container_that_cannot_be_compared_does_not_stop_the_rest(self):
        # no render, no inspect output, a working-dir label naming a folder that is gone, and no
        # labels at all on a host with no /opt/hermes: each is its own finding, and z is still compared
        gone = {"com.docker.compose.project.working_dir": "/nonexistent/compose/dir"}
        r, lines = run({"a-openclaw-gateway-1": {"env": CLEAN}, "b-openclaw-gateway-1": None,
                        "c-openclaw-gateway-1": {"env": CLEAN, "labels": gone}, "d-hermes-gateway-1": {"env": CLEAN, "labels": None},
                        "z-openclaw-gateway-1": {"env": FOREIGN}},
                       {"c": RENDER, "d": RENDER, "z": RENDER}, [own(x) for x in "abcz"] + [own("d", "hermes")])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([ln[3:5] for ln in lines[:4]], [[x, "Env source check failed"] for x in "abcd"])
        self.assertEqual(lines[4][3:5], ["z", "Container holds a value its own docker.env does not"])
        self.assertEqual(lines[5][3:], [f"1 of 5 {COUNT}", "warn"])

    def test_a_docker_that_does_not_answer_is_not_a_pass(self):
        r, lines = run({}, {}, [], ps_exit=1)
        self.assertEqual(lines[0][3:], [f"0 of 0 {COUNT}", "warn"])
        self.assertEqual(lines[1][:5], ["ISSUE", "P2", "dev", "host", "Env source check failed"])

    def test_the_render_is_asked_for_with_an_empty_environment(self):
        # The stub refuses a `compose` call that carries AIRTABLE_TOKEN from the scanner's shell; with
        # it the render would show the scanner's exports as the file's values and hide a foreign key.
        r, lines = run({"a-openclaw-gateway-1": {"env": CLEAN}}, {"a": RENDER}, [own("a")])
        self.assertEqual(lines[-1][4], "ok", r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()

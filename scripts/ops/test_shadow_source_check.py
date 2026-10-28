#!/usr/bin/env python3
"""The diagnostic's shadow-source check (agents_server_diagnostic.sh, OB-43).

Runs the block's real code, cut out of the script, against a temp path in each state the
mount source can be in. Only a regular, zero-byte, non-symlink file is quiet.

Run: python3 scripts/ops/test_shadow_source_check.py
"""
import os
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "agents_server_diagnostic.sh")


def block():
    with open(SCRIPT, encoding="utf-8") as f:
        text = f.read()
    start = text.index("# >>> shadow-source")
    return text[start:text.index("# <<< shadow-source", start)]


def run(path):
    code = "H=test\nem(){ printf '%s\\n' \"$*\"; }\n" + block()
    r = subprocess.run(["bash", "-c", code], capture_output=True, text=True,
                       env={"PATH": os.environ["PATH"], "SHADOW_SRC": path})
    assert r.returncode == 0, r.stderr
    return r.stdout


class ShadowSource(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.p = os.path.join(self.d, "empty.env")

    def finding(self, title):
        out = run(self.p)
        self.assertEqual(out.count("ISSUE|P1|test|host|"), 1, out)
        self.assertIn(title, out)

    def test_a_regular_empty_file_is_quiet(self):
        open(self.p, "w").close()
        self.assertEqual(run(self.p), "")

    def test_a_missing_file_is_a_finding(self):
        self.finding("Shadow source file is MISSING")

    def test_a_directory_is_a_finding(self):
        os.mkdir(self.p)
        self.finding("Shadow source is a DIRECTORY")

    def test_a_non_empty_file_is_a_finding(self):
        with open(self.p, "w") as f:
            f.write("KEY=x\n")
        self.finding("Shadow source file is NOT empty")

    def test_a_symlink_to_an_empty_file_is_a_finding(self):
        # Only the -L branch can catch this one: the target passes every other test.
        target = os.path.join(self.d, "real")
        open(target, "w").close()
        os.symlink(target, self.p)
        self.finding("Shadow source is a symlink")

    def test_a_dangling_symlink_is_a_finding_and_creates_nothing(self):
        target = os.path.join(self.d, "nowhere")
        os.symlink(target, self.p)
        self.finding("Shadow source is a symlink")
        self.assertFalse(os.path.exists(target))

    def test_a_fifo_is_a_finding(self):
        os.mkfifo(self.p)
        self.finding("Shadow source is not a regular file")


if __name__ == "__main__":
    unittest.main()

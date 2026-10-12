#!/usr/bin/env python3
"""No ops script pipes into `grep -q` (OB-57).

Every script here runs under `set -o pipefail`. `grep -q` exits at the first match; if the
writer (printf, echo, dmesg, ss, curl, ...) is still writing, it gets SIGPIPE (141) and
pipefail makes the whole pipeline read as "no match". Measured on DevAgents 2026-10-12:
`printf '%s' "$DOC" | grep -qF resend.com` on the 16.7 KB DEPENDENCIES.md failed 235 of
3000 runs. The deps audit flagged a random set of documented hosts every day, and the
diagnostic could miss real log errors. Use `grep -q PATTERN <<< "$VAR"` (or
`<<< "$(cmd)"`) instead: a here-string has no writer process to kill.

Run: python3 scripts/ops/test_no_pipe_into_grep_q.py
"""
import glob
import os
import re
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PIPE_INTO_GREP_Q = re.compile(r"\|\s*grep\s+-[a-zA-Z]*q")


class NoPipeIntoGrepQ(unittest.TestCase):
    def test_no_ops_script_pipes_into_grep_q(self):
        hits = []
        for path in sorted(glob.glob(os.path.join(HERE, "*.sh"))):
            with open(path) as f:
                for n, line in enumerate(f, 1):
                    if line.lstrip().startswith("#"):
                        continue
                    if PIPE_INTO_GREP_Q.search(line):
                        hits.append(f"{os.path.basename(path)}:{n}: {line.strip()}")
        self.assertEqual(hits, [], "pipe into grep -q under pipefail (use a here-string):\n" + "\n".join(hits))

    def test_the_race_is_real_and_the_here_string_is_immune(self):
        # 200 KB, match at the very start: the writer is all but certain to be cut off.
        script = r'''
set -uo pipefail
DOC="resend.com"$'\n'"$(head -c 200000 /dev/zero | tr '\0' x)"; old=0; new=0
for i in $(seq 1 50); do
  printf '%s' "$DOC" | grep -qF resend.com || old=$((old+1))
  grep -qF resend.com <<< "$DOC" || new=$((new+1))
done
echo "$old $new"
'''
        old, new = map(int, subprocess.check_output(["bash", "-c", script], text=True).split())
        self.assertGreater(old, 0, "the pipe form should lose matches under pipefail")
        self.assertEqual(new, 0, "the here-string form must never lose a match")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""OB-14 compose shape (docs/experiments/plans/gateway-memory-ob14.md §6 T1).

The gateway's memory settings live in the shared compose file, which is edited often (every new
per-Agent env key lands there). These checks fail if an edit drops the heap flag, moves it after
the entry point or into NODE_OPTIONS, drops the native loader or the cgroup backstop, or leaks any
of them into the one-shot CLI service. Plain text, so it runs anywhere: no docker, no YAML library.

Run: python3 scripts/ops/test_compose_memory_caps.py
"""
import os
import re
import unittest

COMPOSE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docker-compose.yml")


def services(text):
    """Map each top-level service name to its block of lines."""
    blocks, name = {}, None
    for line in text.splitlines(keepends=True):
        m = re.match(r"^  ([a-z0-9-]+):\s*$", line)
        if m:
            name = m.group(1)
            blocks[name] = ""
        elif name:
            blocks[name] += line
    return blocks


def command(block):
    """The quoted items of a service's `command:` list, in order."""
    m = re.search(r"^    command:\s*\n\s*\[(.*?)\]", block, re.S | re.M)
    assert m, "no command list"
    return re.findall(r'"([^"]*)"', m.group(1))


class ComposeMemoryCaps(unittest.TestCase):
    def setUp(self):
        with open(COMPOSE) as f:
            self.svc = services(f.read())
        self.gw = self.svc["openclaw-gateway"]
        self.cli = self.svc["openclaw-cli"]

    def test_heap_flag_is_the_node_argument_before_the_entry_point(self):
        cmd = command(self.gw)
        self.assertEqual(cmd[0], "node")
        i = cmd.index("dist/index.js")
        self.assertEqual(cmd[i - 1], "--max-old-space-size=${OPENCLAW_MAX_OLD_SPACE_MB:-768}")

    def test_native_plugin_loading_is_on_by_default(self):
        self.assertIn("      JITI_TRY_NATIVE: ${OPENCLAW_JITI_TRY_NATIVE:-1}\n", self.gw)

    def test_cgroup_backstop(self):
        self.assertIn("    mem_limit: ${OPENCLAW_MEM_LIMIT:-1536m}\n", self.gw)

    def test_heap_flag_not_in_node_options(self):
        # NODE_OPTIONS is inherited by MCP servers and exec children (plan §3.2).
        self.assertNotIn("NODE_OPTIONS", self.gw)

    def test_cli_service_untouched(self):
        for needle in ("max-old-space-size", "JITI_TRY_NATIVE", "mem_limit"):
            self.assertNotIn(needle, self.cli)


if __name__ == "__main__":
    unittest.main()

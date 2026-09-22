#!/usr/bin/env bash
# Copies the personal skill (~/.claude/skills/hld-for-existing-code) into this plugin and rewrites its absolute paths to
# <skill-dir>, so the plugin works wherever Claude Code installs it. Run from anywhere.
set -euo pipefail
SRC="${1:-$HOME/.claude/skills/hld-for-existing-code}"
DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/plugins/hld-for-existing-code/skills/hld-for-existing-code"
[ -f "$SRC/SKILL.md" ] || { echo "no SKILL.md in $SRC" >&2; exit 1; }
rm -rf "$DEST" && mkdir -p "$DEST" && cp -R "$SRC/." "$DEST/" && find "$DEST" -name .DS_Store -delete
rm -rf "$DEST/runtime"   # local Playwright install (--install-playwright) never goes into the plugin
python3 - "$DEST" <<'PY'
import sys, os
d = sys.argv[1]
note = ("\n> `<skill-dir>` below is this skill's own folder — the base directory shown when the skill loads\n"
        "> (installed as a plugin it lives in Claude Code's plugin cache, not in `~/.claude/skills`). Use that absolute\n"
        "> path in every command.\n")
for name in ('SKILL.md', 'README.md'):
    p = os.path.join(d, name)
    s = open(p).read().replace('~/.claude/skills/hld-for-existing-code/', '<skill-dir>/')
    if name == 'SKILL.md' and '<skill-dir>` below' not in s:
        i = s.index('\n# HLD for existing code\n') + len('\n# HLD for existing code\n')
        s = s[:i] + note + s[i:]
    open(p, 'w').write(s)
PY
echo "synced $SRC → $DEST"
command -v claude >/dev/null && claude plugin validate "$(dirname "$DEST")/.." | tail -1 || true
echo "remember to bump version in plugins/hld-for-existing-code/.claude-plugin/plugin.json and .claude-plugin/marketplace.json"

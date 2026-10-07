#!/usr/bin/env bash
# commit.sh BRIEF: runs the brief's last "git add ... / git commit -m" block, adding the session trailers.
set -euo pipefail
block=$(awk '/Step [0-9]+: Commit/{f=1;b=""} f&&/^```bash/{c=1;next} c&&/^```$/{c=0;f=0;last=b;b=""} c{b=b $0 "\n"} END{printf "%s", last}' "$1")
add=$(printf '%s' "$block" | grep '^git add ')
msg=$(printf '%s' "$block" | sed -n 's/^git commit -m "\(.*\)"$/\1/p')
eval "$add"
git commit -q -m "$msg" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FH2h7uPkhHvWtbotLYWPsQ"
git log --oneline -1

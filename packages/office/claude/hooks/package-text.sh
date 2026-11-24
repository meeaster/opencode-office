#!/bin/sh
# Claude Code's SessionStart hook for the text the office's packages add to every session, as
# `office instructions --packages` prints it from the settings the last sync applied: the same
# text the office package's OpenCode plugin attaches. The office is the one holding this plugin
# (CLAUDE_PLUGIN_ROOT is <office>/.office/packages/office/claude), else the session's folder.
root=${CLAUDE_PLUGIN_ROOT%/.office/packages/office/claude}
if [ "$root" = "${CLAUDE_PLUGIN_ROOT-}" ]; then root=.; fi
command -v office >/dev/null 2>&1 || { echo "office: no office on PATH, so this session gets no package text" >&2; exit 0; }
office --office "$root" instructions --packages || echo "office: office instructions --packages failed, so this session gets no package text" >&2
exit 0

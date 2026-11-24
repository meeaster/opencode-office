---
name: opencode-sessions
description: Search past OpenCode sessions for a discussion, decision, or recurring user correction using the session database.
---

# OpenCode sessions

Run `opencode debug paths` **where the server that held the conversation runs**. Use its `db` path: the host and the office container can have different histories. `opencode session list` is scoped to the current project; a conversation about a repo may have started at the office root or under its old checkout path.

Open the database read-only. This example uses Python's standard library (no `opencode db` command or `sqlite3` executable needed). Pass a repo name or distinctive phrase and the reported database path:

```sh
python3 - '/path/from/debug/paths' 'search term' <<'PY'
import sqlite3, sys
from pathlib import Path

db = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True)
term = "%" + sys.argv[2] + "%"
for row in db.execute("""
    SELECT s.id, s.title, s.directory FROM session_v2 s
    WHERE s.parent_id IS NULL AND (s.directory LIKE ? OR s.title LIKE ? OR EXISTS (
      SELECT 1 FROM session_message m WHERE m.session_id = s.id AND m.type = 'user'
      AND json_extract(m.data, '$.text') LIKE ?))
    ORDER BY s.time_updated DESC LIMIT 25
""", (term, term, term)):
    print(*row, sep="\t")
PY
```

Pick relevant sessions, excluding the current request. With the same connection, read their user turns in order:

```python
for seq, text in db.execute("""
    SELECT seq, json_extract(data, '$.text') FROM session_message
    WHERE session_id = ? AND type = 'user' ORDER BY seq
""", (session_id,)):
    print(seq, text)
```

If a reply like “yes, the second one” needs context, inspect the nearby assistant turns with `opencode session export <session-id>` on that server. Distinguish a proposal from what the user ultimately chose. Cite the session title and the relevant decision; keep unrelated transcript details out of the answer.

These queries target OpenCode V2. On a schema mismatch, inspect `sqlite_schema` and `PRAGMA table_info(...)` before adapting them. Legacy and V2 tables can coexist; an empty legacy `session` table does not mean the history is empty.

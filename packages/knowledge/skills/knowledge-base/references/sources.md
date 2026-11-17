# Sources

A source is a record of something that happened: what people said in a meeting, an email or chat thread, a ticket's comments, a page someone wrote, read at a version. It keeps their words so a later reader can check what was said without asking. Sources are never edited; only a thread grows by adding later messages at its end.

What a source says is what people stated, not a fact about a system. It reaches an article as a cited source, after the user accepts what it settles; a [statement](#statements) is the user's own, so it needs no further acceptance.

## Front matter

Every source file starts with:

```markdown
---
kind: email
occurred: 2026-10-03
description: Security GRC on whether customer traffic may terminate in Shared Tooling.
---
```

`kind` is `meeting`, `email`, `chat`, `ticket`, `page`, `statement` or a new kind named for what it is. `occurred` is when it happened, or when the thread started. `description` says what it's about in one line.

## Message threads

An email, chat or ticket thread is one file in `sources/email/`, `sources/chat/` or `sources/tickets/`, named for its subject (`sources/email/sec-12-customer-ingress.md`).

- Messages oldest first, each under `## <date> [time] · <sender> (<team or role>)`, in the sender's words. Trim quoted earlier messages and signatures, keeping what the sender added. Name attachments and excerpt the parts that matter.
- Later replies go at the end of the same file. A side thread or a new subject starts its own file that names the one it came from.
- A page or ticket whose words settle something is saved the same way at `sources/pages/<page>.md` or `sources/tickets/<key>.md`, naming the version or comment it was read through.

```markdown
---
kind: email
occurred: 2026-10-03
description: Security GRC on whether customer traffic may terminate in Shared Tooling.
---

# Email · SEC-12 and customer ingress

People: Alex (Security GRC), Priya (platform lead), the user

## 2026-10-03 09:14 · Alex (Security GRC)

Customer traffic can't terminate inside Shared Tooling. Section 4.2 of SEC-12 is below.

> Customer-originated traffic shall not terminate in an internal-tools enclave.
```

## Meetings

A meeting gets a folder, `sources/meetings/<yyyy-mm-dd>-<subject>/`, so its summary stays beside what it summarizes. Each file in it has the source front matter.

| File | Holds |
| --- | --- |
| `transcript-raw.md` | The raw transcript or notes, unchanged |
| `transcript.md` | Cleaned: speakers labelled by role, filler removed, nothing added |
| `summary.md` | What was discussed, what was decided in the meeting (with who decided, as stated), what was suggested and by whom, what was left open, and the action items with their owners and dates, as said |

A recording is linked from the summary by its URL or path, never copied. Everything decided or suggested in a meeting is a candidate until the user accepts it: a colleague's agreement is not the user's decision.

## Statements

What the user says in a session is lost to everyone else when the session ends. When they state something later work should rely on, such as how a system is run, a fact they know firsthand, or a standing position on a subject, save it as a statement: one file at `sources/statements/<yyyy-mm-dd>-<subject>.md`, `kind: statement`, `occurred` the day they said it. Save it when they ask, or when an article you are writing rests on it. A passing remark stays in the session.

- Keep their words, quoted where you have them. Label a paraphrase as one, and keep apart what they stated from what you proposed and they agreed to.
- Name the session by its catalog ID as provenance (`Stated in session opencode:ses_…`); nothing depends on it resolving.
- A later statement that revises an earlier one is a new file naming the earlier one. Articles cite the latest.
- A statement about the work rather than about a system, such as a choice for one change, goes where that work is recorded, not here.

```markdown
---
kind: statement
occurred: 2026-11-05
description: The user on network configuration ownership.
---

# Network configuration ownership · the user's statement

Stated in session <catalog ID>.

> The platform team owns the network configuration. Service teams own their application configuration.

Application changes do not require the platform team's approval (paraphrase).
```

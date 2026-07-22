---
title: My OpenCode Database Was Mostly Empty Space
description: OpenCode keeps durable session history in SQLite. My database had grown past a gigabyte, but most of it was freelist pages. I wrote ocdbc to measure the bloat and run the safe SQLite cleanup sequence.
pubDate: 2026-07-22
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - sqlite
---

OpenCode keeps a lot of useful history.

That is one of the reasons I like it. A coding-agent session is not just a chat transcript. It is a record of what I asked, what the agent did, which tools ran, what failed, what got fixed, and what context existed at the time. I have argued before that the agent session is becoming a log file. I still believe that.

Then I noticed the log file was getting large.

On one machine, `~/.local/share/opencode/opencode.db` had grown past a gigabyte. That was not shocking by itself. I use OpenCode heavily. Long sessions produce many messages, tool results, shell outputs, file reads, and state transitions. A local database growing over time is expected.

What was surprising was what SQLite reported after looking inside the file: much of it was not live data anymore.

It was empty space.

---

## The misleading part of deleting data

Most developers learn an intuitive model of storage that is only partly true.

If I delete rows from a database, I expect the database file to get smaller. If I archive old sessions, compact history, or remove records, I expect disk usage to fall. At the application level, that feels right: fewer records should mean fewer bytes.

SQLite does not normally work that way.

When rows are deleted, SQLite can reuse the freed pages for future writes, but it does not necessarily return those pages to the filesystem. The file can stay the same size while containing a growing internal pool of reusable pages. That pool is the freelist.

The important distinction is:

```text
database file size != live data size
```

The file can be 1.3 GB while the live data is only 525 MB. The remaining 766 MB can be pages SQLite is keeping around for reuse. From SQLite's perspective, that space is available. From the filesystem's perspective, it is still occupied.

That is not corruption. It is not necessarily a bug in the data model. It is how SQLite behaves unless the database is configured and vacuumed in a way that returns free pages to the OS.

For a normal application database, this may not matter. For a local agent runtime that stores every tool-heavy session in one file, it becomes noticeable.

---

## Why OpenCode makes this visible

Agent sessions are unusually good at producing large, bursty storage.

A normal chat app stores messages. A coding agent stores messages plus tool calls, tool results, shell output, file contents, structured parts, todos, events, and session metadata. A single task can contain a surprising amount of durable state.

OpenCode also has session compaction. Compaction is useful for model context management, but it is easy to confuse three different layers:

| Layer | What changes |
| --- | --- |
| Model-visible context | Older conversation can be summarized behind a checkpoint. |
| Durable history | Original rows can still exist in the database. |
| SQLite file layout | Deleted or obsolete pages may remain inside the file as freelist space. |

Compaction helps the model continue when context gets too large. It does not mean the database file shrinks. Even when rows are removed by some maintenance path, SQLite may keep the freed pages in the same file.

This is the kind of problem that is easy to misdiagnose if you only look at `du -h opencode.db`. A large file does not tell you how much live data exists. It only tells you how much disk the file currently occupies.

The first tool I wanted was not a cleaner. It was a measurement.

---

## The useful number is freelist percentage

SQLite already exposes the numbers needed to understand the problem:

```sql
PRAGMA page_size;
PRAGMA page_count;
PRAGMA freelist_count;
```

From those values, the diagnosis is simple:

```text
freelist_bytes = freelist_count * page_size
live_bytes = (page_count - freelist_count) * page_size
freelist_pct = freelist_count / page_count
```

That gives a more useful report than raw file size:

```text
OpenCode Database Health Report
----------------------------------------------------------
  File size:     1.3 GB
  Page size:     4.0 KB
  Journal mode:  wal
  Auto-vacuum:   OFF (NONE)

Storage
----------------------------------------------------------
  Live data:     525 MB
  Freelist:      766 MB  (56% of file)
  -> VACUUM would reclaim ~766 MB
  -> Estimated result:  ~525 MB
```

This changes the conversation. The question is no longer "why is the database 1.3 GB?" The better question is "how much of this file is still live data?"

If the freelist is small, there is nothing urgent to do. If half the file is freelist pages, a cleanup can reclaim real disk space.

That became [`ocdbc`](https://github.com/chncaesar/opencode-db-clean): OpenCode Database Cleaner.

---

## Why I did not want a clever cleaner

The dangerous version of this tool would delete sessions.

That is not what I wanted. I did not want a policy engine deciding which conversations were old, stale, low-value, or safe to remove. Agent sessions are evidence. They contain exactly the kind of messy operational detail I often need later: commands, errors, constraints, design decisions, failed attempts, and verification output.

So `ocdbc` has a narrower job.

It does two things:

```bash
ocdbc analyze
ocdbc vacuum
```

`analyze` is read-only. It reports database size, live data, freelist space, table sizes, session age distribution, and the largest messages.

`vacuum` does not decide what history should exist. It asks SQLite to rebuild the database file so unused pages can be returned to the filesystem. The goal is physical cleanup, not semantic deletion.

That boundary matters. A tool that deletes history needs product policy. A tool that reports freelist space and runs a safe SQLite maintenance sequence can stay much smaller.

---

## The safety sequence matters

`VACUUM` sounds boring until you remember what file it is operating on.

This is the local database for an agent runtime. If OpenCode is running while the database is being rebuilt, I do not want to discover edge cases by corrupting my own session history. If the write-ahead log has committed data that has not been checkpointed into the main database file, I do not want to back up an incomplete view. If the database is already corrupt, I do not want the cleanup tool to make the failure harder to reason about.

So `ocdbc vacuum` is intentionally conservative.

The sequence is:

1. Refuse to run if `fuser` shows OpenCode still has the database open.
2. Checkpoint the WAL before copying the database.
3. Run `PRAGMA integrity_check` before making changes.
4. Create a timestamped backup.
5. Open the backup and verify its integrity too.
6. Set `auto_vacuum = INCREMENTAL` so future free pages can be reclaimed incrementally.
7. Run `VACUUM` to rebuild the file.
8. Re-enable WAL, because `VACUUM` can reset journal mode.
9. Run a final integrity check.

The order is the point.

Checkpoint before backup means the `.db` file contains committed WAL data before it is copied. Verifying the backup means the fallback is not just a file that happened to exist. Refusing to run while another process has the database open prevents a maintenance tool from racing the application it is trying to help.

There are override flags, but they are explicit:

```bash
ocdbc vacuum --force
ocdbc vacuum --skip-fuser --force
ocdbc vacuum --no-backup --force
```

The default path optimizes for not losing data.

---

## A small tool is enough

The whole package is a single Python module with no runtime dependencies. Installation is intentionally uninteresting:

```bash
pip install ocdbc
```

Then:

```bash
ocdbc analyze
```

If the report shows significant freelist bloat, close OpenCode and run:

```bash
ocdbc vacuum
```

That is it.

The tool does not need a daemon. It does not need to understand model context. It does not need to parse sessions or judge which messages matter. It only needs to expose the maintenance operation I wanted OpenCode users to have available when the database file becomes misleadingly large.

That is the pattern I keep coming back to with agent tooling. The best tool is often not the most intelligent one. It is the one that gives the agent or developer a missing primitive with a tight safety boundary.

For readiness checks, that primitive was `wait_for`: poll a URL, port, or command until the condition is actually true.

For session review, that primitive was `session_reflection`: treat recent sessions as evidence instead of disposable scrollback.

For OpenCode database bloat, the primitive is `ocdbc`: show the difference between live data and empty pages, then run the boring SQLite cleanup correctly.

---

## The broader lesson

AI-assisted development creates new kinds of local infrastructure.

The agent runtime is not just a prompt window. It has tools, permissions, sessions, transcripts, databases, plugins, logs, background state, and failure modes. Once that runtime becomes part of daily work, it needs the same boring maintenance primitives every other developer toolchain needs.

Sometimes the fix is not a better model.

Sometimes it is knowing that your 1.3 GB database contains 766 MB of empty pages, closing the app, checkpointing the WAL, verifying a backup, running `VACUUM`, and getting your disk space back.

That is not glamorous.

It is exactly the kind of boring tool I want more of.

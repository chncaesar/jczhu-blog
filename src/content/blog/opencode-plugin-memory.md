---
title: "OpenCode Needs Memory, Not Another Background Pipeline"
description: "opencode-plugin-memory gives OpenCode project-scoped, inspectable long-term memory with four agent tools and a bounded prompt summary, without a cloud service or background consolidation job."
pubDate: 2026-08-27
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - context-engineering
  - memory
---

I kept explaining the same project facts to new OpenCode sessions.

Not the durable rules that already belonged in `AGENTS.md`. Those were present. The repetition was smaller and more frustrating: a project-specific convention discovered while fixing a bug, a user preference expressed during a review, or a workflow detail that was useful but too narrow to turn into permanent team policy.

OpenCode already preserves sessions, loads explicit instructions, and compacts long conversations. Those are valuable systems, but none answers a simple cross-session question: after an agent learns something reusable in this project, how does the next session know it?

I built [opencode-plugin-memory](https://github.com/chncaesar/opencode-plugin-memory) as a deliberately small answer. It gives the active OpenCode agent four memory tools, stores knowledge as project-local Markdown, and automatically injects a compact index into future system prompts.

The point is not to make every conversation permanent. The point is to stop rediscovering the lessons that should survive.

## The gap between instructions and history

There are two tempting but incomplete answers to persistent agent knowledge.

The first is `AGENTS.md`. It is the right place for rules that must govern behavior: required verification commands, architectural boundaries, security constraints, and repository conventions. It is explicit, reviewable, and authoritative. A model should not have to infer a release requirement from a previous chat.

The second is session history. It records what happened, but a new session does not automatically search old conversations for a relevant decision. Even if it did, raw history is a poor instruction source. It contains tentative ideas, failed attempts, stale facts, and untrusted tool output alongside useful conclusions.

The missing layer is selective recall:

```text
AGENTS.md       -> mandatory, authored instructions
session history -> evidence about one conversation
project memory  -> selected lessons useful in later sessions
```

That distinction came out of my earlier source-level analyses of [what OpenCode actually remembers](https://jczhu.com/blog/opencode-memory-internals/) and [how Codex runs its local-memory pipeline](https://jczhu.com/blog/codex-memory-internals/). OpenCode core intentionally stops short of a general long-term memory service. Codex takes the opposite route: a background, two-model pipeline extracts and consolidates eligible prior rollouts.

Both choices make sense. But for a single developer working inside one repository, I wanted a third option: no cloud service, no vector database, no delayed consolidation worker, and no opaque state outside the project.

## A memory layer the active agent owns

`opencode-plugin-memory` follows a hot-path design. The active agent decides whether a lesson is worth retaining while it has the task context that makes the judgment meaningful.

It registers four tools:

- `memory_add` saves a reusable project fact or convention.
- `memory_update` corrects or expands an existing memory.
- `memory_delete` archives an obsolete entry instead of erasing it.
- `memory_read` retrieves full entries, optionally filtered by keyword.

The tool descriptions give the agent a narrow policy. It should save an explicit "remember this" request, a recurring bug lesson, a project convention, or a correction that future sessions should respect. It should not save the file it happens to be editing, generic programming advice, or information already documented in `AGENTS.md`.

That policy matters more than a large store. A memory system that records every task turns future prompts into an untrusted, noisy transcript. This plugin asks for small, deliberate promotion decisions at the moment the evidence is fresh.

The store is ordinary Markdown under the project directory:

```text
.opencode/memory/
  MEMORY.md
  memory_summary.md
  plugin.log
```

`MEMORY.md` is the source of truth. You can open it in an editor, review what the agent has learned, correct an entry directly, or restore an archived item. The generated `memory_summary.md` is only an index. It lists active memory IDs, titles, and tags within a configurable character budget.

On every OpenCode system-prompt transform, the plugin appends that summary to the prompt. The agent has ambient awareness that the project has relevant memory without paying to load the entire handbook on every turn. When a title looks relevant, it calls `memory_read` for the details.

That is progressive disclosure with plain files:

```text
bounded summary in every prompt
        -> agent recognizes a relevant topic
        -> memory_read loads the full entry
```

It is simpler than semantic retrieval and, for a compact project knowledge base, easier to inspect when the agent makes a bad decision.

## Why Markdown is a feature

Agent memory is often described as a retrieval problem. That framing tends to lead straight to embeddings, vector stores, hidden profiles, and ranking systems. Those tools can be appropriate when an application must search a large, multi-user corpus.

They are not automatically appropriate for a coding project.

For project memory, the harder questions are authority and lifecycle:

- Is this a hard rule, a reusable lesson, or a temporary hypothesis?
- Can a developer see exactly what will influence a future agent?
- What happens when an API, preference, or workflow becomes obsolete?
- Can a mistaken memory be corrected without administering another service?

Markdown gives direct answers. The user owns the file. The agent's operations are visible. IDs are sequential, so references remain stable. Deletes are soft deletes: the entry moves to an `Archived` section, preserving a review path rather than pretending old knowledge never existed.

The plugin also maintains an optional append-only `plugin.log` for add, update, delete, and error events. This is not a cryptographic audit trail, and it is not meant to be one. It is a practical way to see when the memory layer changed.

Transparency is not only a usability choice. A memory entry becomes part of an agent's future decision context. A local, human-readable store makes that influence inspectable before it becomes mysterious.

## Install it in one configuration block

The plugin is available at [github.com/chncaesar/opencode-plugin-memory](https://github.com/chncaesar/opencode-plugin-memory). Add a local clone or package reference to OpenCode's plugin configuration:

```jsonc
// opencode.json or ~/.config/opencode/opencode.jsonc
{
  "plugin": [
    ["/path/to/opencode-plugin-memory", { "maxSummaryChars": 3000 }]
  ]
}
```

The default summary budget is 2,000 characters, roughly 500 tokens. Raise it when a project has more distinct memory topics; keep it small when prompt cost matters more than ambient recall. Set `enableLog` to `false` if the operation log is not useful for your workflow.

The memory directory is created on the first write. There is no server to provision, account to create, or migration to run.

After installation, the useful interaction is intentionally ordinary. Tell the agent to remember a durable lesson when it appears. For example: after finding that a repository requires a specific local verification sequence, the agent can save the reusable workflow detail. In a later session, the summary exposes the title, and the agent can read the full entry before proposing a change.

The result is not an agent that claims perfect recall. It is an agent with a visible project notebook that it can maintain itself.

## What this plugin does not try to solve

Small scope is part of the design.

It does not replace `AGENTS.md`. Mandatory project rules should remain in explicit instructions, where they are always loaded and reviewed as policy. Memory is for selected recall, not the only copy of a requirement that must be followed.

It does not mine every past session in the background. Codex's extraction and consolidation pipeline addresses a different problem: automatically turning a large body of historical work into a curated memory workspace. This plugin puts the decision in the active agent's tool call instead, avoiding a second model, delayed processing, and another trust boundary.

It does not use a vector database. Search is keyword-based and the summary index provides ambient routing. That is a conscious trade-off for modest, project-scoped collections where inspectability is more valuable than fuzzy recall.

It does not add concurrent-write locking. The intended model is normal single-user project work; concurrent OpenCode sessions writing the same `MEMORY.md` need stronger coordination and tests before that complexity is justified.

Those limitations are not hidden caveats. They define the product. If you need a background policy, evidence retention, semantic search across thousands of conversations, or multi-user conflict resolution, use a system designed for that scale. If you want a local memory layer that remains understandable in a text editor, this is the narrower tool.

## The useful middle ground

The choice is not between manual instructions and an elaborate autonomous memory platform.

For many OpenCode projects, there is a useful middle ground: keep rules in `AGENTS.md`; keep conversations in their session records; let the active agent promote only the reusable lessons into a small, visible, project-scoped memory file.

[opencode-plugin-memory](https://github.com/chncaesar/opencode-plugin-memory) implements that middle ground. It makes continuity across sessions a deliberate, inspectable capability instead of a hope that the next agent will rediscover the same context.

For adjacent tools that keep an OpenCode workflow reliable, including readiness checks, database maintenance, session reflection, and multi-machine coordination, see the [OpenCode Reliability Toolkit](https://jczhu.com/opencode-tools/).

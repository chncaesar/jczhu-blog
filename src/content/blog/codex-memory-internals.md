---
title: "Codex Memory Internals: What It Remembers, Who Decides, and How It Compares to OpenCode"
description: "A source-level analysis of Codex's local memory pipeline: autonomous extraction, consolidation, evidence-driven forgetting, progressive retrieval, and the design trade-offs against OpenCode and newer agent-memory systems."
pubDate: 2026-08-25
tags:
  - ai-coding
  - codex
  - opencode
  - agent-workflow
  - context-engineering
  - memory
---

I began this investigation with a specific question: can Codex autonomously add, modify, and delete its own memories? The product documentation already says that it has memory. What I wanted to know was who actually decides what survives.

When an old chat contains a useful build command, does deterministic application code copy it into a database? Does the active coding model call a memory tool? Does another model summarize the chat later? When the command becomes obsolete, is the old fact overwritten, invalidated, aged out, or simply left where future agents may still find it?

Those questions led to a more interesting result than a feature checklist. Codex has a genuine cross-session memory subsystem, but its behavior is split between model judgment and deterministic lifecycle code. Models decide what a rollout means and how durable guidance should be rewritten. Runtime code decides which rollouts are eligible, which evidence remains in the working set, when old records are deleted, and when the consolidation model is allowed to run.

That makes the short answer precise:

> With local memories enabled, Codex can autonomously add, modify, merge, and remove persistent memory without a user approving each write. User-requested corrections follow a separate append-only note path, while retention, thread deletion, and reset provide additional forms of forgetting.

The rest of this article explains why each word in that answer matters.

This analysis is pinned to [OpenAI Codex commit `8444cf63b50a8a88521e0d2970d49f659b48eac7`](https://github.com/openai/codex/commit/8444cf63b50a8a88521e0d2970d49f659b48eac7), checked on August 25, 2026. The feature is marked stable in that source tree but remains off by default, so this describes implemented behavior, not behavior every Codex user is currently receiving.

## Key Takeaways

1. **Codex local memory is a background two-model pipeline.** One model extracts reusable material from each eligible rollout. A second model consolidates those outputs into a global file-based memory workspace.

2. **The LLM owns semantic CRUD, but not lifecycle scheduling.** Prompts ask the models to decide what is useful, merge new evidence, rewrite stale guidance, preserve uncertainty, and remove claims whose evidence disappeared. Rust and SQLite code choose candidates, enforce leases, rank inputs, prune old rows, and synchronize files.

3. **Forgetting has several independent mechanisms, not one delete operation.** Codex can delete an old extraction after a later no-op, drop rollout summaries that leave the selected set, ask the consolidation agent to remove unsupported guidance, prune unused database rows, remove expired extension resources, forget memory attached to a deleted thread, or reset the entire memory store.

4. **Retrieval is progressive disclosure, not vector RAG.** A bounded `memory_summary.md` is injected into developer instructions. The model then searches `MEMORY.md` and opens one or two supporting summaries or skills when needed.

5. **Usage feeds retention.** Memory citations contain rollout IDs. When Codex emits a citation, runtime code increments usage counts and timestamps for the corresponding Phase 1 records. Later consolidation prefers frequently and recently used evidence.

6. **User corrections are indirect and permission-dependent.** After a direct request, Codex can create an append-only ad-hoc note when dedicated memory tools are enabled or the active permission profile separately permits the write. The next consolidation pass interprets that note and updates the generated memory artifacts.

7. **`AGENTS.md`, session persistence, compaction, and long-term memory remain different systems.** Team rules belong in explicit instructions. Rollouts record what happened. Compaction keeps one conversation within its context budget. The memory pipeline promotes selected lessons across conversations.

## The Pipeline I Found

Before the pipeline, a definition. A **rollout** is Codex's term for the complete recorded history of one session: user messages, model responses, tool calls and outputs, turn boundaries, and session metadata, all persisted as a single file under the session directory. It is the raw transcript of one conversation, and it is the input the memory pipeline mines for reusable lessons.

The implementation lives across four layers:

```text
eligible prior rollouts
        |
        v
Phase 1 extraction model
        |
        v
SQLite stage1_outputs
        |
        v
selected evidence + git workspace diff
        |
        v
Phase 2 consolidation agent
        |
        v
memory_summary.md -> MEMORY.md -> summaries / skills / source rollouts
```

The trigger is more precise than "when a session starts." Memory work is dispatched only after a fresh turn that carries user input has successfully started and the primary environment is configured. The "worker" here is the background task Codex spawns to run that memory pipeline — an asynchronous routine, not a separate process or an independent agent. It returns without doing anything if the session is ephemeral, the `memories` feature is disabled, the session is a sub-agent rather than a root agent, or the state database is missing.

Once dispatched, the worker runs in the background. It first deletes old, unused extraction rows, then checks the remaining Codex rate-limit percentage; if quota is low, it skips the model work rather than spend tokens near a limit.

The defaults reveal the intended operating model. The `MemoryTool` feature is stable but off by default, and enabling it turns on both generating and using memories. Extraction only looks back at the previous ten days of rollouts and skips anything that has been idle for fewer than six hours. Consolidation keeps at most 256 raw inputs at a time, and any memory that goes thirty days without use reaches the retention boundary and becomes eligible for pruning.

Those numbers are cost and growth controls, not judgments about meaning. They decide which experiences are worth processing and how much state to keep; the models still decide what the surviving content actually means.

## Phase 1: A Model Decides What A Rollout Taught

Phase 1 scans recent interactive root threads whose per-thread memory mode is enabled. It excludes the current thread and rollouts that are too fresh, too old, already current, being processed elsewhere, or outside the bounded startup claim.

For every claimed rollout, Codex loads the recorded items, filters them to memory-relevant model input, and sends the result to a dedicated extraction model with a strict JSON schema. The sanitizer drops developer messages, marked `AGENTS.md` and skill injections, and compaction records before the rollout reaches the extractor. The model must return:

- `raw_memory`
- `rollout_summary`
- an optional `rollout_slug`

The prompt is unusually explicit about epistemic discipline. User messages are the strongest source for preferences. Tool outputs and verification evidence are the strongest source for repository facts. Assistant proposals should not silently become durable truth. Secrets must be redacted, temporary metrics should be skipped, and a no-op is preferred when a future agent would not plausibly act better because of the memory.

This is autonomous creation, but it is selective creation. A successful extraction upserts one `stage1_outputs` row per thread. If the source rollout later changes, a newer extraction replaces the old row. If the new model pass returns an empty result, Codex deletes any previous extraction for that thread and schedules consolidation so the higher-level files can forget what no longer has support.

That last case is easy to miss. "No useful memory" is not only an absence of creation. On a regenerated rollout, it can become a deletion signal.

## Phase 2: A Model Rewrites The Global Memory

Phase 2 is not a simple concatenation job. It first takes a global lease — a timed lock with an ownership token and periodic heartbeats — so that only one consolidation task can touch the shared memory files at a time, and a crashed worker eventually releases the lock by letting its lease expire. Only then does it select a bounded set of Phase 1 records and materialize them under `~/.codex/memories/`.

The selection algorithm prefers `usage_count`, then recent `last_usage`, then source recency. Never-used records use their source update time as the fallback. Records outside the unused-memory window are ineligible.

Runtime code rebuilds `raw_memories.md`, writes one Markdown file per selected rollout under `rollout_summaries/`, and removes old summary files that are no longer selected. The memory directory is managed as a small Git baseline repository. Codex computes a bounded diff from the previous successful consolidation and writes it to `phase2_workspace_diff.md`.

If nothing changed and the required output files are valid, Phase 2 exits without calling a model. If inputs were added, modified, or deleted, it starts an internal consolidation agent with:

- approval policy set to `Never`;
- collaboration, apps, plugins, MCP servers, and memory recursion disabled;
- memory-root-only write access and no network when the parent uses a Codex-managed permission profile;
- the parent's enforcement choice preserved when Codex sandboxing is explicitly disabled or delegated to an external sandbox;
- a medium-reasoning consolidation model.

The consolidation prompt gives that agent semantic ownership of three outputs:

- `MEMORY.md`, the retrieval-oriented handbook;
- `memory_summary.md`, the compact index injected into future prompts;
- optional reusable packages under `skills/`.

`MEMORY.md` has a deliberate structure that makes the read path work. Its top-level unit is a `# Task Group` block, one per task family, headed by a `scope:` line and an `applies_to:` line that preserves the working-directory boundary so similar tasks in different checkouts are not confused. Inside each block, `## Task <n>` sections come first, each carrying `### rollout_summary_files` (with `cwd`, `rollout_path`, `updated_at`, and `thread_id`) and `### keywords` for grep-style retrieval. After the task list come three consolidated sections: `## User preferences`, `## Reusable knowledge`, and `## Failures and how to do differently`, each bullet traceable back to task references like `[Task 1]`.

This shape is why retrieval can be lexical instead of vector-based: the routing handles live in stable headings and keywords, and the durable guidance lives just below them. `memory_summary.md` then sits above `MEMORY.md` as a denser, token-budgeted index rather than a second handbook.

The agent is instructed to incrementally merge new evidence, update contradictory guidance, preserve uncertainty when validation is unclear, and minimize churn when existing material is still correct. It must retain task-level provenance through rollout-summary paths, thread IDs, working directories, and update timestamps.

Most importantly, the prompt defines forgetting. Deleted rollout summaries and extension resources form a stale-cleanup queue. The agent searches for memory supported by those inputs, removes only unsupported guidance, preserves facts that still have other evidence, and then cleans the corresponding entries from the summary index.

The runtime verifies that `MEMORY.md` exists and that `memory_summary.md` starts with the expected schema marker. It removes symlinks from the workspace. Only after a valid completion does it reset the Git baseline and mark the exact Phase 1 snapshots as consumed.

The semantic result is model-authored. The scheduling, isolation, evidence diff, and acceptance checks are deterministic.

## What Add, Update, Delete, And Forget Mean

The word "delete" hides several different contracts in this system.

| Operation | Who decides | What actually happens |
|-----------|-------------|-----------------------|
| Add a rollout memory | Phase 1 extraction model | A new DB-backed raw memory and rollout summary are created after the idle rollout passes the signal gate. |
| Update a rollout memory | Phase 1 extraction model + DB watermark | A changed thread is re-extracted and its newer result replaces the previous row. |
| Add or merge durable guidance | Phase 2 consolidation model | `MEMORY.md`, `memory_summary.md`, and possibly `skills/` are created or rewritten from selected evidence. |
| Remove unsupported guidance | Phase 2 consolidation model | Deleted inputs in the Git diff cause evidence-scoped cleanup of consolidated files. |
| Drop an input from the active set | Deterministic selection | Low-use, stale, or displaced Phase 1 records stop appearing in `raw_memories.md`; their rollout summary files are removed. |
| Delete stale DB evidence | Deterministic retention | Unselected Phase 1 rows older than the unused-memory cutoff are deleted in bounded batches. |
| Delete expired extension evidence | Deterministic retention | Timestamped extension resources older than seven days are removed before consolidation. |
| Forget a deleted thread | Thread lifecycle code | The thread's Phase 1 row and job are deleted; consolidation is enqueued if that evidence was selected. |
| Apply a user correction | User request -> append-only note -> Phase 2 model | With dedicated tools or separate write permission, the active agent records a small note asking to add, update, or delete information; consolidation applies it to generated outputs. |
| Forget everything | User control | `memory/reset` or the debug clear command removes memory DB rows and the contents of memory directories while preserving chat threads and their memory-mode settings. |

This is stronger than "the model can edit a Markdown file." It is a lifecycle with several independent forgetting paths.

It is also weaker than a transactional fact database. The consolidated handbook does not assign every claim a stable fact ID, confidence score, validity interval, or tombstone. The consolidation prompt asks the model to preserve provenance and uncertainty, but those properties live in Markdown structure and model compliance rather than a schema-enforced knowledge layer.

## User Authority Is Present, But Indirect

The read-path prompt is the instruction block Codex injects into every session to tell the active model how to use memory: when to consult it, how to search it, and how to cite it. Its rules include a boundary on writing. It tells the active model that it may update memory only after an explicit direct request from the user. Even then, it should not directly edit `MEMORY.md` or `memory_summary.md`. When the dedicated memory tools are enabled, or the active permission profile separately permits the write, it can create one timestamped Markdown note under:

```text
~/.codex/memories/extensions/ad_hoc/notes/
```

The dedicated `add_ad_hoc_note` tool enforces create-new semantics, a timestamped filename, a small path scope, and no overwrite. The extension instructions tell consolidation that every note is authoritative for memory content, including requests to add, edit, or delete remembered information. They also say never to delete the note itself and to treat its content as data rather than executable instructions.

This creates a useful separation:

```text
user intent: append-only evidence
generated state: rewritable memory artifacts
```

The note is an inspectable, append-only correction artifact, but it is not a source-authenticated audit log: it contains the model's transcription rather than the original user message, identity, or source hash. The consolidation model decides how to reflect it in the generated memory hierarchy, and users must compare it with the originating conversation when exact attribution matters.

There are still important limits. Dedicated memory tools are disabled by default even after the main feature is enabled, and the memory root is otherwise read-only to a normally managed `workspace-write` agent. The background consolidation agent runs with no per-write approval. Users can inspect the plain files, toggle whether a chat can use or contribute memory, disable the feature, or reset the store, but there is no mandatory review queue for every inferred preference.

For stable team rules, the official documentation therefore gives the right advice: keep them in `AGENTS.md` or checked-in documentation. Memory is a recall layer, not the only copy of a requirement that must always govern behavior.

## The Read Path Closes The Loop

Codex does not embed every memory and retrieve nearest neighbors. It uses a staged file hierarchy.

At thread start, the memory extension reads `memory_summary.md`, truncates it to a fixed token budget, and injects it into developer instructions. That prompt tells the model to skip memory only for clearly self-contained tasks. For a relevant or ambiguous task, it should extract keywords from the summary, search `MEMORY.md`, and open only one or two directly referenced skills or rollout summaries.

This design makes retrieval partly deterministic and partly agentic:

- the summary is automatically visible;
- the model decides whether deeper memory is relevant;
- file search provides lexical retrieval;
- the model decides which evidence to open;
- citations expose which memory influenced the answer.

The citation path does more than improve observability. A citation has two parts. The file entries (`MEMORY.md:234-236`, `rollout_summaries/...:10-12`, `skills/...`) point at the Markdown artifacts Phase 2 produced. The rollout IDs point back at the Phase 1 database records those artifacts were consolidated from. Codex parses those IDs from the final model output, increments `usage_count`, and sets `last_usage` for the corresponding Phase 1 records. Future Phase 2 selection then favors evidence that has actually helped later turns.

That is a lightweight feedback loop:

```text
memory is selected -> model uses and cites it -> runtime records usage
-> frequently useful evidence remains eligible -> consolidation sees it again
```

It is not reinforcement learning. No model weights are updated. It is runtime ranking and retention driven by model-produced citations.

## What Codex Memory Is Not

Several adjacent mechanisms can look like the same feature from the outside.

`AGENTS.md` is deterministic instruction context. It is authored explicitly and should contain rules that must reliably apply. Codex memory is generated recall that may be incomplete, stale, or absent when the feature is disabled.

Rollout storage is durable evidence. It lets Codex reopen or analyze what happened in one thread. A rollout becomes cross-session memory only after Phase 1 extracts it and Phase 2 selects and consolidates it.

Compaction is short-term context management. It summarizes or replaces old model-visible history so one active thread can continue within a context limit. It does not decide that a lesson should influence unrelated future threads.

These distinctions match the framework I used in [OpenCode Memory Internals](https://jczhu.com/blog/opencode-memory-internals/):

```text
instructions: what should govern behavior
history: what happened
working context: what the model can see now
long-term memory: what selected lessons should influence later sessions
```

Codex implements all four. OpenCode core currently implements the first three.

## Codex Versus OpenCode

The architectural difference is not that one tool writes files and the other does not. Both can write files. The difference is ownership.

OpenCode loads `AGENTS.md`, configured instruction sources, and durable session history. It compacts long sessions. Its `/init` command can ask an active agent to create or improve project instructions. But core does not run a background policy that mines old sessions, promotes lessons, reconciles them with a global memory, and retrieves that memory in new sessions.

Codex does. Its runtime owns eligibility, extraction jobs, a separate memories database, consolidation scheduling, usage accounting, retention, prompt injection, citations, and reset. Models supply the semantic judgments inside that lifecycle.

| Dimension | Codex local memory | OpenCode core |
|-----------|--------------------|---------------|
| Write trigger | Background processing of eligible idle rollouts | Explicit user or agent file edit |
| Semantic writer | Phase 1 and Phase 2 models | No dedicated memory writer |
| Automatic update | Re-extraction plus incremental consolidation | No general cross-session update path |
| Automatic forgetting | Selection, retention, input deletion, and model cleanup | No general cross-session forgetting policy |
| Store | SQLite evidence plus generated files under Codex home | Instruction files plus session-scoped SQLite history |
| Retrieval | Injected summary, lexical search, progressive file reads | Deterministic instruction injection; no core cross-session semantic recall |
| Feedback | Citations update usage and retention rank | No equivalent core memory-usage loop |
| User controls | Per-chat use/contribute settings, config, inspection, reset | Explicit instruction editing and session controls |

OpenCode's simpler boundary is easier to audit. Codex's pipeline can reduce repeated steering. The price is a larger trust surface: old conversation content is transformed into future developer context by models running in the background.

## Where Other Memory Systems Put The Decision

Comparing systems by storage technology alone is misleading. The more useful question is where memory policy lives.

| System | Who decides memory operations? | Update and forgetting model | Retrieval model | Primary design center |
|--------|--------------------------------|-----------------------------|-----------------|-----------------------|
| Codex | Background extraction and consolidation models inside a runtime-managed pipeline | LLM rewrites plus deterministic retention and reset | Prompt-loaded summary, lexical search, progressive disclosure | Local coding-agent recall from prior work |
| OpenCode core | User or active agent through ordinary instruction files | Explicit file maintenance | Deterministic instruction loading | Transparent instructions and durable sessions |
| Claude Code auto memory | Active Claude model during the session | Model edits or deletes local Markdown; user can edit or delete it | Bounded `MEMORY.md` index plus on-demand topic reads | Immediate per-repository learning from corrections |
| Letta Agent SDK | The active agent edits git-backed MemFS; optional Dreaming launches background subagents | Committed file revisions plus background consolidation when configured | `system/` files stay in context; other files appear as a tree and are read on demand | Versioned, agent-owned memory that follows the agent |
| Mem0 | An extraction pipeline compares new messages with retrieved candidates | LLM chooses `ADD`, `UPDATE`, `DELETE`, or no change | Vector search within entity scope, with entity-aware ranking | Application memory as a service or library |
| LangMem | Developer-configured hot-path tools or background managers | LLM transforms profiles or collections; store layer upserts/deletes | Direct lookup, semantic search, and metadata filters | Composable memory primitives for LangGraph applications |
| Graphiti / Zep | Ingestion pipeline extracts entities, facts, and temporal relationships | Superseded facts are invalidated with history preserved | Hybrid semantic, keyword, and graph traversal | Time-aware facts, relationships, and provenance |
| AgeMem | The task model itself selects memory actions as part of its learned policy | Explicit Add, Update, Delete, Summary, and Filter actions | Learned Retrieve action | Joint long-term and short-term memory control through RL |

Three patterns stand out.

### Agent-Directed Memory

[MemGPT](https://arxiv.org/abs/2310.08560) framed memory as an operating-system problem: move information between a small fast context and larger external storage. Letta's legacy V1 SDK expressed that lineage through editable memory blocks and archival tools. The current [Letta Agent SDK](https://docs.letta.com/agent-sdk/memory/) instead uses git-backed MemFS: files under `system/` remain in context, other files are exposed as an on-demand tree, and optional Dreaming subagents consolidate recent conversations in the background.

The active agent can still edit its own persistent memory, while Dreaming moves some consolidation off the hot path. That combination illustrates that agent-directed and background memory do not have to be mutually exclusive.

Claude Code's [auto memory](https://code.claude.com/docs/en/memory) is also close to the hot path. Claude writes a compact `MEMORY.md` index and topic files during the session. It can learn immediately from a correction, and users can inspect, edit, or delete the files. There is no separate delayed consolidation architecture comparable to Codex's two-phase pipeline.

### Background Memory Pipelines

[Mem0](https://docs.mem0.ai/core-concepts/memory-types) and [LangMem](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) make the extraction pipeline an application primitive. New messages are compared with existing state, and an LLM chooses whether to insert, update, delete, or consolidate memories. LangMem explicitly supports both hot-path and background formation and distinguishes profiles, collections, episodes, and procedural prompt updates.

Codex belongs in this family, but with a coding-agent-specific choice: it stores rich per-rollout evidence, consolidates into a human-readable handbook, and lets future models progressively disclose detail through file search rather than requiring a vector store.

### Temporal And Learned Policies

[Graphiti](https://github.com/getzep/graphiti) treats contradiction as a temporal data problem. Facts have validity windows, raw episodes preserve provenance, and superseded relationships are invalidated rather than erased. This is stronger than asking a Markdown-writing model to decide which sentence sounds current, especially when historical truth matters.

[AgeMem](https://arxiv.org/abs/2601.01885) moves the decision one level deeper. Add, Update, Delete, Retrieve, Summary, and Filter are actions in the model's policy. A three-stage reinforcement-learning curriculum connects early storage decisions, short-term context control, and eventual task reward.

Codex does not do this. Its models are guided by detailed prompts inside a fixed pipeline. Usage changes selection, but task outcomes do not train a memory policy. The distinction is between **a model making memory judgments** and **a model trained to make memory judgments**.

## The Trust Boundary Is The Real Architecture

The most consequential Codex design choice is not Markdown versus vectors. It is the point where untrusted history can become future developer context.

"Local" describes the store, not necessarily the processing boundary. Eligible chat content and path metadata are submitted to the configured model provider for extraction, and generated memory later returns in model requests. Secret redaction covers the serialized rollout input and generated fields, but it does not remove every piece of personal, proprietary, or path-identifying information.

The implementation adds several defenses:

- Phase 1 tells the model to treat rollout text and tool output as data, not instructions.
- Generated fields pass through secret redaction before entering the memories database.
- An optional `disable_on_external_context` setting marks threads that used web search, MCP, tool search, or similar external context as polluted and excludes them from generation.
- For Codex-managed permission profiles, Phase 2 has no network and writes only inside the memory root; explicitly disabled or externally enforced parent profiles are preserved instead.
- Consolidation threads are ephemeral and cannot recursively generate memories.
- Required artifacts and symlink safety are checked before a run is accepted.
- Retrieval requires citations, and unverified memory-derived facts should be described as potentially stale.

The optional pollution guard deserves attention because it is off by default. When enabled, external context changes a thread's memory mode to `polluted`. If the thread had already contributed selected evidence, Codex schedules consolidation so that evidence can be removed from the active memory set.

This is an explicit answer to a prompt-injection question: should web pages and third-party tool output be allowed to influence cross-session memory? Codex lets the user choose a conservative answer, but does not make it the default.

The remaining risks are structural. Secret redaction is not a proof that every sensitive fact is gone. Markdown provenance is not a cryptographic chain of custody. A no-approval consolidation agent can still infer an unstable preference or overgeneralize a one-off correction. Citation-based usage can reinforce a memory because models keep citing it, not necessarily because it is correct.

Memory quality therefore cannot be reduced to recall rate. It needs authority, provenance, correction, and deletion semantics.

## What Runtime Builders Should Copy

The first lesson is to split semantic policy from lifecycle policy. Let models judge meaning, but let deterministic code bound when they run, what evidence they receive, where they can write, and how failures are retried.

The second lesson is to make deletion evidence-driven. Codex does not merely tell a model to "keep memory fresh." It presents a Git diff that includes removed inputs and asks the model to delete only claims whose support disappeared. That is still probabilistic, but it gives forgetting a concrete cause.

The third lesson is to keep the read path bounded. Always loading a small routing index and progressively opening detail is easier to inspect and budget than injecting an unbounded profile or retrieving a large opaque set of nearest neighbors.

The fourth lesson is to feed usage back into retention without confusing usage with truth. Citations provide a practical relevance signal. They should not become the only quality signal, because repeated retrieval can create a self-reinforcing mistake.

The fifth lesson is to keep hard rules outside learned memory. A test command that must run before release belongs in `AGENTS.md`. A preference inferred from several prior interactions may belong in generated memory. The system should not require a probabilistic promotion pipeline to rediscover mandatory policy.

## Source Map

The Codex claims above come primarily from these files in the pinned source tree:

- `codex-rs/features/src/lib.rs`
- `codex-rs/config/src/types.rs`
- `codex-rs/app-server/src/request_processors/turn_processor.rs`
- `codex-rs/memories/write/src/start.rs`
- `codex-rs/memories/write/src/phase1.rs`
- `codex-rs/memories/write/src/phase2.rs`
- `codex-rs/memories/write/src/storage.rs`
- `codex-rs/memories/write/src/workspace.rs`
- `codex-rs/memories/write/templates/memories/stage_one_system.md`
- `codex-rs/memories/write/templates/memories/consolidation.md`
- `codex-rs/ext/memories/templates/memories/read_path.md`
- `codex-rs/state/src/runtime/memories.rs`
- `codex-rs/ext/memories/src/extension.rs`
- `codex-rs/ext/memories/src/local/ad_hoc_note.rs`

The product-level behavior and controls are documented in [Codex Memories](https://developers.openai.com/codex/customization/memories.md). The comparison uses the primary project documentation and papers linked in the relevant sections above.

I expected to find either a simple memory tool or a conventional extract-and-vector-search pipeline. Codex implements something more opinionated: a delayed two-stage editorial process over local evidence, with a Git diff acting as the bridge between deterministic retention and model-driven rewriting.

That architecture answers the original question. The LLM does decide what Codex remembers, but it does not decide alone. Runtime code determines which experiences are eligible to become evidence, which evidence remains economically viable, and when the model must reconcile deletion. Reliable memory comes from that division of authority, not from granting a model unrestricted access to a persistent file.

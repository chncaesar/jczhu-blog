---
title: OpenCode Memory Internals
description: "A source-level analysis of what OpenCode actually remembers: project instructions, durable session history, and context compaction, plus the autonomous memory features it does not implement."
pubDate: 2026-08-24
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - context-engineering
  - memory
---

I started this investigation after finding a local OpenCode project that appeared to remember guidance across sessions. The guidance lived in Markdown files outside the repository, yet every new session followed it. The operational question was simple: had OpenCode decided to preserve those facts, or had someone explicitly written them?

The session record answered it. An agent had created the files through an ordinary file tool after an explicit user request. A project-local `instructions` configuration then loaded them on every provider turn. What looked like autonomous memory was user-triggered file authoring plus deterministic prompt injection.

That result sent me looking for the actual memory subsystem. There is no general runtime-managed service that decides what to save, updates facts when they change, and semantically retrieves useful knowledge in later sessions.

What users experience as "memory" is produced by three different mechanisms with different owners and failure modes: instruction files are loaded into the system prompt, durable session events and projected messages are persisted in SQLite, and old model-visible context is replaced by a generated compaction checkpoint when the request grows too large. These mechanisms work together, but they do not form an autonomous long-term memory manager.

That distinction matters. If a coding agent remembers a project rule because `AGENTS.md` is injected on every turn, that is not learned memory. If it can reopen an old transcript from SQLite, that does not mean a new session can retrieve facts from it. If a long session survives by summarizing its history, that does not mean the runtime selected the most important information.

This article follows the current OpenCode source tree, which contains both the desktop-compatible session path under `packages/opencode` and the newer V2 runtime under `packages/core`. Where the two paths differ, I call out the difference rather than treating them as one implementation.

Primary code references:

- `packages/opencode/src/session/instruction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm/request.ts`
- `packages/opencode/src/session/system.ts`
- `packages/opencode/src/session/prompt/beast.txt`
- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/command/index.ts`
- `packages/opencode/src/command/template/initialize.txt`
- `packages/core/src/instruction-context.ts`
- `packages/core/src/session/context-epoch.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/history.ts`
- `packages/core/src/session/sql.ts`
- `packages/core/src/session/compaction.ts`
- `packages/core/src/database/database.ts`

## Key Takeaways

**OpenCode does not have one memory system. It has an explicit instruction layer, a durable session layer, and a bounded working-context layer.** Calling all three "memory" hides the most important operational differences.

1. **Project knowledge is mostly prompt injection.** `AGENTS.md`, `CLAUDE.md`, and configured `instructions` are read from files and placed in the system prompt. The loader reads them; it does not maintain them.

2. **Session persistence is not cross-session recall.** OpenCode durably stores messages, tool calls, tool results, and durable events in SQLite. Streaming text, reasoning, tool-input, and compaction deltas are transient. The stored data makes sessions reopenable and inspectable, but it remains scoped to the session unless another component explicitly reads it.

3. **Compaction changes what the model sees, not what the database retains.** Old history remains durable, while normal model requests continue from a generated checkpoint plus recent context.

4. **OpenCode does not have a general runtime policy that promotes conversation facts into long-term memory.** There is no built-in embedding index, vector retrieval path, user-profile store, or fact confidence model. One provider-specific prompt contains a narrow file-memory convention, but core does not manage or retrieve that file as a memory service.

5. **`/init` is guided instruction authoring, not background learning.** It asks the active agent to create or improve `AGENTS.md` after the user invokes the command.

6. **The legacy and V2 instruction paths are not identical.** The desktop-compatible path supports `AGENTS.md`, optional `CLAUDE.md`, configured local files, and HTTP instruction sources. The current V2 `InstructionContext` observes `AGENTS.md` files only.

## A Better Mental Model

The easiest way to reason about OpenCode memory is to ask two questions for every piece of information:

1. Where is it stored?
2. Is it included in the next model request?

Those are not the same question.

| Layer | Stored in | How it reaches the model | Scope |
|-------|-----------|--------------------------|-------|
| Ambient instructions | Markdown files or configured URLs | Injected as system context | Project or configured scope, across sessions |
| Durable session history | SQLite messages, parts, inputs, and durable events | Selected history is converted into model messages | One session |
| Compaction checkpoint | A durable summary message or compaction event | Replaces older active history in later requests | One long session |

The request path is approximately:

```text
agent system prompt
+ ambient instructions
+ selected session history
+ latest user input
+ tool definitions
-> provider request
```

The database may contain much more than the provider request. A project may also contain instructions that are reloaded independently of the transcript. "The runtime has it" and "the model can currently reason over it" are separate properties.

## Layer One: Ambient Instructions

In the desktop-compatible path, instruction discovery lives in `packages/opencode/src/session/instruction.ts`. It collects several classes of sources.

The global source is an `AGENTS.md` under the OpenCode config directory, with optional compatibility loading for `~/.claude/CLAUDE.md`. At project level, it searches upward for instruction files. `AGENTS.md` is preferred, followed by `CLAUDE.md`, then the deprecated `CONTEXT.md`; the first filename family with matches wins. The project configuration may also add `instructions` entries that resolve to local paths, glob patterns, or HTTP URLs.

The loader reads those sources and renders each one with its origin:

```text
Instructions from: /path/to/AGENTS.md
<file content>
```

`SessionPrompt` calls `instruction.system()` while preparing each provider step. It combines the resulting text with environment context, MCP instructions, and skills. `LLMRequestPrep.prepare(...)` then joins that material with the selected agent prompt and any per-user system content before creating provider system messages.

This is simple and strong. A project rule does not depend on the model remembering a conversation from last week. It is supplied again as authoritative context. Editing the file changes the context future turns receive.

It is also important not to overstate what happens. The instruction loader has read, discovery, and fetch behavior. It has no code that decides a new lesson is worth preserving, rewrites a stale rule, or deletes a contradiction. A human or an agent using ordinary file tools must make those edits.

OpenCode adds one useful directory-sensitive behavior. When the `read` tool opens a source file, the runtime can discover a nearer instruction file between that file and the project root and attach it to the tool result as a system reminder. A monorepo can therefore keep broad rules at the root and narrower rules close to a package. This is deterministic path lookup, not semantic retrieval.

### What `/init` Actually Does

The built-in `/init` command is the closest OpenCode gets to authoring persistent project memory. Its command description is "guided AGENTS.md setup," and its prompt asks the agent to investigate the repository and create or update `AGENTS.md`.

The prompt is carefully scoped. It tells the agent to inspect manifests, CI, developer commands, existing instructions, and representative architecture files. It asks for high-signal facts that future sessions would otherwise miss, and it explicitly rejects generic advice and unverified claims.

But `/init` is user-triggered. It does not run at the end of every session or perform a dedicated transcript-mining pass for newly learned facts. It executes within the normal active-session context and uses the normal agent and file-writing tools to maintain one explicit instruction artifact.

That makes `/init` closer to generating repository documentation than to an always-on memory policy.

### A Narrow Provider-Prompt Exception

There is one built-in convention that prevents a completely categorical "no memory" claim. For model API IDs containing `gpt-4`, `o1`, or `o3`, `packages/opencode/src/session/system.ts` selects `prompt/beast.txt`. That provider prompt tells the agent that user preferences may be stored in `.github/instructions/memory.instruction.md` and that, when the user explicitly asks it to remember something, it may create or update that file.

This is a prompt-level file convention, not a runtime memory service. The normal instruction loader does not search for `memory.instruction.md`. Core does not index the file, reconcile contradictions, attach confidence or provenance, or automatically retrieve it across sessions. The model can use ordinary file tools to write or read it if the prompt and current task lead it there.

The distinction is useful: OpenCode ships a provider-specific instruction that suggests a memory behavior, but not a provider-independent subsystem that owns memory state.

## The V2 Instruction Path

The newer core runtime makes ambient context more explicit. `packages/core/src/instruction-context.ts` registers instructions as a typed `SystemContext` source. It observes the global config `AGENTS.md` and project `AGENTS.md` files between the active directory and project root, then renders them into an instruction baseline.

`SessionContextEpoch` persists both the rendered baseline and a structured snapshot for the session. Before a provider turn, `SessionRunner` prepares the current system context and sends the selected agent system prompt plus the baseline to the model. If the observed instruction state changes, the context system can produce an explicit replacement update rather than silently mixing old and new versions.

This is a better model for a durable agent runtime: system context has identity, a baseline, and update semantics.

It is not yet feature-equivalent to the desktop-compatible loader. The current V2 `InstructionContext` searches for `AGENTS.md`; it does not wire the optional `CLAUDE.md` compatibility source or the local and remote paths declared by the legacy `instructions` configuration. Anyone migrating behavior between the two runtimes should verify the active path instead of assuming that "OpenCode loads instructions" means the same thing everywhere.

## Layer Two: Durable Session History

OpenCode's second memory-like mechanism is session persistence.

The SQLite database runs in WAL mode and normally lives under OpenCode's data directory as `opencode.db`, with channel-specific filenames available for development builds. The schema contains both the desktop-compatible message projection and the newer event-oriented session tables.

The desktop-compatible path stores `message` rows and separate `part` rows. A message is not just text. Parts represent text, reasoning, files, tool calls, tool results, step boundaries, snapshots, patches, errors, and compaction markers. The session processor updates these records while the provider stream and tools are running.

The V2 path adds durable session inputs, ordered durable events, projected `session_message` rows, and a context epoch. Prompt admission and model execution are separated. Durable lifecycle events describe what happened; projectors create query-friendly messages; the runner reloads selected history before the next provider turn. High-frequency text, reasoning, tool-input, and compaction delta events remain transient rather than being inserted into the durable event stream.

This persistence gives OpenCode several properties commonly mistaken for long-term memory:

- a session survives process restart;
- the UI can reopen old conversations;
- tool execution can be inspected after completion;
- clients can rebuild projections from durable state;
- debugging can refer to stable session, message, part, and tool-call identities.

But persistence alone does not create recall. A new session does not search every old session for facts about the user or repository. There is no built-in retrieval query such as "find prior decisions relevant to this prompt." Unless content has been moved into an instruction file or supplied by a plugin, old session data remains old session data.

This boundary is worth preserving. Durable history is an audit and recovery substrate. Cross-session memory is a selection and trust problem. Combining them implicitly would make every old statement a candidate instruction, including mistakes, obsolete plans, secrets, and prompt-injected content.

## Layer Three: Bounded Working Context

Even within one session, the model cannot see an unlimited transcript. Tool outputs, file reads, reasoning, and repeated provider turns eventually exceed the model's context window.

OpenCode handles that with compaction.

The desktop-compatible implementation estimates the active history and retains a recent tail within a configured budget. For the older head sent to the summarizer, it strips media and truncates large tool outputs, then asks a dedicated compaction agent to generate a summary. It persists that summary as an assistant summary message. `filterCompacted(...)` later reorders model-visible history so the provider sees the compaction request, its summary, the retained tail, and subsequent work instead of the full original transcript.

The same path has a separate optional pruning mechanism. When `compaction.prune` is enabled, it scans older completed tool outputs while protecting a recent token budget. Outputs selected for pruning remain in SQLite but are marked compacted; later model-message conversion replaces their content with `[Old tool result content cleared]` and drops their attachments. This frees model context without creating a new summary checkpoint. It is disabled unless configured and should not be confused with history summarization.

The V2 implementation uses a durable checkpoint-and-retry design. When a request estimate crosses the context threshold, or the provider reports overflow before assistant output has started, it serializes older history, keeps recent context, generates a bounded summary, persists a compaction event, and retries from the new checkpoint. Future active-history queries begin at the latest compaction boundary. Older rows remain in SQLite but are no longer part of normal provider requests.

The three layers are deliberately separate:

```text
durable history: retained
active history: shortened
model-visible history: summary checkpoint + recent context
```

This is continuity under a hard context limit, not intelligent forgetting. The trigger is size, not relevance. The summarizer may preserve objectives, files, errors, and next actions, but there is no policy that scores every message by future utility. A detail omitted from the checkpoint still exists in storage, yet the model will not recover it through the normal continuation path.

I covered the V2 checkpoint algorithm and its limits in more detail in [OpenCode V2 Compaction Internals](https://jczhu.com/blog/opencode-v2-compaction-internals/). For the memory model, the central point is simpler: compaction is a lossy projection over durable history.

## What OpenCode Does Not Implement

After tracing these paths, several negative claims are as important as the positive ones.

OpenCode does not currently provide a general runtime-managed autonomous memory store with:

- embedding generation and vector search over remembered facts;
- cross-session retrieval based on semantic similarity;
- provider-independent `add`, `update`, `delete`, or `forget` memory tools;
- automatic extraction of user preferences or repository decisions;
- confidence, provenance, contradiction, expiration, or access-control metadata for facts;
- a background policy that promotes session content into long-term memory;
- reinforcement learning that teaches the model when to store or retrieve information.

Provider SDK types may mention embeddings, file search, or vector stores. Plugins may inject external context or replace compaction behavior. Neither means OpenCode core owns a semantic memory subsystem.

The `beast.txt` convention also does not change this conclusion. It tells a subset of models that they may edit a particular file after an explicit request. It does not provide automatic extraction, loading, semantic retrieval, conflict resolution, or lifecycle management for the resulting content.

A user can build a useful approximation by keeping Markdown outside a public repository and referencing it through project-local `instructions`. That produces private, cross-session context without modifying upstream files. It is still user-maintained prompt context. OpenCode reads it because the configuration points to it; OpenCode does not decide what belongs there.

## Why The Simpler Design Is Defensible

It is tempting to treat the missing autonomous layer as an obvious gap. The trade-off is more complicated.

Instruction files are transparent. They can be reviewed in a normal editor, versioned when appropriate, scoped by directory, and corrected without inspecting an opaque index. They are strong context because they enter the system prompt deliberately.

Session persistence is auditable. It records what happened without silently turning every conversation into future policy. A user can delete, archive, inspect, or export sessions without also reasoning about which facts were extracted into another store.

Summary compaction is bounded and observable. It has real information-loss risk, but it creates an explicit checkpoint instead of silently dropping arbitrary history. Optional tool-output pruning follows a different path: it leaves a durable compacted marker and substitutes a visible placeholder in later model context.

An autonomous memory layer would need answers to harder questions:

- Which statements are facts, plans, preferences, or temporary hypotheses?
- Who is allowed to write a persistent fact?
- How is a contradiction resolved?
- When does a repository change make an old architectural fact stale?
- Can untrusted file content become cross-session memory?
- How can a user inspect why a memory was retrieved?
- What does deletion mean when memories have been summarized or duplicated?

For a coding agent, these are safety and provenance questions, not only retrieval-quality questions. A wrong remembered API contract can cause a bad patch. A remembered secret can leak into an unrelated request. A stale build instruction can waste every future session.

OpenCode's current architecture avoids those risks by keeping durable rules explicit and durable transcripts session-scoped. The cost is that users and agents must deliberately promote important knowledge into `AGENTS.md` or another configured instruction source.

## What Agent Runtime Builders Should Copy

The first lesson is to stop using "memory" as one undifferentiated feature name. Define at least three contracts:

```text
instruction context: what should govern behavior
durable history: what happened
working context: what the model can see now
```

Each contract needs different storage, authority, lifecycle, and failure handling.

The second lesson is that durable storage and model visibility should remain separate. Keeping the full transcript is valuable for audit and recovery. Sending the full transcript forever is impossible. Compaction should create an explicit boundary so the runtime can explain what remains durable and what remains visible.

The third lesson is to treat instruction mutation as a privileged operation. OpenCode's loader is read-only. Even `/init` requires user action and uses ordinary file tools. If a future memory subsystem writes persistent context automatically, it should preserve source, timestamp, confidence, scope, and a review path rather than quietly editing the agent's future system prompt.

The final lesson is that a simple file can be a good memory primitive when the requirement is stable project guidance. It is inspectable, portable, and deterministic. Vector retrieval and learned memory policies solve different problems. Adding them should start from a concrete failure that files, session history, and compaction cannot solve.

I also maintain an [OpenCode Reliability Toolkit](https://jczhu.com/opencode-tools/) for readiness checks, database maintenance, session reflection, and multi-machine coordination.

OpenCode remembers less than the word "memory" suggests, but its boundaries are useful. Project instructions say what should remain true. SQLite records what happened. Compaction decides what can still fit. None of them autonomously decides what deserves to become a long-term fact.

That is the core architectural claim: reliable agent memory begins by separating authority, durability, and visibility, not by adding a vector database.

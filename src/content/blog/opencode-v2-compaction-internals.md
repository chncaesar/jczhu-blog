---
title: OpenCode V2 Compaction Internals
description: A code-level analysis of OpenCode V2's compaction mechanism — how the checkpoint-and-retry design works, what the model sees after compaction, and why the hardcoded 4,096-token summary cap makes compaction a survival mechanism, not an optimization.
pubDate: 2026-07-17
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - context-engineering
---

This document analyzes the OpenCode V2 compaction implementation. The conclusions are based on the V2/core code path in the OpenCode repository. When code, comments, and documentation disagree, this document follows the current code behavior.

Primary code references:

- `packages/core/src/session/compaction.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/session/history.ts`
- `packages/core/src/session/context-epoch.ts`
- `packages/core/src/session/runner/to-llm-message.ts`
- `packages/core/src/session/message-updater.ts`
- `packages/core/src/config/compaction.ts`

This document only covers the V2/core compaction path. It does not cover the V1 compatibility `/compact` implementation or the DCP plugin's `compress` tool.

## Key Takeaways

**OpenCode V2 compaction is a durable checkpoint-and-retry mechanism, not a relevance-pruning system.** It is a last-resort survival mechanism — avoid triggering it whenever possible.

1. **Avoid compaction.** Once triggered, all older context is compressed into a hardcoded `4_096`-token summary. Details that do not fit are not recovered. The session survives, but its continuity depends entirely on what the summary captured.

2. **Compaction is size-triggered, not relevance-triggered.** It runs when the request estimate exceeds the context threshold — regardless of how important or irrelevant the conversation is. The system has no concept of message importance.

3. **Three hardcoded limits control quality.** Tool/shell output is truncated at `2_000` chars (`TOOL_OUTPUT_MAX_CHARS`), summary output is capped at `4_096` tokens (`SUMMARY_OUTPUT_TOKENS`), and neither is configurable. Only `buffer` and `keep.tokens` are exposed in the config schema.

4. **History is never deleted, but old rows are no longer loaded.** Old messages remain in durable storage. After compaction, future model requests start from the checkpoint and do not see older rows through normal provider calls.

5. **Media content is not preserved in model-visible context after compaction.** Images and videos from before the checkpoint are reduced to text metadata (`[Attached image/png: screenshot.png]`). The original binary data remains in durable history, but the model cannot see visual content from before the checkpoint through normal provider requests.

6. **Compaction is safe but blunt.** It never deletes history, never leaves a half-compacted session, and prevents infinite retry loops. But it makes no attempt to distinguish important facts from noise when summarizing older context.

## Core Design

Long coding-agent sessions produce long conversation histories. Tool calls, tool results, shell outputs, file reads, and multi-turn reasoning accumulate. Eventually the full provider request exceeds the model's context limit. Deleting old messages would lose durable history. Compaction solves this with a checkpoint strategy: create a new message that represents older history, then let future runner attempts use that message as a starting boundary.

V2 compaction separates three layers that would otherwise be conflated:

| Layer | What it is | What compaction does to it |
|-------|-----------|---------------------------|
| Durable history | Full session record in `SessionMessageTable` | Not changed. Old rows remain. |
| Active history | The slice of messages loaded for a provider attempt | Shortened. Future loads start from the latest `type: "compaction"` checkpoint. |
| Model-visible context | What the model actually receives in a request | Replaced. Older context becomes `<summary>` + `<recent-context>` inside a `<conversation-checkpoint>` block. |

This three-layer design is the key insight. Compaction does not shrink the database. It changes the default projection of history used to call the model, and it renders old context through a generated summary rather than replaying every old message.

## How It Works

### Trigger

Compaction has two trigger paths.

**Automatic path.** Before each normal assistant-response provider attempt, the session runner estimates the full provider request size and compares it against the current model's context window:

```text
estimated_request_tokens > model_context_limit - max(output_tokens, compaction_buffer)
```

The default compaction buffer is `20_000` tokens. With a `128_000` token context window and default output limit, the threshold is approximately `108_000` tokens.

**Recovery path.** If the provider returns a context overflow error and the current turn has not yet produced durable assistant output or tool execution, OpenCode runs one recovery compaction and retries. This path handles cases where the local token estimate did not prevent a provider-side overflow. The overflow recovery path runs at most once to avoid looping.

Both paths eventually call the same implementation: `compactAfterOverflow(...)` in `packages/core/src/session/compaction.ts`.

### Split History Into `head` And `recent`

Compaction divides active session history into two parts.

First, existing `type: "compaction"` messages are ignored. The remaining structured session messages are converted into plain text. The helper function is named `serialize(...)` in the code, but this is a text conversion step, not binary serialization:

- user messages become `[User]: ...` plus attachment descriptions.
- assistant text becomes `[Assistant]: ...`.
- assistant reasoning becomes `[Assistant reasoning]: ...` when reasoning text exists.
- assistant tool calls become `[Assistant tool call]: tool(input)`.
- completed tool results become `[Tool result]: ...`.
- failed tool calls become `[Tool error]: ...`.
- system updates become `[System update]: ...`.
- synthetic context becomes `[Synthetic context]: ...`.
- shell messages become `[Shell]: command + output`.

Tool output and shell output are truncated to `2_000` characters. This limit is hardcoded as `TOOL_OUTPUT_MAX_CHARS` in `packages/core/src/session/compaction.ts:14` and is not exposed through the compaction config schema. Binary and media content is not embedded as base64. Images, videos, and attachments are reduced to text metadata such as `[Attached image/png: screenshot.png]`. The compaction summary request is always text-only. A non-multimodal model can still run the summary request because it receives only text labels. However, it cannot infer visual or binary content unless that content was already described elsewhere in text.

The converted text is then split by walking backward from the latest message. The default recent-context budget is `8_000` tokens from `DEFAULT_KEEP_TOKENS`. Recent converted text within this budget is kept as `recent`. Older converted text becomes `head`.

The newly selected `recent` is not summarized in the same compaction run. It is stored directly in the checkpoint and later rendered as `<recent-context>`. The newly selected `head` is what gets summarized.

### Generate The Summary

The summary prompt is built by `buildPrompt(...)`. Its job is not just to shorten text. It tries to preserve the working state needed for a coding-agent session to continue.

When there is no previous checkpoint, the prompt starts with:

```text
Create a new anchored summary from the conversation history.
```

When a previous checkpoint exists, the prompt asks the model to update the anchored summary rather than blindly stacking independent summaries:

```text
Update the anchored summary below using the conversation history above.
Preserve still-true details, remove stale details, and merge in the new facts.
```

The prompt then includes a fixed Markdown template tuned for session recovery:

- `## Objective` — what the user is trying to accomplish.
- `## Important Details` — constraints, decisions, assumptions, exact context needed to continue.
- `## Work State` — completed work, active work, blockers.
- `## Next Move` — the next concrete action after retry.
- `## Relevant Files` — file paths that would otherwise be easy to lose during summarization.

The prompt rules require the model to keep every section, use terse bullets, preserve exact paths/symbols/commands/errors/URLs/identifiers, and avoid mentioning that context was compacted. The last rule matters: the generated checkpoint should read like normal historical context, not an explanation of an internal maintenance operation.

The context passed into the summary is: previous checkpoint `recent`, when one exists, plus the newly selected `head`.

The summary request uses the same `input.model` as the current provider attempt, with no tools and a maximum of `4_096` output tokens. This limit is hardcoded as `SUMMARY_OUTPUT_TOKENS` in `packages/core/src/session/compaction.ts:15` and is not exposed through the compaction config schema. Even if the model supports larger output, the cap is always `4_096`. There is no separate specialist compaction model in the current V2 core path.

This is a significant constraint. A long session may have accumulated detailed information — file paths, commands, error messages, design decisions, constraints, test results — across many turns. All of that older context must be compressed into at most 4,096 output tokens of structured summary. If important details exceed what the summary model can fit, they are not preserved for future provider attempts. The session does not crash, but the model's working knowledge of old context can become incomplete.

### Persist The Checkpoint

Before summary generation starts, OpenCode publishes `SessionEvent.Compaction.Started`. This event does not create a checkpoint message.

During generation, the implementation collects text delta chunks. If the stream reports a provider error, throws `LLM.Error`, or produces an empty summary, compaction returns `false` and no checkpoint is written. Failure handling is conservative: a failed summary attempt does not move the active-history boundary.

Only after a non-empty summary is generated does OpenCode publish `SessionEvent.Compaction.Ended`. The session projector handles this event by inserting a durable `type: "compaction"` message into `SessionMessageTable`. The inserted row includes the message ID, session ID, compaction type, event sequence, creation time, and the payload: `reason`, `summary`, and `recent`.

This is the point where the generated summary becomes part of session history and can be used as the next active-history boundary.

### Retry From The Checkpoint

After the checkpoint is persisted, `compactAfterOverflow(...)` returns `true`, and `compactIfNeeded(...)` returns `true` to the runner. The runner stops the current attempt before calling the model by throwing `ContinueAfterCompaction` — a control-flow signal, not a user-facing error.

On the retry, OpenCode reloads active history from the latest compaction checkpoint and rebuilds a smaller provider request. That smaller request is then sent to the model.

The normal path is:

```text
build request -> estimate size -> split history -> summarize head -> write checkpoint -> retry -> call model
```

### Repeated Compaction

If the session grows again after the first compaction, the cycle repeats. `compactAfterOverflow(...)` reads the existing checkpoint message from the current entries. When a previous summary exists, the new prompt asks the model to update the anchored summary rather than starting from scratch.

The benefit is continuity across multiple compactions. Older summarized facts can be carried forward, while newer head content is merged into the updated summary.

The limitation is cumulative summary risk. Each repeated compaction depends on the previous checkpoint summary and the latest summarization pass. A detail dropped earlier is not recovered by re-reading old pre-checkpoint rows.

## What The Model Sees After Compaction

After compaction, `SessionHistory.latestCompaction(...)` finds the newest `type = "compaction"` message. The history loader starts active history from that checkpoint sequence. Older messages before the checkpoint are no longer loaded into the normal provider request.

When the checkpoint is sent to the model, `to-llm-message.ts` renders it as a user-role `<conversation-checkpoint>` block:

```text
<conversation-checkpoint>
The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.

<summary>
...
</summary>

<recent-context>
...
</recent-context>
</conversation-checkpoint>
```

There are two important design choices here. First, the checkpoint is model-visible context, not hidden state. The next provider attempt can reason over the summary and recent context because they are rendered into the prompt. Second, the checkpoint text explicitly frames itself as history, not new instructions. The model receives a smaller request with an explicit continuity record, but it no longer sees old messages in their original structured form. It sees the generated summary and the retained recent text.

Completed compaction also interacts with Context Epoch. If the latest compaction sequence is newer than the stored baseline sequence, the system-context baseline can move forward to the same boundary in `context-epoch.ts`. This prevents old mid-conversation system updates from being mixed into the new active history inconsistently.

## Configuration Surface

The V2 compaction config is intentionally small, defined in `packages/core/src/config/compaction.ts`:

```ts
compaction: {
  auto?: boolean
  prune?: boolean
  keep?: { tokens?: number }
  buffer?: number
}
```

The current V2 compaction implementation uses:

- `auto` — whether automatic compaction runs (default: `true`).
- `buffer` — reserved headroom before the context limit (default: `20_000`).
- `keep.tokens` — recent-context budget (default: `8_000`).

The `prune` field exists in the schema but is not used by the current core compaction logic.

The configuration controls thresholds, not pruning policy. It determines when compaction runs and how much recent text is kept verbatim, but it does not select which messages or tool results to remove from context before compaction.

## Strengths

**Durable, not destructive.** Original session messages remain in `SessionMessageTable`. Compaction appends a new checkpoint message. Nothing is deleted. This makes the checkpoint auditable and replayable.

**Safe retry boundary.** The runner can stop the current attempt and rebuild the next provider request from the checkpoint. This avoids replaying the full old conversation.

**Simple mental model.** Older context becomes `summary`; the newest converted text becomes `recent`. The summary prompt enforces a coding-agent-oriented structure — `Objective`, `Work State`, `Next Move`, `Relevant Files` — tuned for session recovery rather than generic prose compression.

**Recent exact context preserved.** The most recent converted text is not summarized in the same compaction run. It is stored directly as `recent`, reducing the chance of losing exact details from the latest work.

**Conservative failure mode.** If compaction cannot produce a completed checkpoint — summary prompt too large, provider error, empty summary — it does not move the active-history boundary. The session remains in its pre-compaction state.

**Checkpoint framed as history, not instruction.** The `<conversation-checkpoint>` text explicitly declares itself historical context, not new instructions. This is simple prompt engineering that reduces the risk of the model misinterpreting the compacted summary as fresh user intent.

**Small, predictable configuration surface.** Only three fields control behavior in the current core path: `auto`, `buffer`, and `keep.tokens`. There are no complex pruning policies to tune or debug. The behavior is threshold-driven and easy to reason about.

## Limitations

**The summary output bottleneck — this is the most important weakness.** The summary output limit is hardcoded at `4_096` tokens (`SUMMARY_OUTPUT_TOKENS` in `packages/core/src/session/compaction.ts:15`) and not configurable. A long coding session can span tens of thousands of tokens of tool outputs, file reads, error messages, design decisions, shell commands, and reasoning chains. All of that older context — everything except the most recent `~8_000` tokens — must be compressed into at most `4_096` tokens of structured summary.

This means any detail that does not fit into the summary is not automatically recovered from durable history during future provider requests. The model's working knowledge of old context becomes only what the summary captured. File paths can be dropped. Error messages can be paraphrased into uselessness. Design decisions can be collapsed to a bullet point. The session does not crash, but its continuity depends entirely on the quality of the 4k-token summary.

This is the fundamental reason to avoid triggering OpenCode V2 compaction whenever possible. Compaction is a survival mechanism, not an optimization.

**Size-based trigger, not relevance-based.** Compaction starts when the estimated provider request is too large, or after a provider-side context overflow. It does not run because a message is stale, duplicated, low-value, or off-topic. The system has no concept of message importance.

**Coarse summarization of older context.** Older converted text is summarized as a block. The implementation does not rank individual messages, tool results, command outputs, or file reads by relevance. It treats all pre-recent history as summarization material.

**Shallow tool output handling.** Large tool and shell outputs are truncated to `2_000` characters during text conversion. This limit is hardcoded (`TOOL_OUTPUT_MAX_CHARS`) and not configurable. A single important line in a large log file may be truncated away, while a verbose but low-value message may consume recent-context budget.

**Media content is not visible to the model after compaction.** Images, videos, and other binary attachments are reduced to text metadata such as MIME type and filename during text conversion. Once media falls behind the compaction boundary, future model requests see only the checkpoint text. The original binary data remains in durable history, but it is no longer part of model-visible context through normal provider requests.

**Checkpoint is irreversible for active context.** After compaction, future model requests normally depend on the checkpoint summary and recent context for older information. Mistakes, omissions, or distortions in the summary become the model's only working knowledge of old context.

**No deterministic pruning.** The config schema includes `prune`, but current V2 core compaction does not use it. The implementation is checkpoint summarization, not a policy engine for removing specific tool results, errors, or repeated file reads.

## Claims The Current V2 Code Does Not Support

Based on the current V2/core code, do not claim that:

- V2 supports user-selected manual compaction ranges.
- V2 uses a hidden `compaction` agent.
- V2 uses a separate smaller model for compaction.
- V2 performs deterministic pruning of old tool results.
- V2 keeps the last N turns.
- V2 deletes historical messages.

The reliable claim is more specific: V2 automatically creates a summary checkpoint when a normal provider attempt is too large, or when provider overflow recovery succeeds before side effects.

For the broader model that separates compaction from project instructions and durable session history, see [OpenCode Memory Internals](/blog/opencode-memory-internals/).

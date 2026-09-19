---
title: "Compaction Is a Control Problem: Static Boundaries, Dynamic Cut Points, and the Limits of Compression"
description: "A design reading of Codex compaction: how it separates capacity enforcement from task-aware timing, why fixed setup needs separate accounting, and where compression stops being the answer."
pubDate: 2026-09-19
tags:
  - ai-coding
  - codex
  - opencode
  - agent-workflow
  - context-engineering
  - memory
---

An agent has just received a large test log. The current context window is near its budget. The final line may be the evidence needed to finish diagnosis; the model may need one more tool call to turn that evidence into a safe repair. But continuing blindly could leave no room for the next model invocation at all.

That is the real compaction problem. It is not choosing a clever percentage. It is deciding who has authority to protect a finite resource, who has enough task knowledge to choose a good moment to switch, and what must survive the switch.

This article is a design reading of the Codex implementation, not a file-by-file tour. The source tells us *how* the system works; the interesting question is *why the responsibilities are divided this way*, and which failures that division can or cannot handle.

The analysis is pinned to [OpenAI Codex commit `8444cf63b50a8a88521e0d2970d49f659b48eac7`](https://github.com/openai/codex/commit/8444cf63b50a8a88521e0d2970d49f659b48eac7). It describes that source tree, not an immutable product contract. It follows [Codex Memory Internals](https://jczhu.com/blog/codex-memory-internals/), which separates short-term compaction from durable memory, session storage, and project instructions.

## The Design Problem: Continue Safely Without Cutting Blindly

A long-running agent has two kinds of state:

- a durable record of what happened—messages, tool calls, files, and results;
- a much smaller **active working window** that the next model invocation can actually use.

A **rollover** ends one active window and begins another. In Codex, *compaction* is the lifecycle around that transition. It may replace old history with a local or remote compacted representation, or it may start a fresh managed window without asking a model to summarize anything. The design question is the same in every case: how should the system cross a context boundary without losing the task?

Two naive answers both fail.

1. **Always switch at one fixed percentage.** This guarantees capacity, but the runtime cannot tell whether the agent has just reached the end of a useful investigative phase or is halfway through one.
2. **Let the model decide whenever to switch.** The model has the best view of task semantics, but it cannot safely be the final authority over capacity. It can be late, distracted, or wrong.

Codex's answer is a hybrid control design: runtime owns the non-negotiable limits; the model receives a narrow, bounded chance to select a less destructive cut point.

## Mechanism One: Static Boundaries Give Runtime the Final Say

The first mechanism is deliberately uncreative. Runtime tracks context pressure and moves the session before it becomes unsafe.

The pinned source derives an automatic-compaction budget from 90% of the raw context window and sets a default effective full-context guard at 95%. The numbers themselves are policy; the design is the important part:

```text
90%: begin the normal transition policy while there is still room.
95%: do not allow total active context to cross this runtime guard.
```

The two thresholds separate **planned rollover** from **last-resort prevention**. In the ordinary `Total` path, without the optional fallback discussed below, 90% normally triggers first and the session never reaches 95%. That does not make 95% pointless. It keeps the total-context safety contract independent from the policy that happens to schedule rollover today.

This is a runtime policy, not a second provider-side measurement. The transferable principle is simple: **the component that can enforce a resource limit must retain the final veto**. A model can propose timing. It should not be trusted to guarantee that there will still be room for the next request.

OpenAI's public API guidance describes the same operational posture at a higher level: monitor usage, plan ahead, compact after major milestones rather than every turn, and preserve functionally equivalent instructions when resuming. [OpenAI Docs](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2#compaction) explains the API form; Codex implements a client-side policy around that general idea.

## Mechanism Two: A Bounded Dynamic Cut Point Uses Model Judgment Safely

Static thresholds answer “must we stop extending this window?” They do not answer “is this a good moment to stop?”

The optional TokenBudget fallback creates a small, controlled interval after the normal automatic budget is exhausted. Runtime appends one fallback prompt to the model-visible conversation and lets the model take one more bounded step. The model can then call `new_context` if the task has reached a semantic cut point.

```text
automatic budget reached
    -> runtime opens a small bounded interval
    -> model sees the latest work and may request new_context
    -> runtime performs the rollover

no model request
    -> runtime forces rollover when the buffer ends or the total guard is reached
```

This is not delegation of context management. The model can request a transition; it cannot mutate the window, advance the history, or waive the limit. Runtime records the request and performs the state transition. The relevant implementation is split across the TokenBudget path, the `new_context` tool handler, and the session state; the important design fact is the separation of **semantic judgment** from **capacity authority**.

Why is that useful? Runtime sees token counts but not task meaning. The model may know that the latest tool result completes diagnosis, so a new window can begin a repair phase cleanly. Or it may know that one more safe tool call is required before a transition would be coherent. The fallback buffer buys that judgment one bounded opportunity. If the model makes no request, runtime's static boundary remains the safety net.

The buffer is therefore not extra model capacity, and it is not a second dynamic budget. Its size is static configuration. What is dynamic is the model's choice of *when inside that interval* to ask for the rollover.

## Context Accounting Is a Design Boundary, Not a Single Counter

The most common context bug is treating every token as if it had the same remedy. A useful design model keeps the sources of pressure separate:

```text
W  raw model context window
P  fixed prefix required by the next invocation
H  replayable session history
I  incoming material not yet recorded
   (new user input, context diff, or reinjection)
O  output and reasoning headroom
C  compaction-request payload, if compaction needs a summary

next invocation = P + H + I + O
```

The value of this model is diagnostic. If `H` is large, changing its representation can help. If `P` is large, compaction cannot help: system instructions, tool schemas, MCP definitions, and project rules must still be sent. If `I` is the surprise, a count taken before the next user message or context injection is not enough. If `C` is too large, the compactor itself needs a budget.

This is why a single `used_tokens` indicator is inadequate for an agent runtime. It cannot explain whether the next action should be compacting history, disabling a tool, choosing a larger-window model, rejecting an oversized injection, or investigating a provider error.

## `BodyAfterPrefix`: Do Not Punish Stable Setup, but Never Hide It

`BodyAfterPrefix` is Codex's answer to a particular accounting problem: a large but stable setup can consume a sizeable share of every new window even when the session itself has barely progressed.

The design separates two questions:

```text
Has this window accumulated enough new work to justify a rollover?
Can the whole request—stable setup plus new work—still fit?
```

To answer the first, Codex remembers the input tokens from the first server-observed request in a window and charges later growth against the automatic budget. To answer the second, it continues to check total active context against the full-context guard. [`auto_compact_window.rs`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/state/auto_compact_window.rs) and [`context_window.rs`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/session/context_window.rs) are the implementation evidence for this split.

The policy is not “ignore the prefix.” It is “do not spend the session-growth budget repeatedly on fixed setup, while still refusing to exceed the total limit.” If the prefix alone nearly fills the usable window, that is not a compaction problem. It is a configuration-admission problem.

## Where Compaction Stops Being the Answer

The static and dynamic mechanisms manage a viable session whose replayable history is growing. Several nearby failures need a different design response.

| Failure class | Why rollover alone is insufficient | Design response |
|---|---|---|
| Fixed prefix already fills the window | No old history exists to remove. | Measure prefix feasibility before first sampling; reduce configuration or select a larger window. |
| Pending input or reinjection crosses the limit | The previous request fit, but the next complete invocation does not. | Preflight the next request, including pending additions and output headroom. |
| A tool loop needs another model call | A reset can detach the continuation from its current task. | Preserve active work state and the user task across the transition. |
| Model switch changes capacity or compatibility | The next consumer is different even though history did not grow. | Validate the target model and migrate the window deliberately. |
| Compaction request overflows | The repair operation exceeds its own input budget. | Bound or chunk compaction input and retain an explicit exact tail. |
| Provider errors recur late in a session | Length is only one possible cause. | Classify the error and compare a smaller retry before treating it as compaction pressure. |

The source makes two of these limits unusually visible. A TODO beside pre-turn compaction says the runtime should estimate pending context updates and the new user message before deciding whether to roll over. That is a design admission: observing the old window is not the same as admitting the next invocation. And local compaction removes oldest history items and retries if its own request overflows, showing that a compactor needs a bounded-input policy of its own. See [`turn.rs`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/session/turn.rs) and [`compact.rs`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/compact.rs).

## One Transition Contract, Several Implementations

The trigger policy answers **when** to leave a window. A separate strategy layer answers **how** to make the next one usable.

Codex can select a remote compaction path, a local replacement-history path, or the TokenBudget path that starts a fresh managed window without model or server summarization. These differ in information preservation and provider dependency, but they should uphold one contract:

```text
after the transition, the next model invocation has a valid context
and enough task state to continue correctly.
```

This is why “compaction” should not be treated as a summary algorithm. It is a state transition with pluggable mechanisms. The dispatch in [`run_auto_compact`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/session/turn.rs) and the fresh-window TokenBudget path in [`compact_token_budget.rs`](https://github.com/openai/codex/blob/8444cf63b50a8a88521e0d2970d49f659b48eac7/codex-rs/core/src/compact_token_budget.rs) make that architecture explicit.

## Define the Continuity Contract Before Choosing the Algorithm

The quality of a transition is not its compression ratio. It is whether the agent can still do the same work without rediscovering or contradicting itself.

For a coding agent, the transition must preserve or make retrievable:

- the objective and non-negotiable user constraints;
- decisions already made and their rationale;
- verified facts from tools and tests;
- exact files, identifiers, commands, errors, and in-progress changes;
- unfinished work, blockers, and the next safe action.

Repeated compaction degrades quality because a summary is not the original record. When a detail is lost and no durable artifact or retrieval path can restore it, later summaries cannot recreate it. The remedy is not merely a longer summary. It is to keep durable files, results, and references outside the hot context window, then make the transition state point back to them.

## What This Means for OpenCode

The OpenCode reports that prompted this investigation fit the same design map. [Issue #48844](https://github.com/anomalyco/opencode/issues/48844) describes a compaction request that is itself too large. [#48847](https://github.com/anomalyco/opencode/issues/48847) describes fixed system, tool, and project overhead exhausting the usable window. [#48370](https://github.com/anomalyco/opencode/issues/48370) describes provider errors that recur as context grows. These are issue reports, not proof of one cause, but they should not all receive “compact earlier” as the answer.

An OpenCode context-health surface should expose design decisions, not just token totals:

- **Capacity safety:** fixed prefix, replayable history, pending additions, output reserve, automatic budget, and full-context guard.
- **Transition timing:** whether a bounded dynamic cut point is available, whether the model requested rollover, and how much room remains before runtime must take over.
- **Failure classification:** prefix infeasibility, compactor size, model-switch compatibility, and provider errors kept separate from normal history growth.

That turns a context-limit error from an opaque event into an operational decision.

## The Core Principle

Compaction is not “summarize when the percentage is high.” It is a control problem with a clear division of labor.

Use deterministic runtime boundaries to guarantee that the agent can continue safely. Within a small bounded interval, let the model use its task understanding to request a less disruptive transition. Keep the actual state change in runtime. And do not mislabel fixed-prefix failures, compactor overflows, model changes, or provider defects as problems a summary can solve.

**Static boundaries protect capacity. Dynamic cut points protect continuity. A reliable agent needs both—and must know when neither is the right tool.**

---
title: OpenCode Session Framework Internals
description: "A developer-facing analysis of OpenCode's session architecture: how sessions are created, how prompts become background work, how clients observe status, and what agent-runtime builders should copy from the design."
pubDate: 2026-07-23
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - session-architecture
---

The easiest way to misunderstand an agent session is to treat it as a chat API call with a longer memory. Send a prompt, receive a response, append both to a transcript. That is enough for a demo. It is not enough for a coding agent.

I ran into this while reading a small fleet client that drives remote OpenCode instances. The client does very little on the surface: create or reuse a session, send a prompt, wait for the remote agent to become idle, then fetch recent messages. The interesting part is that none of those verbs mean exactly what they mean in a normal request-response API. A prompt does not equal a response. A timeout does not mean failure. A session is not just a transcript. Status is not derived from the last line of text.

That small client is a useful entry point because it exposes the shape of the real system. OpenCode's session design is not one function that calls a model. It is a framework for admitting work, serializing execution, projecting durable state, streaming observations, and letting clients recover when a long-running agent is still in flight.

Primary code references:

- `opencode-fleet/src/tools.ts`
- `opencode-fleet/src/session.ts`
- `opencode-fleet/src/node.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- `packages/opencode/src/session/session.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/run-state.ts`
- `packages/opencode/src/session/status.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`
- `packages/core/src/session.ts`
- `packages/core/src/session/input.ts`
- `packages/core/src/session/run-coordinator.ts`
- `packages/core/src/session/runner/llm.ts`
- `packages/core/src/event.ts`
- `packages/core/src/session/projector.ts`

The fleet client follows the desktop-compatible OpenCode API: `/session`, `/session/:id/prompt_async`, `/session/:id/message`, `/session/status`, and `/event`. The newer V2/core API exposes the same architectural direction more explicitly through `/api/session`, `/api/session/:id/prompt`, `/api/session/active`, `/api/session/:id/event`, and the durable `SessionInput` and `SessionEvent` pipeline. Both matter because together they show the transition from a working client protocol to a cleaner internal runtime model.

## Key Takeaways

**If you are building an agent runtime, design sessions as execution containers, not as chat transcripts.** A real session framework has to preserve identity, admit work, run one continuation at a time, expose observable status, persist structured messages, and make interruption and recovery normal operations.

1. **Separate session identity from prompt execution.** A session can outlive any single prompt. It owns directory, project, agent, model, title, permissions, messages, parts, and runtime state.

2. **Treat prompt submission as admission.** The client should be able to submit work and return before the agent finishes. Completion is a separate observation problem.

3. **Serialize execution per session.** Multiple prompts may arrive while the agent is busy. The runtime needs a coordinator that runs at most one drain loop per session and coalesces follow-up work.

4. **Expose status as runtime state.** Busy, idle, and retry are not reliable if inferred from text. They should come from the execution layer or from an authoritative active-session set.

5. **Use events as the observation boundary.** Clients should not poll messages to guess what happened. They should subscribe to session and message events, then keep a local projection.

6. **Persist messages as structured state.** Text is only one part. Tool calls, tool results, reasoning, files, snapshots, errors, and step boundaries need identity and lifecycle.

7. **Make timeout, interrupt, and reset distinct.** Timeout means the caller stopped waiting. Interrupt asks the runtime to stop work. Reset discards a client-side binding or context. These are different operations.

## The Minimal Client Contract

The fleet client is intentionally small. It exposes MCP tools such as `fleet_create_session`, `fleet_send_message`, `fleet_get_session_status`, `fleet_get_session_messages`, `fleet_interrupt_session`, and `fleet_reset_session`. Behind those tools, there are only two main classes.

`SessionManager` keeps an in-memory map from node name to active session ID. It lazily creates a session on first send, reuses the same session for future prompts, and recreates a session if the server returns `404`. `OpenCodeNode` wraps the remote HTTP API and owns a persistent SSE subscriber that listens to `/event`.

The important flow is short:

```text
fleet_send_message
-> SessionManager.send
-> get or create session
-> POST /session/:id/prompt_async
-> wait for session.status idle over SSE
-> GET /session/:id/message
-> extract assistant text or tool progress summary
```

That flow already contains several design choices worth copying.

First, the client binds one long-lived session per remote node. It does not create a fresh session for every prompt. That preserves working context and makes follow-up prompts meaningful.

Second, sending a prompt is asynchronous. `OpenCodeNode.sendPromptAsync(...)` posts a user message to `/session/:id/prompt_async` and returns after the server accepts it. The fleet client then waits for status separately. This is the right split. If the same request both submits work and waits for the entire agent loop to finish, the client has no clean way to distinguish "the server accepted my work but the agent is still running" from "the server never accepted my work."

Third, timeout is not treated as failure. `SessionManager.send(...)` catches `TimeoutError`, fetches partial messages, marks `timedOut: true`, and tells the caller the remote agent is likely still running. That is exactly the behavior an agent coordinator needs. In a coding-agent runtime, a slow task is often useful work, not a broken request.

Fourth, reset is guarded. `fleet_reset_session` checks status and refuses to reset a busy session. This is not just user-interface caution. Resetting while a remote agent is running loses the caller's handle to in-flight work. The agent may still write files, ask for permissions, or finish with output after the caller has thrown away the session ID. A framework should make that hard to do accidentally.

The fleet implementation is not the whole OpenCode session architecture. It is a client-side adaptation. But it shows what the server must provide: stable session IDs, async prompt admission, observable status, message history, interruption, and enough structured message parts to explain progress before final text exists.

## Session Creation Is Identity, Not Execution

In the desktop-compatible API, the legacy route group defines `POST /session` as `session.create`. The handler eventually calls `Session.create(...)`, which creates a session record with an ID, slug, project, directory, path, optional workspace, title, agent, model, permissions, token counters, and timestamps. It publishes `session.created` through the event bridge. Projectors then write that session into SQLite.

Nothing has run yet.

That distinction is easy to miss. A session is not "the model is working." A session is the durable container in which work may later happen. It represents a place in the filesystem, a selected agent and model, permission context, and a message history boundary.

The newer V2/core path makes the same idea clearer. `SessionV2.Service.create(...)` resolves the project for a location, creates a `Session.Info`, publishes a created event, and returns the stored session. Execution is not part of creation. The session starts idle.

This matters for agent framework design because the session ID becomes the join key for everything else:

- user prompts
- assistant messages
- tool calls
- permission requests
- question requests
- status events
- snapshots and diffs
- model and agent switches
- compaction checkpoints
- interrupt and reset operations

If session creation also starts execution, that boundary gets muddy. If a session is only a transcript row, it will not have enough identity to support tooling, permissions, status, or recovery. A good session object should answer: where is this agent working, what policy applies, what model and agent should subsequent turns use, and which durable history does this execution belong to?

## Prompt Submission Is Admission

The desktop-compatible async endpoint is `/session/:sessionID/prompt_async`. Its handler requires the session, then forks `promptSvc.prompt(...)` into the server scope and immediately returns `204 No Content`.

That means the HTTP response does not mean "the assistant finished." It means "the server accepted responsibility for starting the prompt work." The actual work continues in a fiber.

Inside `SessionPrompt.prompt(...)`, OpenCode creates a user message, stores its parts, touches the session, applies any per-prompt tool permission overrides, and then calls `loop(...)` unless the prompt was marked `noReply`. The loop is the real execution path.

The V2/core API names the same boundary more explicitly. `POST /api/session/:sessionID/prompt` calls `SessionV2.Service.prompt(...)`. That service verifies the session, resolves the prompt, chooses a message ID, and calls `SessionInput.admit(...)`. Admission publishes `session.next.prompt.admitted` as a durable event. Only after the input is durably admitted does the service call `execution.wake(sessionID)`.

This is the key design move: prompt submission becomes durable input admission plus execution wakeup.

That gives the runtime several properties that a direct "call the model now" design does not have.

The prompt has an identity before the model runs. The system can reject duplicate message IDs. It can record that a prompt entered the session even if execution starts slightly later. It can choose not to resume immediately. It can queue or steer inputs. It can replay durable input history into a projected message stream. It can recover from client disconnects because the prompt is not merely an in-memory function argument.

If you are building an agent runtime, this is one of the most important principles to copy. Do not make the user's prompt disappear into a model call. Admit it into the session first. Then schedule execution.

## Execution Needs A Per-Session Coordinator

Once prompts can be admitted independently from execution, the runtime needs a rule for what happens when work arrives while the session is already busy.

OpenCode has two implementations that reveal the same idea.

In the desktop-compatible path, `SessionRunState` keeps a per-session `Runner`. The runner has states such as `Idle`, `Running`, `Shell`, and `ShellThenRun`. `ensureRunning(...)` starts work if idle. If a run is already active, it waits for that active run instead of starting a second one. If shell work is active, it can queue a run after the shell finishes. `cancel(...)` interrupts the current fiber and returns the runner to idle.

In V2/core, `SessionRunCoordinator` is smaller and more explicit. It maintains a map from session ID to active entry. `wake(sessionID)` starts a drain fiber if idle. If a fiber is already running, it sets `pendingWake = true`. When the active fiber settles successfully, the coordinator starts a successor if a wake was recorded. `interrupt(sessionID)` marks the entry as stopping, clears pending wake, and interrupts the owner fiber.

That gives OpenCode an important invariant:

```text
one session -> at most one active drain loop
```

Different sessions can run concurrently. The same session cannot accidentally run two provider turns against the same history at the same time.

This is not an implementation detail. It is the difference between a predictable agent session and a race condition factory. Without a per-session coordinator, two prompts can read the same context, both call the model, both write assistant messages, and both execute tools against the filesystem. In a coding agent, that is dangerous. The second prompt may assume files are unchanged while the first prompt is editing them. Tool permissions and status become ambiguous. The UI cannot honestly say what the session is doing.

The right abstraction is not a mutex around the HTTP handler. It is a session execution coordinator. It should live at the runtime layer, below all clients, so desktop, TUI, MCP clients, scripts, and external tools all obey the same rule.

## The Runner Is A Drain Loop, Not One Model Call

The execution loop itself is also larger than one model call.

In the desktop-compatible path, `SessionPrompt.runLoop(...)` repeatedly sets the session busy, loads compacted history, finds the latest user and assistant state, handles subtasks and compaction tasks, resolves the current agent and model, builds tools, assembles system instructions, converts stored messages into provider messages, and calls `SessionProcessor.process(...)`. The processor consumes the provider stream and updates message parts as text, reasoning, tool calls, tool results, errors, and finish state arrive. If the model asked for tools, the loop continues so the tool results can be sent back to the model.

In V2/core, `SessionRunner.run(...)` follows the same conceptual shape. It checks pending steer or queue inputs. `runTurnAttempt(...)` promotes pending input into active context, prepares system context, resolves model and tools, builds an `LLM.request(...)`, streams provider events, publishes structured session events, settles local tools, and continues if tool calls or new steering require another turn.

The naming matters. A good agent runtime does not have a `completeChat(...)` function. It has a drain loop. The loop drains admitted work until the session reaches a stable idle boundary.

That loop has to deal with continuation conditions:

- the model requested tools
- tools finished and their results need to be sent back
- new steering arrived while a turn was active
- queued input is waiting
- compaction is required before another provider call
- the provider failed before durable assistant output existed
- the user denied permission and the loop should stop
- the session was interrupted

If those conditions are bolted onto a single request handler, the handler becomes impossible to reason about. OpenCode keeps them inside session execution. Clients submit work, observe events, and interrupt if needed. They do not own the agent loop.

## Status Should Come From Execution, Not Transcript Guessing

The fleet client originally has a tempting fallback: inspect messages and infer busy or idle by looking for step-finish parts after the last user message. That kind of fallback is useful for compatibility, but it should not be the primary status model.

OpenCode's desktop-compatible runtime has `SessionStatus`. It keeps an instance-local map of non-idle sessions. `set(sessionID, { type: "busy" })` publishes a `session.status` event and stores the status. `set(sessionID, { type: "idle" })` publishes both `session.status` and deprecated `session.idle`, then deletes the session from the map. A missing status means idle.

`SessionRunState` calls `status.set(...busy...)` when a runner becomes active and `status.set(...idle...)` when the runner returns to idle. `SessionProcessor` sets busy while processing provider streams and sets retry status during retry backoff. The server exposes the status map through `GET /session/status`, and it also streams `session.status` events through `/event`.

The V2/core API exposes the same concept as `GET /api/session/active`. It returns the set of foreground drains currently owned by this OpenCode process. If a session appears there, it is running. If it is absent, it is inactive.

The lesson is simple: status should come from the execution owner.

Message history is a projection of what happened. It is not the authority for what is currently happening. A session may be busy before the first assistant step appears. A provider may be retrying without writing new visible text. A tool may be running with no final assistant answer yet. A streamed text delta may arrive before the durable final text part. If a client has to scrape messages to infer status, the runtime has failed to expose a basic operational fact.

This is why `opencode-fleet` keeps a persistent SSE status stream and optimistically marks a session busy immediately after `prompt_async` returns. There is a race window between prompt admission and the first SSE event. A client that immediately checks status should not conclude "idle" just because the event has not arrived yet.

## Events Are The Observation Boundary

OpenCode clients do not need to keep asking, "what changed?" They subscribe.

The desktop-compatible `/event` endpoint registers an eager listener against `EventV2Bridge`, filters events by instance directory and workspace, emits a synthetic `server.connected`, sends heartbeat events, and streams JSON payloads as SSE. The global event endpoint wraps the `GlobalBus` and carries cross-instance events. The newer server package exposes `/api/event` for all server events and `/api/session/:sessionID/event` for durable per-session events.

That gives the desktop app and external clients a common observation model. The app's `server-session.ts` applies events into a local Solid store. It updates session info on `session.created` and `session.updated`, status on `session.status`, messages on `message.updated`, parts on `message.part.updated`, deltas on `message.part.delta`, permissions on `permission.asked`, questions on `question.asked`, and so on. It also reconciles optimistic local messages with confirmed server events.

This local projection is not just for UI polish. It is a fundamental architecture choice. The server owns truth. Clients maintain projections.

That separation solves several problems.

It lets a client show progress before a final response exists. It lets a client reconnect and refresh from durable history when needed. It keeps streaming deltas separate from final durable values. It lets different clients observe the same session without embedding execution logic in each client. It gives external tools a debugging path: subscribe to events, then inspect messages and parts when something looks wrong.

If you build an agent runtime without an event boundary, every client becomes a partial runtime. The UI will poll messages. The CLI will invent a different status heuristic. External tools will guess when work is done. Eventually those guesses disagree.

## Messages Are Structured Projections

The most visible artifact of a session is the conversation. But OpenCode does not treat the conversation as plain text.

In the desktop-compatible projection, session messages live as message rows and part rows. A user message can contain text, files, agents, and subtasks. An assistant message can contain text, reasoning, tool parts, step markers, snapshots, patches, retries, compaction parts, and errors. A tool part has a call ID, tool name, input, status, output, metadata, attachments, and timing.

That shape is why `opencode-fleet` can return useful partial output when a prompt times out. If the assistant has no text yet but tool calls are running, the client can summarize tool activity instead of returning an empty string. It can say the agent is busy and list the tools in progress.

V2/core pushes this further with durable session events and projected messages. `SessionInput.admit(...)` records prompt admission. `SessionInput.promoteSteers(...)` publishes `session.next.prompted`. `createLLMEventPublisher(...)` converts provider events into session events such as `session.next.step.started`, `session.next.text.delta`, `session.next.text.ended`, `session.next.tool.called`, `session.next.tool.success`, `session.next.tool.failed`, and `session.next.step.ended`. `SessionProjector` turns those events into queryable message rows.

This creates three useful layers:

| Layer | Role |
|-------|------|
| Durable events | What happened, in order, with session sequence numbers |
| Projected messages | Query-friendly session state for UI and clients |
| Client store | Local observable cache, including optimistic and streaming state |

That layering is more work than appending text to an array. It is also what makes a coding-agent session debuggable. If a tool failed, you can find the tool call. If a provider streamed text and then failed, you can represent partial output and final error separately. If a permission request blocked execution, it has identity. If compaction changed the context boundary, it is a session event and a message part, not an invisible truncation.

The design principle is that the transcript is a projection, not the source of truth. The source of truth is the session's structured event and message state.

## Interrupt Is Not Reset

Long-running agents need lifecycle controls. OpenCode exposes several, and the differences matter.

`prompt_async` starts work and returns immediately. `session.status` or `/api/session/active` tells a client whether work is still running. `/session/:id/abort` or `/api/session/:id/interrupt` asks the runtime to stop active execution. Fetching messages shows what has happened so far. Resetting a client binding merely means the client stops using that session ID for future sends.

These operations should not be collapsed.

The fleet client handles this well. On timeout, it does not reset. It tells the caller the agent is still running and recommends checking status, inspecting messages, waiting, or interrupting. `fleet_interrupt_session` sends an abort signal but does not delete the session or clear the binding. `fleet_reset_session` discards the cached session ID only after checking that the session is not busy.

That behavior reflects the server-side reality. In the desktop-compatible runtime, `SessionRunState.cancel(...)` interrupts active fibers and cancels related background jobs. The runner transitions back to idle and status events are emitted. In V2/core, `SessionRunCoordinator.interrupt(...)` marks the active entry as stopping, clears pending wake, and interrupts the owner fiber. The runner then settles interrupted tools and assistant state.

A reset cannot do that. Reset is a client-side context decision. Interrupt is an execution decision. Delete is a storage decision. Timeout is a waiting decision. If your framework uses one "cancel" or "reset" button for all four, users will eventually lose work or leave orphaned execution behind.

## Compatibility Is A Shell Around The Runtime

One subtle part of OpenCode's current codebase is that it has both the desktop-compatible instance API and the newer V2/core API mounted in the same process. The route tree in `packages/opencode/src/server/routes/instance/httpapi/server.ts` provides legacy routes such as `/session/:id/prompt_async` and `/event`, while also mounting the newer `@opencode-ai/server` handlers for `/api/session`, `/api/event`, and related endpoints.

That can look confusing if you read only endpoint names. It makes more sense if you separate protocol compatibility from runtime architecture.

The legacy API exists because clients depend on it. The desktop UI, generated SDKs, compatibility wrappers, CLI paths, and external tools still speak that language. It has concepts such as `promptAsync`, `message.part.delta`, and `session.status`.

The V2/core architecture makes the internal model more explicit. Prompt admission is a durable event. Pending inputs live in `SessionInputTable`. Execution is coordinated through `SessionExecution` and `SessionRunCoordinator`. Session events can be replayed per aggregate. Projectors build structured message rows from durable events.

The lesson for agent-runtime builders is not "copy these exact endpoints." The lesson is to keep the compatibility shell thin. Let old clients keep their contract, but move the runtime toward clearer boundaries: admission, execution, events, projection, and observation.

If compatibility code owns the runtime model, every old endpoint shape becomes a permanent architectural constraint. If the runtime owns the model, compatibility handlers can translate.

## What To Copy

If I were designing a session framework for a new coding agent, I would copy these pieces first.

Create sessions independently from prompts. A session should be a durable execution container with location, agent, model, permissions, title, timestamps, and identity. It should be useful before anything is running.

Admit prompts before running them. Give each prompt or user message an ID. Persist it or publish it durably. Only then wake execution. That makes retries, duplicate detection, queueing, and recovery possible.

Run one drain loop per session. Do not let every HTTP request or client call start its own model execution. A coordinator should own session execution and serialize work for that session while allowing other sessions to run concurrently.

Make status authoritative. Either expose a status map or an active execution set. Busy, idle, and retry should be runtime facts, not message-history guesses.

Stream events. Clients should subscribe to server events and maintain projections. Polling can exist as a fallback, but it should not be the core observation model.

Persist structured message parts. Text alone is not enough. Tool calls, tool results, reasoning, files, errors, snapshots, and step boundaries need their own identities and states.

Design lifecycle controls separately. Timeout, wait, interrupt, reset, delete, and fork are not the same operation. Give them separate APIs and make dangerous transitions explicit.

Keep compatibility outside the core. Endpoint names will change. SDK shapes will change. Desktop and CLI needs will differ. The runtime should be stable underneath those clients.

## The Core Shape

The simplest useful mental model for an agent session is this:

```text
Session identity
  -> admitted inputs
  -> per-session execution coordinator
  -> agent drain loop
  -> structured events
  -> projected messages
  -> client-side observable state
```

That shape is more complicated than a chat completion wrapper. But the complexity is paying for real product requirements: long-running work, tool execution, concurrent clients, interruption, retries, partial output, permissions, compaction, and debugging.

The mistake is to start with the provider API and build upward. Provider APIs know how to produce tokens and tool-call requests. They do not know what a session means in your product. They do not know how to serialize work per project directory. They do not know when a client timed out but the agent is still running. They do not know how your UI should reconcile optimistic messages with durable events. They do not know what it means to reset a remote worker safely.

The session framework owns those answers.

OpenCode's implementation is valuable because it exposes that boundary. The model call is inside the session runtime, not the other way around. Prompts are admitted before execution. Execution is coordinated per session. Status is published by the runner. Events are the observation surface. Messages are structured projections. Clients can be thin because the runtime has a real shape.

That is the design principle worth taking: build the session as the agent's operating context. The chat transcript is only one view of it.

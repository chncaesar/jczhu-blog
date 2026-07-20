---
title: OpenCode Tool Calling Internals
description: "A developer-facing analysis of OpenCode's tool-calling design: why agent runtimes need a tool layer, how OpenCode structures that layer, and what to copy or avoid when building your own runtime."
pubDate: 2026-07-18
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - tool-calling
---

This document analyzes OpenCode's tool-calling implementation from the perspective of someone building an agent runtime. The goal is not only to explain how OpenCode happens to call tools today. The more useful question is: what design problems does a real coding-agent runtime have to solve once tool calling moves beyond a demo callback?

Primary code references:

- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/llm/ai-sdk.ts`
- `packages/opencode/src/session/llm/native-runtime.ts`
- `packages/opencode/src/permission/index.ts`

The conclusions below follow the normal OpenCode session tool path. MCP tools, plugin tools, and the experimental native LLM runtime are included where they reveal the underlying design.

## Key Takeaways

**If you are building an agent runtime, treat tool calling as a runtime subsystem, not as a provider feature.** Provider function calling is only the provider-side way of delivering a tool request. The runtime still has to decide which tools exist, which tools are visible, whether execution is allowed, how progress is represented, how output is normalized, and how the session recovers when execution fails.

1. **Keep an internal tool contract.** Do not let OpenAI, Anthropic, AI SDK, MCP, or any one provider define the shape of your runtime tools. OpenCode uses `Tool.Def` as its internal contract and projects it outward later.

2. **Build a tool catalog, not a static tool list.** Tool visibility depends on the agent, model, provider, runtime flags, plugins, MCP clients, and permissions. A serious runtime recomputes the catalog for each turn.

3. **Put permission gates inside execution.** Prompt instructions and UI affordances are not enough. The dangerous action must block at the point where the tool would actually touch the filesystem, shell, network, or external server.

4. **Persist tool calls as state.** A tool call is not just text in the transcript. It has identity, input, progress, output, attachments, timing, error state, and cancellation behavior.

5. **Normalize provider events before they reach the session layer.** Providers and model runtimes disagree about streamed tool inputs, results, errors, and provider-executed calls. The session layer should consume one event vocabulary.

6. **Design for debuggability from the start.** Tool call IDs, session IDs, message IDs, permission events, plugin hooks, and durable message parts are not extras. They are what let you answer the basic question: what happened?

## Why Tool Calling Needs A Runtime Layer

The smallest tool-calling demo looks simple. The model emits a function name and JSON arguments. The application looks up a local function, runs it, sends the result back, and the model continues.

That design collapses as soon as the agent becomes useful.

A coding agent does not merely call `getWeather`. It reads files, writes files, applies patches, spawns shell commands, lists project directories, asks questions, starts subtasks, calls MCP servers, and may return images or other attachments. Some tools are safe. Some need approval. Some are available only for certain models. Some are provided by plugins. Some should be hidden from an agent entirely. Some run long enough that the UI needs progress. Some are interrupted halfway through. Some produce outputs too large to fit into the next request.

At that point, provider function calling is not the system. It is only one input boundary. The real system is the layer that turns a model's request into a permissioned, observable, cancellable, durable operation inside an agent session.

OpenCode's implementation is useful because it draws that boundary clearly. Tools are not just callback functions passed to `streamText(...)`. They pass through an internal contract, a registry, a session adapter, an LLM runtime adapter, and a session processor. That layering has cost, but it solves problems a direct callback design usually discovers too late.

## How The Pieces Connect

The concrete implementation path is short enough to keep in your head.

`SessionPrompt.runLoop(...)` creates the assistant message for the current provider turn. Before calling the model, it asks `SessionTools.resolve(...)` to build the tool map for this exact agent, model, session, permission state, and runtime configuration. `SessionTools.resolve(...)` pulls tool definitions from `ToolRegistry`, adapts them into AI SDK-compatible tools, injects `Tool.Context`, and wires execution through plugin hooks and `Permission.ask(...)`.

Then `SessionProcessor.process(...)` calls `LLM.stream(...)`. The default runtime passes the prepared tools to AI SDK `streamText(...)`. The native runtime uses a different adapter, but still calls back into the same OpenCode-owned tool execution shape. Runtime-specific stream events are converted into `LLMEvent` values. `SessionProcessor` consumes those events and persists text, reasoning, tool calls, tool results, errors, usage, and cleanup state as session message parts.

The spine is:

```text
SessionPrompt.runLoop
-> SessionTools.resolve
-> ToolRegistry.tools
-> LLM.stream
-> LLMAISDK.toLLMEvents or native runtime events
-> SessionProcessor.handleEvent
-> Session.updatePart / Session.updateMessage
```

That path is also the debugging path. If a tool was missing, start at `ToolRegistry.tools(...)`. If it was visible but executed with the wrong context, inspect `SessionTools.resolve(...)`. If the provider emitted unexpected tool events, inspect the runtime adapter. If the UI shows the wrong state, inspect what `SessionProcessor` persisted.

## Design Principle 1: Keep A Provider-Independent Tool Contract

OpenCode's internal contract lives in `packages/opencode/src/tool/tool.ts`. A tool definition has an ID, description, parameter schema, optional JSON Schema, execute function, and optional validation-error formatter. The important detail is that this is OpenCode's shape, not the provider's shape.

The parameter schema is an Effect schema. Before any tool implementation runs, the wrapper created by `Tool.define(...)` decodes unknown model input. If the model emits invalid arguments, OpenCode raises `InvalidArgumentsError` with a model-facing message that asks the model to rewrite the input. Only decoded input reaches the tool implementation.

The execute function receives a `Tool.Context` containing the session ID, message ID, tool call ID, active agent, abort signal, prior messages, a `metadata(...)` updater, and an `ask(...)` permission hook. That context is the real API a tool author uses. A file-writing tool does not need to know how the TUI handles permission prompts. It only needs to call `ctx.ask(...)`. A long-running tool does not need to know how session parts are stored. It only needs to call `ctx.metadata(...)`.

The wrapper also enforces cross-cutting behavior. It validates arguments, records a `Tool.execute` span, applies output truncation when the tool has not already done so, and attaches common attributes such as `tool.name`, `session.id`, `message.id`, and `tool.call_id`.

The design lesson is simple: define the tool contract around your runtime's invariants. Provider schemas, AI SDK tools, MCP definitions, and plugin APIs should be projections or adapters. They should not be the source of truth.

## Design Principle 2: Build A Runtime Tool Catalog

OpenCode's `ToolRegistry` is not just a map from names to functions. It is a catalog builder.

It starts with built-in tools such as `read`, `glob`, `grep`, `edit`, `write`, `task`, `webfetch`, `todo`, `skill`, `shell`, and `apply_patch`. It then scans configured directories for project tools under `{tool,tools}/*.{js,ts}` and loads plugin-provided tools from the plugin service. When a plugin provides a tool, the registry immediately wraps it in OpenCode's internal tool contract, so the rest of the runtime can treat it like a built-in tool.

The registry then filters and shapes that catalog for the current turn. For example, the web search tool is not always visible. OpenCode exposes it only when the selected provider supports it, or when runtime flags such as Exa or parallel search are enabled. Experimental tools appear only when flags allow them. GPT-family model handling can choose `apply_patch` and hide `edit` and `write`. The `task` tool also gets a dynamic description listing the subagents the current agent is allowed to call, so the model knows which `subagent_type` values are valid. Before any tool is exposed to the model, plugins also get a `tool.definition` hook that can adjust its description or schema.

This is also how OpenCode exposes subagent delegation. A subagent is not normally launched by a hidden scheduler. The model sees the `task` tool, reads the dynamically listed `subagent_type` options, and decides whether delegation is useful for the current turn. If it calls `task`, the runtime executes that tool and starts the selected subagent. In other words, delegation itself is modeled as tool calling.

Permissions also affect visibility. A broad deny rule can hide a tool before the model ever sees it. Edit-like tools are grouped under `edit`, while MCP resource tools are grouped under `read`. This avoids advertising tools that are already forbidden by policy.

The design lesson is that an agent's tool list is a runtime projection. It depends on who the agent is, what model is running, what session permissions apply, what plugins are installed, what external servers are connected, and what feature flags are enabled. If you make the tool list static, those concerns will leak into individual tools or into prompt text.

## Design Principle 3: Put Permissions Inside Execution

OpenCode's permission boundary is not a sentence in the system prompt. It is an Effect that can block tool execution.

Tools call `ctx.ask(...)` with a permission name, path or resource patterns, metadata, and optional `always` patterns. The write tool asks for `edit` permission and includes a diff. The shell tool parses commands, resolves paths, asks for `bash`, and separately asks for `external_directory` when a command reaches outside the project boundary. Read-like tools ask for `read` over path patterns. MCP resource tools ask for `read` over `mcp:server:uri` patterns.

`Permission.ask(...)` checks three sources of authority: the agent's configured permission rules, any session-level permission overrides, and approvals granted earlier in the current runtime process when the user chose an "always allow" option. If every pattern is allowed, execution continues. If any pattern is denied, execution fails. If the runtime needs user input, it creates a pending request, publishes `Permission.Event.Asked`, and waits on a `Deferred`. When the client replies, `Permission.reply(...)` publishes `Permission.Event.Replied` and resolves or rejects the waiting tool.

This design matters because permission is enforced at the point of action. A model can ask for a shell command. The UI can render a prompt. But the shell command does not run until the permission service resolves. The approval path is part of execution, not decoration around it.

The design lesson is to make safety a blocking dependency of side effects. If permission is implemented only as model instruction, client UI, or precomputed filtering, eventually some tool path will bypass it.

## Design Principle 4: Persist Tool Calls As State

A tool call is a long-lived operation, not a line of assistant text. It begins when the provider says the model wants a tool, but it may pass through streamed input, permission waiting, execution, progress updates, output truncation, attachment handling, cancellation, and failure cleanup before the model sees a result. If a runtime only stores the final tool result as transcript text, it loses the operation boundary.

That boundary matters. The UI needs to show that a tool is running before it finishes. A permission rejection needs to be different from a tool crash. A cancelled run needs to mark unfinished calls instead of leaving them as ghosts. A debug trace needs to answer which tool ran, with what input, under which assistant message, and what output or error it produced. None of that can be reliably reconstructed from prose.

Durability adds another benefit: interruption and restart become tractable. If tool calls are persisted as structured records, a runtime can inspect what was pending, running, completed, or failed after a crash or cancellation. That does not mean it should blindly re-execute tools after restart; tools may have side effects. It means the runtime has enough state to make an explicit recovery decision: retry only if safe, mark an abandoned call as interrupted, or rebuild the model-visible history with accurate completed results. Without durable tool state, restart logic has to infer too much from partially written text.

OpenCode handles this by persisting tool calls as assistant message parts. `SessionProcessor` owns the state machine. When the normalized event stream reports tool input or a tool call, the processor calls `ensureToolCall(...)`. If this is the first event for a call ID, it creates a `tool` part with state `pending`. When the `tool-call` event arrives, the part becomes `running` and records the tool name, input, timing, and provider metadata. When a result arrives, `completeToolCall(...)` writes `completed` with output, metadata, title, attachments, and end time. When an error arrives, `failToolCall(...)` writes an `error` state.

The basic state model is:

```text
pending
-> running
-> completed | error
```

There is also cleanup behavior. At the end of processing, unresolved tool calls are given a short chance to settle. Remaining calls are marked as interrupted errors with `Tool execution aborted` and metadata indicating interruption. This keeps the transcript from containing permanently running calls after cancellation or stream failure.

The exact state machine is small, but the design choice is large. Tool calls are durable operation records. Text is what the model reads later. State is what the runtime needs to render, cancel, inspect, retry, and debug the operation.

## Design Principle 5: Normalize At Runtime Boundaries

An agent runtime has two unstable boundaries around tool calling. One boundary faces the model provider. The other faces tool implementations. Both are messy.

Providers do not all describe tool activity the same way. One runtime may stream tool input deltas. Another may report only a completed call. A provider may mark a call as provider-executed, surface a tool error as a stream event, or wrap usage and metadata in provider-specific fields. If those event shapes leak directly into session state, every downstream system has to understand provider quirks: UI rendering, debugging, retries, compaction, permissions, and persistence.

Tool outputs have the same problem from the other side. One tool may return a string. Another may return a structured object. An MCP tool may return text, an image, or a resource blob. A file-oriented tool may return attachments. A shell tool may return too much output. If the runtime lets every output shape flow straight into history, the next model request becomes unpredictable and the UI has no stable contract to render.

OpenCode handles the provider side with an event normalization seam. The default runtime path uses AI SDK `streamText(...)`; the experimental native runtime lowers selected requests into `@opencode-ai/llm`. The session processor does not consume either runtime directly. Both paths converge on `LLMEvent`. For the AI SDK path, `packages/opencode/src/session/llm/ai-sdk.ts` converts `fullStream` events into OpenCode's event vocabulary: text deltas, reasoning events, step events, tool input events, tool calls, tool results, tool errors, provider errors, and finish events. The native runtime emits the same downstream vocabulary.

OpenCode handles the tool-output side with a normalized result shape: title, metadata, output text, and optional attachments. The tool wrapper applies output truncation unless the tool already reports truncation metadata. `SessionTools.resolve(...)` assigns IDs to attachments and binds them to the current session and assistant message. `SessionProcessor` can normalize image attachments before persisting the completed result. MCP resource helpers convert text, images, and resource content into explicit text output plus durable file attachments, while unsupported or oversized binary content is omitted with a visible explanation.

The design choice is not just convenience. It protects the rest of the runtime from two sources of drift: provider event drift and tool output drift. Once a provider stream has become `LLMEvent`, session persistence does not care whether the call came from AI SDK or the native runtime. Once a tool result has become OpenCode's output shape, the model, UI, and database do not care whether it came from a built-in tool, plugin tool, or MCP server.

The lesson for runtime builders is to normalize at every boundary where external variability enters. Do not let provider-specific event shapes or tool-specific output shapes become your session model. Convert them into runtime-owned contracts before they become history, UI state, or the next model input.

## What OpenCode Gets Right

**It separates internal tool semantics from provider mechanics.** `Tool.Def` is the source of truth. AI SDK tools, MCP tools, plugin tools, and native runtime tools are adapters around that contract.

**It makes tool visibility contextual.** The runtime does not pretend every agent and every model have the same capabilities. The tool catalog is rebuilt for the current session turn.

**It puts permission checks where side effects happen.** Sensitive operations block inside execution, and the approval flow is represented as runtime events.

**It persists tool lifecycle explicitly.** A tool call has state, input, timing, output, metadata, attachments, and failure information. This is essential for UI, debugging, and recovery.

**It creates a stable event seam between model runtimes and session state.** AI SDK and native runtime differences are normalized before `SessionProcessor` handles them.

**It leaves room for extension.** Plugins and MCP servers can add tools without bypassing the same broad execution framework.

## Where The Design Is Still Expensive

The cost of this design is complexity.

A tool call can pass through many layers: tool definition, registry projection, provider schema transformation, session adapter, permission gate, plugin hooks, LLM runtime, event normalization, and session processor persistence. When behavior is wrong, the bug may live in any one of those seams. A tool can be defined correctly but hidden by permissions. It can be visible but transformed into a provider schema the model handles poorly. It can execute successfully but return an output shape that is later truncated. It can be interrupted after the provider already emitted a partial event.

The design also relies on tools asking for the right permissions. The framework can block `ctx.ask(...)`, but it cannot magically know which resources an opaque tool input will touch. The shell tool is the clearest example. A file tool receives a structured `filePath`, so it can ask for permission over that path directly. A shell tool receives an opaque command string. Before it can ask precise permissions, it has to parse that string, identify filesystem-related commands such as `rm`, `cp`, `mv`, `mkdir`, `cat`, or `cd`, extract path arguments, expand home and environment references, resolve relative paths against the working directory, and detect paths outside the project boundary. Only then can it ask for permissions such as `bash` or `external_directory` with meaningful patterns. Without that parsing step, the runtime would either approve every shell command too broadly or block useful commands too often.

Safety moves from a prompt problem to a tool implementation problem. That is better, but it is still work.

Provider behavior remains an input boundary. OpenCode normalizes provider events after it receives them, but it still depends on the provider or runtime to surface tool calls, results, errors, and cancellation in a usable way. The native runtime can reduce some provider coupling, but it does not remove the need for careful adapter design.

The design lesson is not that every agent runtime should copy OpenCode's exact files. The lesson is that once an agent can change a real project, tool calling becomes infrastructure. Infrastructure has seams, state, and failure modes.

The provider tells you what the model wants. The runtime is responsible for making that request safe, observable, and recoverable.

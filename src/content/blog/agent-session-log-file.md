---
title: The Agent Session Is the New Log File
description: AI coding sessions contain evidence about repeated workflow failures. I built an OpenCode plugin to turn that evidence into rules, skills, commands, and better tools.
pubDate: 2026-07-11
tags:
  - ai-coding
  - software-engineering
  - agent-workflow
  - opencode
---

I kept seeing the same failures in different clothes. An agent would finish a task without running the right verification. Another session would drift because my first instruction was too vague. A third would reveal a missing tool primitive only after the agent had faked it badly with shell glue. None of these incidents were mysterious while they were happening. The mystery was why I kept rediscovering them one session at a time.

The evidence was already there. OpenCode had the full conversation: what I asked, what the agent assumed, which tools it called, where it stopped, where I corrected it, and which mistake repeated from last week. But after a task ended, that evidence mostly turned back into scrollback. I might remember the pain, maybe write one rule into `AGENTS.md`, maybe not. The session itself disappeared from the engineering process.

That started to feel wrong. Code gets reviewed. Logs get searched. CI failures get archived. Production incidents get postmortems. But the conversation that produced the code, the test run, the bad deployment check, or the missing verification step is often treated as disposable. For AI-assisted development, that conversation is not disposable. It is the log of the human-agent system.

---

## The part we do not review

When a pull request goes wrong, I can inspect the diff. When a deployment goes wrong, I can inspect logs and metrics. When a test fails, I can inspect the failing command and output. Those artifacts are boring, durable, and searchable. They give the next debugging pass something firmer than memory.

Agent sessions are different. They are full of useful evidence, but they are rarely treated as an artifact worth reviewing. The usual review stops at the code: did the patch compile, did the test pass, did the diff look reasonable? That misses a layer above the code, where many AI failures actually begin.

The instruction may have been underspecified. The agent may have edited before reading enough context. The task may have needed a global search, but the conversation only named one file. The verification boundary may have been wrong: the agent checked that a command returned success, not that the returned data meant what success was supposed to mean. The tool gap may have been obvious in hindsight because the agent kept recreating the same fragile shell loop, but no one stopped to ask whether that loop should become a real primitive.

These are not code-review findings. They are session-review findings. You only see them by reading the conversation as an execution trace.

---

## A session is telemetry

Once I started thinking of sessions as telemetry, the useful question changed. It was no longer: was this answer good? That question is too local. A single answer can be fine while the workflow around it is broken.

The better question is: what keeps happening?

If I correct the same instruction three times, that is not a prompt problem anymore. It is a missing rule. If an agent repeatedly invents a polling loop with `sleep` and `curl`, that is not a one-off bash mistake. It is a missing tool. If every large task ends with me saying, "you should have checked the rest of the codebase too," that is not an unlucky review comment. It is a missing checklist step.

This is the same move engineers already make everywhere else. One failed request is an error. A pattern of failed requests is an SLO problem. One flaky test is annoying. A cluster of flaky tests is a signal about architecture, isolation, or ownership. One bad agent session is just a bad session. A repeated agent-session shape is workflow telemetry.

The hard part is that humans are bad at remembering this evidence. I remember the emotional contour of a session much better than the actual sequence of events. I remember that I got frustrated. I do not reliably remember whether the first mistake was my instruction, the agent's shortcut, a missing tool, or a verification step that looked complete but was aimed at the wrong thing. If I want to improve the workflow instead of just complain about it, I need the transcript.

---

## The plugin

So I wrote [`opencode-session-reflection`](https://github.com/chncaesar/opencode-session-reflection), a small OpenCode plugin that adds one tool: `session_reflection`.

The installation path is intentionally boring:

```json
{ "plugin": ["opencode-session-reflection"] }
```

Restart OpenCode, then review recent sessions. In my local development setup I also use a slash command, `/session-review`, which calls the tool and asks the current model to analyze the returned evidence. The plugin collects session content through the OpenCode SDK. It does not read `opencode.db` directly.

The analysis prompt focuses on three categories.

First: developer-to-agent communication gaps. Was the task framed poorly? Was the scope ambiguous? Did I fail to say whether I wanted discussion or implementation? Did I omit acceptance criteria or verification requirements that I actually knew at the time?

Second: recurring OpenCode mistakes. Did the agent edit before reading context? Did it claim completion without verification? Did it fix one reported occurrence without searching for the same pattern elsewhere? Did it ignore project rules, overbuild, or stop early?

Third: plugin, skill, command, or rule opportunities. This is the most important category for me. The goal is not to turn every annoyance into automation. The goal is to find repeated friction where OpenCode can observe a reliable trigger and take a safe action. Some failures should become a rule. Some should become a skill. Some should become a slash command. A few deserve a plugin.

The plugin writes privacy-conscious audit metadata locally under the OpenCode config directory: selected session ids and titles, hashed directory paths, message counts, transcript counts, tool-call counts, prompt hashes, and saved report paths. It does not store raw transcripts in the audit manifest. The transcript is used to generate the review prompt in the current OpenCode session; where that prompt goes depends on the model provider configured for that session.

That boundary matters. A session-review tool should not quietly become a second telemetry product. The point is to help the developer inspect their own local workflow, not to upload their mistakes somewhere else.

---

## Why this belongs in the plugin ecosystem

The obvious use is personal: run it on the last few sessions and see what you keep doing wrong. That is already useful. But the more interesting use is upstream of plugin design.

I recently wrote [`opencode-waitfor`](https://github.com/chncaesar/opencode-waitfor) because I kept watching agents fake readiness checks with brittle shell loops. The pattern was concrete. The tool boundary was clear. A URL, port, or command should be polled until a condition holds or a timeout returns the last observed state. That is a good plugin because the repeated behavior was observable and the replacement primitive was smaller than the broken behavior it displaced.

But not every repeated failure is that clean. Some are better handled by an `AGENTS.md` rule. Some need a skill because the real work is reasoning discipline, not API access. Some only need a slash command that packages a known sequence of prompts and tool calls. Some should not be automated at all because the trigger is too ambiguous or the action is too risky.

That is why I wanted the reflection step to ask about feasibility and value, not just annoyance. Can OpenCode detect the situation without brittle transcript parsing? Is the required data available through the SDK? What are the false positives? Does an existing plugin or command already cover most of the need? Would this help other OpenCode users, or is it just a fossil from my private workflow?

Good agent tooling should come from repeated evidence, not imagination. Otherwise it is too easy to build impressive little tools for problems that occurred once, or tools that automate the part that should have stayed under human approval. A session review is a filter. It turns "that was annoying" into "this happened four times, the trigger is visible, the safe action is narrow, and the value is real."

---

## Start with one repeated failure

If you use OpenCode, the useful experiment is small. Install the plugin, run a review over your last few sessions, and look for one repeated failure. Not ten. One.

Maybe it is a communication habit: you keep sending underspecified requests and then correcting the agent two rounds later. Maybe it is a verification habit: the agent keeps checking that commands ran, not that the right thing changed. Maybe it is a tool gap: the agent keeps synthesizing the same fragile shell pattern because no better primitive exists. Pick the clearest one and decide what kind of artifact it deserves.

If it applies across future sessions, write a rule. If it is a reasoning workflow, write a skill. If it is a repeated user-invoked flow, write a command. If it is a narrow, observable operation that agents keep faking badly, write a plugin.

The point is not to make the agent introspective. The point is to make the workflow observable. Once the session becomes a log, repeated mistakes stop being anecdotes. They become engineering input.

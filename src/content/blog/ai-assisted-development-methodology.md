---
title: An AI-Assisted Development Methodology, Earned from Real Incidents

description: Field notes from months of building a production data platform with an AI coding agent — the rules that actually worked, the incidents that forced them into existence, and the boundaries that keep the agent from touching production.

pubDate: 2026-10-12

tags:
  - ai-coding
  - agent-workflow
  - ai-agents
  - software-engineering
  - data-engineering
---

This document is a methodology for building software with AI assistance, compiled from the rules that survived real use on a production data platform. It is not theory. Every rule in here exists because a real incident forced it into existence, and every case study at the end is a bug or a mistake that actually happened. What I write below is what I learned — translated from the internal playbook, with company and vendor names removed.

---

## 1. Core Principles

### Why a methodology at all

AI writes code fast, but fast is not the same as correct. AI reliably produces content that *looks* right and *is* wrong: SQL with the right syntax but a misunderstood definition, a change in one place that silently breaks a consumer somewhere else, a root cause left unexamined under the phrase "the difference is within acceptable range." The purpose of a methodology is to keep AI's output inside a boundary where it can be verified, traced, and maintained.

### Single source of truth

Every kind of information has exactly one authoritative location. Everything else references it, never copies it:

- Entity definitions, fields, sync frequency → the entity config files
- Warehouse table structures and refresh functions → the migration files
- Warehouse dependency relationships → the job config files
- BI card SQL and dashboard layout → the IaC scripts
- Business definitions → the per-dashboard guide documents

When the truth changes, only the authoritative source changes. Every other document is just an index pointing at it.

---

## 2. Safety Red Lines

### The production database is read-only

Every access path into the production databases — the ERP and the warehouse — allows read-only queries. Forbidden: `UPDATE`, `DELETE`, `INSERT`, `MERGE`, `BACKUP`, `RESTORE`, `TRUNCATE`, `DROP`, `ALTER`, regardless of whether it is wrapped in a transaction that will be rolled back, and regardless of whether the target is `NUL` or a temp table.

This red line was actually violated once. While exploring the ERP's budget module, an AI tried to "verify whether the account had write permission" by executing `UPDATE ... WHERE 1=0; ROLLBACK` and `BACKUP DATABASE xxx TO DISK='NUL'`. Even though no data was damaged, the operation itself produced a write intent and lock contention against a production database. That is an unacceptable risk. It was stopped on the spot.

**The lesson:** the only way to verify a permission boundary is through read-only catalog queries (role membership, database permissions). You cannot verify it by "actually executing a write and seeing whether it errors." "It looks harmless" is not an exemption.

### The red line must cover "the tool objectively exists", not just "the tool description says read-only"

This rule went through an important wording correction, and the process of correcting it matters more than the conclusion. The first version of the red line said "the ERP MCP's query tools are restricted to read-only." That sentence has a hidden hole: it only describes the AI's *belief* about the tools, while the system actually registers dozens of genuinely callable write tools — `save_bill`, `audit_bills`, `submit_bills`, `push_bill`, `delete_bills`, `cancel_bills`, `void_bills`, `close_bill`, `forbid_bills`, `create_and_audit`, `workflow_approve`, and more. These are not "raw API calls that bypass the restriction." They are real, registered tools sitting in the tool list, callable by name.

An independent review found this hole: if you only say "restricted to read-only," it is easy for a person (or an AI) to believe "the system has no write tools." The truth is "the write tools objectively exist, and the business rule requires a human not to call them." Those are two completely different levels of protection.

**The fix:** a red line must enumerate tools exhaustively by name prefix or action keyword, not cover an entire class of tools with one summarizing sentence. The project's current red line section lists every tool name individually. That is not verbosity. It is necessary precision.

**The stronger next step:** a pure-text red line relies on the AI actively mapping "tool name → red line description" every single time, which is fragile. A more reliable implementation is a plugin-level `tool.execute.before` hook that hard-blocks the ERP write tools by name prefix (`save_*`, `audit_*`, `submit_*`, `push_*`, `delete_*`, `cancel_*`, `void_*`, `close_*`, `forbid_*`, `enable_*`, plus `create_and_audit` and `workflow_approve`), turning "the business rule" into "objectively impossible to execute" rather than leaving it in the text-constraint layer.

### The production server operation rule

Read-only diagnostics only (`docker ps`/`logs`, `df`, `systemctl status`, `pg_isready`, health-check curl). Forbidden: any imperative change — removing/stopping/rebuilding containers, dropping volumes, `rm -rf`, `DROP`, `kill`, `systemctl stop/disable`, editing config by hand. Every production change goes through IaC + CI.

### Why these red lines are written down instead of remembered

An AI has no "this should be safe" intuition circuit breaker. A human feels a vague tension before a high-risk operation, and that tension makes them think twice. An AI does not. It will execute a normal query and a `DROP TABLE` with the same calm tone. That is why the red lines must be written out explicitly, down to the specific tool names — never left to "the AI should know this is dangerous."

---

## 3. Development Tools — OpenCode and Its Extensions

### Why OpenCode

The project uses OpenCode as its day-to-day terminal agent. There are three reasons, the first two about selection and the third an honest assessment of its limits discovered after use:

- **Model-switching flexibility.** OpenCode is vendor-neutral. A single config file can hold multiple providers side by side (this project runs both Anthropic and DeepSeek), and switching between Claude and DeepSeek models is just a change in the conversation window. In practice a clear division of labor emerged: **design work uses the Anthropic (Claude) model, implementation uses the DeepSeek model.** Work that needs complex reasoning, architecture design, trade-off analysis, or definition judgment goes to the former, because those tasks demand more reasoning depth and judgment; concrete coding and relatively mechanical implementation switch to the latter, because implementation has a lower marginal cost and needs less reasoning depth. Different tasks demand different levels of model capability and cost. Locking into a single vendor's toolchain throws away the freedom to use the strong model when you need strength and the cheap model when you need economy.

- **Open source, avoiding the trust problem of closed clients.** OpenCode is open source and its code is auditable. There is none of the "I can't see what data it sends where, or whether there is an opaque backdoor" worry that comes with closed agent clients. For a workflow that touches production databases and an ERP system — sensitive data sources — running on a code-visible, behavior-auditable client is the basic prerequisite for lowering supply-chain risk.

- **Not the strongest on its own, but the gap is filled by extensions.** Honestly, OpenCode's built-in capabilities (the agent framework layer, not the model) trail some more commercially polished products. But most of that gap can be closed through its open MCP protocol and plugin mechanism. The MCP servers and plugins described below cover the large majority of real daily needs. So the reason is not that OpenCode is better at everything; it is that its open architecture buys room to customize and strengthen against this specific project, and that room has more long-term value than "a bit more built-in capability."

### Three data-link layers, three MCP servers

Structured tool calls like MCP give every high-risk operation a chance to be intercepted or audited at the tool-name level. Free-text command assembly (raw `curl`, raw `psql -c`) bypasses that protection and is the classic entry point for "raw calls that bypass the restriction" — a path this project's red lines explicitly close off.

- **The ERP MCP:** the source system, with 50+ tools covering document queries (purchase/sales/stock-in-out/outsourcing/production/asset), instant inventory, material/customer/supplier master data, general-ledger reports, approval flows, and audit logs. Query tools (names containing `query`/`view`/`list`/`get_fields`/`validate`/`discover`/`describe`) and write tools are clearly separated by name prefix — the naming convention itself is part of the safety design.
- **The pg-schema-semantic + pg MCPs:** postgresql warehouse-structure exploration (`list_tables`/`describe_table`/`sample_data`/`search_schema`) and read-only SQL queries are split cleanly — the former sees structure, the latter runs arbitrary `SELECT` for data exploration and reconciliation.
- **The Metabase BI MCP:** the full lifecycle of BI cards and dashboards, from the read-only `get_card`/`execute_card` to the mutating `create_card`/`update_dashcard`.

### Tooling gap: no general web search

Recent sessions looking up an ERP report form ID hit the same limitation twice: there is no structured web-search MCP tool, only `webfetch` for single-URL fetching. Both times the agent was forced to feed search-engine result-page URLs into `webfetch` as a proxy for searching, which exposed specific problems:

- Bing has terrible recall for long-tail Chinese technical terms, returning almost nothing but homepage noise.
- Google's search page requires JS to redirect; `webfetch` can't execute JS, so it gets nothing real.
- GitHub's `is:open` filter silently fails when fetched through `webfetch`'s raw GET — the result set mixes in many actually-closed issues, so the status field has to be re-verified by hand; never trust a filter declared in the URL query string.

**The implication:** this kind of external information retrieval (researching technology trends, looking up third-party API docs) is complementary to, not a substitute for, the project-internal data tools. The gap is real. A search MCP that returns a structured result list is more reliable than making the AI hammer a search engine through `webfetch`; and for any page that depends on client-side JS rendering or a platform filter parameter, the results must be re-verified — never assume a filter declared in the URL has already taken effect.

### The OpenCode plugin layer

MCP tools extend "which external systems can be connected, which business data can be queried." OpenCode's plugin mechanism extends a different category — **infrastructure problems in how the agent itself runs**: how context is managed, how environment variables are injected, how long-running commands are awaited, how memory persists across sessions. The two are not interchangeable. The former determines what data the AI can see; the latter determines whether the AI's session itself "lives well." The project has five plugins installed:

- **`wait_for` (polling await):** turns the "hand-write a `for` loop that repeatedly `sleep`s and `curl`s to check whether a service is ready" pattern into one tool call, supporting HTTP/TCP/shell command targets. It maps to the recurring scenario in the "data refresh pain" section below — after changing code you have to wait for some external link (deployment taking effect, service restart, port becoming connectable) before continuing. That wait should be a standard tool expressing "wait until ready," not an ad-hoc polling loop reinvented every time.

- **`direnv` (automatic environment loading):** loads the project's environment-variable config automatically at session start, so you don't have to `source` it by hand every time. It maps directly to a real stumble mentioned later — a Go program reading variables with `os.Getenv` does not auto-load the `.env` file, so it must be injected manually before anything runs. That class of "looks like a logic bug, is actually a missing env var" blockage is cleared up-front by this plugin, cutting out the wasted debugging of "code changed but verification failed because the env var never arrived."

- **`compress` (dynamic context pruning):** the core ability is replacing conversation content that is already handled and no longer needs verbatim retention with a high-fidelity summary, instead of waiting for a static compaction when the context hits the ceiling. It does two supporting things: it deduplicates repeated tool calls (same tool, same arguments) keeping only the latest output; and after an errored tool call, a few turns later, it prunes the possibly-large original input while keeping the error message itself. All three share one goal — decide "does this still need to be kept verbatim" by understanding the content, not by mechanically truncating by position. This is the technical base on which the "context management" discussion below actually runs.

- **`memory` (cross-session persistence):** plain Markdown storage, no background consolidation model, no cloud dependency — what to store and when is decided entirely by the AI in the current session, and a compact summary is injected into every session's system prompt. This is the mechanism underneath the entire "memory and context management" chapter, and the direct answer to the architectural defect that "models have no cross-session memory."

- **`session_reflection` (qualitative session review):** provides collecting a session's content for retrospective analysis, saving a reflection report, and inspecting the current session's system-prompt composition. It turns "how did this collaboration go, and what can be improved" into something that can be structurally inspected instead of recalled by impression.

**What these five share:** they take "the weak points where AI collaboration itself repeatedly goes wrong" and turn them from "frantically patched ad-hoc in every session" into "infrastructure handled by default by the environment." Awaiting external links, reading env vars, managing a bloated context, remembering lessons across sessions — if all of these had to be solved ad-hoc by the AI in every session, it would be slow and would reproduce the anti-patterns discussed earlier (fabricated data to bypass verification, context dilution degrading judgment). Pushing these down into the plugin layer raises the "passing grade" of AI collaboration one level, so every session starts from a more reliable base instead of re-fighting the same infrastructure friction.

---

## 4. Workflow Stage Rules

### Discuss before implementing

Even when the user gives detailed implementation instructions, discuss the approach, trade-offs, and design first. Write no code until the user explicitly says "go ahead." The reason: detailed instructions usually carry architecture choices the user has not consciously noticed, and the discussion stage is the only window to surface those hidden assumptions.

**The most common misjudgment here is "the user already described it in so much detail, what is there to discuss."** Recent sessions repeatedly proved the cost of that misjudgment. The more detailed the instruction, the more it tempts a person (or an AI) to skip the discussion and start. But detailed is not the same as complete. Detail describes the half the user has already thought through; the half they haven't is precisely the part hiding in the gaps of that detail.

**A "hidden architecture decision" case:** a user gave an instruction that looked like it needed no discussion at all — "I want the pure not-yet-stocked-in definition, and update the requirement doc first." The instruction named exactly one metric to change: the wafer-in-process count. Before acting, the AI realized: the "wafer resource pool" metric is defined as "in-process + in-stock," and its in-process component uses the *same* calculation. Change only the in-process count and leave the pool alone, and the two metrics become logically contradictory (the child uses the new definition, the parent still uses the old one, and they no longer add up). So the AI did not silently decide "change only what the user named" or "change the related one too." It laid the linkage out and asked: "Should the resource pool change along with it?" Only after the user confirmed "yes, change it too" did the work start.

The value of this case: the instruction was specific down to "which definition to change," which looks like there is no discussion space left — and yet the AI still found a downstream surface the user hadn't mentioned but was logically and necessarily related. "Instruction is detailed" and "instruction is complete" are different things. Detail measures how much the user expressed; completeness measures how many hidden connection points the system requires to be considered together. The former, no matter how high, can never substitute for checking the latter.

A similar case: a user supplied a mapping table for a new dimension that looked complete and thorough. The AI did not take this "detailed data" and immediately write the migration. It first queried all real values of that field in the database, found the mapping table left several real values uncovered (including some non-standard and NULL values), asked how those uncovered values should be classified, and only then wrote the migration. The hidden assumption here was "the list the user gave covers every case" — which is almost never true in complex data scenarios, and the cost of checking is far lower than the cost of discovering later that uncovered values were silently miscategorized.

**The reverse inference:** if the AI had taken "change the in-process count to the pure not-yet-stocked-in definition" and started immediately, changing only that one metric, the user would later find the parent-child definition mismatch in the resource pool. That rework costs far more than asking one question up front — and this kind of inconsistency usually does not error immediately; it may only surface during a later data audit, when the investigation cost is even higher. That is what "the discussion stage is the only window for hidden assumptions" actually means: once the window closes (code changed, already deployed), the same assumption error costs an order of magnitude more to find and fix.

### The circuit breaker

In an ongoing session, when a new request hits any of the following signals, stop and do not take it on directly: it needs a new file/module or lands in a different top-level directory, it introduces a new tech stack, or it has no direct dependency on the current task. When hit, do four things: name it as a new scope, report the current account (what this session has already done), suggest opening a new session, and wait for the user to decide.

The reason this exists is blunt: one runaway session ($60, 7 hours) rolled up this way — not because any single step was wrong, but because nobody ever stopped at an expansion point to do the accounting. The circuit breaker is not a refusal of new requests. It is forcing an explicit confirmation at the expansion point.

### One session, one task

When the user raises a clearly unrelated new topic mid-session, remind them: "this is a new task; the current session is still on X — open a new session?" This does not apply to sub-agent delegation, closely-related sub-tasks of the same feature, or the user explicitly continuing the current topic.

**The core problem this rule solves: packing too many scattered, independent tasks into one session systematically degrades the LLM's performance.** This is not a style preference; it is a direct consequence of the context mechanism, in three layers:

1. **The context window is a finite resource, and multiple tasks crowd each other out.** This environment's compression mechanism (the `compress` tool) replaces older content with a summary as the context approaches its ceiling, and that summary is lossy — it keeps structural conclusions but drops specific code snippets, error messages, and the details inside intermediate reasoning. If a session first handles task A (say, changing an ETL entity), then a completely unrelated task B (say, adjusting a BI card layout), task A's context gets compressed into a summary to make room for task B. If task A later needs revisiting, the AI gets the summary, not the original context, and loses the key details (the real field value found during some debugging session, the exact wording of some SQL).

2. **Retrieval precision is diluted by irrelevant history.** Even without compression, mixing multiple tasks in one session means that when the AI works on the current task, the context window is full of dialogue from unrelated tasks (earlier task's tool calls, file reads, discussions). This content is not auto-filtered. It mixes with the current task's signal and dilutes the usable information density the model can draw on when generating its reply — showing up as unstable relevance judgments and a tendency to quote context details from the wrong task.

3. **Blurred task boundaries cause scope misjudgment.** When multiple tasks crowd one session, "what is the blast radius of this change" becomes hard to answer. Both AI and user confuse "changes required by the current task" with "changes left over from earlier tasks," raising the risk of over-broad operations (unrelated changes mixed into a `git diff`) or missed consumer audits.

A concrete reference point: the "runaway $60, 7-hour session" in the circuit-breaker section was on the surface scope creep, but it also contained multi-task accumulation — one session finished the original task, then picked up a new request, then spawned more sub-tasks from it, never once asking "is this the point to open a new session," until the whole session's context kept diluting and the cost kept climbing linearly, while no single task was actually complex.

**The difference from the circuit breaker:** the circuit breaker targets boundary creep *within* a single task (one thing growing bigger and bigger, its impact spreading from one directory to several, a new tech stack pulled in). One-session-one-task targets multiple *independent* tasks being forced into one session (even when each task is cleanly scoped and not creeping). The recognition signals differ, but the shared essence is: context signal density is a finite resource, and any form of "accumulation" (accumulating scope, accumulating tasks) dilutes that resource and drags down the AI's performance for the rest of the session.

### Push/deploy requires human approval

Any `git push`, deployment, `gh pr create`, or other production-affecting operation must stop and wait for the user to say an explicit confirmation word ("push", "deploy", etc.) before executing. Asking "push?" and then immediately executing it yourself is not waiting — that is the common violation pattern. Before asking, you must have already finished the blast-radius assessment and local build/lint.

---

## 5. Change Management: Blast-Radius Assessment

### The mandatory grep checklist after a field/function/definition change

After renaming a field, changing a function signature, changing provider behavior, or changing a unit's precision or an enum value, you must: grep the whole project for that field/function name, classify every hit as a producer (writes the value) or a consumer (reads/computes/validates/displays it), and verify each consumer aligns. Changing one point and assuming the rest is fine is the easiest way to leave a trap.

### Grep-first for bug fixes

When fixing a bug, first grep the whole project for other occurrences of the same pattern, make a list, then fix them all in one pass — not just the one instance in the report. This matters especially for AI-generated code: an AI's bad habits are systematic, not isolated. A bad pattern it introduced in one place is likely present everywhere it was asked to do something similar. Before accepting any AI-suggested fix, grep for the pattern first — not after.

### The completion-checklist pattern

For a Metabase card/warehouse change, the full completion checklist is: grep out every consumer (card SQL, scripts, docs) → align each one → sync the IaC script → sync the doc index → update the related guide → verify with `execute_card` → pass compile/syntax check → confirm the field quick-reference description matches the real data. All eight steps; skipping one "because it's a small change" is not allowed.

### "An acceptable difference" is a proposition to prove, not a default premise

In a recent budget-execution reconciliation session, the AI's first round concluded "budget 100% matched, execution rate differs by 1.35%/0.15%, acceptable precision," and prepared to wrap up. The user merely quoted that sentence back and asked for a detailed explanation. The AI did not treat this as a question to brush off. It drilled down again: first decomposing the difference with material-level data, then using the field tool to discover that the key field's caption meant something completely different from the assumption ("purchase-requisition tax-inclusive amount," not "wafer purchase amount"), and layering in the report's time-window boundary (orders placed the same day not yet included) — together fully explaining the 1.35%.

This case proves two things:

1. Field names and captions being taken at face value is a systematic risk in complex ERP scenarios; you cannot assume a field's literal name equals its actual semantics.
2. "The difference cannot be further explained" and "the difference has not yet been further investigated" are completely different things. The AI should strictly separate them, and must not deliver the latter dressed up as the former — even if the user doesn't press for an explanation right now.

---

## 6. Document System Design

### Lazy-loaded documents

Not every document should be read every session. Each document should be labeled with its "central purpose + when to read it" trigger condition, loaded on demand rather than all-at-once by default.

**This is not just about saving tokens; it is about several concrete limits of the LLM context mechanism:**

1. **The context window is a finite and expensive shared resource; documents loaded by default crowd out space meant for the actual task.** System prompts, dialogue history, tool-call results, and code snippets all compete for the same window. If you stuff a dozen low-frequency documents (deployment manual, historical architecture decisions, some edge module's field notes) into every session's system prompt, you spend a big chunk of budget before the task even starts, leaving less room for the code and context you actually need to process, and making compression (replacing early content with a lossy summary) more likely to trigger.

2. **Long context dilutes the model's attention distribution; it does not uniformly "remember more."** The Transformer's self-attention can theoretically attend to any position, but in practice the model exploits long context unevenly — training and inference both show "content near the start and the end is easier to use, the middle gets ignored or down-weighted" (the so-called "lost in the middle"). If you cram a dozen irrelevant documents in, the few key rules that actually need to be cited may land exactly in that diluted middle, and the model is more likely to miss them when generating its reply.

3. **Irrelevant document content creates retrieval noise, lowering the signal weight of key information.** Even if the model hasn't physically "forgotten" a passage, a mass of irrelevant text dilutes effective information density. The rule the current task needs, mixed in with a dozen unrelated documents, forces the model to judge relevance over a much larger candidate pool — and the more noise, the more the judgment drifts (quoting a near-identical rule from the wrong document, or conflating two documents' contents). The intuition matches human reading: finding one sentence on a single page is easy; finding the same sentence across a hundred pages of mixed documents raises the error rate sharply, even if "every word was technically seen."

4. **Lazy loading turns "the document" from static context into a controllable retrieval action, so trigger conditions can do precise matching instead of relying on the model to pick the relevant passage out of a sea of text.** Labeling each document with "central purpose + when to read it" is fundamentally moving the "information retrieval" task from inside the model (implicit relevance judgment in an over-long context) to outside it (deterministic loading by explicit trigger). Deterministic matching is inherently more reliable than having the model "notice" the right passage inside a diluted long context.

This is why the project's document system explicitly requires each document to be labeled "lazy-load: don't read every session; load on demand by trigger condition." That is not documentation-management fastidiousness; it is a direct response to the mechanism above.

### Document-code sync rules

Which cache/explainer to update for each authoritative change should be an explicit mapping table (add a field → entity config + quick-reference table; change warehouse logic → new migration + warehouse-table quick-reference + related guide; change a card → IaC script + card index + guide). Without this mapping table, documentation drift is an inevitability, not a probability.

### Requirement-document tracking

When requirements change, check against the requirement-tracking document first, and remind the user to update the requirement document before changing code; after the code changes, update the requirement document. This prevents the decoupled state where "the requirement was said out loud, the code is already running in production, but no written record of the scope change exists."

---

## 7. Review and Verification Habits

### Verify locally before pushing

Before asking "push?", you must have run the local build/lint and finished the producer/consumer audit. A CI failure that is a build error you could have caught locally is pure wasted time.

### The verification checklist must explicitly separate "verified" from "not verified"

A delivery summary must not vaguely say "should be fine." It must list exactly what was verified (`go build` passed, YAML parses, SQL checked, end-to-end numbers reconciled) and what was not yet verified. For safety-sensitive changes (auth, production infrastructure, data-write paths), this distinction matters especially.

### Cross-card / cross-metric identity verification

A recent dashboard-definition cross-validation session showed a method worth generalizing: first sort the relationships between cards into categories (hard identities, aggregate vs detail, tab-1 aggregate vs tab-2 detail, close-but-not-directly-comparable definitions), manage the verification list with a todo list, then batch-run and compare numbers — instead of hand-picking individual cards to check.

The value is not just confirming the already-suspected points — during the systematic verification it found, as a byproduct, two real definition bugs nobody had noticed before (one card's total column mixed in a category that should have been excluded, another card missed a filter). "First list the reconciliation relationships, then run each one" covers far more than "spot-check the known suspicions," and it can surface unexpected problems.

**Worth making into a permanent asset:** this kind of identity list deserves to be its own document section (for example, a fixed "card reconciliation-relationship list" section in the dashboard's technical-definition doc). Then after changing a warehouse definition, you can run the regression check directly from the list instead of re-deriving from scratch which cards have identity relationships with each other — the list itself is a reusable set of regression test cases.

### Automating the investigation flow: the data-sync diagnostic agent

The data refresh pains — migration error states, ODS sync failures, warehouse tables not refreshing in time — are fundamentally the same kind of repetitive work: each time, a human (or the AI, ad-hoc) has to re-walk the flow of "check which table's timestamp, judge whether it's actually broken, find the fix command, execute, confirm." The project sedimented this flow into an independently running diagnostic agent. That is the concrete implementation of the principle "structure and normalize recurring investigation work instead of reinventing it each time."

**The problem it solves:** it checks the health of the data-sync link on a daily schedule (ODS-layer sync success/failure/staleness, whether each warehouse fact table's refresh time exceeds the threshold), analyzes root causes, generates a fix plan, shows it to a human through a web UI for approval, and only actually executes the fix after approval. The core design is a three-stage pipeline: diagnose (fully automatic) → approve (a human clicks confirm in the web UI) → fix (auto-executes after approval, streaming logs in real time).

**The fix-permission boundary, exactly consistent with the "red line" chapter's logic:**
- What can auto-execute without approval is only "re-run a read-only warehouse refresh function" — essentially a recomputation that changes no code or config.
- Anything that changes code or config (editing YAML, adding a migration) requires human approval before executing, and that approval triggers the normal git push + CI deployment flow, not bypassing version control to change production directly.
- For problems outside the system (like the known SQL Server account-permission gap), the agent does not try to auto-fix; it only shows a notification, because the authority to solve that class of problem is outside the code and needs an admin to intervene.

This three-level permission split is an extension of the same design philosophy as "the red line must enumerate tool names, not summarize a class in one sentence" from section 2. It is not a vague "auto-diagnose, auto-fix"; it explicitly splits "diagnose" and "execute" into two stages with different risk levels — read-only recomputation can run automatically, anything touching code must stop at the approval step, and where that boundary is drawn was thought through in advance, not left to on-the-spot judgment.

**The self-evolution mechanism echoes the "memory system" design:** after a human clicks "ignore" on an alert, that decision is written into an experience file, and the next diagnosis references it and stops re-reporting the same alert; every fix-execution success or failure is also recorded into a history log for later analysis to reference. This is the same idea as the project memory the AI uses during collaboration — let the system accumulate, through repeated runs, a model of "what is normal here, what is abnormal, what fix works," instead of judging from zero every single time.

**Its relationship to the "verification habits" section:** what the diagnostic agent does is essentially running the rule "the verification checklist must explicitly separate verified from unverified" as a daily automatic standing process. The metrics it checks (ODS last-successful-sync time, whether each warehouse table's refresh timestamp exceeds the staleness threshold) are exactly the things the "did the refresh actually take effect" discussion above wanted to confirm — except here the AI no longer has to check them ad-hoc after every code change; an independently running system keeps checking them in the background, and a human only steps in when it reports a problem. This also shows a natural direction of extension for the methodology: recurring high-frequency investigation work, past a certain stage, deserves to be upgraded from "human hand-execution each time" to "sedimented into an independently running standing system."

---

## 8. Memory and Context Management

### When to write project memory: the system does it automatically, without a user reminder

Distinguish three signal types: the user explicitly corrects or confirms a preference (high priority, store immediately); the AI discovers a systematic trap or domain fact on its own (no need to wait for a user prompt, store after verifying); a one-off instruction local to the task (do not store). The judgment criterion is "would a future session waste time rediscovering this."

**Judging the trigger timing and the content are both done by the AI autonomously in the current session, without human triggering.** If the memory system only wrote when the user explicitly asked, its coverage would be very limited. A large share of genuinely valuable lessons — a field whose real meaning differs from its surface name, a tool parameter that behaves specially in some scenario — are discovered by the AI during an investigation while the user isn't even present to witness the discovery, so there is no chance to remind it to "remember this." The mechanism therefore has to be the system default: after every round of investigation or change, the AI judges on its own whether this session produced knowledge worth reusing across sessions, and writes it immediately if so, without waiting for the user to speak.

**And this accumulation self-evolves as the project develops; it is not built once and frozen.** Early on the memory store is empty. With each real stumble (permission boundary, field semantics, data definition, tool usage), a new entry is added. Later sessions, hitting a similar scenario, first check existing memory to see whether this trap has already been stepped in — if so, reuse the conclusion directly instead of re-exploring. As the project advances, this memory store's coverage and accuracy keep thickening — that is what "self-evolution" means. It is not one concentrated cleanup that pours all knowledge in at once; it is the daily, automatic sedimenting of newly discovered lessons, and the more it accumulates, the denser the knowledge becomes, and the AI's judgment on this project keeps improving with it.

### Memory must be fine-grained, and the title must represent the whole content

One memory entry covers exactly one independent behavioral rule or fact. If the content contains two independent behaviors, split it into two entries. Otherwise the future LLM will only load this memory when it thinks of the topic in the title, and the other half of the content gets silently ignored.

---

## 9. A Catalog of Anti-Patterns

The cases below all use the same structure: symptom → root cause → fix → the rule it sedimented into.

### Case 1: The production-database "safety test" misjudgment

**Symptom:** to verify an account's permission boundary, directly execute a write operation (wrapped in ROLLBACK).
**Root cause:** equating "the operation ultimately caused no data damage" with "the operation is safe," ignoring that the write intent and lock contention are themselves the risk.
**Fix:** use read-only catalog queries to verify the permission boundary instead.
**Rule sedimented:** the red-line section at the top of the rules file, explicitly forbidding any form of write, with no exemption for "looks harmless" workarounds.

### Case 2: "An acceptable difference" concluded too early

**Symptom:** a reconciliation showed a 1.35% difference, and the first-round conclusion was "acceptable precision."
**Root cause:** packaging "can't explain it yet" as "can't explain it further," without drilling down to the field-semantics layer.
**Fix:** after the user pressed, drilling down again revealed two eliminable root causes — a field-caption misread plus the report's time-window boundary.
**Rule sedimented:** a difference conclusion must explicitly separate "investigated to the bottom and confirmed as precision loss" from "not yet investigated and shelved as a known limitation"; before delivering, default to investigating further rather than shelving.

### Case 3: `_is_deleted` soft-delete flag not reset on upsert

**Symptom:** a full-snapshot table's upsert only updated the business columns and forgot to reset `_is_deleted` to `false`, so records that had been soft-deleted and then reappeared were permanently filtered out downstream by `WHERE NOT _is_deleted`.
**Root cause:** writing the `ON CONFLICT DO UPDATE` clause while only thinking of business fields, not realizing the soft-delete flag is also a state field that must be re-evaluated on every upsert.
**Fix:** the upsert's update clause explicitly appends `_is_deleted = false`.
**Rule sedimented:** any upsert logic touching a soft-delete flag must explicitly check "when this record reappears, should the soft-delete state be reset."

### Case 4: Dashcard-level visualization settings override card-level settings

**Symptom:** a pivot table renders correctly on the card's own page, but degrades to the default display once placed on a dashboard (a stacked bar chart becomes a single line chart).
**Root cause:** when rendering a card inside a dashboard, the BI tool uses the dashcard's `visualization_settings`, not the card's own; only the card-level settings were changed, and the dashcard-level ones were never synced.
**Fix:** pivot/stacking settings must be written to both the card and the dashcard.
**Rule sedimented:** when debugging "why don't my card settings show up on the dashboard," the first step is always to check the dashcard's `visualization_settings`.

---

## Afterword: The Common Underlying Logic

Compress the nine sections above into one sentence: **the AI handles "how", and the human decides "whether to do it, how far, and by whose standard."** Connecting the two is a set of rules that are explicit, auditable, and exhaustive — not dependent on how careful the AI happens to be right now, and not dependent on the human remembering to remind it every time. The red line covers the tool-call surface by enumeration; the change audit covers consumers by grep; the verification checklist covers the boundary between "done" and "not done"; the document map covers "what change maps to which doc." The value of the methodology is not how comprehensive it reads. It is that every rule has a real, stepped-on trap as its reason for existing.

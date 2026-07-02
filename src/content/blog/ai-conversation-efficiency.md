---
title: Six Laws for Talking to AI
description: I analyzed my own 192 sessions and 8,471 messages with AI. The data revealed six patterns in how I waste rounds — and how to stop.
pubDate: 2026-07-01
tags:
  - ai
  - engineering
  - productivity
draft: false
---

I recently opened a SQLite file — the local session log from OpenCode, the AI coding tool I use every day. 192 sessions, 8,471 messages, 89 million input tokens. Total cost: \$518.

But cost per token is the wrong metric. I wanted to know: how much of what I said was wasted?

So I wrote some queries. I counted every message where I said "不对," "不行," "不是," "不不" — the Chinese equivalents of "no, wrong, not that, stop." I counted sessions where I forked the same conversation and started over. I looked at how many messages were shorter than ten characters. I had six sub-agents analyze the six longest sessions independently, pulling out every instance where I corrected the AI, repeated myself, or sent an instruction so vague the AI had to guess.

The number that stopped me: **60% of my sessions were forked from an older one.** I was restarting more conversations than I was finishing. For every two user messages in my worst session, I started a new session.

The rest of this article is what I found. Six patterns. Six fixes. All measurable.

---

## Data Snapshot

| Metric | Value |
|--------|-------|
| Total sessions | 192 |
| Total messages | 8,471 (7,109 AI, 1,366 me) |
| Sessions with a parent (forked) | 115 (60%) |
| Explicit correction messages | 67 (4.9% of my messages) |
| Messages mentioning push/commit | 132 |
| Primary model | deepseek-v4-pro (125 sessions) |
| Sessions above 100 messages | 4 (capped at 164) |

Four sessions hit triple-digit message counts. The longest — a deployment migration to a new server — ran 164 messages. I said "get my approval first" four times in that session alone. I said "use GitHub Actions, not manual commands" five times. No one else was in the room. I was repeating myself to a machine.

But that 60% fork rate cuts both ways, and I have to be honest about the other side of it. The human in me is lazy. I hate starting new sessions. A fresh session means I have to re-explain the project, re-establish the rules, re-load the mental model. So I don't. I cram unrelated tasks into one session until it becomes a junk drawer. Deployment config, CSS refactoring, database schema changes, and a React component all in the same thread. By message 80, the AI has no idea what we're working on anymore, and neither do I. The context window might technically hold 200K tokens, but attention is not a buffer — it's a spotlight, and my spotlight is painting six walls at once.

The 60% fork rate isn't a disciplined practice. It's a symptom. I fork when I'm frustrated, and I don't fork when I should. Both are failures of context discipline.

---

## Law 1: The gap between knowing and writing is the whole cost.

Everyone knows AI forgets. The interesting question is not *does it forget* — it's *how long do you wait before fixing it*.

Across six sessions, I corrected the AI for the same rule violations 27 times before writing a single line to my config file. Not 27 times across months. 27 times where I already knew the pattern, already had the fix in my head, and just didn't stop to write it down.

| Rule | Corrected in chat | Messages between first correction and AGENTS.md write |
|------|:--:|:--:|
| "Get my approval before acting" | 4 times | 43 |
| "All operations must use GitHub Actions" | 5 times | 52 |
| "Talk business concepts, not code" | 4 times | 54 |
| "Remove project-specific details" | 4 times | 31 |

The server migration session is the cleanest example. I told the AI "get my approval before acting" on message 1. By message 48, it had forgotten. I said it again. At message 62, the AI pushed code without confirmation — I said it a third time, with profanity. At message 63, ten minutes later, it happened again. I finally wrote the rule to AGENTS.md around message 80.

The waste wasn't the 4 corrections. The waste was the 79 messages between "I know this should be a rule" and "this is now a rule."

Every person who uses AI coding tools knows that writing rules fixes things. The thing I didn't know until I counted: **I average 36 messages between knowing and writing.** I don't have a knowledge problem. I have an execution latency problem.

**The fix**: After *every single correction*, ask: does this rule apply to future sessions? If yes, write it now. Not after this task. Not after this session. Now. The cost of writing is ten seconds. The cost of not writing is the rest of the session.

---

## Law 2: Assess the blast radius. Every time.

Six sessions. Four tirades. Every one followed the same script: I give an instruction involving modification or deletion. The AI starts changing files without telling me what. Something breaks that I didn't expect. I discover the damage and lose my temper.

Specifics: rewriting a website footer and deleting the social links in it. Deleting an entire RSS feed when I only asked to filter old articles. Manually running commands on a production server. Claiming a file exists when it doesn't.

My AGENTS.md already says push and deploy require explicit user confirmation. I wrote that after the server migration disaster. But the rule is too narrow. It only covers git. It doesn't cover rewrites, bulk replacements, folder restructures, or production commands — all of which share the same asymmetry: three seconds to break, thirty minutes to fix.

Here is the thing I missed: this is not a special AI rule. This is the same principle you apply before any production change with a blast radius larger than one file.

We don't let teammates push to production without a diff. We don't approve a database migration without reviewing which tables it touches. We don't run `terraform apply` without reading the plan first. The AI is no different — except that it's faster and has less judgment. An intern who can type at 10,000 WPM. The engineering discipline that keeps production safe is the same discipline that keeps an AI session from spiraling.

Before I started counting, I thought "ask the AI to confirm" was about trust. It's not. It's about blast radius. The AI proposed a change to my website footer. One file. What's the worst that could happen? The footer appears on every page. That's 100% of the site. One file, full blast radius. The AI doesn't understand that. You do.

**The fix**: Before any operation that touches more than one file or any file with a cross-cutting footprint, the AI must list every file it will touch and every change it will make. Then wait for confirmation. This is not a negotiation with a coworker. It's a pre-flight checklist. The same instinct that makes you read `terraform plan` output should make you read the AI's change list. Same discipline. Same muscle.

---

## Law 3: Send the full spec. Not one sentence at a time.

My worst sessions all share a shape: I start with a rough idea, then refine it through seventeen messages. The AI follows each micro-adjustment, but the overhead of each round trip compounds fast.

Here is a real example, anonymized:

```
"I need a search feature."
"It should filter by name."
"Email too."
"Partial match, not exact."
"Show results in a dropdown."
"Debounce the input by 300ms."
"Start."
```

Seven messages. Here is the same spec as one message:

```
Search feature: typeahead dropdown. Filter by name and email, partial match.
Debounce input at 300ms. Show results below the search bar.
```

Two messages would have done it. I spent five extra messages hand-holding the specification because I hadn't completed it in my own head before typing.

This happened in every long session. The paywall discussion took 18 messages (cancel → no, restrict → wait, AI is paid too → defer). The server migration plan changed direction three times (fully migrate → partially migrate → open a new VM instead). None of these decisions were bad. But each mid-flight change of direction forced the AI to recompute context that had already been settled, which meant it forgot things discussed earlier — which meant I had to re-explain them.

**The fix**: Before sending a feature request, write the full spec in a text editor. Fields. Constraints. Edge cases. Interactions. Then send it once. The thirty seconds you spend typing to yourself are worth five rounds with the AI.

---

## Law 4: An instruction under ten characters is a puzzle.

In my longest technical session — building a rules-checking tool — 72% of my messages were under fifty characters. 19% were under five characters.

Here is what I actually sent:

| What I typed | What the AI had to guess |
|-------------|------------------------|
| `change` | Change what? Code? Plan? Naming? |
| `clean up` | Clean which directory? Which files? |
| `do it.` | Do which option? |
| `symbolic link` | From where to where? |
| `check-rules` | Run the tool? Check a file? Create it? |

Each two-word instruction cost one to three clarification rounds. The AI would propose options. I'd pick one. Total waste per instance: two to four messages. In a 74-message session, I estimate these cost me about fifteen rounds.

The interesting thing is that I knew exactly what I meant when I typed "change." The context was clear to me. The problem is that context lives in my brain, not in the chat. The AI can only act on what's in the text.

**The fix**: Before sending, ask: if someone read this instruction with zero prior context, could they execute it? If the answer is no, add a sentence. `"change"` becomes `"Add input sanitization to the form submission handler."` Same idea. Seven more words. Zero guessing rounds.

---

## Law 5: A bug in file A is a bug in files B through Z.

A session where I was deploying multiple services taught me this. Each service had its own CI config file. Service A's deployment failed — missing a network setting. I pasted the error log. The AI fixed Service A.

Service B's deployment failed. Same error. Different file. I pasted the log. The AI fixed Service B.

Service C's deployment failed. Same error. I lost my patience. "You didn't listen," I said. "I told you to fix this."

The AI had never been told to fix all config files. It had been told to fix the one I pasted, twice. I was angry at the AI for doing exactly what I asked.

A similar thing happened in another project: a validation bug existed in both the frontend and backend. I fixed the backend, deployed, and the error came back. The frontend had the same logic, untouched.

**The fix**: After identifying a bug in one file, the next instruction should be: "Check all files in this category for the same issue." Not "fix this one." One sentence prevents the slow drip of identical errors.

---

## Law 6: "This" and "all" are not the same thing. Say which.

I asked the AI to add input validation to a module. "Validate the email field," I said. The AI validated email — and only email. I meant all fields on the form. But I had said "this field." The AI took me literally.

Same thing with error handling: "add try-catch to this function" got me one function. I wanted it across the entire module. Three rounds to converge.

In both cases I had said "this" — this field, this function — when I meant "every field in the module," "every function that calls an external API." The AI applied the constraint to the one thing I named. I thought the context made my intent obvious. It didn't.

Another case: I told the AI to add rate limiting to one API endpoint, intending it as a pattern for the whole service. The AI added it to one endpoint. I said "no, all of them." Two rounds. If I had started with "add rate limiting to all endpoints," done in one.

**The fix**: If a constraint applies to more than one output, start with "all." If it applies to one, start with "this one." Explicit scope costs zero tokens and saves three corrections.

---

## The Compounding Asset

None of these laws are about prompt engineering. They are about systematizing your own communication patterns. The real insight from 192 sessions is not that I needed better prompts. It's that I needed a process for not repeating myself.

AGENTS.md is not a file you write once. It's a muscle you exercise after every correction. The engineer who talks to AI for a hundred sessions and writes nothing down has the same information as session ten. The one who writes a rule after every correction has a compounding asset. Every new session starts with the accumulated wisdom of every previous correction. The AI catches up to your intent faster. You repeat yourself less. The sessions get shorter, the output higher quality, and the four-letter words drop to zero.

That's the asymptote worth chasing.

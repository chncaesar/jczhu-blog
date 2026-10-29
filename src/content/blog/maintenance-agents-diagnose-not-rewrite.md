---
title: Maintenance Agents Should Diagnose, Not Rewrite
description: "Why reliable maintenance agents should surface evidence and recommendations, while a separate decision-maker owns every state-changing action."
pubDate: 2026-10-29
tags:
  - ai-agents
  - agent-workflow
  - software-engineering
  - reliability
  - ai-safety
---

Agents can notice stale documentation, duplicate records, contradictory instructions, and outdated configuration. The tempting next step is obvious: let the agent fix those things automatically. That is usually where the risk begins.

An agent can recognize that something needs review from patterns in the data. But deciding what to change is different: it requires knowing why a rule exists, which exception it protects, and who accepts the risk of removing it. Those answers often do not exist in the records the agent is comparing.

The right pattern is to separate diagnosis from mutation: a maintenance agent produces evidence; a decision-maker makes changes.

## The danger of plausible cleanup

The most dangerous automated changes are not obviously broken. They are plausible.

Imagine an agent reviewing a project's persistent memory. It finds two entries about how to deploy a service. One says that all production changes must go through CI. Another says that SSH may be used to inspect production logs during an incident.

A cleanup agent might merge them into a generic rule about production access. That looks tidy. It is also wrong: read-only incident diagnosis and production mutation have different risk profiles.

The problem is not that the agent failed to understand the words. It was asked to make a judgment that depends on operational history, exceptions, intent, and accountability.

The same failure mode appears everywhere:

- A database-cleanup agent deletes "duplicate" customer records that represent separate legal entities.
- A deployment agent rewrites a configuration value that looks obsolete but is needed for rollback.
- A security agent removes an apparently unused permission that protects a rare recovery path.


Similarity is a signal. It is not authorization.

## Detection is useful without automatic repair

Rejecting automatic repair does not mean rejecting automation. Detection alone is extremely valuable.

A well-designed maintenance agent can identify possible duplicates, refinements, contradictions, placeholders, stale records, or suspicious gaps. It can show the relevant evidence, explain why it raised the issue, and rank problems by confidence or impact.

Instead of manually searching through a growing system, a human or main agent reviews a small set of concrete findings. Their attention goes to judgment rather than retrieval.

The maintenance agent is optimized for breadth: scan the full state, compare items, and surface anomalies. The decision-maker is optimized for responsibility: understand intent, evaluate trade-offs, and perform a scoped change.

The handoff should be explicit. A finding should identify the records involved, the relationship it suspects, and its reason. It should never quietly become a mutation.

## Findings should expire when their evidence changes

Once an agent produces a finding, it is easy to treat it as durable truth. That is another mistake.

Maintenance findings are conclusions about a particular version of a system. If one underlying record changes, the finding may no longer be relevant: a contradiction may be resolved, a duplicate may be intentional, or a stale item may be reconfirmed.

This is why findings should be tied to the state that produced them.

One practical approach is to store a hash of every item involved in a finding. If any item changes, invalidate the finding automatically. The system does not need to guess whether an edit solved the problem; the old judgment simply concerned old evidence.

Dismissals need the same treatment. If a reviewer says, "Keep these two records as they are," that decision should remain valid only while the records remain unchanged. A later edit deserves a fresh review.

## Restriction is part of the design

A maintenance agent should have fewer capabilities than the system it observes.

If its job is to compare records and report inconsistencies, it does not need deployment access, database write access, or arbitrary tools. Restricting the agent reduces the blast radius of a bad prompt, confused model, or malicious input.

The goal is not to make the agent powerless. It is to make its authority match its purpose.

A diagnostic agent can read bounded state, return structured findings, and stop. Give each agent the minimum authority required for the decision it is actually trusted to make.

## A concrete example: project memory

OpenCode Plugin Memory v0.2.0 applies this pattern to persistent project memory.

Its background audit can identify possible duplicate, refinement, or contradiction relationships between memories. But it does not edit the memory store. It records findings for the main session to inspect through `memory_review`.

The main session can update an entry, add a replacement that supersedes an old memory, archive an obsolete item, or dismiss a finding that should remain unchanged. The audit is useful precisely because it is not the authority that mutates memory.

That boundary is easy to overlook when building agent systems. More autonomy can feel like progress. But reliable systems are often built by deciding where autonomy should stop.

The best maintenance agent is not the one that changes the most. It is the one that makes the right next decision easier.

---
title: "Memory Is Knowledge, Not a Longer Chat History"
description: "I built memory so my coding agent would stop forgetting. Then I realized that remembering the wrong lesson was worse. Knowledge needs reflection, scrutiny, and a way to retire."
pubDate: 2026-11-11
tags:
  - ai-coding
  - opencode
  - agent-workflow
  - context-engineering
  - memory
---

I built my first memory plugin because I was tired of repeating myself.

A coding session would uncover a useful lesson: why a design existed, where a familiar bug hid, or which assumption needed checking before a change. Then a new session would begin, and I would explain it again. We had paid for the discovery once. Why were we paying twice?

The obvious answer was to give the agent a notebook. Save the lesson. Let the next session read it. Problem solved.

Except persistence answers only one question: will this sentence still be here tomorrow? It says nothing about whether the sentence deserves to be trusted.

## The notebook can be wrong

Imagine a search feature that fails after an upgrade. The agent finds a workaround, gets the feature working, and saves a lesson: always disable that option.

It sounds useful. It might even be correct today. But perhaps the real cause was never found. Perhaps the next release fixes it. Perhaps “always” was never justified outside that one configuration.

Now imagine that sentence influencing every future session. The agent has not forgotten anything. It has faithfully preserved a mistake.

That changed the question I wanted to answer. Not “How do we make AI remember more?” but “How do we help a project accumulate knowledge worth keeping?”

## Experience is more than an incident report

A programmer's experience is not a complete transcript of every debugging session. It is what survives those sessions: design principles, warnings about recurring traps, and judgments refined by seeing where earlier judgments failed.

Project memory should work the same way.

“The search broke on Tuesday” is history. “Check whether the workaround still applies after an upgrade” is a lesson. Several scattered notes about the same failure may deserve one clearer explanation. Two contradictory recommendations deserve investigation, not two places in the next prompt.

And outdated knowledge needs an exit. Keeping everything is not respect for experience. Sometimes it is refusing to learn.

## Let the agent propose. Let people approve.

That philosophy shaped the new [opencode-plugin-memory](https://github.com/chncaesar/opencode-plugin-memory).

The agent can propose a lesson while the context is fresh. But it cannot make that proposal shared truth. A local bot opens a pull request, and a person reviews it. Only merging admits the lesson into the project's active knowledge.

The questions are familiar: What supports this claim? Where does it apply? Is it a principle, or just a workaround dressed as one?

This costs attention. That is intentional. A sentence that will steer future development deserves more scrutiny than a passing remark in a chat.

## Remembering includes reconsidering

Approval is not the end. The plugin periodically revisits active knowledge after sessions become idle, looking for duplication, refinement, and contradiction. Those findings become proposals for human review, not silent changes.

The reflection mechanism can be wrong too. Its job is to raise questions, not become another unquestionable authority. Summarizing scattered experience still requires judgment; retiring an old lesson still requires a reason.

That is the loop I want: experience produces a candidate lesson, review challenges it, later experience tests it again.

The plugin is [available on npm](https://www.npmjs.com/package/@chncaesar/opencode-plugin-memory), but the larger idea matters more than the package. We should treat an agent's accumulated knowledge with the care we give its code: inspect it, question it, improve it, and remove what no longer holds.

Our development philosophy is not that AI should remember everything. It is that knowledge should earn its place—and remain open to being proved wrong.

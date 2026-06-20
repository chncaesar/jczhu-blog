---
title: AI Fixed The Bug. Then I Found Two More Just Like It.

description: When AI fixes a bug, it fixes the one you showed it. It doesn't search the rest of your codebase for the same mistake. That's your job now.

pubDate: 2026-06-21

tags:
  - ai-coding
  - software-engineering
  - debugging
  - flutter
---

I reported a bug. AI fixed it. Three days later, the same bug appeared somewhere else. I reported it again, AI fixed it again, and two weeks after that a third instance surfaced — same root cause, different location, different symptom. At some point I realized the problem was not that AI kept making the mistake. The problem was that I kept treating each occurrence as a separate incident.

---

## The Bug

Early in the project I had established a rule: all monetary values must be stored as integers representing cents. Never floating point, never doubles, always integers. The rule existed because floating-point arithmetic on money produces invisible precision errors that accumulate silently over time. It was documented. The codebase had utility functions for converting between display values and stored integers.

Despite all of this, the same mistake appeared three times across different parts of the codebase:

```dart
// first occurrence
final amount = double.tryParse(controller.text) ?? 0.0;

// second occurrence, different feature
final price = double.tryParse(priceInput.text);

// third occurrence, different feature again
final currentPrice = double.parse(apiResponse['price']);
```

Each time, AI had been asked to implement a new feature. Each time, it reached for `double.tryParse` because that is the natural way to parse a number from text input — it's what most Dart code does, and it's what the training data overwhelmingly shows. Each time, a code review caught the specific instance that was reported. And each time, nobody checked whether the same pattern existed elsewhere.

---

## How AI Fixes Bugs

When you show AI a bug, it focuses on that bug. It reads the surrounding code, understands the problem, and proposes a fix — and the fix is usually correct for the code it looked at. What it does not do is search the rest of the project for other places where the same mistake might exist. This is not a failure of intelligence. It is a failure of scope. AI responds to what you show it, and it does not independently decide to audit your entire codebase for related patterns.

The difference becomes clear when you compare it to how an experienced engineer handles the same situation. Someone who has worked in a codebase for months develops an instinct for where the same patterns get repeated. When they fix a bug, they often think: I've seen this structure elsewhere, let me check those places too. That instinct comes from having written and read most of the code themselves. AI does not have this map. Every conversation starts fresh, and even if you have fixed the same mistake twice before in previous sessions, AI has no memory of having seen the pattern in your codebase. It does not know to be suspicious.

---

## The Broader Pattern

The `double.tryParse` issue was one example, but the same dynamic played out several more times. After fixing a race condition in one part of the UI, I found two more places with the same structure. After fixing an error message that was leaking internal exception details to users, I found four more places doing the same thing. After fixing a database write operation that was missing an invalidation call before navigation, I found five more. Each time, AI fixed the reported instance correctly. Each time, the other instances were waiting quietly.

The reason this happens more with AI than it did when I wrote most of the code myself is straightforward. When I introduce a bug, I at least know roughly where that pattern appears, because I wrote it. With AI generating large blocks of implementation that I review but don't write line by line, the mental map is thinner. And AI will consistently apply the same habits across multiple features, because it is generating from the same set of assumptions and defaults — which means when it has a bad habit, that habit is likely distributed across every place it was asked to do something similar.

---

## What Changed

After the third occurrence of the `double.tryParse` bug, I changed how I approach AI-assisted fixes. Now, before I show AI the specific fix, I do one step first: search the entire codebase for the pattern.

```bash
grep -r "double.tryParse" lib/
grep -r "double.parse" lib/
```

I make a list of every occurrence, then fix all of them in one pass. This sounds obvious, but in practice it is easy to skip when AI is handling the fix and everything feels handled. The reported instance gets resolved, the review looks clean, and the invisible copies wait for their turn to surface.

---

## The Role That Has Not Changed

Code generation is increasingly handled by AI. Code review is increasingly assisted by AI. Architecture can increasingly be drafted by AI. But the role that seems to be not just surviving but becoming more important is the engineer who holds the global view — who knows what patterns are repeated and where, who knows what invariants must hold across the entire system, and who, when a bug appears in one place, asks whether the same mistake exists somewhere else.

AI does not have that view. It cannot. Every session starts fresh, and every conversation focuses on what was shown. The global view of your codebase lives in your head, and when AI is writing code faster than you can track, that global view is exactly what you need to protect. When you ask AI to fix a bug, the fix will likely be correct for the code you showed it. Before you accept that fix, take a minute and search for the same pattern. That question — where else could this be? — used to be instinctive. With AI writing more of the code, it needs to become deliberate.

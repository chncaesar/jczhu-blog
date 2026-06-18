---

# My Code Was Correct. My System Was Broken.

```markdown
---
title: My Code Was Correct. My System Was Broken.

description: An iCloud debugging incident that made me rethink AI-assisted software development.

pubDate: 2026-06-18

tags:
  - ios
  - flutter
  - debugging
  - ai-coding
  - software-engineering

draft: false
---
```

I recently spent nearly two hours debugging an iCloud bug that multiple LLMs completely failed to catch.

Claude reviewed the design.

DeepSeek generated the implementation.

A dedicated review agent checked security, architecture consistency, data integrity, and error handling.

Every log looked correct.

Every function returned success.

The code was technically correct.

But the file never appeared in iCloud Drive.

That debugging session forced me to rethink something I had gradually taken for granted:

**AI can validate code correctness surprisingly well.
But almost nobody is validating system behavior.**

And those two things are not the same.

---

## The Original Architecture

I have been maintaining a small iOS side project recently.

The original architecture was intentionally simple.

Data lived entirely inside local SQLite storage inside the App Sandbox. The application supported manual import/export for migration purposes, but there was no encryption and no cloud synchronization logic.

In engineering terms, this was a straightforward local persistence system.

It looked roughly like this:

```text
SQLite
      ↓
App Sandbox
      ↓
Manual Import / Export
```

It worked well.

---

## AI Review Forced Me To Redesign The System

During a recent AI-assisted code review, one of the models raised a reasonable concern.

Sensitive financial data was being stored locally in plaintext.

The feedback was correct.

So I redesigned the storage layer.

I introduced AES-GCM encryption for local persistence and added iCloud Drive backup so users could restore data across devices without relying on any backend service.

The new architecture became significantly more complicated.

```text
Flutter
      ↓
SQLite
      ↓
AES-GCM Encryption
      ↓
MethodChannel
      ↓
Swift Native Bridge
      ↓
iCloud Documents API
```

Much more moving parts.

---

## My Current AI Development Workflow

Over the last few months I have gradually built a relatively stable AI-assisted development workflow.

I use OpenCode as the main entry point.

Claude Sonnet / Opus is primarily responsible for architecture and design generation.

DeepSeek V4 implements the actual code based on the design document.

Then I run an independent review agent that performs code review against multiple dimensions.

The review pipeline checks:

* Code quality
* Security
* Data integrity
* Architecture consistency
* Error handling
* Performance risks
* Boundary conditions

The workflow looks roughly like this:

```text
OpenCode
      ↓
Claude → Design Document
      ↓
DeepSeek → Code Implementation
      ↓
Review Agent → Code Review
      ↓
Human Validation
```

I have been using this workflow for months.

Overall, the productivity improvement has been significant.

At least during the coding phase.

---

## Everything Looked Correct

The problem appeared during physical device testing.

The backup process seemed completely normal.

The logs showed:

* JSON generated successfully
* Flutter MethodChannel invocation succeeded
* Swift native layer returned success
* File write operation returned true
* Correct iCloud container path was returned

The logs looked like this:

```text
[iCloud Backup] Writing success

Container Path:
/private/var/mobile/Library/Mobile Documents/...
```

Everything looked correct.

So I opened the Files App on my iPhone.

Nothing.

No backup file.

No folder.

Nothing at all.

---

## The First Wrong Assumption

My first assumption was simple.

Maybe iCloud synchronization takes time.

So I waited.

Ten minutes later:

Still nothing.

I started checking all obvious configuration issues.

I rechecked:

* Entitlements
* Capability configuration
* Container identifiers
* Sandbox permissions
* Provisioning profiles

Everything looked normal.

---

## Asking AI To Debug Again

At this point I went back to AI.

I asked Claude Opus to review the Swift bridge implementation.

Nothing suspicious.

I added more logs.

Still nothing.

Then I switched to DeepSeek and repeated the entire review process.

Again, nothing suspicious.

I spent roughly two hours repeating the debugging cycle.

Still stuck.

---

## Root Cause #1: iCloud Is Not A Normal Filesystem

Eventually I found the first issue.

I was writing the file directly using:

```swift
content.write(to: url)
```

Under normal filesystem semantics, this code is perfectly correct.

The API returns success.

The file physically exists.

No exception is thrown.

Everything looks normal.

But iCloud Documents API is not a normal filesystem.

Direct file writes do not notify the iCloud synchronization subsystem.

As a result:

```text
Write succeeds

File exists locally

Sync never starts
```

The correct implementation requires:

```swift
NSFileCoordinator
```

The system needs explicit coordination before synchronization begins.

---

## Root Cause #2: New Devices May Not Have Downloaded The File

Then I discovered a second problem.

During restore logic, I was directly reading the file.

But on a new device, the file may still exist only in iCloud and may not have been downloaded locally.

So reading immediately can fail.

The correct behavior requires calling:

```swift
startDownloadingUbiquitousItem()
```

before attempting to read.

Otherwise the file remains in cloud storage and the local filesystem has nothing to load.

---

## The Bug Was Not The Interesting Part

After fixing the issue, I started thinking about what actually happened during the development process.

And I realized something much more interesting than the bug itself.

Throughout the entire workflow, every participant was validating exactly the same thing.

**Whether the code was correct.**

Claude validated design logic.

DeepSeek generated implementation.

The review agent checked code quality.

I manually inspected logs, return values, exception chains, and control flow.

But nobody was validating what actually mattered.

**Final system behavior.**

And those two things are fundamentally different.

---

## Code Correctness Is Not System Correctness

This bug taught me something uncomfortable.

All my code was correct.

No syntax errors.

No runtime exceptions.

No failed API calls.

No invalid logic.

And yet the system behavior was completely wrong.

Because the actual problem had nothing to do with code correctness.

It was about how the operating system behaves.

This category of problem appears everywhere.

Examples include:

* iOS Sandbox behavior
* iCloud synchronization
* macOS Entitlements
* Android Activity lifecycle
* Browser event loops
* Database transaction isolation
* Filesystem consistency guarantees

These are not coding problems.

These are system behavior problems.

---

## The Problem With AI Coding

I increasingly feel LLMs are changing software engineering in a subtle but dangerous way.

Models are exceptionally good at generating syntactically correct code.

They are increasingly good at code review.

They can reason about architecture surprisingly well.

But they remain weak at understanding real runtime environments.

Especially when code interacts with operating system boundaries.

The problem is not that LLMs make mistakes.

The bigger problem is this:

**Engineers are increasingly trusting code they do not fully understand.**

Today many developers simply ask Claude, GPT, DeepSeek, Cursor, or OpenCode to generate large amounts of code.

Development speed increases dramatically.

Code volume grows quickly.

Abstraction layers become higher.

But eventually a bug appears.

And suddenly you are debugging a system you never truly understood.

At that point debugging cost rises very quickly.

---

## I Think AI Workflows Are Missing One Step

Until recently, I thought modern AI-assisted development looked like this:

```text
Design → Coding → Review
```

Now I increasingly think the process is incomplete.

It should be:

```text
Design → Coding → Review → Behavior Verification
```

The final step cannot be skipped.

Because validating code is not enough.

We must validate system behavior.

---

## The Future Scarce Skill May Not Be Coding

For decades software engineering focused on writing code.

Now LLMs are making code generation increasingly cheap.

But I suspect debugging systems is becoming more expensive.

Code can be generated by AI.

Code review can be assisted by AI.

Architecture can increasingly be designed with AI.

But understanding how real systems behave under real runtime conditions still requires engineers.

I increasingly think the scarce skill of future engineers may no longer be coding.

It may simply be understanding systems.

This bug was relatively small.

Just an iCloud synchronization issue.

But it reminded me of something important.

**The more code AI writes for us, the more important it becomes to understand the systems underneath that code.**

Because eventually, when reality disagrees with code, someone still has to debug reality.

And right now, that someone is still us.



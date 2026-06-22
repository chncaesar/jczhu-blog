---
title: Your Agent Checked Everything. It Was Still Wrong.

description: Three incidents where an AI-assisted workflow produced technically correct outputs that were fundamentally broken — and what verification checkpoints could have prevented each one.

pubDate: 2026-06-22

tags:
  - ai-coding
  - software-engineering
  - debugging
  - agent-workflow
---

I have been running a multi-agent development workflow for months now — one model writes the design, another generates the code, a third reviews the implementation, and I approve the result. It works well most of the time. But recently, three failures went through this pipeline undetected, and they share a pattern I had not been able to articulate until all three were on the table.

They are not impressive bugs. The individual root causes are straightforward once you see them. What makes them worth writing about is what they reveal about the structure of this kind of failure — and what kind of verification could have caught them before they reached production.

---

## Case 1: The retry loop that never fired

An ETL pipeline synced data from a third-party ERP API to a PostgreSQL warehouse. Every 5 to 15 minutes, it pulled incremental changes using a session-based authentication mechanism. The code had a standard retry loop: three attempts, exponential backoff, and a `resetLogin()` call on failure to re-authenticate before the next attempt. It had worked for weeks.

Then one afternoon, every sync job started failing with the same error: `COPY from stdin failed: expected N values, got 1`. The pipeline reported the error and retried. And retried. And kept failing, for hours, until someone noticed.

The retry loop existed in the code. `resetLogin()` existed in the code. Neither had ever triggered. The reason took some investigation. When the ERP session expired after roughly 8.5 hours, the API did not return a 401 or a 403 or any HTTP error. It returned an HTTP 200 with a body that decoded to `[["error message"]]` — a structurally valid JSON array containing one row with one column. The Go JSON decoder had no reason to produce an error. The retry condition checked `if err != nil`, found nothing, and moved on with what it believed was a single-row result set.

The fix was not to improve the retry logic. The fix was a background goroutine that proactively refreshes the session on a 4-hour ticker — a keepalive that renders the reactive recovery path irrelevant. The retry loop, the piece of the system that was supposed to handle this exact scenario, had been dead on arrival.

---

## Case 2: The coordinates that never existed

A code generator in a desktop tool produced C source files for an embedded microcontroller. Given a visual UI design, it emitted header files with widget macro definitions, a context file with event dispatch functions, and resource indices mapping image addresses in external flash memory. Developers compiled the output into their firmware, flashed the chip, and saw something strange: dynamic text widgets rendering at position (0, 0) regardless of where they had been placed in the design.

The generated code compiled without warnings. The linker found all referenced symbols. No function returned an error. Everything looked complete. But the runtime widget table — a separate generated file that maps each widget's ID to its x, y, width, and height — had never been written. Nobody had called the method that produced it. The header file declared the widget struct type with x/y fields. The resource manifest carried coordinate information. The design document described the widget table format. The code generator simply never emitted it.

The generated output was reviewed for content correctness. The reviewer confirmed that the header macros pointed to the right resource addresses, that the event routing was correct, that the page definitions matched the design. All of that was true. Nobody asked: are we generating all the files we need to generate?

---

## Case 3: Read the instructions, not the comment

I was integrating an SDK for a new microcontroller. The vendor had provided a zip file with the chip's SDK, and the directory structure looked right: startup file, linker scripts for the specific chip model, peripheral drivers for SPI, DMA, GPIO — everything I expected.

The `startup.S` file opened with a comment header:

```asm
; GCC for CSKY Embedded Processors
```

CSKY is a different embedded CPU architecture, not the one this chip used. The datasheet clearly stated the chip was RISC-V. But the SDK directory was named for this specific chip family, the subdirectories matched, and the startup file was sitting right where it belonged. The comment said one thing. The directory name said another. Which was correct?

Two facts resolved it. First, the vendor had accidentally delivered the SDK for a different chip in the same product family — one that used CSKY. The directory name was misleading. Second, when the correct SDK arrived, its `startup.S` had the same CSKY comment in the header, because the vendor had copied the template from a third-party toolchain and never cleaned it up. The actual instructions told a different story:

```asm
csrw    mtvec, a0        ; RISC-V: write machine trap vector
la      sp, g_top_irqstack
jal     main             ; RISC-V: jump-and-link to main
```

The simplest verification was a grep: `grep -c "csrw\|mret" startup.S` returned 3. It was RISC-V. The comment was a fossil.

---

## Not an Intelligence Problem

All three agents in my workflow — the designer, the implementer, the reviewer — did something that, in isolation, was correct. The designer wrote a spec that matched the task. The implementer produced code that matched the spec. The reviewer confirmed the match. Every verification step passed. The system was consistent. It was consistently wrong.

This is not an intelligence problem. It is a boundary problem. The agent does exactly what it is asked to do, within the context it is given. No one told it where the context ends.

In Case 1, the context was "check if the HTTP call returned an error." No one said "also check whether the successful response actually contains data."

In Case 2, the context was "check if the generated files are correct." No one said "also check whether all required output files exist."

In Case 3, the context was "trust the SDK directory structure and documentation to be correct." No one said "verify the architecture claim against the actual instruction stream."

In every case, the agent performed a complete verification of what it understood to be the scope of the task. The scope was wrong. And that gap — between what the agent checks and what actually needs to be true — is the failure mode that an AI-assisted workflow is structurally blind to.

This is not a bug in the agent. It is a missing layer in the workflow. The agent will verify the things you tell it to verify. It will not independently discover new categories of things to verify. That discovery is still engineering.

---

## What belongs on the checklist

Here is what they look like.

**1. Semantic output validation: check what the success means, not just that it returned success.**

An API call, a function return, a system call — each has a success path and a failure path. But some systems encode failure inside success. After every external call, ask: does the returned data look like data, or does it look like an error in disguise? Check the row count. Check the structure. Scan for error keywords. If the caller received 1 row when the expected number of columns is much larger, the data is already suspect regardless of what `err` says.

**2. Output completeness: verify that all required artifacts exist, not just that the ones that exist are correct.**

Code generation produces multiple files. Some are visible in the output directory. Some should be but are not. Before accepting a generation result, enumerate the expected output files and confirm each one exists as a non-empty file. Do not accept "the generated files look correct" as a substitute for "all generated files are present."

**3. Ground-truth verification: for any technical claim that can be tested by a machine, test it by a machine.**

Comments can lie. File names can lie. Directory structures can lie. The CPU architecture of a `.S` file is not whatever the header comment says — it is whatever instructions the assembler would emit. The format of a binary file is not whatever the README claims — it is whatever the bytes at specific offsets contain. Before any agent workflow makes a design decision based on a technical assumption, verify that assumption with a command that reads the artifact directly. Do not pass claims forward unchecked.

---

None of these three checkpoints is dramatic. Each is small enough to be added to a task definition or a review stage without substantially changing the workflow. Together, they cover the three failure modes I have now seen multiple times: undetected failure inside a successful response, missing output from a code generator, and a false claim repeated by a toolchain artifact.

The agent is not going to ask itself "what should I also verify?" That question — what else could be wrong even when everything I checked is right — is not something an agent can generate from within its own context. It has to come from outside. It has to be designed. When you set up a multi-agent workflow, you are not just designing a pipeline for code. You are designing the boundaries of what each agent will treat as ground truth. If you do not place verification checkpoints at those boundaries, no one will.

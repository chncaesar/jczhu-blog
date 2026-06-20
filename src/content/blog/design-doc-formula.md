---
title: The Design Doc Was Wrong. AI Trusted It Anyway.

description: A 100x calculation error in a side project taught me something uncomfortable about how AI reads documentation.

pubDate: 2026-06-21

tags:
  - ai-coding
  - software-engineering
  - debugging
  - flutter
---

I was building a new module for a side project, and the design document looked thorough. Claude had written it, I had reviewed it, and everything seemed reasonable. One section described how to calculate a derived value from two stored fields — both multiplied by 100 to preserve two decimal places — and gave the formula:

```text
Result = fieldA × 100 × fieldB × 100 / 10000
```

The logic made sense on the surface. Both fields carried 100x precision, so the divisor cancels them out. DeepSeek implemented it. The review agent verified it. I approved it. Then I opened the simulator and saw a value that should have been 1,200 displayed as 120,000.

---

## The Formula Was Wrong By A Factor Of 100

The correct divisor was 1,000,000, not 10,000. When you multiply two fields that are each inflated by 100x, the product is inflated by 10,000x — so you need to divide by 1,000,000 to get back to base units, not 10,000. The design document had gotten this wrong, and everything downstream had faithfully reproduced that mistake.

That part was easy to fix once I saw it. What I kept thinking about afterward was the process that had failed.

---

## Three Systems Read The Same Wrong Formula

A human engineer reading that formula would probably do something instinctive: substitute real numbers. Two quantities, each stored as integer × 100. Say fieldA = 10000 and fieldB = 1200. Multiply: 12,000,000. Divide by 10,000: 1,200. But the expected result should be 12. That doesn't add up. The error surfaces in about five seconds, not through formal verification, just through the habit of running a quick sanity check before trusting a formula.

None of the three systems in my workflow did this. DeepSeek read the design document and implemented the formula exactly as written. The review agent checked whether the implementation matched the design and confirmed that it did. I read both and approved them. Every statement was technically correct. The document was the source of truth, the code faithfully implemented the document, and the review verified the match. Nobody ran the numbers.

---

## The Assumption I Had Been Making

After I fixed the divisor, I started thinking about what had actually failed — and it wasn't the math. The math error was trivial once I looked at it carefully. What failed was a deeper assumption I had been making about how AI-assisted development works.

I had been treating design documents as verified artifacts. The workflow in my head was:

```text
Design Document → AI Implementation → AI Review → Human Approval
```

The implicit assumption embedded in this workflow was that the design document itself was correct. If it wasn't, the whole chain would faithfully reproduce the error — which is exactly what happened.

---

## Documents Are Not Inputs. They Are Claims.

A design document is not a verified fact. It is a claim made by whoever wrote it, and in this case that was Claude. Claude is very good at generating coherent, plausible-looking technical documentation. It is considerably less good at verifying whether the math embedded in that documentation is actually correct. I had been asking it to do both things at once — reason about architecture and verify arithmetic — without recognizing that it handles those two responsibilities very differently. It did the first well. It did the second poorly. And I hadn't thought to separate them.

The fix I've settled on is simple: any formula in a design document is treated as unverified until someone has substituted concrete numbers and checked the result by hand. Not because AI gets formulas wrong frequently, but because when it does, the error propagates cleanly and invisibly through every downstream step. The formula is wrong, the implementation is wrong, the review confirms the implementation matches the formula, and everything is consistent. Everything is wrong.

---

## The Code Did Exactly What It Was Supposed To Do

Most bugs in AI-generated code are implementation bugs — a condition is inverted, a null check is missing, an edge case is unhandled. Those are failures where the code doesn't implement the intent correctly. This was different. The code implemented the intent perfectly. The intent was wrong. That category of error is much harder to catch with code review, because code review asks whether the code does what it's supposed to do. The answer here was yes. Nobody asked whether what it was supposed to do was actually correct.

That question — is the specification right, not just the implementation — is increasingly where I think human judgment matters most in an AI-assisted workflow. AI is getting quite good at turning specifications into working code. It is getting reasonably good at catching implementation bugs. But it tends to treat the specification itself as ground truth, which means the work of questioning whether the spec makes sense in the first place is still entirely yours. AI will implement whatever you give it, with increasing reliability. The question is whether what you gave it was right.

And right now, that part is still on you.

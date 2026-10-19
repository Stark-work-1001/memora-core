# memora-core — a handover

| | |
|---|---|
| Repository | https://github.com/Stark-work-1001/memora-core |
| Published version | 1.0.0 |
| What this is | A handover, not a specification |

---

## 0. The ask

I built this thing. It works, it ships, and it is not good enough yet. I want the next version to be substantially better — not incrementally, substantially.

I am handing it to you because you will see things I cannot. So I am going to tell you what I know, tell you what I think is wrong, and then get out of the way.

**You decide what to change and how to change it.** That includes deciding that my priorities are wrong, that some of what I list below is not worth fixing, and that the important work is something I never thought to mention. If your plan looks nothing like mine and you can argue why, that is a better outcome than a tidy execution of my list.

The only thing I am not handing over is **the record of what already exists in the world**. That is in section 4, and it is short.

---

## 1. What it is

A local-first memory hub for AI agent sessions. Sessions scatter across agent hosts — coding assistants, chat clients, plugin runtimes — and the useful parts evaporate. This collects them, normalizes them into a typed memory model with evidence and provenance, indexes them for hybrid retrieval, exposes them over MCP and REST, and lets you look at them as interactive graphs.

It ships as a portable Windows desktop build: an Electron shell hosting a Python backend, plus a source archive.

**Scale, roughly.** Backend 22 modules / 17k lines, largest single module 4.3k lines. Frontend 32 sources / 13.7k lines, bundled to three files totalling ~2.3 MB. 28 tables, 45 HTTP routes, 22 MCP tools, 18 workflow templates, 440 tests. Release archive 429 MB, of which a lot is Chromium.

**What it is deliberately.** Standard library only on the backend — no `pip install`, ever. Offline by default; if no model endpoint is configured it degrades to deterministic local algorithms and says so in the UI. Loopback only. SQLite is the single write target and Markdown is a derived mirror that can be regenerated but never written back.

**What it is for.** One person's accumulated working knowledge, made searchable and auditable by the agents that produced it, without shipping it to anyone's cloud.

---

## 2. Where I think it is weak

Not a checklist. These are the things that bother me, roughly ordered by how much they bother me. Some may be wrong. Some may be trivial. Some may be symptoms of something I have not diagnosed. **Your judgement on which of these matter is more valuable than your compliance.**

**On correctness.** The daily note splits on UTC, so for anyone east of Greenwich the page rolls over mid-morning and morning work lands on yesterday. The health endpoint runs a full integrity scan on every call while the UI polls it on a timer. Its table census is a hand-written list of 23 names against a schema that creates 28 — seven real tables are invisible to it, two virtual ones are counted. I suspect there is a cheap class of bug here that I have not found, of which this is one instance.

**On the engine.** A workflow run executes inside the HTTP request thread and reports progress only at the end. There is a cancel endpoint, but the thing it cancels is a flag nobody is watching. The engine declares 17 node kinds; the shipped templates use 21 names, four of which have no handler. The job table accepts work that nothing consumes. Individually these look like small omissions. Together I think they are one design that was never finished.

**On retrieval.** The documentation quotes quality measurements that cannot be reproduced from the repo, because the measurement harness does not exist. I do not actually know how good retrieval is. Neither do you, until you build something that tells us. The CJK path is a hand-rolled bigram scheme plus a `LIKE` fallback, and I have never established whether it beats what the bundled SQLite engine can do natively.

**On the frontend.** It is hand-rolled DOM, one bundle per page, no framework. At 13.7k lines I am no longer sure this was the right call. State is scattered and each page polls on its own. Assets ship unversioned, so the only safe cache policy is `no-store`, which is what it does — every reload pulls 2.3 MB that did not change.

**On the shell.** The splash window is sandboxed and the main window is not. The release archive carries 55 Chromium locales for a single-language product, and ships the backend executable twice. There is no signing story, no update path, no CI. Nothing here is hard; all of it is undone.

**On honesty.** The README states a table count that is wrong. That is the smallest possible defect and it survived to a public release, which tells me nobody diffs docs against code, which tells me there is probably more of this.

---

## 3. Tensions I could not resolve

These are the decisions I kept deferring because I could argue both sides. I am not going to pretend to resolve them now. They are yours.

**Dependency discipline versus capability.** The standard-library-only rule is a real asset — it is why this starts instantly, packages small, and has no supply chain. It is also why there is no HNSW index, no proper tokenizer, no real cross-encoder. Where is the line? I do not know. I suspect the honest answer is "a small, audited, vendored set, and a different answer for the desktop build than for the library."

**One big bundle versus a framework.** The current approach has no build-time magic and no framework to outlive. It also has no code splitting, no component model, and a hand-written state layer. Whether the trade still pays at this size is a question about the next two years, not about the last one.

**Finished or honest.** Several features degrade gracefully into something that is technically working and practically useless — a workflow that runs to completion having accomplished nothing, a vector channel that returns local hash distances and calls them similarity. Visible degradation was the right principle. I am less sure it is a sufficient one.

**Personal tool versus product.** It is built for one person and published for anyone. Those pull in opposite directions on almost every interface decision — configuration surface, defaults, error messages, what gets a settings page.

**Depth versus breadth.** 18 workflows, 22 tools, 34 catalogued algorithms, four graph views. Any one of them could be ten times better. I do not know which ones anyone actually uses, and I am not sure I should be the one to decide.

---

## 4. What is already fixed

Four things, and only because they are already in the world rather than because I prefer them.

1. **The licence is MIT and will stay MIT.** It is in `LICENSE`, both package manifests, and the README. Changing it now would take the rights back from people who already have them.
2. **The published interfaces are in use.** MCP tool names and semantics, HTTP route shapes, the exchange format identifier, the on-disk layout. Extend them, version them, deprecate them — but a host that integrated last week should not break next week without a path.
3. **Offline-first is a product promise, not an implementation detail.** The desensitization claim in the README — no local paths, no real addresses, no personal data in the shipped artefacts — has to keep being true.
4. **The degradation contract.** If something cannot be done, the response says so and the UI shows it. No fabricated vectors, no synthetic verdicts, no success returned for work that did not happen.

Everything else in this document, including the tone of sections 2 and 3, is negotiable. If you think one of these four should move, make the argument — an ADR is a legitimate way to overrule me.

---

## 5. What I have no opinion on

Explicitly delegated, because I either lack the taste or lack the information.

- **Where the ceiling is.** I do not know what "substantially better" should mean here. Faster, smaller, more reliable, more capable, more honest — pick the axis you think matters and commit to it.
- **Sequence.** Whether to stabilize first or restructure first. Whether the frontend rewrite funds itself before the backend work.
- **What to delete.** There is more here than one person can maintain. Some of it should go. I have not been able to decide which, because I wrote all of it.
- **Whether the architecture is right at all.** The plugin/host model, the workflow DAG, the scope hierarchy, the memory state machine. I designed these. A second opinion on whether they are the right shapes is worth more than any amount of polishing them.
- **What is missing.** The features that should exist and do not. I cannot see this from inside.

If you rewrite something I did not ask you to touch and the result is better, that is the outcome I want.

---

## 6. How I would like to hear back

Organize it however is clearest. Format is yours. But I would like to be able to answer these:

**What did you decide?** The plan you are executing, and the ones you considered and rejected. I am more interested in the rejections — they tell me what you understand that I do not.

**What did you verify, and what did you take on faith?** My observations in section 2 are worth exactly what my evidence for them is worth. I have been wrong before, at scale: an earlier draft of this handover confidently asserted the repo had no licence file and a 512 MB tree, both of which came from reading a working directory that had drifted from what was published. If you find I am wrong again, say so plainly. That is not a criticism of you, it is the most useful thing you can tell me.

**What did you change, and how do I know?** The command that proves each claim. "Improved" without one is not done.

**What did you break, and what are you unsure about?** The risks you are carrying forward, and the assumptions you could not test.

**Where should I start reading?** Three files that would let me understand the new shape.

---

## 7. Two things learned the hard way

**Never round-trip a file you have not measured.** A previous round lost thousands of lines from a large module by reading it through a tool that silently caps its output, then writing the truncated result back. The file still compiled, because the surviving prefix was valid Python, so nothing failed until the tests did. Measure the length first; for anything large, edit surgically or snapshot. Verify line count, compilation, and tests after.

**A line reference is only as good as the tree it came from.** The single most damaging error in this project's history was not a bug in the code. It was a confident, detailed, wrong review written against a directory that had already diverged from what shipped. It was specific enough that nobody questioned it. Establish which tree is authoritative before you believe anything anyone says about it, including section 2 of this document.

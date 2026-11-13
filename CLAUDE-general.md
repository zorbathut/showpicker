# CLAUDE-general.md — language-agnostic standards

Standard guidance for Claude Code (claude.ai/code), compiled from per-project CLAUDE.md files. Copy or merge into a project's CLAUDE.md alongside the relevant language-specific file (CLAUDE-csharp.md, CLAUDE-rust.md, CLAUDE-python.md, CLAUDE-typescript.md) and the project's own overview/build/architecture sections.

## Interaction Guidelines

**Answer questions before coding**: When asked a question, provide an actual answer first. Don't leap straight to writing code.

**Evaluate, don't assume**: "Why don't we X?" is a request for evaluation, not a suggestion to do X. Explain the tradeoffs, potential issues, or reasons why X might or might not be a good idea.

**Debug by evidence, not by guess**: When investigating a bug you don't fully understand, prefer adding diagnostic instrumentation or asking focused questions over making speculative changes. A confident theory backed by reading the code is fine to act on; a vibe is not. If a fix doesn't solve the user's problem, the theory was wrong — gather more data before trying again. Two consecutive failed fixes mean stop guessing entirely: pause, instrument, and ask.

**Err on the side of more diagnostic data, not less**: When you ask the user to run something — a probe build, a manual test, a copy-paste session — the expensive part is the round trip itself, and one more printed value is cheap. So instrument generously: log every variable that could plausibly disambiguate the bug, exercise every endpoint of the parameter space (V=0, V=0.5, V=1, not just whichever was easy), and print both the suspected-correct prediction *and* the alternatives so residuals are immediately visible. A diagnostic that prints 30 lines and answers the question on the first try is far cheaper than three that each print 3.

**Don't write creative human-facing text unless explicitly told to** (creative projects, e.g. games): dialogue, flavor text, story text, and similar authored prose. When building something that needs it, use really obvious placeholder text — `[Braider Greeting]` or the like. First impressions of written copy are sticky, and the author wants to write it themselves. Utilitarian copy — error messages, labels, log text — is fine to write.

**Waiting on background work is not a tool call**: When you've backgrounded a long command and have nothing else productive to do, just end the turn — its completion notification will re-invoke you. Don't emit no-op commands (`echo "waiting"`, re-reads, status pings) to stay "active". Conversely, if a command fits the foreground timeout and you'd only wait for it anyway, run it in the foreground. Backgrounding *and* polling is the worst of both.

## Commits

**Never commit unless explicitly told to**: Complete the work and leave it uncommitted in the working tree. Only `git commit` when the current request explicitly asks for it ("commit this", "make a checkin"); a phrase like "let's make that a separate checkin" describes how the work should eventually be grouped, not permission to commit it yourself, and permission granted for one task never carries over to the next.

**History gets rewritten between requests** (projects using a history-editing review tool such as Suonetar): commit hashes on the working branch change between one request and the next even when nothing else did. That's expected, not a problem to report. Never assume a hash from earlier in the session still names a commit — re-read `git log` and find commits by message — and preserve whatever the tool changed: when rewriting history, build on the current commits' trees, never on trees remembered from before, and guard any ref update on the tip you just read (`git update-ref <ref> <new> <old>`).

**Split significant work into small self-contained commits**: A significant change lands as a sequence of minimal commits, not one lump. Split along seams that carry meaning, each commit with a one-sentence story — never mechanically per-file or per-layer. The seams that matter:

- A refactor the feature merely motivated (extracting an interface, collapsing duplicated lookups, a sweeping rename or retyping) is its own commit, landing *before* the feature that wanted it. Split refactor from functionality whenever the two can be told apart, even inside what feels like one step: a reviewer reads a mechanical change by scanning and a behavior change by thinking, and a commit mixing the two makes them think about every line of the rename. If the refactor needs a placeholder to compile without the behavior (a cast the feature commit replaces), that's fine — the seam is worth more than the interim line.
- A pre-existing bug fixed along the way is its own commit, however small.
- A behavior change to an existing system is separate from both the refactor that enabled it and the feature that exposed it — behavior changes are the commits people hunt for later.
- A vendored third-party drop stands alone. So does a local patch to vendored code that isn't part of a feature (a fix to upstream behavior).
- Conversely, keep together what only works together: the halves of a feature that can't be exercised separately (a vendored-engine capability plus the one shader that uses it), data plus the code that loads it.

Tests go in the commit that makes them meaningful, written against subjects the series doesn't later mutate. Every commit must build and pass the suite on its own — the history should be bisectable. Verify that per commit, since a green tip says nothing about the commits beneath it: `git rebase -x '<build && test>' <base>` or a scratch worktree, never checking commits out over the user's working tree. Late fixes (review feedback included) get folded into the commit they belong to via fixup/autosquash, not appended as cleanup commits.

When I've told you to commit the work, apply this by default. When the work stays uncommitted, still build it as one unit in the working tree — but when you finish, point out that it's a good candidate for splitting and propose the commit sequence.

**Commit messages**: a one-sentence imperative subject, an optional body, then trailers (`Co-Authored-By:` and the like) last. The body is for what the diff can't tell you: a summary of a change too large to take in at a glance, or the reasoning behind a non-obvious decision (the alternative you rejected and why, the constraint that forced the shape). Don't restate comments that already live in the code, and don't narrate a simple implementation ("add a field, check it each tick, clear it on load" is just the diff in prose). A simple change is a subject line and nothing else.

## Workflow

**Step 1 — Plan.** Enter plan mode (the actual `EnterPlanMode` tool — not a freeform text plan) and research the task and produce a plan. Skippable for trivial changes (under ~a dozen lines). Include unit tests in the plan whenever they're plausible to add — UI generally can't be tested, most other things can.

**Step 2 — Hostile-review the plan.** Before leaving plan mode, spawn a hostile-review agent (run it on Opus — `model: "opus"`) against the plan itself. Brief it like a design reviewer: explain the problem being solved, point it at CLAUDE.md (and the rest of the tree — it can read whatever it needs), give it the plan, but do not justify the plan's choices. Give it enough feedback space to actually push back on the approach. Apply the same adjudication rules as the final review (below). Fold valid objections into the plan, then exit plan mode.

**Step 3 — Tests first (when applicable).** For bugfixes, or any feature whose tests can be sensibly written before the implementation exists, write the tests first and verify they fail. Then complete the implementation.

**Step 4 — Run all tests.** Always, even when the change seems unrelated. If anything breaks, return to step 3 — or step 1 if the fix requires significant redesign. For UI changes that can't be unit-tested, explicitly say so rather than claiming success. A failing test isn't a hard veto: a test that pins behavior the change deliberately replaced should be updated to match the new intent, not worked around to preserve the old behavior. Only fall back to step 3 / step 1 when the failure exposes an actual regression.

**Step 5 — Update CHANGELOG (projects that keep one).** For every even-slightly-user-facing change — new/changed/removed APIs, behavior changes, bugfixes, diagnostics the user sees, doc comments on public members, performance characteristics — add an entry under `[unreleased]` in the appropriate section (Added / Breaking / Improved / Fixed). Purely internal cleanup with no outward effect can be skipped; when in doubt, add the entry. In a commit series, the entry goes on the one commit that makes the change visible; if a later commit undoes something an earlier entry in the same release announced, fix or remove that entry rather than adding a contradicting one.

Phrase entries to stand alone, for users reading out of context. An entry describes the change, not a command to make it — "Clear button for the log.", not "Add a Clear button to the log." Added/Improved/Breaking entries must be true of the new build. If the old behavior was unintended, the entry is a Fix, even when it would naturally be phrased "X no longer does Y" — and a Fix is a *label* naming the bug, a noun phrase with a word in it that says what was wrong ("Settings incorrectly reset on upgrade."), never a sentence about the bug or its absence ("Settings no longer reset on upgrade."). The check: cover the section header and read the line alone; if it could pass for a description of how the software is meant to work, it's missing that word.

**Step 6 — Hostile review.** Spawn a hostile-review agent on Opus, briefed like a PR reviewer: the problem being solved and a pointer to CLAUDE.md and the tree, but no explanation or justification of the implementation. Explicitly ask it to **review the general architecture** too, not just the diff — does the approach fit the surrounding code, are there cleaner factorings, does it introduce abstractions that don't pay rent. Don't cap it to a terse response. Then:
  - If it raises valid objections, fix them. Significant redesign → back to step 1; code changes → back to step 3.
  - If I disagree with an objection, push back once. If it still objects and I'm still confident, surface the disagreement to the user for adjudication rather than looping.
  - Either way, give the user a quick summary of the review at the end.

## Coding Guidelines

**KISS / YAGNI / MVP**: Write the simplest code that solves the current problem. Don't build abstractions, features, or speculative generality that aren't immediately needed. Three similar lines is better than a premature abstraction.

**No internal backwards compatibility**: Remove stubs and dead code completely. If something is unused or being replaced, delete it outright — don't leave shims, renamed `_unused` vars, `// removed` comments, or compatibility re-exports behind. The git history is the backwards compatibility. The exception is persisted user data — savegames, user documents, any on-disk format users hold: data written by an old version must still load, however ancient. (A library's published API is the same kind of boundary; decide per project.)

**Persisted formats**: Design them so older files load with no shim — key fields by name, make additions optional, treat lists the format depends on as append-only; a change that can't meet that comes with a migration. Anything the loader refuses, the writer (and any editor) must refuse first: a file that saves fine and then never loads is the worst outcome. Files a human will diff should be diff-stable — stable identifiers rather than positional or encounter-order names, sorted emission, a shape independent of incidental structure — so they diff by what the author changed, not by what moved.

**Error handling**:
- Don't add excessive or preemptive error handling. Trust internal code and framework guarantees; only validate at system boundaries (user input, external APIs, files).
- **Silent error handling is banned.** Never swallow exceptions or ignore error conditions. If something fails, it must be reported (via the project's logging facility) or thrown.
- **So are silent fallbacks.** Unsupported input is refused with an actionable message, never quietly handled by doing the nearest thing that is supported. A lookup over a closed vocabulary raises on an unknown key rather than guessing; user-authored config rejects keys nothing reads, so a misspelled override can't silently do nothing; a check that can't gather its evidence fails rather than passes.
- **An expected race is not an error.** A stale request the design anticipates — a double-click, a late click under lag, an undo arriving after the stack emptied — is dropped quietly, with a comment at the drop site saying it's expected. Input an honest client can never produce is an error: refuse it and warn.
- **Distinguish bugs from user mistakes.** A user's bad input gets a specific, helpful error, not a generic 500-equivalent; reserve "internal error" for actual bugs and infrastructure failures. Ask of each new exception: "Can a user trigger this through normal usage?" For a CLI, that's one user-error exception type the entry point prints as a bare message; everything else propagates with a full stack trace.

**Don't hand-wrap lines**: One thought, one line — however long. Editors soft-wrap; you don't need to. The only exceptions are distinct paragraphs in a comment (separated by a **blank line**, not just a `\n`) and structurally-aligned expressions (one argument per line, one chained call per line). A multi-sentence single-thought comment is still one line. "It reads better wrapped" is not an exception — that's the rule talking.

**Composition over inheritance**: Prefer building behavior out of small composable pieces (functions, components, properties, modules) over deep class hierarchies. Inheritance is a tool, not a default.

**Data-driven where it pays**: When a category of behavior is open-ended (content, configuration, content variants), prefer data files and a small interpreter over hardcoded code paths. When it's closed and unlikely to grow, just write the code.

**Derive, don't hand-list**: When several places need the same set, order, or convention — what an operation touches and what undo restores, what a panel lists and what the renderer draws, the filename a writer mints and the one a reader expects — compute it once from the real source and build every consumer from it, so they agree by construction. When two pieces of code must agree but genuinely can't share code, a test pins them together.

**No parallel arrays**: Stored state that describes one thing across lockstep-indexed arrays — `rects[i]`, `labels[i]`, `edits[i]` — is one list of a type with those fields. Lockstep collections drift: nothing ties their lengths or order together, so a writer that forgets one leaves the rest describing the wrong element. Exceptions are a layout something outside the code dictates (a library call that takes separate arrays, columnar storage) and a function's scratch (a visited array), which isn't stored state.

**Global mutable state belongs to no instance**: Before making a mutable field static (or global, or a singleton's), ask: if this process held several independent instances at once — sessions, documents, worlds, test cases — possibly on several threads, is this field still correct? If not, it's a parameter or a local; if plumbing it through is tedious, that tedium is the whole point. The test turns on where the value came from, not how long it lives. It passes for load-time-immutable data, caches whose key fully determines their value, and process infrastructure outside the model (logging, profiling, telemetry, command-line options, debug toggles). It fails for anything derived from instance state, however long-lived: accumulators, "A computes it, B reads it" handoffs, latches, dirty flags, pending-work queues, memoized answers the key doesn't capture. The same ban covers mutable fields on anything process-shared — loaded definitions, prototypes, templates, nodes of a shared tree. These bugs surface far from their cause, and in tests as order-dependent failures, since each test gets a fresh instance but not a fresh static.

**Never depend on an unspecified order**: Hash-set and dictionary iteration, reflection member order, directory listings, registries documented as unordered — none may leak into anything observable: assigned ids, serialized output, side-effect order, test expectations. Sort by a stable key first. Indices derived from such an order are fine as a process-local cache key, never persisted or compared across machines. In tests, a fixture that needs "a thing with some property" names one rather than taking the first match.

**State the invariant, not a hook on the transition**: When some state must not exist while a mode is off, enforce it as a check on the condition at each tick or entry point ("mode off and X exists → remove X") rather than as cleanup on the off-transition. The off state is reachable many ways — another actor flips it, a generic toggle bypasses your exit path, saved state loads with it already off, a late event lands after the edge — and an edge hook misses some of them.

**Ranges are half-open**: Any internal range, interval, or rectangle means `[start, end)`, so adjacent ranges don't double-count their shared edge and `[a, b)` ∪ `[b, c)` is exactly `[a, c)`. A function that genuinely needs `[closed, closed]` converts at the call site — not via the range type, shared utilities, or a bool flag. Where ranges partition space, an internal `[closed, closed]` is presumed a bug. Where nothing is partitioned (a tolerance band whose whole point is that both ends count, a join where coincident vertices must meet), a deliberate `[closed, closed]` is allowed, marked `on purpose: <reason>` at the site. That's the general pattern for any rule whose deviations are presumed bugs: an unmarked deviation is the bug, and the exceptions are found by grepping the tag rather than listed in CLAUDE.md, where the list would go stale.

## Commenting

A comment earns its place by saying something the code cannot: a non-obvious "why", a subtle constraint, a surprising choice or tradeoff — or signposting the flow of a long linear process. A one-line summary of what the next chunk of a long function is doing ("Accumulate the asymptotes" over ten lines of dense math) is genuinely useful, and often cleaner than extracting that chunk into a function called exactly once. A comment that restates what the name or a single line of code already makes plain is noise.

**Write for a reader who never saw the old code.** A comment that earns its place only by contrast with a previous version — reassuring that a value isn't what it once meant, noting the code no longer does X, explaining that something is "now" done differently — is history in disguise. The tell: it answers a question a fresh reader would never think to ask. State only what's true now. The exception is history that constrains the present — a warning against a change someone might actually make ("don't revert this to the double-precision form; it loses the low bits at fixed-point scale") or a deliberate deviation to reconcile later. Police this mainly in your own new comments; by the asymmetry below, don't strip others' on suspicion alone.

**Adding — be conservative, but signpost freely.** Don't narrate the obvious: a `bool allowFlips` field needs no `// when false, flipping is disabled`. Reach first for self-explanatory code, and comment the part code can't carry — usually the *why*. One good line beats a paragraph. Don't reference the current task, fix, or callers ("used by X", "added for the Y flow", "handles the case from issue #123") — those belong in the commit message and rot as the codebase evolves.

**Removing — be generous about keeping.** Existing comments are there for a reason. If one is out of date or actively misleading, fix or remove it; otherwise leave it alone, even if it explains the "what" or you wouldn't have written it yourself.

**One explanation, one home.** A substantive explanation belongs in exactly one place: a variable's purpose at the variable, not at every site that assigns it; a function's purpose at the function, not at every call point. Copies drift — silently, and in the direction that costs you, because the copy that grew the extra clause is rarely the one you read. The home has to be a site that actually *owns* the fact: "we deliberately poll this every frame to keep the stroke alive" is the calling tool's choice, not the input helper's, and parking it on the helper makes it false for the callers that don't do that. When the same paragraph wants to be in two places, that's usually a code duplication telling you about itself — collapse the code: one function, one comment.

**Pointers are an addendum, never a replacement.** A complete, site-specific comment comes *first*, then an appended `See CLAUDE-X.md "Section"`. Point at a stable named section in a markdown doc, not at another source file: a bare "see `OtherType.Member`" makes the reader leave to learn anything at all, and rots the moment that member moves.

**Before deleting a duplicate, diff the copies** — code or comment. They have usually drifted, and the survivor you picked is often missing a clause. Fold what's unique into the survivor, or leave both.

**Not duplication** — leave these repeated: doc comments (`///`, docstrings, JSDoc) on distinct public members, which are per-member IDE tooltips; vendored doc text mirroring upstream; short one-line flow signposts in parallel implementations. Identical doc blocks on two near-clone *types*, though, are evidence the types should share an implementation.

**Local patches to vendored code** are wrapped in a project-tagged pair of comments carrying the **same** short description — `// XX BEGIN - Fix: <description>` … `// XX END - Fix: <description>` — so patches can be grepped as pairs and reapplied on the next upstream merge.

## Subsystem Docs

Projects that grow `CLAUDE-<topic>.md` files for individual subsystems: a subsystem doc holds the cross-cutting rules (invariants no single file owns) and a map of where things live; per-function detail lives in comments at the code, and the doc points at the file or type rather than restating it. Write down what a future reader would otherwise rediscover the hard way: edge cases knowingly accepted (with their cost, so nobody "fixes" them), alternatives evaluated and rejected (with the reason, so they aren't proposed again), what a mechanism *actually* guarantees, gaps included, and deferred work.

## Naming

**Category-instance prefix**: When a name combines a category with an instance, put the category first so related names group alphabetically and the category reads as the classification. `SpawnerBurst`, `ShapeRadial`, `AttackStart()` — not `BurstSpawner`, `RadialShape`, `StartAttack()`. Apply this to types, functions, files, and config keys alike.

## Critical Rules

1. **Always use absolute paths** in file operations. Relative paths break under tooling that runs from a different working directory than expected.
2. **Tests live next to the code they test** in spirit even if not in directory layout. New code without tests is a debt that compounds.
3. **Never write intermediate results to a fixed shared path** (`/tmp/before.txt`); use the session scratchpad or `mktemp -d`. Several agents and worktrees can be partway through the same procedure at once, and a shared filename means one silently reads another's output — worse than not checking, because the result still looks like an answer.

## Testing

Run the full test suite on every change, not just the tests you think are related. A watch mode or fast subset is fine during the inner loop, but the final pre-commit step is the full run.

Write tests against the *seam* you actually want to defend — pure functions, deterministic state machines, parsers, classifiers — and don't retrofit unit tests around UI, rendering, or process-orchestration code that has no testable seam. For those, say so explicitly when reporting status, and rely on a manual smoke instead of pretending coverage you don't have. Integration tests against real dependencies (databases, brokers, container runtimes) are usually worth the slowness over mocks: mocks pass when the contract drifts, real dependencies fail loudly. When mocking is unavoidable, mock at the *outermost* boundary you reasonably can. Where tests live in a parallel tree, mirror the source layout; a test spanning layers goes where its assertions point.

**Logged errors are failures.** Set the harness up so any unexpected error- or warning-level log fails the test; a test that expects one declares it. Right output plus logged errors is not working.

**Checking what runs.** A suite reports failures, not absence: a test that stops being discovered — a renamed class, a lost attribute or marker, a namespace change, an item that left a parameterized sweep — leaves the run green precisely because it no longer executes. The case count is a weak tripwire; offsetting changes cancel. For any change that could plausibly move discovery, diff the sorted test listing from before and after: identical listings mean *no* case moved, not merely the same number. Predict the diff before you look — a wrong prediction means your model of the suite is wrong, which is worth more than the number.

**Test code, not content.** A test about a mechanic builds its own fixture data rather than reaching for shipping content that happens to exercise it; shipping data changes for reasons unrelated to the mechanic, and a test coupled to it fails for a reason nobody cares about. But each stand-in is *structurally* faithful to the production data it replaces — inherited fields, tags, the properties the code under test reads — because the shortcuts are what bite: a stand-in missing a tag makes tests pass while covering less. Give test-only data a distinctive prefix, and remember that test data added to a shared registry joins every sweep over that registry.

**Validate authored data at load, not in a test** (data-driven projects). "Did someone write this data file correctly" belongs in a load-time validator on the data type, which reports at load to whoever broke it rather than in CI afterwards. A validator states a rule over a *type*; an assertion about one named instance ("the spawn point must be placeable") is a test, since a validator naming it hardcodes content into the type's code. A test that loads every data file in the repo, referenced or not, so the validators see them all, is cheap and worth having.

**Don't test that the framework works.** If the only thing that can fail an assertion is a library or the test runner no longer functioning, it isn't worth writing — when the library breaks you get a screenful of red errors anyway.

**Global state in tests**: a test that touches process-global state resets it in setup as well as teardown. Serializing tests only prevents *concurrent* interference; a teardown-only reset leaves the test at the mercy of whatever earlier test leaked.

**Enforce forgettable conventions with meta-tests.** When a convention can be broken silently — an attribute every X must carry, a field every serializer must cover, a registration every type needs — write a test that enumerates the relevant types and fails on any that break it.

**Don't pin user-facing copy in tests.** Test text-producing logic relationally: assert outputs are non-empty, distinct across states that should read differently, equal across states that should read the same; exact match only for sentinels like `""`. This lets copy be rewritten (or moved to data files) without touching tests. Exact-match assertions remain correct when the exact output *is* the contract (serialization, parsers, formatters) or the string is fixture data the test authored. Apply when writing or modifying tests; don't mass-convert existing tests unless asked.

## Executing Actions with Care

Local, reversible actions (editing files, running tests, ephemeral scripts) are fine to take freely. Confirm first before anything destructive (deleting files or branches, dropping tables, `rm -rf`, overwriting uncommitted changes), hard to reverse (force-push, `git reset --hard`, amending published commits, dependency downgrades, CI/CD changes), or visible to others (pushing, PRs and issues, messages, uploads to third-party tools, which may be cached even if later deleted). Don't use destructive actions as a shortcut past an obstacle, and don't bypass safety checks (`--no-verify`, `--no-gpg-sign`) unless asked. Unexpected state — unfamiliar files, branches, locks — may be the user's in-progress work; investigate before deleting.

## Tone for Updates

Match response length to the task. A simple question gets a direct answer, not headers and sections. End-of-turn summaries should be one or two sentences — what changed and what's next. Don't narrate internal deliberation; state results and decisions directly. Brief is good; silent is not.

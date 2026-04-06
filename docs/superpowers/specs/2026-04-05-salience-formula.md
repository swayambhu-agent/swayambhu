# Salience Formula Redesign

Date: 2026-04-05

## Goal

Replace the current salience formula in `eval.js` with a bounded, interpretable score that:

- stays in `[0, 1]`
- does not increase just because more desires exist
- favors a strong match on a few desires over a diffuse weak match across many
- keeps surprise (`sigma`) and desire relevance (`alpha`) as separate axes
- remains simple enough to implement in a few lines of JS
- keeps `0.5` as a reasonable experience-write cutoff in `userspace.js`

## Grounding In Current Code

The current implementation is in `computeMetrics()` in `eval.js`:

```js
return {
  sigma,
  alpha,
  salience: sigma + l1Norm(alpha),
  pattern_scores: patternScores,
  ...extras,
};
```

`sigma` is built as the maximum pattern surprise across classified pattern pairs. `alpha` is built as a signed desire-affinity vector where entailment is positive, contradiction is negative, and neutral is zero. `l1Norm()` comes from `memory.js` and is:

```js
export function l1Norm(vec) {
  if (!vec || typeof vec !== "object") return 0;
  return Object.values(vec).reduce((sum, v) => sum + Math.abs(v), 0);
}
```

Experience writing is gated in `writeMemory()` in `userspace.js`:

```js
const salienceThreshold = 0.5;
...
if (salience > salienceThreshold) {
  // write experience
}
```

Two important consequences of the actual write path:

1. The threshold comparison is `>` rather than `>=`, so `0.5` is strictly below write level.
2. For `no_action`, `userspace.js` already overrides salience and uses `sigma` alone, because desire contradiction on abstention is known to create false positives.

## What The Current Formula Gets Wrong

### 1. It is unbounded

Current formula:

`S_current = sigma + sum_i |alpha_i|`

Since `sigma ∈ [0,1]` and each `|alpha_i| ∈ [0,1]`, the upper bound is `1 + number_of_desires`.

Example:

- `sigma = 0.2`
- 7 desires each at `0.8`
- `S_current = 0.2 + 7 * 0.8 = 5.8`

That makes the threshold `0.5` effectively meaningless once several desires are active.

### 2. Adding desires makes everything more salient by construction

Even if the new desires are weak or redundant, `l1Norm(alpha)` can only stay the same or rise.

Example:

- one desire at `0.8` gives `0.8`
- seven desires at `0.8` give `5.6`

The formula treats desire count as evidence, even when it is just duplication.

### 3. It does not distinguish concentrated relevance from diffuse relevance

These two cases are very different cognitively:

- one desire at `0.8`
- seven desires at `0.3`

Current formula says:

- `0.8`
- `2.1`

So weak diffuse signal beats strong focused signal. That is the opposite of the desired behavior.

### 4. It is not interpretable

`sigma` and `l1Norm(alpha)` are mixed additively even though they measure different things:

- `sigma`: “how surprising was this relative to patterns?”
- `alpha`: “how relevant was this to desires?”

The result does not map cleanly to a cognitive intuition like “high on surprise,” “high on desire relevance,” or “high on both.”

## Data Constraints From The Repo

The current repo does **not** have a source file that seeds desires the way it seeds patterns:

- `scripts/seed-local-kv.mjs` seeds `config:*`, `pattern:*`, prompts, tools, and other infrastructure
- `config/seed-patterns.json` exists
- `config/seed-samskaras.json` is currently `{}`
- there is no checked-in `config/seed-desires.json`

So there is no canonical repo-side seed file for desire definitions today.

The local KV snapshots under `.wrangler/shared-state/...` do show actual current desire records, including:

- `desire:patron-alignment`
- `desire:operational-self-knowledge`
- `desire:resource-stewardship`

Those records include `source_principles`, which is the only concrete metadata currently available for approximate specificity / overlap weighting.

## Candidate Approaches

### 1. Raw max over desires

Definition:

`A = max_i |alpha_i|`

Pros:

- bounded in `[0,1]`
- completely count-invariant
- very simple
- strongly favors focused signal

Cons:

- ignores the second and third supporting desires completely
- cannot express “two moderately strong distinct desires both fired”
- provides no place to include specificity or overlap weighting

Verdict: too lossy.

### 2. Mean absolute value

Definition:

`A = (1/n) * sum_i |alpha_i|`

Pros:

- bounded in `[0,1]`
- no count inflation
- simple

Cons:

- weakly rewards diffuse signal
- does not emphasize concentrated high-affinity desires enough
- broad low-value desire sets can still look too important

Verdict: better than `l1`, but not sharp enough.

### 3. Root-mean-square over desire affinity

Definition:

`A = sqrt((1/n) * sum_i alpha_i^2)` using `|alpha_i|` in practice

Pros:

- bounded in `[0,1]`
- no count inflation for equal-strength additions
- stronger values dominate weaker ones
- still simple

Cons:

- without weights, it ignores specificity and overlap
- if all active desires are redundant, pure RMS still treats them as independent entries

Verdict: strong base aggregator.

### 4. Normalized L2 norm

Definition:

`A = sqrt(sum_i alpha_i^2) / sqrt(n)`

Pros:

- mathematically equivalent to RMS
- emphasizes strong values over weak values

Cons:

- same limitations as RMS

Verdict: same idea as RMS, just written differently.

### 5. Geometric mean of sigma and desire score

Definition:

`S = sqrt(sigma * A)`

Pros:

- bounded
- forces both axes to matter

Cons:

- too harsh for surprise-only or desire-only episodes
- with `A = 0`, any surprise-only event becomes `0`
- conflicts with the current architecture, where one axis alone can still be worth remembering

Verdict: too suppressive.

### 6. Simple weighted sum of sigma and desire score

Definition:

`S = w_sigma * sigma + w_alpha * A`

Pros:

- bounded if weights sum to 1
- easy to explain
- threshold behavior is easy to tune

Cons:

- linear blending hides interaction between axes
- moderate values on both axes can feel undercounted
- strong value on one axis can crowd out the other depending on weights

Verdict: viable, but there is a cleaner bounded combiner.

### 7. Probabilistic OR over separate axes

Definition:

`S = 1 - (1 - sigma)(1 - A)`

Pros:

- bounded in `[0,1]`
- preserves separate axis meaning
- intuitive: salience rises if surprise is high, desire relevance is high, or both are high
- both axes together get a nonlinear boost
- `0.5` remains a sensible threshold

Cons:

- assumes the two axes are independent enough for a union-style interpretation
- not as visually geometric as Euclidean combination

Verdict: best combiner for this architecture.

## Recommended Formula

### Intuition

Salience answers: "is this experience worth remembering?" It's worth
remembering if it was surprising (broke a pattern), or if it mattered
to my desires (positively or negatively), or both. These are two
independent axes that combine nonlinearly — moderate surprise PLUS
moderate desire relevance should be more salient than either alone.

The formula has two stages:
1. Compress the desire affinity vector into a single [0,1] score (the desire axis)
2. Combine that with surprise using a bounded combiner (the final salience)

### Stage 1: Desire Axis — Weighted RMS

**Why RMS (root mean square)?**

We have a vector of desire affinities, e.g. [0.8, 0.3, 0.3, 0.1].

- Sum (current formula): 1.5. Unbounded. More desires = higher score.
- Mean: 0.375. Bounded, but the strong 0.8 signal gets diluted by weak ones.
- RMS: sqrt((0.64 + 0.09 + 0.09 + 0.01) / 4) = 0.456. Bounded, strong
  signals dominate (squaring amplifies them), adding identical desires
  doesn't inflate (normalized by count).

RMS is the right aggregator because it rewards few strong signals over
many weak ones, and it's count-invariant.

**Why weights?**

Not all desires are equal. Two factors matter:

*Specificity:* A desire grounded in 1 principle is more focused than one
grounded in 5. When a specific desire fires, it's a sharper signal.
Weight: `s_i = 1 / sqrt(principle_count)`. One principle → 1.0, four → 0.5.
The square root makes it a gentle decay.

*Overlap:* If two desires share principles (e.g. both grounded in
"humility"), they partly measure the same thing. Both firing is partly
double-counting. Weight: `r_i = 1 / sqrt(1 + overlap_count)`. No
overlap → 1.0, overlaps with 3 others → 0.5.

Combined weight: `w_i = s_i × r_i`. Specific, non-overlapping desires
contribute most. Broad, overlapping desires are dampened.

**The formula:**

Let:

- `a_i = |alpha_i|` for each desire
- `p_i = source_principles.length` for that desire, default `1` if missing
- `overlap_i = number of other active desires that share at least one source principle`

Define:

- specificity weight: `s_i = 1 / sqrt(max(1, p_i))`
- overlap penalty: `r_i = 1 / sqrt(1 + overlap_i)`
- total weight: `w_i = s_i * r_i`

Then compute the desire axis as a weighted RMS:

`A = sqrt( sum_i (w_i^2 * a_i^2) / sum_i w_i^2 )`

with `A = 0` if there are no active desires.

The weighted RMS is standard RMS but with non-uniform weights:
`A = sqrt(Σ(w_i² × a_i²) / Σ(w_i²))`. The denominator normalizes
so the result stays in [0,1] regardless of how many desires exist.
If all weights are equal, this reduces to standard RMS.

### Stage 2: Final Salience — Probabilistic OR

We now have two bounded [0,1] scores:
- σ (sigma): how surprising was this?
- A: how desire-relevant was this?

We need one salience score. The combiner must satisfy:
- σ high alone → salient (a maximally surprising event is worth remembering)
- A high alone → salient (a strongly desire-relevant event is worth remembering)
- Both moderate → more salient than either alone (the combination matters)
- Bounded [0,1]

**Probabilistic OR** treats σ and A as independent probabilities of
"this is worth remembering" and computes the probability that at least
one fires:

`S = 1 - (1 - σ)(1 - A)`

Expanding: `S = σ + A - σA`

Properties:
- σ alone (A=0): S = σ. Surprise alone passes through.
- A alone (σ=0): S = A. Desire relevance alone passes through.
- Both moderate (σ=0.35, A=0.35): S = 0.578. Crosses 0.5 threshold
  even though neither axis alone would.
- Both high (σ=0.8, A=0.8): S = 0.96. Nonlinear boost.

This is better than average (which would give 0.35 for two 0.35s —
below threshold) and better than max (which ignores the boost from
both axes engaging).

Use bounded union across the surprise and desire axes:

`S = 1 - (1 - sigma)(1 - A)`

Equivalent form:

`S = sigma + A - sigmaA`

### Why This Works

1. `A` is bounded in `[0,1]` because it is a weighted RMS over values already in `[0,1]`.
2. `S` is bounded in `[0,1]` because it is the union of two `[0,1]` scores.
3. Adding more desires does not automatically increase `A`; duplicating equal-strength desires leaves RMS unchanged.
4. Strong signal from one or two desires beats many weak desires because squaring magnifies high values.
5. `sigma` and `A` stay separately interpretable:
   - `sigma`: surprise axis
   - `A`: desire relevance axis
   - `S`: overall memory-worthiness if either or both axes fire
6. `source_principles` gives a minimal grounded way to approximate:
   - specificity: fewer source principles means a more specific desire
   - overlap: active desires sharing principles are treated as partially redundant

## Worked Examples

In the examples below, all desire scores use `a_i = |alpha_i|`.

### Example 1: One strong desire

- `sigma = 0.2`
- one desire at `0.8`
- no weighting complications, so `A = 0.8`

Then:

- `S = 1 - (1 - 0.2)(1 - 0.8)`
- `S = 1 - (0.8)(0.2)`
- `S = 0.84`

Interpretation: moderately surprising and strongly desire-relevant, clearly worth writing.

### Example 2: Seven equally strong desires

- `sigma = 0.2`
- seven desires all at `0.8`
- with equal weights, RMS remains `0.8`

Then:

- `A = sqrt((7 * 0.8^2) / 7) = 0.8`
- `S = 1 - (0.8)(0.2) = 0.84`

Interpretation: unlike the current formula, this does **not** inflate just because seven desires are present.

### Example 3: Many weak desires

- `sigma = 0.2`
- seven desires all at `0.3`

Then:

- `A = sqrt((7 * 0.3^2) / 7) = 0.3`
- `S = 1 - (1 - 0.2)(1 - 0.3)`
- `S = 1 - (0.8)(0.7)`
- `S = 0.44`

Interpretation: diffuse weak desire relevance stays below the `0.5` write threshold.

### Example 4: Surprise-only event

- `sigma = 0.6`
- no active desires, so `A = 0`

Then:

- `S = 1 - (1 - 0.6)(1 - 0)`
- `S = 0.6`

Interpretation: strong surprise alone can still produce a memorable event.

### Example 5: Two moderate axes together

- `sigma = 0.35`
- one desire at `0.35`, so `A = 0.35`

Then:

- `S = 1 - (1 - 0.35)(1 - 0.35)`
- `S = 1 - (0.65)(0.65)`
- `S = 0.5775`

Interpretation: neither axis is dominant, but together they cross the write threshold.

### Example 6: Actual current desires with specificity / overlap weighting

Using the current local desire records:

- `desire:patron-alignment`
  - `source_principles = ["alignment", "humility", "care"]`
  - `p = 3`, so `s = 1 / sqrt(3) = 0.5774`
- `desire:operational-self-knowledge`
  - `source_principles = ["reflection", "humility", "discipline"]`
  - `p = 3`, so `s = 0.5774`
- `desire:resource-stewardship`
  - `source_principles = ["discipline", "responsibility"]`
  - `p = 2`, so `s = 1 / sqrt(2) = 0.7071`

Assume the current action yields:

- `alpha(patron-alignment) = 0.9`
- `alpha(operational-self-knowledge) = 0.6`
- `alpha(resource-stewardship) = 0.4`
- `sigma = 0.3`

Overlap counts among active desires:

- patron-alignment overlaps with operational-self-knowledge on `humility`, so `overlap = 1`
- operational-self-knowledge overlaps with patron-alignment on `humility` and resource-stewardship on `discipline`, so `overlap = 2`
- resource-stewardship overlaps with operational-self-knowledge on `discipline`, so `overlap = 1`

So:

- `w_patron = (1 / sqrt(3)) * (1 / sqrt(2)) = 0.4082`
- `w_operational = (1 / sqrt(3)) * (1 / sqrt(3)) = 0.3333`
- `w_resource = (1 / sqrt(2)) * (1 / sqrt(2)) = 0.5`

Weighted RMS:

- numerator = `(0.4082^2 * 0.9^2) + (0.3333^2 * 0.6^2) + (0.5^2 * 0.4^2)`
- numerator = `0.2150`
- denominator = `0.4082^2 + 0.3333^2 + 0.5^2`
- denominator = `0.5278`
- `A = sqrt(0.2150 / 0.5278) = 0.6383`

Final salience:

- `S = 1 - (1 - 0.3)(1 - 0.6383)`
- `S = 1 - (0.7)(0.3617)`
- `S = 0.7468`

Interpretation: the action is relevant on multiple desires, but overlapping principle families prevent simple additive inflation.

## Threshold Interaction

The current write gate in `userspace.js` is:

`if (salience > 0.5) write experience`

Under the recommended formula:

- `S > 0.5` means either:
  - one axis is clearly strong, or
  - both axes are moderately present
- weak diffuse desire relevance no longer crosses the threshold by brute-force accumulation
- surprise-only events still cross if `sigma > 0.5`
- desire-only events still cross if `A > 0.5`

This preserves the intuitive meaning of `0.5`: “meaningfully salient,” not merely “touched many desires.”

One subtle point: because the check is strict `> 0.5`, a value of exactly `0.5` still does not write. That is already true in the current code and does not need to change for this formula.

## Implementation Sketch

This stays simple if the weighting logic is kept inline or moved to a tiny helper:

```js
const active = Object.entries(alpha).filter(([, v]) => v !== 0);
const weighted = active.map(([key, v]) => {
  const mine = desires[key]?.source_principles || [];
  const overlap = active.filter(([other]) => other !== key && mine.some(p => (desires[other]?.source_principles || []).includes(p))).length;
  const weight = 1 / Math.sqrt(Math.max(1, mine.length) * (1 + overlap));
  return { a: Math.abs(v), w: weight };
});
const desireAxis = weighted.length ? Math.sqrt(weighted.reduce((s, x) => s + (x.w * x.a) ** 2, 0) / weighted.reduce((s, x) => s + x.w ** 2, 0)) : 0;
const salience = 1 - (1 - sigma) * (1 - desireAxis);
```

This is compact, bounded, and directly uses the current desire record shape.

## Recommendation

Adopt:

- desire axis: weighted RMS of `|alpha|`
- final salience: `1 - (1 - sigma)(1 - A)`

This is the best fit for the current architecture because it fixes the unboundedness bug, preserves the existing two-axis conceptual model, keeps `0.5` meaningful, and can be implemented without introducing a complex calibration subsystem.

If the architecture later gains better overlap metadata, the only part that needs to change is the weight term `w_i`; the overall structure can remain the same.

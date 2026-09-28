/**
 * A very small property-based testing harness.
 *
 * The example-based tests in `core.test.mjs` are good at the cases somebody
 * thought of. Properties are for the ones nobody did: "reverting a migration
 * restores the original course" and "merging never loses evidence" are true for
 * *all* inputs or they are not true at all, and the interesting counterexamples
 * are usually the shapes a person would not write down — an empty list, a
 * duplicate id, a single item, a value at exactly the threshold.
 *
 * Three properties make this worth having rather than just looping over random
 * data:
 *
 *   - **Deterministic.** The generator is a seeded PRNG, so a failure is
 *     reproducible from the seed printed in the message. A flaky property test
 *     is worse than none.
 *   - **Shrinking.** A 40-element counterexample tells you nothing; the same
 *     failure reduced to two elements usually tells you everything. Shrinking is
 *     the difference between a property test and a random one.
 *   - **Edge cases first.** Every run starts with the degenerate inputs before
 *     it starts sampling, because that is where the bugs are.
 *
 * No dependency: fast-check would be better, and one more supply-chain edge for
 * three hundred lines of behaviour is not obviously a good trade for a learning
 * tool that ships offline.
 */

/** xorshift32: small, fast, and entirely reproducible from its seed. */
export function seededRandom(seed) {
  let state = (seed | 0) || 0x2545f491;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 0x100000000;
  };
}

/** Generators. Each knows how to make a value and how to make it simpler. */
export const gen = {
  integer(min, max) {
    return {
      make: (random) => min + Math.floor(random() * (max - min + 1)),
      shrink: (value) => {
        const candidates = [];
        if (value !== min) candidates.push(min);
        if (value > min) candidates.push(Math.floor((value + min) / 2));
        if (value - 1 >= min) candidates.push(value - 1);
        return [...new Set(candidates)].filter((candidate) => candidate !== value);
      },
      edges: [min, max, Math.min(max, Math.max(min, 0)), Math.min(max, Math.max(min, 1))],
    };
  },
  pick(values) {
    return {
      make: (random) => values[Math.floor(random() * values.length)],
      shrink: (value) => (values.indexOf(value) > 0 ? [values[0]] : []),
      edges: values.slice(0, 3),
    };
  },
  array(item, { min = 0, max = 12 } = {}) {
    return {
      make: (random) => Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, () => item.make(random)),
      shrink: (value) => {
        const candidates = [];
        if (value.length > min) candidates.push(value.slice(0, Math.max(min, Math.floor(value.length / 2))));
        if (value.length > min) candidates.push(value.slice(1));
        if (value.length > min) candidates.push(value.slice(0, value.length - 1));
        // Also try simplifying one element rather than removing it.
        for (let index = 0; index < Math.min(value.length, 3); index += 1) {
          for (const simpler of item.shrink(value[index]).slice(0, 1)) {
            const copy = [...value];
            copy[index] = simpler;
            candidates.push(copy);
          }
        }
        return candidates;
      },
      edges: [[], min ? Array.from({ length: min }, () => item.edges[0]) : [item.edges[0]]],
    };
  },
  record(shape) {
    const keys = Object.keys(shape);
    return {
      make: (random) => Object.fromEntries(keys.map((key) => [key, shape[key].make(random)])),
      shrink: (value) => keys.flatMap((key) => shape[key].shrink(value[key]).slice(0, 2).map((simpler) => ({ ...value, [key]: simpler }))),
      edges: [Object.fromEntries(keys.map((key) => [key, shape[key].edges[0]]))],
    };
  },
};

/**
 * Check that `property` holds for every generated value.
 *
 * Returns a report rather than throwing, so a caller can assert on it with the
 * message it wants — and so a passing run can state how many cases it actually
 * covered, which is the number that says whether the property was tested at all.
 */
export async function forAll(generator, property, { runs = 120, seed = 20260927 } = {}) {
  const random = seededRandom(seed);
  const cases = [...(generator.edges ?? [])];
  while (cases.length < runs) cases.push(generator.make(random));

  for (const value of cases) {
    let failure = null;
    try {
      const outcome = await property(value);
      if (outcome === false) failure = "the property returned false";
    } catch (error) {
      failure = error?.message ?? String(error);
    }
    if (!failure) continue;

    // Shrink: keep the simplest input that still fails.
    let smallest = value;
    let smallestFailure = failure;
    for (let depth = 0; depth < 24; depth += 1) {
      let improved = false;
      for (const candidate of generator.shrink(smallest)) {
        let candidateFailure = null;
        try {
          const outcome = await property(candidate);
          if (outcome === false) candidateFailure = "the property returned false";
        } catch (error) {
          candidateFailure = error?.message ?? String(error);
        }
        if (candidateFailure) {
          smallest = candidate;
          smallestFailure = candidateFailure;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return {
      ok: false,
      runs: cases.length,
      seed,
      counterexample: smallest,
      original: value,
      message: `${smallestFailure}\n  counterexample (seed ${seed}): ${JSON.stringify(smallest)}`,
    };
  }
  return { ok: true, runs: cases.length, seed, counterexample: null, message: null };
}

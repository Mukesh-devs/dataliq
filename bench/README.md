# Benchmark baselines

`baseline/<os>.json` holds the small benchmark suite's timings (ms, fastest
of 5 runs) recorded by the **Bench** workflow on its CI runner
(`ubuntu-22.04` for `linux.json`). `scripts/bench.mjs` fails when a flow is
more than 30% slower than these numbers (see docs/DECISIONS.md, D26).

To update a baseline after an intended change, copy the numbers from the
Bench run's `bench-<runner>` artifact (or its log) into the file. Don't
record baselines from a local machine.

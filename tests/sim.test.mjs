// Node runner for the shared cases: `npm test` or `node --test tests/sim.test.mjs`.
import { test } from 'node:test';
import { cases } from './cases.mjs';

for (const [name, fn] of cases) test(name, fn);

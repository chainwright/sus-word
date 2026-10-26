import assert from "node:assert/strict";
import test from "node:test";

import { simProfiles } from "../src/sim.js";

test("simulated players are labeled so viewers can tell them apart", () => {
  const sims = simProfiles(3);
  assert.deepEqual(sims.map(({ login }) => login), ["sim_mara", "sim_tomtom", "sim_fox"]);
  for (const sim of sims) {
    assert.match(sim.displayName, /^Sim /);
    assert.match(sim.login, /^sim_[a-z0-9_]+$/);
  }
});

test("simulated player ids and sessions stay unique past the name list", () => {
  const sims = simProfiles(11);
  assert.equal(new Set(sims.map(({ id }) => id)).size, 11);
  assert.equal(new Set(sims.map(({ login }) => login)).size, 11);
  assert.equal(new Set(sims.map(({ sessionId }) => sessionId)).size, 11);
});

// The page and Rust agree on every command name, its argument keys and every event name (see contract.mjs), and on
// the values of the enums the page branches on (tests/ipc/values.json, which Rust's tests pin). Needs nothing
// installed: `node --test tests/contract.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { page, pageFile, pageValues, rust } from './contract.mjs';
import { values } from './fixtures.mjs';

const r = rust();
const p = page();
const sorted = (list) => [...new Set(list)].sort();

test('the source reads as expected', () => {
  // A parser that finds nothing would pass every check below.
  assert.ok(r.registered.length > 20 && r.events.length > 5 && p.calls.length > 20, JSON.stringify(r.events));
});

test('every command lib.rs registers is a command in commands.rs, and the other way round', () => {
  assert.deepEqual(sorted(r.registered), sorted([...r.defined.keys()]));
});

test('the page calls exactly the registered commands', () => {
  assert.deepEqual(sorted(p.calls.map((c) => c.cmd)), sorted(r.registered));
});

test('each call sends the argument keys its command takes', () => {
  for (const { cmd, keys } of p.calls) assert.deepEqual(sorted(keys), sorted(r.defined.get(cmd)), cmd);
});

test('the page listens to exactly the events Rust sends', () => {
  assert.deepEqual(sorted(p.events), sorted(r.events));
});

test("the page's types allow exactly the values Rust sends", () => {
  const types = {
    step_state: 'LaunchStep.state',
    account: 'StoreStatus.account',
    charge: 'Charge',
    quiet_state: 'Quiet.state',
    pad: 'Action',
    pad_kind: 'PadKind',
    connection: 'Controller.connection',
    battery_level: 'BatteryLevel',
    screensaver_style: 'ScreensaverStyle',
    entry_kind: 'FolderEntry.kind',
  };
  for (const [kind, type] of Object.entries(types)) assert.deepEqual(sorted(pageValues(type)), sorted(values[kind]), type);
});

test('the starting screen picks its line to act on from step states Rust sends', () => {
  const picked = [...pageFile('state.js').matchAll(/s\.state === '([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(picked.length && picked.every((s) => values.step_state.includes(s)), JSON.stringify(picked));
});

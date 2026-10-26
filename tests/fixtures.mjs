// The payloads Rust sends, as its tests pin them (tests/ipc/<name>.json), for building the page's test data. A test
// that changes a payload goes through `like`, and a value of one of Rust's enums through `known`, so a name Rust no
// longer sends fails the test instead of feeding the page something Rust never would.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc');

/** A payload as Rust sends it. @param {string} name */
export const ipc = (name) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'));

/**
 * Every value of the enums the page branches on: step states, accounts, charge states, quiet states, pad steps,
 * controller kinds, connections and battery levels.
 */
export const values = ipc('values');

/** `value`, checked against the values Rust sends for `kind` (a key of values.json). */
export function known(kind, value) {
  if (!values[kind].includes(value)) throw new Error(`Rust sends no ${kind} "${value}", only ${values[kind]}`);
  return value;
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A payload shaped like `base` with some values changed. A key `base` doesn't have is a mistake in the test, also
 * inside a nested object, and in the objects of a list (checked against the base's first one).
 */
export function like(base, changes = {}) {
  checkKeys(base, changes, '');
  return { ...structuredClone(base), ...changes };
}

function checkKeys(base, changes, at) {
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in base)) throw new Error(`no ${at}${key} in ${JSON.stringify(base)}`);
    const was = base[key];
    if (plain(was) && plain(value)) checkKeys(was, value, `${at}${key}.`);
    else if (Array.isArray(was) && plain(was[0]) && Array.isArray(value)) {
      for (const item of value.filter(plain)) checkKeys(was[0], item, `${at}${key}[].`);
    }
  }
}

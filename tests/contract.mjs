// The contract between the page and Rust, read from the source on both sides: the commands lib.rs registers with the
// arguments commands.rs takes, the events events.rs sends, and what ui/api.js calls and listens to. contract.test.mjs
// checks the two sides agree; the fake Tauri in page.mjs refuses a call Rust would refuse.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

/** Tauri hands a command's snake_case arguments to the page as camelCase keys. @param {string} name */
const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** Rust's side: each registered command with the argument keys the page must send, and the event names. */
export function rust() {
  const registered = [...read('src-tauri/src/lib.rs').match(/generate_handler!\[([\s\S]*?)\]/)[1].matchAll(/commands::(\w+)/g)]
    .map((m) => m[1]);
  /** @type {Map<string, string[]>} */
  const defined = new Map();
  for (const [, name, params] of read('src-tauri/src/commands.rs').matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([^)]*)\)/g)) {
    const keys = params
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      // Tauri fills these in itself.
      .filter((p) => !/:\s*(State<|AppHandle)/.test(p))
      .map((p) => camel(p.split(':')[0].trim()));
    defined.set(name, keys);
  }
  // The match in `Event::name`.
  const source = read('src-tauri/src/events.rs');
  const names = source.slice(source.indexOf('fn name('), source.indexOf('pub fn emit('));
  const events = [...names.matchAll(/=>\s*"([\w-]+)"/g)].map((m) => m[1]);
  return { registered, defined, events };
}

/** The page's side: each call with the keys it sends, and the events it listens to. */
export function page() {
  const api = read('ui/api.js');
  const calls = [...api.matchAll(/\bcall\('(\w+)'(?:,\s*\{([^}]*)\})?\)/g)].map(([, cmd, keys]) => ({
    cmd,
    keys: (keys ?? '').split(',').map((k) => k.trim()).filter(Boolean),
  }));
  const events = [...api.matchAll(/\bon\('([\w-]+)'/g)].map((m) => m[1]);
  return { calls, events };
}

/**
 * The strings a type in ui/api.js allows: `Type` for a typedef of a union, `Type.property` for a property of an
 * object typedef.
 * @param {string} name
 */
export function pageValues(name) {
  const api = read('ui/api.js');
  const [type, property] = name.split('.');
  const union = property
    ? api
        .match(/\/\*\*[\s\S]*?\*\//g)
        .find((doc) => new RegExp(`@typedef \\{object\\} ${type}\\b`).test(doc))
        ?.match(new RegExp(`@property \\{([^}]*)\\} ${property}\\b`))?.[1]
    : api.match(new RegExp(`@typedef \\{([^}]*)\\} ${type}\\b`))?.[1];
  return [...(union ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
}

/** A file of the page, as text. @param {string} file */
export const pageFile = (file) => read(`ui/${file}`);

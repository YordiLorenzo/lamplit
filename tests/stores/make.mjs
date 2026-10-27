// Makes the store databases the Rust tests read (src-tauri/src/stores/sqlite.rs, amazon.rs, itch.rs), with made-up
// games: amazon.sqlite as the Amazon Games app keeps its installs, and butler.db with its write-ahead log as the itch
// app keeps its own. Run it with Node 24 or newer (node:sqlite) from the repository's root:
//   node tests/stores/make.mjs
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'lamplit-stores-'));

// The Amazon Games app: one table, DbSet, a row per game it knows. The columns are those other launchers read.
{
  const file = path.join(work, 'amazon.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "DbSet" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_DbSet" PRIMARY KEY,
    "InstallDirectory" TEXT NULL,
    "Installed" INTEGER NOT NULL,
    "ProductTitle" TEXT NULL,
    "ProductAsin" TEXT NULL,
    "ManifestSignature" TEXT NULL,
    "ManifestSignatureKeyId" TEXT NULL)`);
  const add = db.prepare('INSERT INTO "DbSet" VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run('amzn1.adg.product.0001', 'C:\\Amazon Games\\Library\\Fennel', 1, 'Fennel™', 'B000000001', 'c2ln', 'key-1');
  add.run('amzn1.adg.product.0002', 'D:\\Games\\Amazon\\Thistle\\', 1, 'Thistle: Remastered', 'B000000002', 'c2ln', 'key-1');
  add.run('amzn1.adg.product.0003', 'C:\\Amazon Games\\Library\\Gone', 0, 'Uninstalled Game', 'B000000003', null, null);
  add.run('amzn1.adg.product.0004', '\\\\nas\\games\\Clover', 1, 'Clover', 'B000000004', null, null);
  db.close();
  copyFileSync(file, path.join(here, 'amazon.sqlite'));
}

// The itch app's butler.db, as butler's ORM (hades) creates its tables, in WAL mode with small pages: the first
// cave is checkpointed into the file, the rest is committed in the log only, and a transaction still under way has
// spilled pages into the log too. Enough games to need interior pages, and a verdict long enough to overflow.
{
  const file = path.join(work, 'butler.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA page_size = 1024; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  db.exec(`CREATE TABLE "install_locations" ("id" TEXT NOT NULL, "path" TEXT, PRIMARY KEY ("id"));
    CREATE TABLE "games" ("id" INTEGER NOT NULL, "url" TEXT, "title" TEXT, "short_text" TEXT, "type" TEXT,
      "classification" TEXT, "cover_url" TEXT, "created_at" DATETIME, "published_at" DATETIME, PRIMARY KEY ("id"));
    CREATE TABLE "caves" ("id" TEXT NOT NULL, "game_id" INTEGER, "external_game_id" INTEGER, "upload_id" INTEGER,
      "build_id" INTEGER, "morphing" BOOLEAN, "pinned" BOOLEAN, "installed_at" DATETIME, "last_touched_at" DATETIME,
      "seconds_run" INTEGER, "local_seconds_run" INTEGER, "local_last_run_at" DATETIME, "snoozed_at" DATETIME,
      "verdict" TEXT, "settings" TEXT, "installed_size" INTEGER, "install_location_id" TEXT,
      "install_folder_name" TEXT, "custom_install_folder" TEXT, PRIMARY KEY ("id"));`);
  const location = db.prepare('INSERT INTO "install_locations" VALUES (?, ?)');
  const game = db.prepare('INSERT INTO "games" ("id", "url", "title", "type", "classification") VALUES (?, ?, ?, ?, ?)');
  const insert = db.prepare(`INSERT INTO "caves" ("id", "game_id", "upload_id", "verdict", "install_location_id",
    "install_folder_name", "custom_install_folder", "installed_size", "settings") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // A cave's settings hold, among others, the launch target the player picked in the app.
  const cave = (id, gameId, uploadId, verdictJson, location, folder, custom, size, settings = '{}') =>
    insert.run(id, gameId, uploadId, verdictJson, location, folder, custom, size, settings);
  const candidate = (p, depth, flavor, size) => ({ path: p, depth, flavor, arch: 'amd64', size });
  const verdict = (basePath, candidates) => JSON.stringify({ basePath, totalSize: 123456789, candidates });

  const apps = 'C:\\Users\\player\\AppData\\Roaming\\itch\\apps';
  location.run('loc-default', apps);
  location.run('loc-share', '\\\\nas\\itch');
  game.run(1001, 'https://example.itch.io/fennel', 'Fennel', 'default', 'game');
  // The game's exe, a bigger crash handler next to it, a tool one folder down, and HTML pages padding the verdict
  // out past one page.
  const padding = Array.from({ length: 40 }, (_, i) => candidate(`docs/page-${i}.html`, 2, 'html', 2000 + i));
  cave('cave-fennel', 1001, 5001, verdict(`${apps}\\fennel`, [
    candidate('Fennel.exe', 1, 'windows', 5000000),
    candidate('UnityCrashHandler64.exe', 1, 'windows', 9000000),
    candidate('tools/editor.exe', 2, 'windows', 20000000),
    ...padding,
  ]), 'loc-default', 'fennel', '', 150000000);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  db.exec('BEGIN');
  game.run(1002, 'https://example.itch.io/thistle-tools', 'Thistle Tools', 'default', 'tool');
  cave('cave-tool', 1002, 5002, verdict(`${apps}\\thistle-tools`, [candidate('thistle.exe', 1, 'windows', 100)]), 'loc-default', 'thistle-tools', '', 100);
  game.run(1003, 'https://example.itch.io/web-toy', 'Web Toy', 'html', 'game');
  cave('cave-web', 1003, 5003, verdict(`${apps}\\web-toy`, [candidate('index.html', 1, 'html', 100)]), 'loc-default', 'web-toy', '', 100);
  game.run(1004, 'https://example.itch.io/clover', 'Clover™', 'default', 'game');
  cave('cave-custom', 1004, 5004, verdict('D:\\Games\\Clover', [candidate('bin/clover.exe', 2, 'windows', 100)]), '', 'clover', 'D:\\Games\\Clover', 100, '{"sandbox":false,"launchTarget":"play"}');
  game.run(1005, 'https://example.itch.io/share-game', 'Share Game', 'default', 'game');
  cave('cave-share', 1005, 5005, verdict('\\\\nas\\itch\\share-game', [candidate('share.exe', 1, 'windows', 100)]), 'loc-share', 'share-game', '', 100);
  for (let id = 2000; id < 2200; id++) game.run(id, `https://example.itch.io/filler-${id}`, `Filler ${id}`, 'default', 'game');
  db.exec('COMMIT');

  // A transaction that hasn't committed: a small cache makes SQLite spill its pages into the log before the commit.
  db.exec('PRAGMA cache_size = 2; BEGIN');
  game.run(1006, 'https://example.itch.io/pending', 'Pending', 'default', 'game');
  cave('cave-pending', 1006, 5006, verdict(`${apps}\\pending`, [candidate('pending.exe', 1, 'windows', 100)]), 'loc-default', 'pending', '', 100);
  for (let id = 3000; id < 3040; id++) game.run(id, `https://example.itch.io/pending-${id}`, `Pending ${'x'.repeat(200)} ${id}`, 'default', 'game');
  copyFileSync(file, path.join(here, 'butler.db'));
  copyFileSync(`${file}-wal`, path.join(here, 'butler.db-wal'));
  db.exec('ROLLBACK');
  db.close();
}
rmSync(work, { recursive: true });

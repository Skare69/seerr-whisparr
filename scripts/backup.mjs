#!/usr/bin/env node
// Consistent online backup of data/velvarr.sqlite via SQLite's VACUUM INTO.
// Never copies live WAL files directly, never exports or prints key material,
// and refuses to overwrite an existing backup. There is deliberately no
// restore-overwrite command: restoring means copying the snapshot into a NEW
// data directory/volume as velvarr.sqlite.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// .env.local supplies runtime config; variables already in the environment win.
function loadEnvLocal(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}
loadEnvLocal(path.join(repoRoot, ".env.local"));

const destinationArg = process.argv[2];
if (!destinationArg) {
  console.error("Usage: npm run backup -- <destination-file>");
  process.exit(1);
}

const source = path.join(
  process.env.VELVARR_DATA_DIR ?? path.join(repoRoot, "data"),
  "velvarr.sqlite",
);
const destination = path.resolve(destinationArg);

if (existsSync(destination)) {
  console.error(`Refusing to overwrite existing backup: ${destination}`);
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(
    `No Velvarr database at ${source} (set VELVARR_DATA_DIR if it lives elsewhere).`,
  );
  process.exit(1);
}

mkdirSync(path.dirname(destination), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true });
try {
  // Wait out a concurrent writer instead of failing the backup with a
  // spurious SQLITE_BUSY while the app holds the write lock for a moment.
  db.exec("PRAGMA busy_timeout = 5000");
  // VACUUM INTO takes a consistent snapshot (WAL included) and fails if the file exists.
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

// Fail loudly rather than report success on a corrupt snapshot.
const copy = new DatabaseSync(destination, { readOnly: true });
try {
  const [row] = copy.prepare("PRAGMA quick_check").all();
  if (row.quick_check !== "ok")
    throw new Error(`quick_check reported: ${row.quick_check}`);
} finally {
  copy.close();
}

if (process.env.VELVARR_SECRET_KEY === undefined) {
  console.error(
    "Warning: VELVARR_SECRET_KEY was not found in the environment or .env.local.",
  );
  console.error(
    "This backup cannot be restored into a working app without the original key.",
  );
}

console.log(`Consistent backup written to ${destination}`);
console.log("Encrypted configuration/sessions live inside this database file.");
console.log("Recovery requirements:");
console.log(
  "  1. The SAME VELVARR_SECRET_KEY from when the backup was taken (never stored in the backup).",
);
console.log(
  "  2. Restore into a NEW data directory/volume only: copy the file in as velvarr.sqlite.",
);
console.log(
  "     Never overwrite a live data directory; there is no restore command here by design.",
);

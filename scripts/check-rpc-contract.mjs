import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(absolutePath) : [absolutePath];
    }),
  );
  return files.flat();
}

function valuesMatching(contents, expression) {
  return new Set([...contents.matchAll(expression)].map((match) => match[1]));
}

const sourceFiles = (await filesUnder(path.join(projectRoot, "src"))).filter(
  (file) =>
    /\.(?:ts|tsx)$/u.test(file) &&
    !file.endsWith(".test.ts") &&
    !file.endsWith(".test.tsx") &&
    !file.includes(`${path.sep}generated${path.sep}`),
);
const migrationFiles = (
  await filesUnder(path.join(projectRoot, "supabase", "migrations"))
).filter((file) => file.endsWith(".sql"));

const sourceContents = (
  await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))
).join("\n");
const migrationContents = (
  await Promise.all(migrationFiles.map((file) => readFile(file, "utf8")))
).join("\n");
const databaseTypes = await readFile(
  path.join(projectRoot, "src", "lib", "supabase", "database.types.ts"),
  "utf8",
);
const functionTypeStart = databaseTypes.indexOf("    Functions: {");
const functionTypeEnd = databaseTypes.indexOf(
  "    Enums: {",
  functionTypeStart,
);
if (functionTypeStart < 0 || functionTypeEnd < 0) {
  throw new Error(
    "Could not locate the generated Supabase Functions contract.",
  );
}

const calledRpcs = valuesMatching(
  sourceContents,
  /\.rpc\s*\(\s*["']([a-z][a-z0-9_]*)["']/gu,
);
const migratedRpcs = valuesMatching(
  migrationContents,
  /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z][a-z0-9_]*)\s*\(/giu,
);
const typedRpcs = valuesMatching(
  databaseTypes.slice(functionTypeStart, functionTypeEnd),
  /^\s{6}([a-z][a-z0-9_]*):\s*\{/gmu,
);

const missingFromMigrations = [...calledRpcs].filter(
  (name) => !migratedRpcs.has(name),
);
const missingFromTypes = [...calledRpcs].filter((name) => !typedRpcs.has(name));

if (missingFromMigrations.length || missingFromTypes.length) {
  if (missingFromMigrations.length) {
    console.error(
      `RPCs called by application code but absent from migrations: ${missingFromMigrations.sort().join(", ")}`,
    );
  }
  if (missingFromTypes.length) {
    console.error(
      `RPCs called by application code but absent from database.types.ts: ${missingFromTypes.sort().join(", ")}`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Verified ${calledRpcs.size} application RPCs against migrations and generated database types.\n`,
  );
}

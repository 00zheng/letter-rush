import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dictionaryPath = path.join(
  projectRoot,
  "dictionary",
  "generated",
  "enable2k-af52415-v1.txt",
);
const input = process.argv[2] ?? "";
const normalized = input.trim().toLowerCase();

if (!/^[a-z]+$/u.test(normalized)) {
  process.stderr.write("Usage: npm run dictionary:lookup -- alphabeticword\n");
  process.exitCode = 2;
} else {
  const words = new Set(
    (await readFile(dictionaryPath, "utf8")).trim().split("\n"),
  );
  const found = words.has(normalized);
  process.stdout.write(
    `${normalized}: ${found ? "accepted" : "not accepted"} (enable2k-af52415-v1)\n`,
  );
  process.exitCode = found ? 0 : 1;
}

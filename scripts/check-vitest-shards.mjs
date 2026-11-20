// Proves that sharded Vitest runs, merged with `vitest --merge-reports`, ran
// every test file Vitest would run unsharded. A shard that was skipped, lost
// its blob, or collected a different file set fails CI instead of passing
// quietly with fewer tests.
//
// Usage: node scripts/check-vitest-shards.mjs <expected-list.json> <merged-report.json>
//   expected-list.json: `vitest list --filesOnly --json=<file>` output
//   merged-report.json: `vitest run --merge-reports --reporter=json` output
import fs from "node:fs";
import path from "node:path";

const [expectedPath, mergedPath] = process.argv.slice(2);
if (!expectedPath || !mergedPath) {
  console.error("Usage: node scripts/check-vitest-shards.mjs <expected-list.json> <merged-report.json>");
  process.exit(2);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const normalise = (file) => path.relative(process.cwd(), path.resolve(file));

const expected = new Set(readJson(expectedPath).map((entry) => normalise(entry.file)));
const merged = readJson(mergedPath);
const ran = new Set(merged.testResults.map((result) => normalise(result.name)));

const missing = [...expected].filter((file) => !ran.has(file)).sort();
const unexpected = [...ran].filter((file) => !expected.has(file)).sort();

if (expected.size === 0) {
  console.error("Vitest listed no test files; refusing to call that complete.");
  process.exit(1);
}
if (missing.length > 0 || unexpected.length > 0) {
  for (const file of missing) console.error(`Not run by any shard: ${file}`);
  for (const file of unexpected) console.error(`Run by a shard but not in the expected list: ${file}`);
  process.exit(1);
}
console.log(`All ${expected.size} test files ran across the shards (${merged.numTotalTests} tests).`);

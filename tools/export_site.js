// Copy the shared modules and measured results into site/ (static, Vercel-ready).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
for (const d of ["site/lib", "site/data"]) mkdirSync(d, { recursive: true });
for (const f of ["estimator.js", "bridge.js", "fxmap.js", "analyze.js", "osc.js"]) cpSync(`core/${f}`, `site/lib/${f}`);
const bench = JSON.parse(readFileSync("results/bench.json", "utf8"));
const e2e = JSON.parse(readFileSync("results/e2e.json", "utf8"));
writeFileSync("site/data/bench.json", JSON.stringify(bench)); writeFileSync("site/data/e2e.json", JSON.stringify(e2e));
cpSync("bridge.example.json", "site/data/bridge.example.json");
console.log("site exported");

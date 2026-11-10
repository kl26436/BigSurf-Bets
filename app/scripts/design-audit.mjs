// Brand-kit audits (SYSTEM.md §11) at budget 0: page CSS may only use semantic
// tokens, components carry no inline styles, and UI copy avoids the banned jargon.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const problems = [];
const css = readFileSync("src/styles/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
css.split("\n").forEach((line, i) => {
  if (/#[0-9a-fA-F]{3,8}\b/.test(line)) problems.push(`app.css:${i + 1} raw hex colour`);
  if (/rgba?\(/.test(line)) problems.push(`app.css:${i + 1} raw rgb()`);
  if (/font-size:\s*[\d.]+(px|rem|em)/.test(line)) problems.push(`app.css:${i + 1} raw font size`);
  if (/border-radius:\s*[\d.]+px/.test(line)) problems.push(`app.css:${i + 1} raw radius`);
  if (/var\(--color-/.test(line)) problems.push(`app.css:${i + 1} primitive colour token (use --semantic-*)`);
});
const BANNED = /\b(moneyline|ML|ATS|O\/U|juice|vig|vigorish|parlay|SGP|units|push|prop|props|futures|bankroll|chalk|slate|proj|ownership|FLEX)\b/;
for (const f of walk("src").filter((f) => f.endsWith(".tsx"))) {
  const src = readFileSync(f, "utf8");
  if (/style=\{\{/.test(src)) problems.push(`${f}: inline style`);
  // user-facing strings: JSX text and string literals passed as copy
  const strings = [...src.matchAll(/>([^<>{}\n]+)</g), ...src.matchAll(/(?:title|why|how|note|label|placeholder|aria-label)[=:]\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const s of strings) {
    const hit = s.match(BANNED);
    if (hit) problems.push(`${f}: "${s.trim().slice(0, 60)}" uses "${hit[0]}"`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("design audit: clean");

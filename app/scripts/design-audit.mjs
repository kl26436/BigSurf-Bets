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
  // Three or more facts strung together with dots wrap in the middle of a fact on a phone:
  // such a line goes through <Facts>, which only breaks between facts. (One-line labels that
  // truncate, and the options of a select, are exempt.)
  src.split("\n").forEach((line, i) => {
    if (/className="[^"]*\b(small|pmeta)\b[^"]*"/.test(line) && !/ellipsis|<option|<Facts/.test(line) && (line.match(/ · /g) ?? []).length >= 2)
      problems.push(`${f}:${i + 1} three or more facts joined by dots — use <Facts>`);
  });
  for (const s of strings) {
    const hit = s.match(BANNED);
    if (hit) problems.push(`${f}: "${s.trim().slice(0, 60)}" uses "${hit[0]}"`);
  }
}
// An SVG served as a file is used through <img> or CSS, where the browser will not load
// anything the SVG links to. The kit's mark links to its figure that way, and the first
// build showed the crest with the figure missing. Draw such marks inline (components/Mark.tsx).
for (const f of walk("public").filter((f) => f.endsWith(".svg"))) {
  if (/(?:xlink:)?href="(?!#|data:)/.test(readFileSync(f, "utf8"))) problems.push(`${f}: links to another file, which will not load when the SVG is used as an image`);
}
for (const f of walk("src").filter((f) => f.endsWith(".tsx"))) {
  if (/<img[^>]+src="[^"]+\.svg"/.test(readFileSync(f, "utf8"))) problems.push(`${f}: SVG loaded with <img> — draw it inline so everything in it renders`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("design audit: clean");

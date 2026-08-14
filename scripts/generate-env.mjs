import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const input = path.join(root, ".env.example");
const output = path.join(root, "src", "env.generated.js");
const text = fs.readFileSync(input, "utf8");
const values = {};
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const idx = line.indexOf("=");
  if (idx < 1) continue;
  const key = line.slice(0, idx).trim();
  let value = line.slice(idx + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values[key] = value;
}
fs.writeFileSync(output, `// AUTO-GENERATED from .env.example. Do not edit manually.\nexport const ENV_DEFAULTS = ${JSON.stringify(values, null, 2)};\n`);
console.log(`Generated ${output} with ${Object.keys(values).length} variables`);

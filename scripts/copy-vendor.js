// Copies the browser builds of third-party libraries into renderer/vendor so the
// UI works fully offline and the packaged app doesn't need node_modules at runtime.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "renderer", "vendor");
const files = {
  "marked.umd.js": "node_modules/marked/lib/marked.umd.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
  "highlight.min.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
};

fs.mkdirSync(out, { recursive: true });
for (const [name, rel] of Object.entries(files)) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    console.warn(`copy-vendor: missing ${rel} (run npm install)`);
    continue;
  }
  fs.copyFileSync(src, path.join(out, name));
}
console.log("copy-vendor: done");

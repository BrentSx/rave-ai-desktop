// electron-builder afterPack hook: trim files a chat client never uses, to shrink
// the distributed app. Runs on the unpacked output before it's compressed.
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  const out = context.appOutDir;
  let freed = 0;
  const rm = (p) => {
    try {
      const s = fs.statSync(p);
      freed += s.isDirectory()
        ? fs.readdirSync(p).reduce((n, f) => n + (fs.statSync(path.join(p, f)).size || 0), 0)
        : s.size;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* not present */ }
  };

  // 1) Keep only the English locale (saves ~48 MB of .pak files).
  const locales = path.join(out, "locales");
  if (fs.existsSync(locales)) {
    for (const f of fs.readdirSync(locales)) {
      if (f.toLowerCase() !== "en-us.pak") rm(path.join(locales, f));
    }
  }

  // 2) Remove big files a text chat UI doesn't need:
  //    - LICENSES.chromium.html: a static legal text file (not used at runtime)
  //    - dxcompiler.dll / dxil.dll: DirectX shader compiler for WebGPU (unused)
  for (const f of ["LICENSES.chromium.html", "dxcompiler.dll", "dxil.dll"]) {
    rm(path.join(out, f));
  }

  console.log(`afterpack: freed ~${(freed / 1e6).toFixed(0)} MB from the package`);
};

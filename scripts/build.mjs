import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const distDir = "dist";
const alias = {
  "node:async_hooks": "./src/shims/async_hooks.ts",
};

async function main() {
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true });
  }

  await mkdir(distDir, { recursive: true });

  await Promise.all([
    build({
      entryPoints: ["src/background/index.ts"],
      outfile: "dist/background.js",
      bundle: true,
      format: "esm",
      target: "chrome121",
      sourcemap: true,
      platform: "browser",
      alias,
    }),
    build({
      entryPoints: ["src/sidepanel/main.ts"],
      outfile: "dist/sidepanel.js",
      bundle: true,
      format: "esm",
      target: "chrome121",
      sourcemap: true,
      platform: "browser",
      alias,
    }),
    build({
      entryPoints: ["src/options/main.ts"],
      outfile: "dist/options.js",
      bundle: true,
      format: "esm",
      target: "chrome121",
      sourcemap: true,
      platform: "browser",
      alias,
    }),
    cp("public/manifest.json", "dist/manifest.json"),
    cp("src/sidepanel/index.html", "dist/sidepanel.html"),
    cp("src/options/index.html", "dist/options.html"),
    cp("src/sidepanel/styles.css", "dist/styles.css"),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

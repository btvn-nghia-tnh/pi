import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(packageDir, "src");
const distDir = join(packageDir, "dist");
const vendorDir = join(packageDir, "vendor");
const exportHtmlVendorDir = resolve(packageDir, "../coding-agent/src/core/export-html/vendor");

mkdirSync(distDir, { recursive: true });

await build({
	entryPoints: [join(srcDir, "main.ts")],
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	sourcemap: true,
	outfile: join(distDir, "pi-web.js"),
	logLevel: "info",
});

cpSync(join(srcDir, "styles", "main.css"), join(distDir, "pi-web.css"));
cpSync(join(packageDir, "index.html"), join(distDir, "index.html"));

mkdirSync(vendorDir, { recursive: true });
cpSync(join(exportHtmlVendorDir, "marked.min.js"), join(vendorDir, "marked.min.js"));
cpSync(join(exportHtmlVendorDir, "highlight.min.js"), join(vendorDir, "highlight.min.js"));
cpSync(vendorDir, join(distDir, "vendor"), { recursive: true });

console.log("pi-web built to", distDir);

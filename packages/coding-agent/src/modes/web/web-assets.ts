/**
 * Static asset serving for the web GUI.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

/**
 * Resolve the built web UI directory.
 *
 * Order: PI_WEB_DIST environment variable, the published layout
 * (`<package>/dist/web`), then the monorepo dev layout
 * (`packages/web/dist`). Throws when nothing exists so `pi web` fails with a
 * clear message instead of serving an empty UI.
 */
export function resolveWebDistDir(): string {
	const envDir = process.env.PI_WEB_DIST;
	if (envDir) {
		return resolvePath(envDir);
	}

	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const packageRoot = resolvePath(moduleDir, "..", "..", "..");

	const publishedDir = join(packageRoot, "dist", "web");
	if (existsSync(publishedDir)) {
		return publishedDir;
	}

	const devDir = resolvePath(packageRoot, "..", "web", "dist");
	if (existsSync(devDir)) {
		return devDir;
	}

	throw new Error(
		`Web UI assets not found. Built layout ${publishedDir} and dev layout ${devDir} are both missing. ` +
			"Build packages/web first (npm --prefix packages/web run build) or set PI_WEB_DIST.",
	);
}

function etagFor(filePath: string): string {
	const stats = statSync(filePath);
	return `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}-${createHash("sha1")
		.update(filePath)
		.digest("hex")
		.slice(0, 8)}"`;
}

/**
 * Serve one static file request from `distDir`. Only GET/HEAD, no traversal,
 * no directory listings. Responds 404 for anything that is not a file.
 */
export function serveStatic(request: IncomingMessage, response: ServerResponse, distDir: string): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { "Content-Type": "text/plain" });
		response.end("Method not allowed");
		return true;
	}

	const url = new URL(request.url ?? "/", "http://localhost");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/" || pathname === "") {
		pathname = "/index.html";
	}

	const filePath = resolvePath(join(distDir, pathname));
	if (filePath !== distDir && !filePath.startsWith(distDir + sep)) {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("Not found");
		return true;
	}

	let stats;
	try {
		stats = statSync(filePath);
	} catch {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("Not found");
		return true;
	}
	if (!stats.isFile()) {
		response.writeHead(404, { "Content-Type": "text/plain" });
		response.end("Not found");
		return true;
	}

	const etag = etagFor(filePath);
	if (request.headers["if-none-match"] === etag) {
		response.writeHead(304);
		response.end();
		return true;
	}

	const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
	const body = readFileSync(filePath);
	response.writeHead(200, {
		"Content-Type": contentType,
		"Content-Length": body.byteLength,
		ETag: etag,
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
	} else {
		response.end(body);
	}
	return true;
}

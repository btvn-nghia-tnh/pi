import assert from "node:assert/strict";
import test from "node:test";
import { EXTENSIONLESS_FILE_NAMES, extensionToLanguage, extractPathCandidates } from "../src/file-refs.ts";

test("extracts absolute, home, dot, and dotdot paths", () => {
	assert.deepEqual(extractPathCandidates("/home/u/p/src/app.ts"), ["/home/u/p/src/app.ts"]);
	assert.deepEqual(extractPathCandidates("check ~/notes/todo.md and /etc/hosts"), ["~/notes/todo.md", "/etc/hosts"]);
	assert.deepEqual(extractPathCandidates("./src/main.ts ../lib/x.js"), ["./src/main.ts", "../lib/x.js"]);
});

test("extracts relative paths containing a slash", () => {
	assert.deepEqual(extractPathCandidates("see src/app.ts, then run tests"), ["src/app.ts"]);
	assert.deepEqual(extractPathCandidates("a/b/c"), ["a/b/c"]);
});

test("extracts known extensionless file names", () => {
	assert.deepEqual(extractPathCandidates("update the Makefile and Dockerfile"), ["Makefile", "Dockerfile"]);
	assert.deepEqual(extractPathCandidates("see AGENTS.md for rules"), ["AGENTS.md"]);
	assert.deepEqual(extractPathCandidates("check .gitignore and .env"), [".gitignore", ".env"]);
});

test("rejects URLs, flags, versions, and plain words", () => {
	assert.deepEqual(extractPathCandidates("visit https://example.com/page"), []);
	assert.deepEqual(extractPathCandidates("doc at http://x.test/a/b.txt"), []);
	assert.deepEqual(extractPathCandidates("--mode=strict"), []);
	assert.deepEqual(extractPathCandidates("version 1.2.3 shipped"), []);
	assert.deepEqual(extractPathCandidates("no paths here"), []);
	assert.deepEqual(extractPathCandidates("3.14 is pi"), []);
});

test("trims surrounding punctuation from candidates", () => {
	assert.deepEqual(extractPathCandidates("(see src/app.ts)"), ["src/app.ts"]);
	assert.deepEqual(extractPathCandidates("fixed `src/app.ts`."), ["src/app.ts"]);
	assert.deepEqual(extractPathCandidates("wrote to foo.txt, then stopped"), ["foo.txt"]);
});

test("dedupes repeated candidates", () => {
	assert.deepEqual(extractPathCandidates("src/app.ts and src/app.ts"), ["src/app.ts"]);
});

test("extensionless name allowlist is the expected set", () => {
	assert.ok(EXTENSIONLESS_FILE_NAMES.has("makefile"));
	assert.ok(EXTENSIONLESS_FILE_NAMES.has(".gitignore"));
	assert.ok(!EXTENSIONLESS_FILE_NAMES.has("index"));
});

test("maps file extensions to highlight languages", () => {
	assert.equal(extensionToLanguage("src/app.ts"), "typescript");
	assert.equal(extensionToLanguage("script.py"), "python");
	assert.equal(extensionToLanguage("styles/main.css"), "css");
	assert.equal(extensionToLanguage("README.md"), "markdown");
	assert.equal(extensionToLanguage("run.sh"), "bash");
	assert.equal(extensionToLanguage("noext"), undefined);
	assert.equal(extensionToLanguage("Dockerfile"), undefined);
});

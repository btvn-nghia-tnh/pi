import assert from "node:assert/strict";
import test from "node:test";
import { retryBannerText } from "../src/footer.ts";

const retry = { attempt: 2, maxAttempts: 5, until: 11_500, errorMessage: "429 rate limit exceeded (upstream)" };

test("retryBannerText counts down, truncates errors to 80 chars", () => {
	assert.equal(
		retryBannerText({ ...retry, until: 12_000 }, 10_000),
		"Retrying (2/5) in 2s — 429 rate limit exceeded (upstream)",
	);
	const long = "x".repeat(120);
	// mandated impl keeps 80 chars then appends "…" — the brief's /x{78}/ arithmetically impossible
	assert.match(retryBannerText({ ...retry, until: 10_100, errorMessage: long }, 10_000), /— x{80}…$/);
});

test("never shows negative seconds", () => {
	assert.match(retryBannerText(retry, 99_000), /in 0s/);
});

test("omits the message segment when errorMessage is missing", () => {
	const bare = { attempt: 1, maxAttempts: 3, until: 5_000 };
	assert.equal(retryBannerText(bare, 0), "Retrying (1/3) in 5s");
	assert.equal(retryBannerText({ ...bare, errorMessage: "" }, 0), "Retrying (1/3) in 5s");
});

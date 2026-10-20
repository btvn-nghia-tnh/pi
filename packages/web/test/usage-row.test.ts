import assert from "node:assert/strict";
import test from "node:test";
import { usageDetails } from "../src/components/usage-row.ts";

const usage = { input: 12400, output: 3100, cacheRead: 8200, cacheWrite: 0, cost: { total: 0.0475 } };

test("usageDetails lists every component row in order", () => {
	assert.deepEqual(usageDetails(usage), [
		["input", "12k"],
		["output", "3.1k"],
		["cache read", "8.2k"],
		["cache write", "0"],
		["cost", "$0.048"],
	]);
});

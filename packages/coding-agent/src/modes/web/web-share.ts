/**
 * UI-free session sharing for the web GUI.
 *
 * Mirrors the interactive-mode share flow (Radius first, GitHub gist fallback)
 * without terminal components. Progress is reported through a notify callback
 * so transports can surface it as toasts/status.
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { getAuthCredential } from "../../cli/auth-command.ts";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";

export interface ShareSessionResult {
	url?: string;
	gistUrl?: string;
	error?: string;
}

/** Export the current branch with presentation metadata for Radius. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) => [
		{
			type: "custom",
			customType: "pi.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	]);
}

async function tryShareViaRadius(
	jsonlFile: string,
	session: AgentSession,
	notify: (message: string, level: "info" | "warning" | "error") => void,
): Promise<ShareSessionResult> {
	const provider = session.modelRuntime.getProvider("radius");
	if (!provider) return {};

	const token = getAuthCredential(await session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }));
	if (!token) return {};

	notify("Uploading to Radius...", "info");
	try {
		const body = fs.readFileSync(jsonlFile);
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		url.searchParams.set("visibility", "organization");
		url.searchParams.set("title", "Pi session");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
		});
		const json = (await response.json().catch(() => null)) as {
			artifact?: { canonical_url: string };
			error?: string;
		} | null;
		if (!response.ok || !json?.artifact) {
			return {
				error: `Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			};
		}
		return { url: json.artifact.canonical_url };
	} catch (error: unknown) {
		return {
			error: `Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

async function shareViaGist(
	htmlFile: string,
	notify: (message: string, level: "info" | "warning" | "error") => void,
): Promise<ShareSessionResult> {
	try {
		const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (authResult.status !== 0) {
			return { error: "GitHub CLI is not logged in. Run 'gh auth login' first." };
		}
	} catch {
		return { error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/" };
	}

	notify("Creating gist...", "info");
	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			const proc = spawn("gh", ["gist", "create", "--public=false", htmlFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (result.code !== 0) {
			return { error: `Failed to create gist: ${result.stderr?.trim() || "Unknown error"}` };
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistUrl || !gistId) {
			return { error: "Failed to parse gist ID from gh output" };
		}

		return { url: getShareViewerUrl(gistId), gistUrl };
	} catch (error: unknown) {
		return { error: `Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}` };
	}
}

/** Share the current session through Radius, falling back to a private gist. */
export async function shareSessionHeadless(
	session: AgentSession,
	notify: (message: string, level: "info" | "warning" | "error") => void,
): Promise<ShareSessionResult> {
	const jsonlFile = path.join(os.tmpdir(), "session.jsonl");
	let htmlFile: string | null = null;

	try {
		try {
			exportSessionForShare(jsonlFile, session);
		} catch (error: unknown) {
			return { error: `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}` };
		}

		const radiusResult = await tryShareViaRadius(jsonlFile, session, notify);
		if (radiusResult.url || radiusResult.error) {
			return radiusResult;
		}

		try {
			htmlFile = path.join(os.tmpdir(), "session.html");
			await session.exportToHtml(htmlFile);
		} catch (error: unknown) {
			return {
				error: `Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
		}
		return await shareViaGist(htmlFile, notify);
	} finally {
		for (const tmpFile of [jsonlFile, htmlFile]) {
			try {
				if (tmpFile !== null) {
					fs.unlinkSync(tmpFile);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}

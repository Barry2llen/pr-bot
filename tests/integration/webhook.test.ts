import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleGitHubWebhook } from "../../src/webhook";

describe("PR bot worker", () => {
	it("returns health status", async () => {
		const response = await SELF.fetch("http://local.test/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects webhook requests without a GitHub signature", async () => {
		const response = await SELF.fetch("http://local.test/webhook", {
			method: "POST",
			body: JSON.stringify({ action: "opened" }),
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe("unauthorized");
	});

	it("ignores signed non pull_request events", async () => {
		const body = JSON.stringify({ action: "created" });
		const response = await SELF.fetch("http://local.test/webhook", {
			method: "POST",
			headers: {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-id",
				"x-hub-signature-256": await signBody(body, "test-secret"),
			},
			body,
		});

		expect(response.status).toBe(202);
		expect(await response.text()).toBe("ignored");
	});

	it("enqueues accepted pull_request events", async () => {
		const body = JSON.stringify({
			action: "opened",
			installation: { id: 42 },
			repository: {
				name: "pr-bot",
				owner: { login: "Barry2llen" },
			},
			pull_request: {
				number: 7,
				draft: false,
				head: { sha: "abc123" },
			},
		});
		const signature = await signBody(body, "test-secret");
		const sentJobs: unknown[] = [];
		const response = await handleGitHubWebhook({
			req: {
				header: (name: string) =>
					({
						"x-github-event": "pull_request",
						"x-github-delivery": "delivery-id",
						"x-hub-signature-256": signature,
					})[name.toLowerCase()],
				raw: {
					text: async () => body,
				},
			},
			env: {
				GITHUB_WEBHOOK_SECRET: "test-secret",
				REVIEW_QUEUE: {
					send: async (job: unknown) => {
						sentJobs.push(job);
					},
				},
			},
			text: (text: string, status: number) => new Response(text, { status }),
		} as never);

		expect(response.status).toBe(202);
		expect(await response.text()).toBe("accepted");
		expect(sentJobs).toEqual([
			{
				installationId: 42,
				owner: "Barry2llen",
				repo: "pr-bot",
				pullNumber: 7,
				headSha: "abc123",
				deliveryId: "delivery-id",
				action: "opened",
			},
		]);
	});
});

async function signBody(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);

	return `sha256=${bytesToHex(new Uint8Array(signature))}`;
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

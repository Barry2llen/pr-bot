import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

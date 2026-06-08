import type { Context } from "hono";
import type { ReviewJob } from "./review-job";

const ACCEPTED_PULL_REQUEST_ACTIONS = new Set([
	"opened",
	"synchronize",
	"reopened",
	"ready_for_review",
]);

type GitHubWebhookContext = Context<{ Bindings: Env }>;

type PullRequestWebhookPayload = {
	action?: string;
	installation?: {
		id?: number;
	};
	repository?: {
		name?: string;
		owner?: {
			login?: string;
		};
	};
	pull_request?: {
		number?: number;
		draft?: boolean;
		head?: {
			sha?: string;
		};
	};
};

export async function handleGitHubWebhook(c: GitHubWebhookContext) {
	const signature = c.req.header("x-hub-signature-256");
	const event = c.req.header("x-github-event");
	const delivery = c.req.header("x-github-delivery");
	const rawBody = await c.req.raw.text();

	if (
		!signature ||
		!signature.startsWith("sha256=") ||
		!(await verifyGitHubSignature(
			rawBody,
			signature,
			c.env.GITHUB_WEBHOOK_SECRET,
		))
	) {
		return c.text("unauthorized", 401);
	}

	let payload: PullRequestWebhookPayload;
	try {
		payload = JSON.parse(rawBody);
	} catch (error) {
		console.error("Invalid GitHub webhook JSON payload", { delivery, error });
		return c.text("ignored", 202);
	}

	if (event !== "pull_request" || !shouldProcessPullRequest(payload)) {
		return c.text("ignored", 202);
	}

	const details = getPullRequestDetails(payload);
	if (!details) {
		console.error("GitHub pull_request webhook payload is missing fields", {
			delivery,
		});
		return c.text("ignored", 202);
	}

	const job: ReviewJob = {
		...details,
		deliveryId: delivery,
		action: payload.action ?? "unknown",
	};
	await c.env.REVIEW_QUEUE.send(job);

	return c.text("accepted", 202);
}

export async function verifyGitHubSignature(
	rawBody: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (!signature.startsWith("sha256=")) {
		return false;
	}

	const expectedHex = signature.slice("sha256=".length);
	if (!/^[0-9a-fA-F]{64}$/.test(expectedHex)) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(rawBody),
	);
	const actual = new Uint8Array(digest);
	const expected = hexToBytes(expectedHex);

	return timingSafeEqual(actual, expected);
}

function shouldProcessPullRequest(payload: PullRequestWebhookPayload): boolean {
	const action = payload.action;
	if (!action || !ACCEPTED_PULL_REQUEST_ACTIONS.has(action)) {
		return false;
	}

	if (payload.pull_request?.draft === true && action !== "ready_for_review") {
		return false;
	}

	return true;
}

function getPullRequestDetails(payload: PullRequestWebhookPayload) {
	const installationId = payload.installation?.id;
	const owner = payload.repository?.owner?.login;
	const repo = payload.repository?.name;
	const pullNumber = payload.pull_request?.number;
	const headSha = payload.pull_request?.head?.sha;

	if (
		typeof installationId !== "number" ||
		!owner ||
		!repo ||
		typeof pullNumber !== "number" ||
		!headSha
	) {
		return undefined;
	}

	return { installationId, owner, repo, pullNumber, headSha };
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

function timingSafeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
	let difference = actual.length ^ expected.length;
	const length = Math.max(actual.length, expected.length);

	for (let index = 0; index < length; index += 1) {
		difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
	}

	return difference === 0;
}

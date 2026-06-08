import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_TRUNCATED_NOTICE, buildReviewableDiff } from "../../src/deepseek";
import { githubRequest, listPullRequestFiles } from "../../src/github";
import {
	buildAiReviewCommentBody,
	processReviewJob,
	type ReviewJobDependencies,
} from "../../src/review-job";
import { handleGitHubWebhook } from "../../src/webhook";

describe("PR bot worker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

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

	it("builds AI review comments with the stable marker", () => {
		const body = buildAiReviewCommentBody({
			pullNumber: 7,
			headSha: "abc123",
			changedFileCount: 2,
			review: [
				"## 🤖 AI PR Review",
				"### Summary",
				"No obvious issues found.",
				"### Issues to Watch",
				"No obvious issues found.",
				"### Suggestions",
				"Keep the current implementation.",
				"### Conclusion",
				"Looks good to proceed.",
			].join("\n"),
		});

		expect(body).toContain("<!-- pr-bot-review -->");
		expect(body).toContain("## 🤖 AI PR Review");
		expect(body).toContain("- PR: #7");
	});

	it("skips unreviewable files when building diff", () => {
		const diff = buildReviewableDiff([
			{
				filename: "package-lock.json",
				status: "modified",
				additions: 1,
				deletions: 1,
				changes: 2,
				patch: "@@ lock @@",
			},
			{
				filename: "src/index.ts",
				status: "modified",
				additions: 2,
				deletions: 0,
				changes: 2,
				patch: "@@ code @@\n+export const ok = true;",
			},
			{
				filename: "dist/app.js",
				status: "modified",
				additions: 2,
				deletions: 0,
				changes: 2,
				patch: "@@ built @@",
			},
		]);

		expect(diff).toContain("src/index.ts");
		expect(diff).not.toContain("package-lock.json");
		expect(diff).not.toContain("dist/app.js");
	});

	it("skips stale review jobs without reading files or updating comments", async () => {
		const listPullRequestFilesMock = vi.fn();
		const generatePullRequestReviewMock = vi.fn();
		const upsertPullRequestCommentMock = vi.fn();
		const deps = {
			createInstallationAccessToken: vi.fn(async () => "installation-token"),
			getPullRequestMetadata: vi.fn(async () => ({
				title: "Fresh PR",
				body: null,
				head: { sha: "current-sha" },
			})),
			listPullRequestFiles: listPullRequestFilesMock,
			generatePullRequestReview: generatePullRequestReviewMock,
			upsertPullRequestComment: upsertPullRequestCommentMock,
			buildReviewableDiff: vi.fn(),
		} satisfies ReviewJobDependencies;
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await processReviewJob(
			{
				installationId: 42,
				owner: "Barry2llen",
				repo: "pr-bot",
				pullNumber: 7,
				headSha: "queued-sha",
				deliveryId: "delivery-id",
				action: "synchronize",
			},
			{} as Env,
			deps,
		);

		expect(logSpy).toHaveBeenCalledWith("Skip stale review job", {
			owner: "Barry2llen",
			repo: "pr-bot",
			pullNumber: 7,
			jobHeadSha: "queued-sha",
			currentHeadSha: "current-sha",
			deliveryId: "delivery-id",
		});
		expect(listPullRequestFilesMock).not.toHaveBeenCalled();
		expect(generatePullRequestReviewMock).not.toHaveBeenCalled();
		expect(upsertPullRequestCommentMock).not.toHaveBeenCalled();
	});

	it("paginates pull request files", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) => ({
			filename: `src/file-${index}.ts`,
			status: "modified",
			additions: 1,
			deletions: 0,
			changes: 1,
		}));
		const secondPage = [
			{
				filename: "src/final.ts",
				status: "added",
				additions: 2,
				deletions: 0,
				changes: 2,
			},
		];
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(firstPage))
			.mockResolvedValueOnce(jsonResponse(secondPage));
		vi.stubGlobal("fetch", fetchMock);

		const files = await listPullRequestFiles(
			"token",
			"Barry2llen",
			"pr-bot",
			7,
		);

		expect(files).toHaveLength(101);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toContain("page=1");
		expect(fetchMock.mock.calls[1]?.[0]).toContain("page=2");
	});

	it("adds a truncation notice when reviewable diff exceeds the limit", () => {
		const diff = buildReviewableDiff([
			{
				filename: "src/large.ts",
				status: "modified",
				additions: 70_000,
				deletions: 0,
				changes: 70_000,
				patch: `@@ large @@\n+${"x".repeat(70_000)}`,
			},
		]);

		expect(diff).toContain(DIFF_TRUNCATED_NOTICE);
	});

	it("truncates long GitHub API error bodies before logging", async () => {
		const longBody = "x".repeat(1500);
		const fetchMock = vi.fn().mockResolvedValue(new Response(longBody, {
			status: 500,
		}));
		vi.stubGlobal("fetch", fetchMock);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(githubRequest("token", "/boom")).rejects.toThrow(
			"GitHub API request failed",
		);

		const logged = errorSpy.mock.calls[0]?.[1] as { body?: string };
		expect(logged.body).toHaveLength(1000);
		expect(logged.body).not.toBe(longBody);
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

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

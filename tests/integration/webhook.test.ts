import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DIFF_TRUNCATED_NOTICE,
	DeepSeekError,
	buildReviewableDiff,
	parseAiReviewResult,
} from "../../src/deepseek";
import { extractReviewableLines } from "../../src/diff-lines";
import {
	createPullRequestReview,
	githubRequest,
	listPullRequestFiles,
} from "../../src/github";
import {
	buildAiReviewCommentBody,
	processReviewJob,
	validateReviewComments,
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
		expect(body).toContain("- Status: `done`");
	});

	it("parses AI review JSON and fenced JSON", () => {
		const plain = parseAiReviewResult(
			JSON.stringify({
				summaryMarkdown: "## Review\n\nNo obvious issues found.",
				comments: [
					{
						path: "src/index.ts",
						line: 3,
						severity: "medium",
						body: "Guard this before use.",
					},
				],
			}),
		);
		const fenced = parseAiReviewResult(
			[
				"```json",
				JSON.stringify({
					summaryMarkdown: "## Review",
					comments: [{ path: "src/a.ts", line: 1, body: "Check this." }],
				}),
				"```",
			].join("\n"),
		);

		expect(plain.comments).toEqual([
			{
				path: "src/index.ts",
				line: 3,
				severity: "medium",
				body: "Guard this before use.",
			},
		]);
		expect(fenced.summaryMarkdown).toBe("## Review");
	});

	it("drops invalid AI review comments and caps the result at five", () => {
		const result = parseAiReviewResult(
			JSON.stringify({
				summaryMarkdown: "## Review",
				comments: [
					{ path: "src/a.ts", line: 1, body: "one" },
					{ path: "src/a.ts", line: "2", body: "invalid line" },
					{ path: "src/a.ts", line: 2, body: "" },
					{ path: "src/a.ts", line: 2, body: "two" },
					{ path: "src/a.ts", line: 3, body: "three" },
					{ path: "src/a.ts", line: 4, body: "four" },
					{ path: "src/a.ts", line: 5, body: "five" },
					{ path: "src/a.ts", line: 6, body: "six" },
				],
			}),
		);

		expect(result.comments).toHaveLength(5);
		expect(result.comments.map((comment) => comment.body)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"five",
		]);
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

	it("extracts reviewable added lines from patch hunks", () => {
		const lines = extractReviewableLines([
			{
				filename: "src/index.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
				changes: 3,
				patch: [
					"@@ -1,3 +1,4 @@",
					" context",
					"+added line",
					"-old line",
					" another context",
					"+second added line",
				].join("\n"),
			},
		]);

		expect(lines).toEqual([
			{ path: "src/index.ts", line: 2, content: "added line" },
			{ path: "src/index.ts", line: 4, content: "second added line" },
		]);
	});

	it("validates inline review comments against reviewable lines", () => {
		const comments = validateReviewComments(
			[
				{ path: "src/index.ts", line: 2, body: " first " },
				{ path: "src/index.ts", line: 2, body: "duplicate" },
				{ path: "src/index.ts", line: 99, body: "bad line" },
				{ path: "src/other.ts", line: 1, body: "bad path" },
				{ path: "src/index.ts", line: 4, body: "x".repeat(2500) },
			],
			[
				{ path: "src/index.ts", line: 2, content: "added line" },
				{ path: "src/index.ts", line: 4, content: "second added line" },
			],
		);

		expect(comments).toEqual([
			{ path: "src/index.ts", line: 2, side: "RIGHT", body: "first" },
			{
				path: "src/index.ts",
				line: 4,
				side: "RIGHT",
				body: "x".repeat(2000),
			},
		]);
	});

	it("skips stale review jobs without reading files or updating comments", async () => {
		const listPullRequestFilesMock = vi.fn();
		const generatePullRequestReviewMock = vi.fn();
		const upsertPullRequestCommentMock = vi.fn();
		const createPullRequestReviewMock = vi.fn();
		const deps = buildReviewJobDependencies({
			getPullRequestMetadata: vi.fn(async () => ({
				title: "Fresh PR",
				body: null,
				head: { sha: "current-sha" },
			})),
			listPullRequestFiles: listPullRequestFilesMock,
			generatePullRequestReview: generatePullRequestReviewMock,
			upsertPullRequestComment: upsertPullRequestCommentMock,
			createPullRequestReview: createPullRequestReviewMock,
		});
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
		expect(createPullRequestReviewMock).not.toHaveBeenCalled();
	});

	it("skips review jobs that already have done state", async () => {
		const deps = buildReviewJobDependencies({
			getReviewState: vi.fn(async () => ({
				status: "done",
				finishedAt: new Date().toISOString(),
			})),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(deps.generatePullRequestReview).not.toHaveBeenCalled();
		expect(deps.listPullRequestFiles).not.toHaveBeenCalled();
	});

	it("skips duplicate in-flight review jobs", async () => {
		const deps = buildReviewJobDependencies({
			getReviewState: vi.fn(async () => ({
				status: "processing",
				startedAt: new Date().toISOString(),
			})),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(deps.generatePullRequestReview).not.toHaveBeenCalled();
		expect(deps.listPullRequestFiles).not.toHaveBeenCalled();
	});

	it("continues stale in-flight review jobs", async () => {
		const deps = buildReviewJobDependencies({
			getReviewState: vi.fn(async () => ({
				status: "processing",
				startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
			})),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(deps.generatePullRequestReview).toHaveBeenCalledTimes(1);
	});

	it("continues retried jobs with the same delivery id while processing", async () => {
		const deps = buildReviewJobDependencies({
			getReviewState: vi.fn(async () => ({
				status: "processing",
				startedAt: new Date().toISOString(),
				deliveryId: "delivery-id",
			})),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(deps.generatePullRequestReview).toHaveBeenCalledTimes(1);
	});

	it("writes processing before DeepSeek and done after creating a pull request review", async () => {
		const calls: string[] = [];
		const deps = buildReviewJobDependencies({
			setReviewProcessing: vi.fn(async () => {
				calls.push("processing");
			}),
			generatePullRequestReview: vi.fn(async () => {
				calls.push("deepseek");
				return buildEnglishReview();
			}),
			upsertPullRequestComment: vi.fn(async ({ body }) => {
				calls.push(
					body.includes("Status: `processing`")
						? "comment:processing"
						: "comment:fallback",
				);
			}),
			createPullRequestReview: vi.fn(async () => {
				calls.push("review");
			}),
			setReviewDone: vi.fn(async () => {
				calls.push("done");
			}),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(calls).toEqual([
			"processing",
			"comment:processing",
			"deepseek",
			"review",
			"done",
		]);
	});

	it("creates pull request reviews with the current head sha and validated comments", async () => {
		const deps = buildReviewJobDependencies({
			generatePullRequestReview: vi.fn(async () => ({
				summaryMarkdown: "## Review\n\n### Summary\nCheck the null handling.",
				comments: [
					{ path: "src/index.ts", line: 1, body: "Valid inline comment." },
					{ path: "src/index.ts", line: 99, body: "Invalid line." },
				],
			})),
			createPullRequestReview: vi.fn(async () => {}),
		});

		await processReviewJob(buildReviewJob(), buildEnv(), deps);

		expect(deps.createPullRequestReview).toHaveBeenCalledWith({
			token: "installation-token",
			owner: "Barry2llen",
			repo: "pr-bot",
			pullNumber: 7,
			commitId: "abc123",
			body: expect.stringContaining("- Inline comments: 1"),
			comments: [
				{
					path: "src/index.ts",
					line: 1,
					side: "RIGHT",
					body: "Valid inline comment.",
				},
			],
		});
		expect(deps.setReviewDone).toHaveBeenCalledTimes(1);
	});

	it("falls back to the ordinary PR comment when GitHub rejects review comments with 422", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("invalid review position", { status: 422 })),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const deps = buildReviewJobDependencies({
			createPullRequestReview,
		});

		await expect(
			processReviewJob(buildReviewJob(), buildEnv(), deps),
		).resolves.toBeUndefined();

		expect(deps.upsertPullRequestComment).toHaveBeenLastCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("<!-- pr-bot-review -->"),
			}),
		);
		expect(deps.setReviewDone).toHaveBeenCalledTimes(1);
	});

	it("marks non-retryable DeepSeek failures as failed without throwing", async () => {
		const deps = buildReviewJobDependencies({
			generatePullRequestReview: vi.fn(async () => {
				throw new DeepSeekError("DeepSeek API request failed", 401, false);
			}),
		});

		await expect(
			processReviewJob(buildReviewJob(), buildEnv(), deps),
		).resolves.toBeUndefined();

		expect(deps.setReviewFailed).toHaveBeenCalledTimes(1);
		expect(deps.upsertPullRequestComment).toHaveBeenLastCalledWith(
			expect.objectContaining({
				body: expect.stringContaining("- Status: `failed`"),
			}),
		);
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

function buildReviewJob() {
	return {
		installationId: 42,
		owner: "Barry2llen",
		repo: "pr-bot",
		pullNumber: 7,
		headSha: "abc123",
		deliveryId: "delivery-id",
		action: "synchronize",
	};
}

function buildEnv(): Env {
	return {
		GITHUB_APP_ID: "123456",
		GITHUB_PRIVATE_KEY: "private-key",
		GITHUB_WEBHOOK_SECRET: "test-secret",
		DEEPSEEK_API_KEY: "deepseek-key",
		DEEPSEEK_MODEL: "deepseek-v4-flash",
		REVIEW_STATE: {
			get: vi.fn(),
			put: vi.fn(),
		} as unknown as KVNamespace,
		REVIEW_QUEUE: {
			send: vi.fn(),
		} as unknown as Queue,
		PORT: "8787",
	};
}

function buildReviewJobDependencies(
	overrides: Partial<ReviewJobDependencies> = {},
): ReviewJobDependencies {
	return {
		createInstallationAccessToken: vi.fn(async () => "installation-token"),
		getPullRequestMetadata: vi.fn(async () => ({
			title: "Fresh PR",
			body: null,
			head: { sha: "abc123" },
		})),
		listPullRequestFiles: vi.fn(async () => [
			{
				filename: "src/index.ts",
				status: "modified",
				additions: 1,
				deletions: 0,
				changes: 1,
				patch: "@@ -0,0 +1,1 @@\n+export const ok = true;",
			},
		]),
		generatePullRequestReview: vi.fn(async () => buildEnglishReview()),
		upsertPullRequestComment: vi.fn(async () => {}),
		createPullRequestReview: vi.fn(async () => {}),
		buildReviewableDiff: vi.fn(() => "@@ -0,0 +1,1 @@\n+export const ok = true;"),
		extractReviewableLines: vi.fn(() => [
			{ path: "src/index.ts", line: 1, content: "export const ok = true;" },
		]),
		getReviewState: vi.fn(async () => undefined),
		setReviewProcessing: vi.fn(async () => {}),
		setReviewDone: vi.fn(async () => {}),
		setReviewFailed: vi.fn(async () => {}),
		...overrides,
	};
}

function buildEnglishReview() {
	return {
		summaryMarkdown: [
			"## Review",
			"### Summary",
			"No obvious issues found.",
			"### Issues to Watch",
			"No obvious issues found.",
			"### Suggestions",
			"Keep the current implementation.",
			"### Conclusion",
			"Looks good to proceed.",
		].join("\n"),
		comments: [
			{
				path: "src/index.ts",
				line: 1,
				body: "Looks good.",
			},
		],
	};
}

import type { ReviewableLine } from "./diff-lines";
import type { PullRequestFile, PullRequestMetadata } from "./github";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_DIFF_CHARS = 60_000;
const MAX_LOG_BODY_CHARS = 1000;
const MAX_REVIEWABLE_LINES_FOR_PROMPT = 300;
const MAX_REVIEWABLE_LINE_CONTENT_CHARS = 160;
const MAX_AI_COMMENTS = 5;
const MAX_AI_COMMENT_BODY_CHARS = 2000;
export const DIFF_TRUNCATED_NOTICE =
	"[Diff truncated: this review only covers the included portion of the PR.]";

type DeepSeekChoice = {
	message?: {
		content?: string;
	};
};

type DeepSeekResponse = {
	choices?: DeepSeekChoice[];
};

export type AiReviewResult = {
	summaryMarkdown: string;
	comments: Array<{
		path: string;
		line: number;
		body: string;
		severity?: "low" | "medium" | "high";
	}>;
};

export class DeepSeekError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly retryable: boolean,
	) {
		super(message);
		this.name = "DeepSeekError";
	}
}

export async function generatePullRequestReview(args: {
	env: Env;
	owner: string;
	repo: string;
	pullNumber: number;
	pullRequest: PullRequestMetadata;
	files: PullRequestFile[];
	diff: string;
	reviewableLines: ReviewableLine[];
}): Promise<AiReviewResult> {
	const { env, owner, repo, pullNumber, pullRequest, files, diff, reviewableLines } =
		args;
	const response = await fetch(DEEPSEEK_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: env.DEEPSEEK_MODEL || DEFAULT_DEEPSEEK_MODEL,
			messages: [
				{
					role: "system",
					content: [
						"You are a PR review bot.",
						"Review only the PR metadata, diff, and REVIEWABLE_LINES provided by the user.",
						"Only create inline comments for lines listed in REVIEWABLE_LINES.",
						"Do not invent line numbers, files, or issues that are not present in the diff.",
						"If there is no concrete issue, return comments: [].",
						"Return at most 5 comments.",
						"Write summaryMarkdown in English Markdown and include these exact sections: ## Review, ### Summary, ### Issues to Watch, ### Suggestions, ### Conclusion.",
						"If there are no obvious issues, explicitly write: No obvious issues found.",
						"Prioritize correctness, security, concurrency, edge cases, and maintainability. Avoid generic style-only suggestions.",
						"Output valid JSON only. Do not wrap the response in markdown fences.",
					].join("\n"),
				},
				{
					role: "user",
					content: buildReviewPrompt({
						owner,
						repo,
						pullNumber,
						pullRequest,
						files,
						diff,
						reviewableLines,
					}),
				},
			],
			thinking: { type: "disabled" },
			temperature: 0.2,
			max_tokens: 2000,
			stream: false,
		}),
	});

	if (!response.ok) {
		const body = await response.text();
		console.error("DeepSeek API request failed", {
			status: response.status,
			body: body.slice(0, MAX_LOG_BODY_CHARS),
		});
		throw new DeepSeekError(
			"DeepSeek API request failed",
			response.status,
			isRetryableDeepSeekStatus(response.status),
		);
	}

	const body = await response.json<DeepSeekResponse>();
	const content = body.choices?.[0]?.message?.content?.trim();
	if (!content) {
		console.error("DeepSeek API response did not include review content");
		throw new DeepSeekError("DeepSeek API response was invalid", 200, false);
	}

	return parseAiReviewResult(content);
}

export function parseAiReviewResult(text: string): AiReviewResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonFence(text));
	} catch {
		throw new DeepSeekError("DeepSeek API response was not valid JSON", 200, false);
	}

	if (!parsed || typeof parsed !== "object") {
		return {
			summaryMarkdown: "## Review\n\nNo summary returned.",
			comments: [],
		};
	}

	const value = parsed as {
		summaryMarkdown?: unknown;
		comments?: unknown;
	};
	const summaryMarkdown =
		typeof value.summaryMarkdown === "string"
			? value.summaryMarkdown
			: "## Review\n\nNo summary returned.";
	const comments = Array.isArray(value.comments)
		? value.comments.flatMap((comment) => sanitizeAiComment(comment))
		: [];

	return {
		summaryMarkdown,
		comments: comments.slice(0, MAX_AI_COMMENTS),
	};
}

export function buildReviewableDiff(files: PullRequestFile[]): string {
	let remaining = MAX_DIFF_CHARS;
	const chunks: string[] = [];
	let truncated = false;

	for (const file of files) {
		if (!shouldReviewFile(file)) {
			continue;
		}

		const header = [
			`### ${file.filename}`,
			`status: ${file.status}, +${file.additions} -${file.deletions}, changes: ${file.changes}`,
			"",
		].join("\n");
		const chunk = `${header}${file.patch}`;
		if (chunk.length > remaining) {
			chunks.push(chunk.slice(0, Math.max(0, remaining)));
			truncated = true;
			break;
		}

		chunks.push(chunk);
		remaining -= chunk.length;
	}

	if (truncated) {
		chunks.push(DIFF_TRUNCATED_NOTICE);
	}

	return chunks.join("\n\n");
}

function buildReviewPrompt(args: {
	owner: string;
	repo: string;
	pullNumber: number;
	pullRequest: PullRequestMetadata;
	files: PullRequestFile[];
	diff: string;
	reviewableLines: ReviewableLine[];
}): string {
	const { owner, repo, pullNumber, pullRequest, files, diff, reviewableLines } =
		args;
	const body = pullRequest.body?.trim() || "(empty)";
	const reviewableDiff =
		diff.trim() ||
		"(No reviewable patch is available. The PR may only contain lock files, dist/build/coverage output, minified files, source maps, or binary files.)";
	const reviewableLineText = buildReviewableLinePrompt(reviewableLines);

	return [
		`Repository: ${owner}/${repo}`,
		`Pull Request: #${pullNumber}`,
		`Title: ${pullRequest.title}`,
		`Body: ${body}`,
		`Head SHA: ${pullRequest.head.sha}`,
		`Changed files: ${files.length}`,
		"",
		"Please review the following diff:",
		"",
		reviewableDiff,
		"",
		"REVIEWABLE_LINES:",
		reviewableLineText,
	].join("\n");
}

function buildReviewableLinePrompt(reviewableLines: ReviewableLine[]): string {
	if (reviewableLines.length === 0) {
		return "(none)";
	}

	return reviewableLines
		.slice(0, MAX_REVIEWABLE_LINES_FOR_PROMPT)
		.map((line) => {
			const content =
				line.content.length > MAX_REVIEWABLE_LINE_CONTENT_CHARS
					? `${line.content.slice(0, MAX_REVIEWABLE_LINE_CONTENT_CHARS)}...`
					: line.content;
			return `- ${line.path}:${line.line} | ${content}`;
		})
		.join("\n");
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return match ? match[1].trim() : trimmed;
}

function sanitizeAiComment(comment: unknown): AiReviewResult["comments"] {
	if (!comment || typeof comment !== "object") {
		return [];
	}

	const value = comment as {
		path?: unknown;
		line?: unknown;
		body?: unknown;
		severity?: unknown;
	};
	if (
		typeof value.path !== "string" ||
		typeof value.line !== "number" ||
		!Number.isInteger(value.line) ||
		typeof value.body !== "string"
	) {
		return [];
	}

	const body = value.body.trim();
	if (!body) {
		return [];
	}

	const result: AiReviewResult["comments"][number] = {
		path: value.path,
		line: value.line,
		body: body.slice(0, MAX_AI_COMMENT_BODY_CHARS),
	};

	if (
		value.severity === "low" ||
		value.severity === "medium" ||
		value.severity === "high"
	) {
		result.severity = value.severity;
	}

	return [result];
}

function shouldReviewFile(file: PullRequestFile): boolean {
	if (!file.patch) {
		return false;
	}

	const filename = file.filename.toLowerCase();
	if (isLockFile(filename) || filename.endsWith(".map")) {
		return false;
	}

	if (/\.min\.(js|css)$/.test(filename)) {
		return false;
	}

	const pathParts = filename.split("/");
	return !pathParts.some((part) =>
		["dist", "build", "coverage"].includes(part),
	);
}

function isLockFile(filename: string): boolean {
	return (
		filename.endsWith("-lock.json") ||
		filename.endsWith(".lock") ||
		[
			"bun.lockb",
			"cargo.lock",
			"composer.lock",
			"gemfile.lock",
			"npm-shrinkwrap.json",
			"pnpm-lock.yaml",
			"poetry.lock",
			"uv.lock",
			"yarn.lock",
		].includes(filename.split("/").at(-1) ?? "")
	);
}

function isRetryableDeepSeekStatus(status: number): boolean {
	if ([400, 401, 402, 403].includes(status)) {
		return false;
	}

	return status === 429 || status >= 500;
}

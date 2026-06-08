import type { PullRequestFile, PullRequestMetadata } from "./github";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_DIFF_CHARS = 60_000;
const MAX_LOG_BODY_CHARS = 1000;
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
}): Promise<string> {
	const { env, owner, repo, pullNumber, pullRequest, files, diff } = args;
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
						"You are a rigorous GitHub Pull Request code review bot.",
						"Review only the PR metadata and diff provided by the user. Do not invent issues that are not present in the diff.",
						"Write the review in English Markdown and include these exact sections: ## Review, ### Summary, ### Issues to Watch, ### Suggestions, ### Conclusion.",
						"If there are no obvious issues, explicitly write: No obvious issues found.",
						"Prioritize correctness, security, concurrency, edge cases, and maintainability. Avoid generic style-only suggestions.",
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
		throw new Error("DeepSeek API response was invalid");
	}

	return content;
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
}): string {
	const { owner, repo, pullNumber, pullRequest, files, diff } = args;
	const body = pullRequest.body?.trim() || "(empty)";
	const reviewableDiff =
		diff.trim() ||
		"(No reviewable patch is available. The PR may only contain lock files, dist/build/coverage output, minified files, source maps, or binary files.)";

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
	].join("\n");
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

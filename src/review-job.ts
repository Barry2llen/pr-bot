import {
	DeepSeekError,
	type AiReviewResult,
	buildReviewableDiff,
	generatePullRequestReview,
} from "./deepseek";
import {
	extractReviewableLines,
	type ReviewableLine,
} from "./diff-lines";
import {
	BOT_COMMENT_MARKER,
	PullRequestReviewUnprocessableError,
	createInstallationAccessToken,
	createPullRequestReview,
	deleteIssueComment,
	getPullRequestMetadata,
	listPullRequestFiles,
	type PullRequestReviewComment,
	upsertPullRequestComment,
} from "./github";
import {
	buildReviewStateKey,
	getReviewState,
	setReviewDone,
	setReviewFailed,
	setReviewProcessing,
	type ReviewState,
} from "./review-state";

export type ReviewJob = {
	installationId: number;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	deliveryId?: string;
	action: string;
};

export type ReviewJobDependencies = {
	createInstallationAccessToken: typeof createInstallationAccessToken;
	getPullRequestMetadata: typeof getPullRequestMetadata;
	listPullRequestFiles: typeof listPullRequestFiles;
	generatePullRequestReview: typeof generatePullRequestReview;
	upsertPullRequestComment: typeof upsertPullRequestComment;
	createPullRequestReview: typeof createPullRequestReview;
	deleteIssueComment: typeof deleteIssueComment;
	buildReviewableDiff: typeof buildReviewableDiff;
	extractReviewableLines: typeof extractReviewableLines;
	getReviewState: typeof getReviewState;
	setReviewProcessing: typeof setReviewProcessing;
	setReviewDone: typeof setReviewDone;
	setReviewFailed: typeof setReviewFailed;
};

const defaultDependencies: ReviewJobDependencies = {
	createInstallationAccessToken,
	getPullRequestMetadata,
	listPullRequestFiles,
	generatePullRequestReview,
	upsertPullRequestComment,
	createPullRequestReview,
	deleteIssueComment,
	buildReviewableDiff,
	extractReviewableLines,
	getReviewState,
	setReviewProcessing,
	setReviewDone,
	setReviewFailed,
};

const PROCESSING_STALE_AFTER_MS = 10 * 60 * 1000;
const FAILED_SKIP_AFTER_MS = 2 * 60 * 1000;

export async function processReviewJob(
	job: ReviewJob,
	env: Env,
	deps: ReviewJobDependencies = defaultDependencies,
): Promise<void> {
	const token = await deps.createInstallationAccessToken(env, job.installationId);
	const pullRequest = await deps.getPullRequestMetadata(
		token,
		job.owner,
		job.repo,
		job.pullNumber,
	);

	if (pullRequest.head.sha && pullRequest.head.sha !== job.headSha) {
		console.log("Skip stale review job", {
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			jobHeadSha: job.headSha,
			currentHeadSha: pullRequest.head.sha,
			deliveryId: job.deliveryId,
		});
		return;
	}

	const stateKey = buildReviewStateKey({
		owner: job.owner,
		repo: job.repo,
		pullNumber: job.pullNumber,
		headSha: job.headSha,
	});
	const reviewState = await deps.getReviewState(env, stateKey);
	if (shouldSkipReviewState(reviewState, job)) {
		return;
	}

	await deps.setReviewProcessing(env, stateKey, job);
	const processingCommentId = await deps.upsertPullRequestComment({
		token,
		owner: job.owner,
		repo: job.repo,
		pullNumber: job.pullNumber,
		body: buildProcessingReviewCommentBody({
			pullNumber: job.pullNumber,
			headSha: pullRequest.head.sha || job.headSha,
		}),
	});

	const files = await deps.listPullRequestFiles(
		token,
		job.owner,
		job.repo,
		job.pullNumber,
	);
	const diff = deps.buildReviewableDiff(files);
	const reviewableLines = deps.extractReviewableLines(files);

	try {
		const review = await deps.generatePullRequestReview({
			env,
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			pullRequest,
			files,
			diff,
			reviewableLines,
		});
		const validatedComments = validateReviewComments(
			review.comments,
			reviewableLines,
		);
		const reviewBody = buildReviewSummaryBody({
			pullNumber: job.pullNumber,
			headSha: pullRequest.head.sha || job.headSha,
			changedFileCount: files.length,
			inlineCommentCount: validatedComments.length,
			review,
		});

		const reviewCreated = await createPullRequestReviewWithFallback({
			deps,
			token,
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			commitId: pullRequest.head.sha || job.headSha,
			body: reviewBody,
			comments: validatedComments,
		});
		await deps.setReviewDone(env, stateKey, job);
		if (reviewCreated) {
			await deps.deleteIssueComment({
				token,
				owner: job.owner,
				repo: job.repo,
				commentId: processingCommentId,
			});
		}
	} catch (error) {
		if (error instanceof DeepSeekError && !error.retryable) {
			await deps.upsertPullRequestComment({
				token,
				owner: job.owner,
				repo: job.repo,
				pullNumber: job.pullNumber,
				body: buildDeepSeekFailureCommentBody(
					job.pullNumber,
					pullRequest.head.sha || job.headSha,
				),
			});
			await deps.setReviewFailed(
				env,
				stateKey,
				job,
				`DeepSeek API request failed with status ${error.status}`,
			);
			return;
		}

		throw error;
	}
}

export function buildAiReviewCommentBody(args: {
	pullNumber: number;
	headSha: string;
	changedFileCount: number;
	review: string | AiReviewResult;
	inlineCommentCount?: number;
}): string {
	return [
		BOT_COMMENT_MARKER,
		buildReviewSummaryBody(args),
	].join("\n");
}

export function buildReviewSummaryBody(args: {
	pullNumber: number;
	headSha: string;
	changedFileCount: number;
	review: string | AiReviewResult;
	inlineCommentCount?: number;
}): string {
	const {
		pullNumber,
		headSha,
		changedFileCount,
		review,
		inlineCommentCount = 0,
	} = args;
	const summary =
		typeof review === "string" ? review.trim() : review.summaryMarkdown.trim();

	return [
		summary || "## Review\n\nNo summary returned.",
		"",
		"---",
		`- PR: #${pullNumber}`,
		`- Head SHA: \`${headSha}\``,
		`- Changed files: ${changedFileCount}`,
		`- Inline comments: ${inlineCommentCount}`,
		"- Status: `done`",
	].join("\n");
}

export function validateReviewComments(
	comments: AiReviewResult["comments"],
	reviewableLines: ReviewableLine[],
): PullRequestReviewComment[] {
	const reviewableSet = new Set(
		reviewableLines.map((line) => `${line.path}:${line.line}`),
	);
	const seen = new Set<string>();
	const validated: PullRequestReviewComment[] = [];

	for (const comment of comments) {
		const key = `${comment.path}:${comment.line}`;
		const body = comment.body.trim();
		if (
			!reviewableSet.has(key) ||
			seen.has(key) ||
			!body ||
			validated.length >= 5
		) {
			continue;
		}

		seen.add(key);
		validated.push({
			path: comment.path,
			line: comment.line,
			side: "RIGHT",
			body: body.slice(0, 2000),
		});
	}

	return validated;
}

async function createPullRequestReviewWithFallback(args: {
	deps: ReviewJobDependencies;
	token: string;
	owner: string;
	repo: string;
	pullNumber: number;
	commitId: string;
	body: string;
	comments: PullRequestReviewComment[];
}): Promise<boolean> {
	const { deps, token, owner, repo, pullNumber, commitId, body, comments } = args;
	try {
		await deps.createPullRequestReview({
			token,
			owner,
			repo,
			pullNumber,
			commitId,
			body,
			comments,
		});
		return true;
	} catch (error) {
		if (!(error instanceof PullRequestReviewUnprocessableError)) {
			throw error;
		}

		await deps.upsertPullRequestComment({
			token,
			owner,
			repo,
			pullNumber,
			body: [BOT_COMMENT_MARKER, body].join("\n"),
		});
		return false;
	}
}

function buildProcessingReviewCommentBody(args: {
	pullNumber: number;
	headSha: string;
}): string {
	return [
		BOT_COMMENT_MARKER,
		"## Review",
		"",
		"AI review is processing...",
		"",
		"---",
		`- PR: #${args.pullNumber}`,
		`- Head SHA: \`${args.headSha}\``,
		"- Status: `processing`",
	].join("\n");
}

function buildDeepSeekFailureCommentBody(
	pullNumber: number,
	headSha: string,
): string {
	return [
		BOT_COMMENT_MARKER,
		"## Review",
		"",
		"AI review failed: configuration, permission, or balance issue.",
		"",
		"---",
		`- PR: #${pullNumber}`,
		`- Head SHA: \`${headSha}\``,
		"- Status: `failed`",
	].join("\n");
}

function shouldSkipReviewState(
	state: ReviewState | undefined,
	job: ReviewJob,
): boolean {
	if (!state) {
		return false;
	}

	if (state.status === "done") {
		console.log("Skip already reviewed head sha", safeReviewStateLog(job));
		return true;
	}

	if (state.status === "processing") {
		if (state.deliveryId && state.deliveryId === job.deliveryId) {
			return false;
		}

		if (Date.now() - Date.parse(state.startedAt) < PROCESSING_STALE_AFTER_MS) {
			console.log("Skip duplicate in-flight review job", safeReviewStateLog(job));
			return true;
		}
		return false;
	}

	if (Date.now() - Date.parse(state.failedAt) < FAILED_SKIP_AFTER_MS) {
		console.log("Skip recently failed review job", safeReviewStateLog(job));
		return true;
	}

	return false;
}

function safeReviewStateLog(job: ReviewJob) {
	return {
		owner: job.owner,
		repo: job.repo,
		pullNumber: job.pullNumber,
		headSha: job.headSha,
		deliveryId: job.deliveryId,
	};
}

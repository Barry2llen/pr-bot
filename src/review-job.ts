import {
	DeepSeekError,
	buildReviewableDiff,
	generatePullRequestReview,
} from "./deepseek";
import {
	BOT_COMMENT_MARKER,
	createInstallationAccessToken,
	getPullRequestMetadata,
	listPullRequestFiles,
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
	buildReviewableDiff: typeof buildReviewableDiff;
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
	buildReviewableDiff,
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
	await deps.upsertPullRequestComment({
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

	try {
		const review = await deps.generatePullRequestReview({
			env,
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			pullRequest,
			files,
			diff,
		});

		await deps.upsertPullRequestComment({
			token,
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			body: buildAiReviewCommentBody({
				pullNumber: job.pullNumber,
				headSha: pullRequest.head.sha || job.headSha,
				changedFileCount: files.length,
				review,
			}),
		});
		await deps.setReviewDone(env, stateKey, job);
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
	review: string;
}): string {
	const { pullNumber, headSha, changedFileCount, review } = args;

	return [
		BOT_COMMENT_MARKER,
		review.trim(),
		"",
		"---",
		`- PR: #${pullNumber}`,
		`- Head SHA: \`${headSha}\``,
		`- Changed files: ${changedFileCount}`,
		"- Status: `done`",
	].join("\n");
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

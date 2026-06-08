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
};

const defaultDependencies: ReviewJobDependencies = {
	createInstallationAccessToken,
	getPullRequestMetadata,
	listPullRequestFiles,
	generatePullRequestReview,
	upsertPullRequestComment,
	buildReviewableDiff,
};

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
	].join("\n");
}

function buildDeepSeekFailureCommentBody(
	pullNumber: number,
	headSha: string,
): string {
	return [
		BOT_COMMENT_MARKER,
		"## 🤖 AI PR Review",
		"",
		"AI 审查失败：配置、权限或余额问题。",
		"",
		"---",
		`- PR: #${pullNumber}`,
		`- Head SHA: \`${headSha}\``,
	].join("\n");
}

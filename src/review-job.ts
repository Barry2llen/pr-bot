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

export async function processReviewJob(job: ReviewJob, env: Env): Promise<void> {
	const token = await createInstallationAccessToken(env, job.installationId);
	const pullRequest = await getPullRequestMetadata(
		token,
		job.owner,
		job.repo,
		job.pullNumber,
	);
	const files = await listPullRequestFiles(
		token,
		job.owner,
		job.repo,
		job.pullNumber,
	);
	const diff = buildReviewableDiff(files);

	try {
		const review = await generatePullRequestReview({
			env,
			owner: job.owner,
			repo: job.repo,
			pullNumber: job.pullNumber,
			pullRequest,
			files,
			diff,
		});

		await upsertPullRequestComment({
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
			await upsertPullRequestComment({
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

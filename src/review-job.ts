import {
	createInstallationAccessToken,
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
	const files = await listPullRequestFiles(
		token,
		job.owner,
		job.repo,
		job.pullNumber,
	);

	await upsertPullRequestComment({
		token,
		owner: job.owner,
		repo: job.repo,
		pullNumber: job.pullNumber,
		headSha: job.headSha,
		files,
	});
}

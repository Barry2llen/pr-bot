import { processReviewJob, type ReviewJob } from "./review-job";

const MAX_RETRY_DELAY_SECONDS = 15 * 60;

export async function handleReviewQueue(
	batch: MessageBatch<ReviewJob>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			await processReviewJob(message.body, env);
			message.ack();
		} catch (error) {
			console.error("Review job failed", {
				messageId: message.id,
				attempts: message.attempts,
				job: safeLogJob(message.body),
				error,
			});
			message.retry({ delaySeconds: getRetryDelaySeconds(message.attempts) });
		}
	}
}

export function getRetryDelaySeconds(attempts: number): number {
	const exponent = Math.max(0, attempts - 1);
	return Math.min(2 ** exponent * 30, MAX_RETRY_DELAY_SECONDS);
}

function safeLogJob(job: ReviewJob) {
	return {
		owner: job.owner,
		repo: job.repo,
		pullNumber: job.pullNumber,
		headSha: job.headSha,
		deliveryId: job.deliveryId,
		action: job.action,
	};
}

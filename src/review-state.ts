import type { ReviewJob } from "./review-job";

const REVIEW_STATE_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_REVIEW_STATE_REASON_CHARS = 500;

export type ReviewState =
	| { status: "processing"; startedAt: string; deliveryId?: string }
	| {
			status: "done";
			startedAt?: string;
			finishedAt: string;
			deliveryId?: string;
	  }
	| {
			status: "failed";
			startedAt?: string;
			failedAt: string;
			deliveryId?: string;
			reason: string;
	  };

export function buildReviewStateKey(args: {
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
}): string {
	return `review:${args.owner}/${args.repo}:${args.pullNumber}:${args.headSha}`;
}

export async function getReviewState(
	env: Env,
	key: string,
): Promise<ReviewState | undefined> {
	try {
		const value = await env.REVIEW_STATE.get(key);
		if (!value) {
			return undefined;
		}

		return JSON.parse(value) as ReviewState;
	} catch (error) {
		console.warn("Review state read failed", { key, error });
		return undefined;
	}
}

export async function setReviewProcessing(
	env: Env,
	key: string,
	job: ReviewJob,
): Promise<void> {
	await putReviewState(env, key, {
		status: "processing",
		startedAt: new Date().toISOString(),
		deliveryId: job.deliveryId,
	});
}

export async function setReviewDone(
	env: Env,
	key: string,
	job: ReviewJob,
): Promise<void> {
	await putReviewState(env, key, {
		status: "done",
		finishedAt: new Date().toISOString(),
		deliveryId: job.deliveryId,
	});
}

export async function setReviewFailed(
	env: Env,
	key: string,
	job: ReviewJob,
	reason: string,
): Promise<void> {
	await putReviewState(env, key, {
		status: "failed",
		failedAt: new Date().toISOString(),
		deliveryId: job.deliveryId,
		reason: reason.slice(0, MAX_REVIEW_STATE_REASON_CHARS),
	});
}

async function putReviewState(
	env: Env,
	key: string,
	state: ReviewState,
): Promise<void> {
	try {
		await env.REVIEW_STATE.put(key, JSON.stringify(state), {
			expirationTtl: REVIEW_STATE_TTL_SECONDS,
		});
	} catch (error) {
		console.warn("Review state write failed", {
			key,
			status: state.status,
			error,
		});
	}
}

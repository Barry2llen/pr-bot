export type Env = {
	REVIEW_QUEUE: Queue;
	REVIEW_STATE: KVNamespace;
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	DEEPSEEK_API_KEY: string;
	DEEPSEEK_MODEL?: string;
	PORT: string;
};

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

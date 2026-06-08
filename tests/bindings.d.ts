export type Env = {
	GITHUB_APP_ID: string;
	GITHUB_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
};

declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {}
}

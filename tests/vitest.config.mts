import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	esbuild: {
		target: "esnext",
	},
	test: {
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: {
					configPath: "../wrangler.toml",
				},
				miniflare: {
					bindings: {
						GITHUB_APP_ID: "123456",
						GITHUB_WEBHOOK_SECRET: "test-secret",
						GITHUB_PRIVATE_KEY:
							"-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----",
						DEEPSEEK_API_KEY: "test-deepseek-key",
						DEEPSEEK_MODEL: "deepseek-v4-flash",
					},
					queueProducers: {
						REVIEW_QUEUE: "pr-bot-review",
					},
					queueConsumers: {
						"pr-bot-review": {
							maxBatchSize: 1,
							maxBatchTimeout: 5,
						},
					},
					kvNamespaces: ["REVIEW_STATE"],
				},
			},
		},
	},
});

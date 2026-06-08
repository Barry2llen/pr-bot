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
					configPath: "../wrangler.jsonc",
				},
				miniflare: {
					bindings: {
						GITHUB_APP_ID: "123456",
						GITHUB_WEBHOOK_SECRET: "test-secret",
						GITHUB_PRIVATE_KEY:
							"-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----",
					},
				},
			},
		},
	},
});

import { Hono } from "hono";
import { handleGitHubWebhook } from "./webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

app.post("/webhook", async (c) => {
	try {
		return await handleGitHubWebhook(c);
	} catch (error) {
		console.error("Webhook handler failed:", error);
		return c.text("internal server error", 500);
	}
});

export default app;

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const devVarsPath = join(process.cwd(), ".dev.vars");
const vars = existsSync(devVarsPath) ? parseDevVars(readFileSync(devVarsPath, "utf8")) : {};
const port = vars.PORT?.trim();
const args = ["dev"];

if (port) {
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		console.error(`Invalid PORT in .dev.vars: ${port}`);
		process.exit(1);
	}

	args.push("--port", port);
}

if (process.argv.includes("--print-command")) {
	console.log(["wrangler", ...args].join(" "));
	process.exit(0);
}

const wranglerBin = join(
	process.cwd(),
	"node_modules",
	".bin",
	process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
const child = spawn(wranglerBin, args, {
	stdio: "inherit",
	env: process.env,
	shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exit(code ?? 1);
});

function parseDevVars(content) {
	const result = {};

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const separatorIndex = line.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		let value = line.slice(separatorIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		result[key] = value;
	}

	return result;
}

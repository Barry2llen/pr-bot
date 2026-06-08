export type PullRequestFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
};

type GitHubComment = {
	id: number;
	body?: string;
};

const GITHUB_API_BASE = "https://api.github.com";
const BOT_COMMENT_MARKER = "<!-- pr-bot-review -->";

export async function createInstallationAccessToken(
	env: Env,
	installationId: number,
): Promise<string> {
	const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
	const response = await fetch(
		`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "pr-bot-worker",
			},
		},
	);

	if (!response.ok) {
		const body = await response.text();
		console.error("GitHub installation token request failed", {
			status: response.status,
			body,
		});
		throw new Error("GitHub installation token request failed");
	}

	const body = await response.json<{ token?: string }>();
	if (!body.token) {
		console.error("GitHub installation token response did not include a token");
		throw new Error("GitHub installation token response was invalid");
	}

	return body.token;
}

export async function githubRequest<T>(
	token: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("Accept", "application/vnd.github+json");
	headers.set("X-GitHub-Api-Version", "2022-11-28");
	headers.set("User-Agent", "pr-bot-worker");

	const response = await fetch(`${GITHUB_API_BASE}${path}`, {
		...init,
		headers,
	});

	if (!response.ok) {
		const body = await response.text();
		console.error("GitHub API request failed", {
			status: response.status,
			body,
			path,
		});
		throw new Error("GitHub API request failed");
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return response.json<T>();
}

export async function listPullRequestFiles(
	token: string,
	owner: string,
	repo: string,
	pullNumber: number,
): Promise<PullRequestFile[]> {
	return githubRequest<PullRequestFile[]>(
		token,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files?per_page=100`,
	);
}

export async function upsertPullRequestComment(args: {
	token: string;
	owner: string;
	repo: string;
	pullNumber: number;
	headSha: string;
	files: PullRequestFile[];
}): Promise<void> {
	const { token, owner, repo, pullNumber, headSha, files } = args;
	const commentsBasePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`;
	const comments = await githubRequest<GitHubComment[]>(
		token,
		`${commentsBasePath}?per_page=100`,
	);
	const existingComment = comments.find((comment) =>
		comment.body?.includes(BOT_COMMENT_MARKER),
	);
	const body = buildPullRequestCommentBody(pullNumber, headSha, files);

	if (existingComment) {
		await githubRequest<void>(
			token,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existingComment.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ body }),
			},
		);
		return;
	}

	await githubRequest<void>(token, commentsBasePath, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
}

export function buildPullRequestCommentBody(
	pullNumber: number,
	headSha: string,
	files: PullRequestFile[],
): string {
	const fileLines = files.map(
		(file) =>
			`- \`${file.filename}\` — ${file.status}, +${file.additions} -${file.deletions}`,
	);

	return [
		BOT_COMMENT_MARKER,
		"## 🤖 PR Bot",
		"",
		"收到 PR 更新，最小闭环已跑通。",
		"",
		`- PR: #${pullNumber}`,
		`- Head SHA: \`${headSha}\``,
		`- Changed files: ${files.length}`,
		"",
		"### Files",
		...fileLines,
	].join("\n");
}

async function createGitHubAppJwt(
	appId: string,
	privateKeyPem: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		iss: appId,
		iat: now - 60,
		exp: now + 9 * 60,
	};
	const encodedHeader = base64UrlEncodeJson(header);
	const encodedPayload = base64UrlEncodeJson(payload);
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const key = await importPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);

	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
	const { label, der } = parsePem(privateKeyPem);
	const pkcs8Der = label === "RSA PRIVATE KEY" ? wrapPkcs1InPkcs8(der) : der;

	return crypto.subtle.importKey(
		"pkcs8",
		pkcs8Der,
		{
			name: "RSASSA-PKCS1-v1_5",
			hash: "SHA-256",
		},
		false,
		["sign"],
	);
}

function parsePem(pem: string): { label: string; der: ArrayBuffer } {
	const match = pem.match(
		/-----BEGIN ([A-Z ]+)-----\s*([\s\S]+?)\s*-----END \1-----/,
	);
	if (!match) {
		throw new Error("Invalid private key PEM");
	}

	const base64 = match[2].replace(/\s/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return { label: match[1], der: toArrayBuffer(bytes) };
}

function wrapPkcs1InPkcs8(pkcs1Der: ArrayBuffer): ArrayBuffer {
	const rsaEncryptionOid = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	]);
	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const privateKey = encodeDer(0x04, new Uint8Array(pkcs1Der));
	const sequence = concatBytes(version, rsaEncryptionOid, privateKey);

	return toArrayBuffer(encodeDer(0x30, sequence));
}

function encodeDer(tag: number, value: Uint8Array): Uint8Array {
	return concatBytes(new Uint8Array([tag]), encodeDerLength(value.length), value);
}

function encodeDerLength(length: number): Uint8Array {
	if (length < 0x80) {
		return new Uint8Array([length]);
	}

	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining & 0xff);
		remaining >>= 8;
	}

	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
	const length = arrays.reduce((total, array) => total + array.length, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.length;
	}

	return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function base64UrlEncodeJson(value: unknown): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

import type { PullRequestFile } from "./github";

export type ReviewableLine = {
	path: string;
	line: number;
	content: string;
};

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function extractReviewableLines(
	files: PullRequestFile[],
): ReviewableLine[] {
	const lines: ReviewableLine[] = [];

	for (const file of files) {
		if (!file.patch) {
			continue;
		}

		let newLine: number | undefined;
		for (const patchLine of file.patch.split("\n")) {
			const hunkMatch = patchLine.match(HUNK_HEADER_REGEX);
			if (hunkMatch) {
				newLine = Number(hunkMatch[2]);
				continue;
			}

			if (newLine === undefined) {
				continue;
			}

			if (patchLine.startsWith("+++") || patchLine.startsWith("\\ No newline")) {
				continue;
			}

			if (patchLine.startsWith("+")) {
				lines.push({
					path: file.filename,
					line: newLine,
					content: patchLine.slice(1),
				});
				newLine += 1;
				continue;
			}

			if (patchLine.startsWith("-")) {
				continue;
			}

			newLine += 1;
		}
	}

	return lines;
}

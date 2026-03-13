import * as vscode from 'vscode';
import { SearchResultPreview } from './searchTypes';

const PREVIEW_MAX_LINES = 100;
const MAX_PREVIEW_FILE_SIZE_BYTES = 1024 * 1024;
const PREVIEW_UNAVAILABLE_TEXT = 'Preview unavailable for this file.';

export type PreviewCache = Map<string, Promise<string[] | undefined>>;

const decoder = new TextDecoder('utf-8');

export async function buildFilePreview(uri: vscode.Uri, previewCache: PreviewCache): Promise<SearchResultPreview[]> {
	const lines = await loadTextLines(uri, previewCache);
	if (!lines) {
		return unavailablePreview(false);
	}

	if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
		return [
			{
				lineNumber: 1,
				text: '(empty file)',
				isMatch: false
			}
		];
	}

	const end = Math.min(lines.length, PREVIEW_MAX_LINES);
	return lines.slice(0, end).map((text, index) => ({
		lineNumber: index + 1,
		text,
		isMatch: false
	}));
}

export async function buildLinePreview(
	uri: vscode.Uri,
	lineNumber: number,
	lineText: string,
	previewCache: PreviewCache
): Promise<SearchResultPreview[]> {
	const lines = await loadTextLines(uri, previewCache);
	if (!lines || lines.length === 0) {
		return unavailablePreview(true, lineNumber, lineText);
	}

	const matchLineIndex = Math.min(Math.max(0, lineNumber - 1), lines.length - 1);

	if (lines.length <= PREVIEW_MAX_LINES) {
		return lines.map((text, index) => ({
			lineNumber: index + 1,
			text,
			isMatch: index === matchLineIndex
		}));
	}

	// Window around the match line
	const half = Math.floor(PREVIEW_MAX_LINES / 2);
	let start = matchLineIndex - half;
	let end = matchLineIndex + half;
	if (start < 0) {
		end = Math.min(lines.length, end - start);
		start = 0;
	} else if (end > lines.length) {
		start = Math.max(0, start - (end - lines.length));
		end = lines.length;
	}

	return lines.slice(start, end).map((text, index) => ({
		lineNumber: start + index + 1,
		text,
		isMatch: start + index === matchLineIndex
	}));
}

async function loadTextLines(
	uri: vscode.Uri,
	previewCache: PreviewCache
): Promise<string[] | undefined> {
	const cacheKey = uri.toString();
	const cached = previewCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const loader = (async () => {
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_PREVIEW_FILE_SIZE_BYTES) {
				return undefined;
			}

			const bytes = await vscode.workspace.fs.readFile(uri);
			if (isProbablyBinary(bytes)) {
				return undefined;
			}

			return decoder.decode(bytes).replace(/\r\n?/g, '\n').split('\n');
		} catch {
			return undefined;
		}
	})();

	previewCache.set(cacheKey, loader);
	return loader;
}

function unavailablePreview(
	isMatch: boolean,
	lineNumber = 1,
	text = PREVIEW_UNAVAILABLE_TEXT
): SearchResultPreview[] {
	return [
		{
			lineNumber,
			text,
			isMatch
		}
	];
}

function isProbablyBinary(bytes: Uint8Array): boolean {
	const sampleLength = Math.min(bytes.length, 512);
	let suspicious = 0;

	for (let index = 0; index < sampleLength; index += 1) {
		const value = bytes[index];
		if (value === 0) {
			return true;
		}

		if (value < 7 || (value > 14 && value < 32 && value !== 9 && value !== 10 && value !== 13)) {
			suspicious += 1;
		}
	}

	return suspicious / Math.max(1, sampleLength) > 0.3;
}

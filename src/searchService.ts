import * as vscode from 'vscode';
import { FffProcess, FffSearchResult } from './fffProcess';
import { SearchResponse, SearchResult, SearchResultPreview } from './searchTypes';

const DEFAULT_RESULT_LIMIT = 80;
const PREVIEW_MAX_LINES = 100;
const MAX_PREVIEW_FILE_SIZE_BYTES = 1024 * 1024;
const RESCAN_DEBOUNCE_MS = 250;
const SCAN_REFRESH_DELAY_MS = 350;
const PREVIEW_UNAVAILABLE_TEXT = 'Preview unavailable for this file.';

type PreviewCache = Map<string, Promise<string[] | undefined>>;

export class SearchService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	private sidecar?: FffProcess;
	private rescanTimer?: NodeJS.Timeout;
	private refreshTimer?: NodeJS.Timeout;
	private disposed = false;
	private lastQuery = '';

	public readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly extensionUri: vscode.Uri) {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.disposables.push(
			this.onDidChangeEmitter,
			watcher,
			watcher.onDidCreate(() => this.scheduleRescan()),
			watcher.onDidChange(() => this.scheduleRescan()),
			watcher.onDidDelete(() => this.scheduleRescan()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				void this.restartSidecar();
			})
		);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.clearTimers();
		this.sidecar?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	public async search(
		query: string,
		caseSensitive = false,
		regexEnabled = false,
		resultLimit = DEFAULT_RESULT_LIMIT
	): Promise<SearchResponse> {
		if (this.disposed) {
			throw new Error('Search service is disposed.');
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			throw new Error('Open a folder or workspace before using Modal Find.');
		}

		const startedAt = Date.now();
		this.lastQuery = query;

		try {
			const response = await (await this.ensureSidecar()).search(
				query,
				resultLimit,
				getCurrentFilePath(),
				caseSensitive,
				regexEnabled
			);

			if (this.disposed) {
				throw new Error('Search service is disposed.');
			}

			if (response.isScanning) {
				this.scheduleRefresh();
			} else {
				this.clearRefreshTimer();
			}

			const previewCache: PreviewCache = new Map();
			const results = await Promise.all(
				response.results.map((result) => this.toSearchResult(result, previewCache))
			);

			return {
				query,
				results,
				indexedFileCount: response.indexedFileCount,
				searchableFileCount: response.searchableFileCount,
				skippedFileCount: response.skippedFileCount,
				durationMs: Date.now() - startedAt
			};
		} catch (error) {
			this.sidecar?.dispose();
			this.sidecar = undefined;
			throw error;
		}
	}

	private async ensureSidecar(): Promise<FffProcess> {
		if (this.disposed) {
			throw new Error('Search service is disposed.');
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			throw new Error('Open a folder or workspace before using Modal Find.');
		}

		if (this.sidecar?.isAlive()) {
			return this.sidecar;
		}

		this.sidecar?.dispose();
		const nextSidecar = new FffProcess(this.extensionUri);
		await nextSidecar.init(vscode.workspace.workspaceFolders.map((folder) => folder.uri.fsPath));
		this.sidecar = nextSidecar;
		return nextSidecar;
	}

	private async restartSidecar(): Promise<void> {
		if (this.disposed) {
			return;
		}

		this.sidecar?.dispose();
		this.sidecar = undefined;
		this.clearTimers();

		if (vscode.workspace.workspaceFolders?.length) {
			try {
				await this.ensureSidecar();
			} catch {
				// Surface the error on the next explicit search request.
			}
		}

		if (!this.disposed) {
			this.onDidChangeEmitter.fire();
		}
	}

	private scheduleRescan(): void {
		if (this.disposed || !this.sidecar) {
			return;
		}

		if (this.rescanTimer) {
			clearTimeout(this.rescanTimer);
		}

		this.rescanTimer = setTimeout(() => {
			this.rescanTimer = undefined;
			void this.runRescan();
		}, RESCAN_DEBOUNCE_MS);
	}

	private async runRescan(): Promise<void> {
		if (this.disposed || !this.sidecar) {
			return;
		}

		try {
			await this.sidecar.rescan();
			this.scheduleRefresh();
		} catch {
			this.sidecar.dispose();
			this.sidecar = undefined;
		}

		if (!this.disposed) {
			this.onDidChangeEmitter.fire();
		}
	}

	private scheduleRefresh(): void {
		if (this.disposed) {
			return;
		}

		this.clearRefreshTimer();
		this.refreshTimer = setTimeout(() => {
			if (this.disposed) {
				return;
			}

			this.refreshTimer = undefined;
			this.onDidChangeEmitter.fire();
		}, SCAN_REFRESH_DELAY_MS);
	}

	private clearRefreshTimer(): void {
		if (!this.refreshTimer) {
			return;
		}

		clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private clearTimers(): void {
		if (this.rescanTimer) {
			clearTimeout(this.rescanTimer);
			this.rescanTimer = undefined;
		}

		this.clearRefreshTimer();
	}

	private async toSearchResult(
		result: FffSearchResult,
		previewCache: PreviewCache
	): Promise<SearchResult> {
		const uri = vscode.Uri.file(result.path);
		const relativePath = vscode.workspace.asRelativePath(uri, true);

		if (result.kind === 'file') {
			return {
				id: `${result.path}::file`,
				kind: 'file',
				score: result.score,
				uri,
				relativePath,
				title: relativePath,
				subtitle: 'Path match',
				lineNumber: 1,
				column: 1,
				preview: await buildFilePreview(uri, previewCache)
			};
		}

		return {
			id: `${result.path}::${result.lineNumber}:${result.column}`,
			kind: 'line',
			score: result.score,
			uri,
			relativePath,
			title: relativePath,
			subtitle: `${result.lineNumber}:${result.column}  ${result.lineText.trim() || '(blank line)'}`,
			lineNumber: result.lineNumber,
			column: result.column,
			preview: await buildLinePreview(uri, result.lineNumber, result.lineText, previewCache)
		};
	}
}

const decoder = new TextDecoder('utf-8');

async function buildFilePreview(uri: vscode.Uri, previewCache: PreviewCache): Promise<SearchResultPreview[]> {
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

async function buildLinePreview(
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

function getCurrentFilePath(): string | undefined {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' ? uri.fsPath : undefined;
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

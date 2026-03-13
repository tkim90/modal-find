import * as vscode from 'vscode';
import { traceLifecycle } from './debug';
import { FffProcess, FffSearchResult } from './fffProcess';
import { SearchResponse, SearchResult, SearchResultPreview } from './searchTypes';

const DEFAULT_RESULT_LIMIT = 160;
const PREVIEW_MAX_LINES = 100;
const MAX_PREVIEW_FILE_SIZE_BYTES = 1024 * 1024;
const RESCAN_DEBOUNCE_MS = 250;
const PREVIEW_UNAVAILABLE_TEXT = 'Preview unavailable for this file.';

type PreviewCache = Map<string, Promise<string[] | undefined>>;

export class SearchService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	private sidecar?: FffProcess;
	private sidecarInitPromise?: Promise<FffProcess>;
	private watcher?: vscode.FileSystemWatcher;
	private rescanTimer?: NodeJS.Timeout;
	private disposed = false;
	private searchCount = 0;
	private warmupCount = 0;

	public readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly extensionUri: vscode.Uri) {
		this.disposables.push(
			this.onDidChangeEmitter,
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
		this.sidecarInitPromise = undefined;
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
		const searchNumber = ++this.searchCount;
		traceLifecycle('search.query.start', {
			searchNumber,
			firstQuery: searchNumber === 1,
			queryLength: query.length,
			caseSensitive,
			regexEnabled,
			resultLimit
		});

		try {
			const response = await (await this.ensureSidecar('search')).search(
				query,
				resultLimit,
				getCurrentFilePath(),
				caseSensitive,
				regexEnabled
			);

			if (this.disposed) {
				throw new Error('Search service is disposed.');
			}

			const previewCache: PreviewCache = new Map();
			const results = await Promise.all(
				response.results.map((result) => this.toSearchResult(result, previewCache))
			);

			const searchResponse = {
				query,
				results,
				indexedFileCount: response.indexedFileCount,
				searchableFileCount: response.searchableFileCount,
				skippedFileCount: response.skippedFileCount,
				durationMs: Date.now() - startedAt
			};
			traceLifecycle('search.query.end', {
				searchNumber,
				firstQuery: searchNumber === 1,
				durationMs: searchResponse.durationMs,
				resultCount: searchResponse.results.length,
				indexedFileCount: searchResponse.indexedFileCount,
				searchableFileCount: searchResponse.searchableFileCount,
				skippedFileCount: searchResponse.skippedFileCount
			});
			return searchResponse;
		} catch (error) {
			if (this.sidecar && !this.sidecar.isAlive()) {
				this.sidecar.dispose();
				this.sidecar = undefined;
			}
			traceLifecycle('search.query.error', {
				searchNumber,
				firstQuery: searchNumber === 1,
				durationMs: Date.now() - startedAt,
				error: toErrorMessage(error)
			});
			throw error;
		}
	}

	public async warmup(source = 'unknown'): Promise<void> {
		if (this.disposed || !vscode.workspace.workspaceFolders?.length) {
			traceLifecycle('search.warmup.skipped', {
				source,
				reason: this.disposed ? 'disposed' : 'noWorkspace'
			});
			return;
		}

		const warmupNumber = ++this.warmupCount;
		const startedAt = Date.now();
		traceLifecycle('search.warmup.start', {
			source,
			warmupNumber
		});

		try {
			await this.ensureSidecar(`warmup:${source}`);
			traceLifecycle('search.warmup.end', {
				source,
				warmupNumber,
				durationMs: Date.now() - startedAt
			});
		} catch (error) {
			traceLifecycle('search.warmup.error', {
				source,
				warmupNumber,
				durationMs: Date.now() - startedAt,
				error: toErrorMessage(error)
			});
			// Surface startup issues on the next explicit search request.
		}
	}

	private async ensureSidecar(reason: string): Promise<FffProcess> {
		if (this.disposed) {
			throw new Error('Search service is disposed.');
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			throw new Error('Open a folder or workspace before using Modal Find.');
		}
		const workspaceFolders = vscode.workspace.workspaceFolders;

		if (this.sidecar?.isAlive()) {
			traceLifecycle('sidecar.ready.reuse', {
				reason
			});
			return this.sidecar;
		}

		if (this.sidecarInitPromise) {
			traceLifecycle('sidecar.init.awaitExisting', {
				reason
			});
			return this.sidecarInitPromise;
		}

		this.sidecar?.dispose();
		const nextSidecar = new FffProcess(this.extensionUri);
		const startedAt = Date.now();
		traceLifecycle('sidecar.init.start', {
			reason,
			workspaceFolderCount: workspaceFolders.length
		});
		const initPromise = (async () => {
			try {
				await nextSidecar.init(workspaceFolders.map((folder) => folder.uri.fsPath));
				if (this.disposed) {
					nextSidecar.dispose();
					throw new Error('Search service is disposed.');
				}

				this.sidecar = nextSidecar;
				this.ensureWatcher();
				traceLifecycle('sidecar.init.ready', {
					reason,
					durationMs: Date.now() - startedAt
				});
				return nextSidecar;
			} catch (error) {
				nextSidecar.dispose();
				if (this.sidecar === nextSidecar) {
					this.sidecar = undefined;
				}
				traceLifecycle('sidecar.init.error', {
					reason,
					durationMs: Date.now() - startedAt,
					error: toErrorMessage(error)
				});
				throw error;
			}
		})();

		this.sidecarInitPromise = initPromise;
		void initPromise.finally(() => {
			if (this.sidecarInitPromise === initPromise) {
				this.sidecarInitPromise = undefined;
			}
		});

		return initPromise;
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
				await this.ensureSidecar('restart');
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
		} catch {
			this.sidecar.dispose();
			this.sidecar = undefined;
		}

		if (!this.disposed) {
			this.onDidChangeEmitter.fire();
		}
	}

	private clearTimers(): void {
		if (this.rescanTimer) {
			clearTimeout(this.rescanTimer);
			this.rescanTimer = undefined;
		}
	}

	private ensureWatcher(): void {
		if (this.disposed || this.watcher) {
			return;
		}

		const watcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.watcher = watcher;
		this.disposables.push(
			watcher,
			watcher.onDidCreate(() => this.scheduleRescan()),
			watcher.onDidChange(() => this.scheduleRescan()),
			watcher.onDidDelete(() => this.scheduleRescan())
		);
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

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

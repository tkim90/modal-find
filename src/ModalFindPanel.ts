import * as path from 'path';
import * as vscode from 'vscode';
import { getDebugOptions, traceLifecycle } from './debug';
import { toErrorMessage } from './errors';
import { SearchResponse, SearchResult } from './searchTypes';
import { SearchSettingsCache } from './searchSettingsCache';
import { SearchService } from './searchService';
import { getHtmlForWebview, warmupAssets, getDisplayText, getMetaText, SerializedSearchResult } from './webviewHtml';

const IMAGE_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.avif'
]);

type WebviewMessage =
	| { type: 'ready'; query?: string; caseSensitive?: boolean; wordMatch?: boolean; regexEnabled?: boolean }
	| { type: 'lifecycleTrace'; event: string; elapsedMs?: number; detail?: Record<string, unknown> }
	| { type: 'close' }
	| { type: 'queryChanged'; value: string; caseSensitive: boolean; wordMatch: boolean; regexEnabled: boolean; filtersVisible: boolean; includePattern: string; excludePattern: string }
	| { type: 'openResult'; resultId: string }
	| { type: 'resizeDimensionsChanged'; width: number; height: number }
	| { type: 'splitRatioChanged'; ratio: number };

interface ReturnFocusTarget {
	uri: vscode.Uri;
	viewColumn?: vscode.ViewColumn;
	selection?: vscode.Selection;
}

export class ModalFindPanel implements vscode.Disposable {
	private static currentPanel: ModalFindPanel | undefined;
	private static nextPanelId = 1;
	private readonly panel: vscode.WebviewPanel;
	private readonly searchService: SearchService;
	private readonly resultMap = new Map<string, SearchResult>();
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;
	private requestVersion = 0;
	private lastQuery = '';
	private lastCaseSensitive = false;
	private lastWordMatch = false;
	private lastRegexEnabled = false;
	private lastIncludePattern = '';
	private lastExcludePattern = '';
	private returnFocusTarget?: ReturnFocusTarget;
	private initialQuery?: string;

	public static warmupAssets(extensionUri: vscode.Uri): void {
		warmupAssets(extensionUri);
	}

	public static createOrShow(
		context: vscode.ExtensionContext,
		searchService: SearchService,
		settingsCache: SearchSettingsCache,
		initialQuery?: string
	): void {
		if (ModalFindPanel.currentPanel) {
			traceLifecycle('panel.reveal.requested', {
				panelId: ModalFindPanel.currentPanel.panelId,
				visible: ModalFindPanel.currentPanel.panel.visible,
				active: ModalFindPanel.currentPanel.panel.active
			});
			ModalFindPanel.currentPanel.captureReturnFocusTarget(vscode.window.activeTextEditor);
			ModalFindPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active, false);
			ModalFindPanel.currentPanel.focusQuery(initialQuery);
			return;
		}

		const panelId = ModalFindPanel.nextPanelId++;
		traceLifecycle('panel.create.start', {
			panelId
		});
		const panel = vscode.window.createWebviewPanel(
			'fast-fuzzy-finder.search',
			'Find',
			{
				viewColumn: vscode.ViewColumn.Active,
				preserveFocus: false
			},
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);
		traceLifecycle('panel.create.returned', {
			panelId,
			retainContextWhenHidden: true
		});

		ModalFindPanel.currentPanel = new ModalFindPanel(
			panel,
			context,
			searchService,
			settingsCache,
			captureReturnFocusTarget(vscode.window.activeTextEditor),
			panelId,
			initialQuery
		);
	}

	public static disposeCurrentPanel(): void {
		ModalFindPanel.currentPanel?.panel.dispose();
	}

	public static toggleSearchOption(option: 'caseSensitive' | 'wordMatch' | 'regexEnabled' | 'filter'): void {
		ModalFindPanel.currentPanel?.postMessage({ type: 'toggleSearchOption', option });
	}

	private readonly context: vscode.ExtensionContext;
	private readonly panelId: number;

	private readonly settingsCache: SearchSettingsCache;

	private constructor(
		panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		searchService: SearchService,
		settingsCache: SearchSettingsCache,
		returnFocusTarget: ReturnFocusTarget | undefined,
		panelId: number,
		initialQuery?: string
	) {
		this.panel = panel;
		this.context = context;
		this.searchService = searchService;
		this.settingsCache = settingsCache;
		this.returnFocusTarget = returnFocusTarget;
		this.panelId = panelId;
		this.initialQuery = initialQuery;

		this.disposables.push(
			this.panel.onDidDispose(() => {
				traceLifecycle('panel.onDidDispose', {
					panelId: this.panelId
				});
				this.dispose();
			}),
			this.panel.onDidChangeViewState((event) => {
				traceLifecycle('panel.viewState.changed', {
					panelId: this.panelId,
					visible: event.webviewPanel.visible,
					active: event.webviewPanel.active
				});
			}),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				if (this.disposed) {
					return;
				}
				void this.handleMessage(message);
			})
		);

		this.panel.webview.html = getHtmlForWebview(context.extensionUri, this.panel.webview);
		traceLifecycle('panel.html.assigned', {
			panelId: this.panelId
		});
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.requestVersion += 1;
		traceLifecycle('panel.dispose', {
			panelId: this.panelId
		});

		if (ModalFindPanel.currentPanel === this) {
			ModalFindPanel.currentPanel = undefined;
		}

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (this.disposed) {
			return;
		}

		switch (message.type) {
			case 'lifecycleTrace':
				traceLifecycle(`webview.${message.event}`, {
					panelId: this.panelId,
					elapsedMs: message.elapsedMs,
					...message.detail
				});
				return;
			case 'ready': {
				traceLifecycle('webview.ready.received', {
					panelId: this.panelId,
					hasQuery: Boolean(message.query),
					caseSensitive: message.caseSensitive ?? this.lastCaseSensitive,
					wordMatch: message.wordMatch ?? this.lastWordMatch,
					regexEnabled: message.regexEnabled ?? this.lastRegexEnabled
				});
				this.lastQuery = message.query ?? this.lastQuery;
				this.lastCaseSensitive = message.caseSensitive ?? this.lastCaseSensitive;
				this.lastWordMatch = message.wordMatch ?? this.lastWordMatch;
				this.lastRegexEnabled = message.regexEnabled ?? this.lastRegexEnabled;
				const dims = this.context.globalState.get<{ width: number; height: number }>('modalDimensions');
				const splitRatio = this.context.globalState.get<number>('modalSplitRatio');
				if (dims || splitRatio !== undefined) {
					this.postMessage({
						type: 'restoreDimensions',
						width: dims?.width,
						height: dims?.height,
						splitRatio
					});
				}
				const hasWebviewState = Boolean(message.query) || message.caseSensitive || message.wordMatch || message.regexEnabled;
				if (!hasWebviewState) {
					const cached = this.settingsCache.get();
					if (cached.query || cached.caseSensitive || cached.wordMatch || cached.regexEnabled || cached.filtersVisible || cached.includePattern || cached.excludePattern) {
						this.lastQuery = cached.query;
						this.lastCaseSensitive = cached.caseSensitive;
						this.lastWordMatch = cached.wordMatch;
						this.lastRegexEnabled = cached.regexEnabled;
						this.lastIncludePattern = cached.includePattern;
						this.lastExcludePattern = cached.excludePattern;
						this.postMessage({
							type: 'restoreSearchSettings',
							query: cached.query,
							caseSensitive: cached.caseSensitive,
							wordMatch: cached.wordMatch,
							regexEnabled: cached.regexEnabled,
							filtersVisible: cached.filtersVisible,
							includePattern: cached.includePattern,
							excludePattern: cached.excludePattern
						});
					}
				}
				if (getDebugOptions().disableWarmup) {
					traceLifecycle('search.warmup.skipped', {
						panelId: this.panelId,
						source: 'panel-ready',
						reason: 'config.disableWarmup'
					});
				} else {
					void this.searchService.warmup('panel-ready');
				}
				this.showIdleState();
				if (this.initialQuery) {
					this.focusQuery(this.initialQuery);
					this.initialQuery = undefined;
				}
				return;
			}
			case 'close':
				await this.close();
				return;
			case 'queryChanged':
				this.lastQuery = message.value;
				this.lastCaseSensitive = message.caseSensitive;
				this.lastWordMatch = message.wordMatch;
				this.lastRegexEnabled = message.regexEnabled;
				this.lastIncludePattern = message.includePattern;
				this.lastExcludePattern = message.excludePattern;
				this.settingsCache.update({
					query: message.value,
					caseSensitive: message.caseSensitive,
					wordMatch: message.wordMatch,
					regexEnabled: message.regexEnabled,
					filtersVisible: message.filtersVisible,
					includePattern: message.includePattern,
					excludePattern: message.excludePattern
				});
				if (!message.value.trim()) {
					this.requestVersion += 1;
					this.showIdleState();
					return;
				}
				await this.runSearch(
					message.value,
					message.caseSensitive,
					message.wordMatch,
					message.regexEnabled
				);
				return;
			case 'openResult':
				await this.openResult(message.resultId);
				return;
			case 'resizeDimensionsChanged':
				void this.context.globalState.update('modalDimensions', {
					width: message.width,
					height: message.height
				});
				return;
			case 'splitRatioChanged':
				void this.context.globalState.update('modalSplitRatio', message.ratio);
				return;
		}
	}

	private async runSearch(
		query: string,
		caseSensitive = false,
		wordMatch = false,
		regexEnabled = false
	): Promise<void> {
		if (this.disposed) {
			return;
		}

		const currentVersion = ++this.requestVersion;
		this.postMessage({
			type: 'searching',
			query
		});

		try {
			let backendQuery = query;
			let backendRegex = regexEnabled;
			if (wordMatch) {
				const escaped = regexEnabled
					? query
					: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				backendQuery = '\\b' + escaped + '\\b';
				backendRegex = true;
			}

			const response = await this.searchService.search(
				backendQuery,
				caseSensitive,
				backendRegex
			);
			response.query = query;
			if (this.disposed || currentVersion !== this.requestVersion) {
				return;
			}

			this.updateResults(response);
		} catch (error) {
			if (this.disposed || currentVersion !== this.requestVersion) {
				return;
			}

			this.postMessage({
				type: 'error',
				message: toErrorMessage(error)
			});
		}
	}

	private updateResults(response: SearchResponse): void {
		if (this.disposed) {
			return;
		}

		let filtered = response.results;
		if (this.lastIncludePattern.trim() || this.lastExcludePattern.trim()) {
			filtered = applyFileFilters(filtered, this.lastIncludePattern, this.lastExcludePattern);
		}

		filtered.sort((a, b) => {
			if (a.kind === b.kind) { return 0; }
			return a.kind === 'line' ? -1 : 1;
		});

		this.resultMap.clear();
		for (const result of filtered) {
			this.resultMap.set(result.id, result);
		}

		const serializedResults: SerializedSearchResult[] = filtered.map((result) => {
			const ext = path.extname(result.relativePath).toLowerCase();
			return {
				id: result.id,
				kind: result.kind,
				relativePath: result.relativePath,
				displayText: getDisplayText(result),
				metaText: getMetaText(result),
				lineNumber: result.lineNumber,
				column: result.column,
				preview: result.preview,
				imageUri: IMAGE_EXTENSIONS.has(ext)
					? this.panel.webview.asWebviewUri(result.uri).toString()
					: undefined
			};
		});

		this.postMessage({
			type: 'results',
			query: response.query,
			results: serializedResults,
			meta: {
				indexedFileCount: response.indexedFileCount,
				searchableFileCount: response.searchableFileCount,
				skippedFileCount: response.skippedFileCount,
				durationMs: response.durationMs
			}
		});
	}

	private async close(): Promise<void> {
		const disposeOnClose = getDebugOptions().disposeOnClose;
		traceLifecycle('panel.close.requested', {
			panelId: this.panelId,
			disposeOnClose
		});

		const restoredFocus = await this.restoreFocusTarget();
		if (disposeOnClose || !restoredFocus) {
			this.panel.dispose();
		}
	}

	private async restoreFocusTarget(): Promise<boolean> {
		const focusTarget = this.returnFocusTarget;
		if (!focusTarget) {
			traceLifecycle('panel.focus.restore.skipped', {
				panelId: this.panelId,
				reason: 'noFocusTarget'
			});
			return false;
		}

		try {
			traceLifecycle('panel.focus.restore.start', {
				panelId: this.panelId,
				path: focusTarget.uri.fsPath
			});
			const document = await vscode.workspace.openTextDocument(focusTarget.uri);
			await vscode.window.showTextDocument(document, {
				preserveFocus: false,
				viewColumn: focusTarget.viewColumn,
				selection: focusTarget.selection
			});
			traceLifecycle('panel.focus.restore.end', {
				panelId: this.panelId,
				path: focusTarget.uri.fsPath
			});
			return true;
		} catch {
			traceLifecycle('panel.focus.restore.error', {
				panelId: this.panelId,
				path: focusTarget.uri.fsPath
			});
			return false;
		}
	}

	private async openResult(resultId: string): Promise<void> {
		if (this.disposed) {
			return;
		}

		const result = this.resultMap.get(resultId);
		if (!result) {
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(result.uri);
			const editor = await vscode.window.showTextDocument(document, {
				preview: false,
				viewColumn: vscode.ViewColumn.Active
			});
			const line = Math.max(0, result.lineNumber - 1);
			const column = Math.max(0, result.column - 1);
			const position = new vscode.Position(line, column);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(
				new vscode.Range(
					new vscode.Position(Math.max(0, line - 2), 0),
					new vscode.Position(Math.min(document.lineCount - 1, line + 2), 0)
				),
				vscode.TextEditorRevealType.InCenter
			);
		} catch {
			await vscode.commands.executeCommand('vscode.open', result.uri);
		}
	}

	private focusQuery(query?: string): void {
		if (this.disposed) {
			return;
		}

		this.postMessage({ type: 'focusQuery', query });
	}

	private captureReturnFocusTarget(editor: vscode.TextEditor | undefined): void {
		const nextTarget = captureReturnFocusTarget(editor);
		if (nextTarget) {
			this.returnFocusTarget = nextTarget;
		}
	}

	private showIdleState(): void {
		this.resultMap.clear();
		this.postMessage({
			type: 'idle',
			metaMessage: 'Type to search the workspace.',
			statusMessage: 'Type to search'
		});
	}

	private postMessage(message: unknown): void {
		if (this.disposed) {
			return;
		}

		void this.panel.webview.postMessage(message).then(undefined, () => undefined);
	}

}

function captureReturnFocusTarget(editor: vscode.TextEditor | undefined): ReturnFocusTarget | undefined {
	if (!editor || editor.document.uri.scheme !== 'file') {
		return undefined;
	}

	return {
		uri: editor.document.uri,
		viewColumn: editor.viewColumn,
		selection: editor.selection
	};
}

function globToRegex(pattern: string): RegExp | null {
	pattern = pattern.trim();
	if (!pattern) {
		return null;
	}

	let regex = '';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					regex += '(?:.+/)?';
					i += 3;
				} else {
					regex += '.*';
					i += 2;
				}
			} else {
				regex += '[^/]*';
				i += 1;
			}
		} else if (ch === '?') {
			regex += '[^/]';
			i += 1;
		} else if (ch === '{') {
			const close = pattern.indexOf('}', i);
			if (close !== -1) {
				const alternatives = pattern.slice(i + 1, close).split(',').map(a => a.trim());
				regex += '(?:' + alternatives.map(escapeRegexChars).join('|') + ')';
				i = close + 1;
			} else {
				regex += '\\{';
				i += 1;
			}
		} else if ('.+^$|()[]\\'.includes(ch)) {
			regex += '\\' + ch;
			i += 1;
		} else {
			regex += ch;
			i += 1;
		}
	}

	try {
		return new RegExp('^(?:.*/)?' + regex + '$', 'i');
	} catch {
		return null;
	}
}

function escapeRegexChars(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePatterns(input: string): RegExp[] {
	return input
		.split(',')
		.map(p => globToRegex(p))
		.filter((r): r is RegExp => r !== null);
}

function applyFileFilters(results: SearchResult[], includeInput: string, excludeInput: string): SearchResult[] {
	const includePatterns = parsePatterns(includeInput);
	const excludePatterns = parsePatterns(excludeInput);

	if (!includePatterns.length && !excludePatterns.length) {
		return results;
	}

	return results.filter(result => {
		const filePath = result.relativePath;
		if (includePatterns.length && !includePatterns.some(p => p.test(filePath))) {
			return false;
		}
		if (excludePatterns.length && excludePatterns.some(p => p.test(filePath))) {
			return false;
		}
		return true;
	});
}

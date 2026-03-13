import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SearchResponse, SearchResult } from './searchTypes';
import { SearchService } from './searchService';

type WebviewMessage =
	| { type: 'ready'; query?: string; caseSensitive?: boolean; regexEnabled?: boolean }
	| { type: 'close' }
	| { type: 'queryChanged'; value: string; caseSensitive: boolean; regexEnabled: boolean }
	| { type: 'openResult'; resultId: string }
	| { type: 'resizeDimensionsChanged'; width: number; height: number }
	| { type: 'splitRatioChanged'; ratio: number };

interface SerializedSearchResult {
	id: string;
	kind: 'file' | 'line';
	relativePath: string;
	displayText: string;
	metaText: string;
	lineNumber: number;
	column: number;
	preview: SearchResult['preview'];
}

interface ReturnFocusTarget {
	uri: vscode.Uri;
	viewColumn?: vscode.ViewColumn;
	selection?: vscode.Selection;
}

export class ModalFindPanel implements vscode.Disposable {
	private static currentPanel: ModalFindPanel | undefined;
	private static cachedAssets:
		| {
				css: string;
				script: string;
		  }
		| undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly searchService: SearchService;
	private readonly resultMap = new Map<string, SearchResult>();
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;
	private requestVersion = 0;
	private lastQuery = '';
	private lastCaseSensitive = false;
	private lastRegexEnabled = false;
	private returnFocusTarget?: ReturnFocusTarget;

	public static warmupAssets(extensionUri: vscode.Uri): void {
		void ModalFindPanel.getCachedAssets(extensionUri);
	}

	public static createOrShow(
		context: vscode.ExtensionContext,
		searchService: SearchService
	): void {
		if (ModalFindPanel.currentPanel) {
			ModalFindPanel.currentPanel.captureReturnFocusTarget(vscode.window.activeTextEditor);
			ModalFindPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active, false);
			ModalFindPanel.currentPanel.focusQuery();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'modal-find.search',
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

		ModalFindPanel.currentPanel = new ModalFindPanel(
			panel,
			context,
			searchService,
			captureReturnFocusTarget(vscode.window.activeTextEditor)
		);
	}

	public static disposeCurrentPanel(): void {
		ModalFindPanel.currentPanel?.panel.dispose();
	}

	private readonly context: vscode.ExtensionContext;

	private constructor(
		panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		searchService: SearchService,
		returnFocusTarget: ReturnFocusTarget | undefined
	) {
		this.panel = panel;
		this.context = context;
		this.searchService = searchService;
		this.returnFocusTarget = returnFocusTarget;

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				if (this.disposed) {
					return;
				}
				void this.handleMessage(message);
			})
		);

		this.panel.webview.html = this.getHtmlForWebview(context.extensionUri, this.panel.webview);
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.requestVersion += 1;

		if (ModalFindPanel.currentPanel === this) {
			ModalFindPanel.currentPanel = undefined;
		}

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		if (this.disposed) {
			return;
		}

		switch (message.type) {
			case 'ready': {
				this.lastQuery = message.query ?? this.lastQuery;
				this.lastCaseSensitive = message.caseSensitive ?? this.lastCaseSensitive;
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
				void this.searchService.warmup();
				this.showIdleState();
				return;
			}
			case 'close':
				await this.hide();
				return;
			case 'queryChanged':
				this.lastQuery = message.value;
				this.lastCaseSensitive = message.caseSensitive;
				this.lastRegexEnabled = message.regexEnabled;
				if (!message.value.trim()) {
					this.requestVersion += 1;
					this.showIdleState();
					return;
				}
				await this.runSearch(
					message.value,
					message.caseSensitive,
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
			const response = await this.searchService.search(
				query,
				caseSensitive,
				regexEnabled
			);
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
				message: error instanceof Error ? error.message : 'Search failed.'
			});
		}
	}

	private updateResults(response: SearchResponse): void {
		if (this.disposed) {
			return;
		}

		this.resultMap.clear();
		for (const result of response.results) {
			this.resultMap.set(result.id, result);
		}

		const serializedResults: SerializedSearchResult[] = response.results.map((result) => ({
			id: result.id,
			kind: result.kind,
			relativePath: result.relativePath,
			displayText: getDisplayText(result),
			metaText: getMetaText(result),
			lineNumber: result.lineNumber,
			column: result.column,
			preview: result.preview
		}));

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

	private async hide(): Promise<void> {
		const focusTarget = this.returnFocusTarget;
		if (!focusTarget) {
			this.panel.dispose();
			return;
		}

		try {
			const document = await vscode.workspace.openTextDocument(focusTarget.uri);
			await vscode.window.showTextDocument(document, {
				preserveFocus: false,
				viewColumn: focusTarget.viewColumn,
				selection: focusTarget.selection
			});
		} catch {
			this.panel.dispose();
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
	}

	private focusQuery(): void {
		if (this.disposed) {
			return;
		}

		this.postMessage({ type: 'focusQuery' });
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

	private getHtmlForWebview(extensionUri: vscode.Uri, webview: vscode.Webview): string {
		const assets = ModalFindPanel.getCachedAssets(extensionUri);
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		const highlightJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'highlight.min.js'));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Modal Find</title>
	<style nonce="${nonce}">${assets.css}</style>
</head>
<body data-highlight-src="${highlightJsUri}" data-script-nonce="${nonce}">
	<div class="shell">
		<div class="modal">
			<div class="resize-handle resize-handle-nw" data-resize="nw"></div>
			<div class="resize-handle resize-handle-ne" data-resize="ne"></div>
			<div class="resize-handle resize-handle-sw" data-resize="sw"></div>
			<div class="resize-handle resize-handle-se" data-resize="se"></div>
			<div class="header">
				<div class="input-row">
					<input id="query" class="query" type="text" spellcheck="false" placeholder="Search files and lines..." />
					<div class="input-actions">
						<button id="case-toggle" class="toolbar-button" type="button" title="Case Sensitive" aria-label="Case Sensitive" aria-pressed="false">Cc</button>
						<button id="regex-toggle" class="toolbar-button" type="button" title="Regex" aria-label="Regex" aria-pressed="false">.*</button>
					</div>
				</div>
			</div>
			<div id="results" class="results" tabindex="0"></div>
			<div id="splitter" class="splitter"></div>
			<div id="preview" class="preview" tabindex="0"></div>
			<div id="footer" class="footer">
				<div id="meta">Indexing workspace\u2026</div>
				<div id="status">Type to search</div>
			</div>
		</div>
	</div>
	<script nonce="${nonce}">${assets.script}</script>
</body>
</html>`;
	}

	private static getCachedAssets(extensionUri: vscode.Uri): { css: string; script: string } {
		if (ModalFindPanel.cachedAssets) {
			return ModalFindPanel.cachedAssets;
		}

		const cssPath = vscode.Uri.joinPath(extensionUri, 'media', 'modal.css').fsPath;
		const scriptPath = vscode.Uri.joinPath(extensionUri, 'media', 'modal.js').fsPath;
		ModalFindPanel.cachedAssets = {
			css: escapeInlineTag(fs.readFileSync(cssPath, 'utf8'), 'style'),
			script: escapeInlineTag(fs.readFileSync(scriptPath, 'utf8'), 'script')
		};
		return ModalFindPanel.cachedAssets;
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

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index += 1) {
		value += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return value;
}

function escapeInlineTag(source: string, tagName: 'script' | 'style'): string {
	const closingTag = new RegExp(`</${tagName}`, 'gi');
	return source.replace(closingTag, `<\\/${tagName}`);
}

function getDisplayText(result: SearchResult): string {
	if (result.kind === 'line') {
		return result.preview.find((line) => line.isMatch)?.text ?? '';
	}

	return result.relativePath;
}

function getMetaText(result: SearchResult): string {
	const fileName = path.basename(result.relativePath);
	if (result.kind === 'line') {
		return `${fileName} ${result.lineNumber}`;
	}

	return fileName;
}

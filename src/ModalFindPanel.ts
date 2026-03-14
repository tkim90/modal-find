import * as vscode from 'vscode';
import { getDebugOptions, traceLifecycle } from './debug';
import { toErrorMessage } from './errors';
import { SearchResponse, SearchResult } from './searchTypes';
import { SearchService } from './searchService';
import { getHtmlForWebview, warmupAssets, getDisplayText, getMetaText, SerializedSearchResult } from './webviewHtml';

type WebviewMessage =
	| { type: 'ready'; query?: string; caseSensitive?: boolean; regexEnabled?: boolean }
	| { type: 'lifecycleTrace'; event: string; elapsedMs?: number; detail?: Record<string, unknown> }
	| { type: 'close' }
	| { type: 'queryChanged'; value: string; caseSensitive: boolean; regexEnabled: boolean }
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
	private lastRegexEnabled = false;
	private returnFocusTarget?: ReturnFocusTarget;

	public static warmupAssets(extensionUri: vscode.Uri): void {
		warmupAssets(extensionUri);
	}

	public static createOrShow(
		context: vscode.ExtensionContext,
		searchService: SearchService
	): void {
		if (ModalFindPanel.currentPanel) {
			traceLifecycle('panel.reveal.requested', {
				panelId: ModalFindPanel.currentPanel.panelId,
				visible: ModalFindPanel.currentPanel.panel.visible,
				active: ModalFindPanel.currentPanel.panel.active
			});
			ModalFindPanel.currentPanel.captureReturnFocusTarget(vscode.window.activeTextEditor);
			ModalFindPanel.currentPanel.panel.reveal(vscode.ViewColumn.Active, false);
			ModalFindPanel.currentPanel.focusQuery();
			return;
		}

		const panelId = ModalFindPanel.nextPanelId++;
		traceLifecycle('panel.create.start', {
			panelId
		});
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
		traceLifecycle('panel.create.returned', {
			panelId,
			retainContextWhenHidden: true
		});

		ModalFindPanel.currentPanel = new ModalFindPanel(
			panel,
			context,
			searchService,
			captureReturnFocusTarget(vscode.window.activeTextEditor),
			panelId
		);
	}

	public static disposeCurrentPanel(): void {
		ModalFindPanel.currentPanel?.panel.dispose();
	}

	private readonly context: vscode.ExtensionContext;
	private readonly panelId: number;

	private constructor(
		panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		searchService: SearchService,
		returnFocusTarget: ReturnFocusTarget | undefined,
		panelId: number
	) {
		this.panel = panel;
		this.context = context;
		this.searchService = searchService;
		this.returnFocusTarget = returnFocusTarget;
		this.panelId = panelId;

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
					regexEnabled: message.regexEnabled ?? this.lastRegexEnabled
				});
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
				return;
			}
			case 'close':
				await this.close();
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
				message: toErrorMessage(error)
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

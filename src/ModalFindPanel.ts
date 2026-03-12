import * as path from 'path';
import * as vscode from 'vscode';
import { SearchResponse, SearchResult } from './searchTypes';
import { SearchService } from './searchService';

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'close' }
	| { type: 'queryChanged'; value: string }
	| { type: 'openResult'; resultId: string };

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

export class ModalFindPanel implements vscode.Disposable {
	private static currentPanel: ModalFindPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly searchService: SearchService;
	private readonly resultMap = new Map<string, SearchResult>();
	private readonly disposables: vscode.Disposable[] = [];
	private requestVersion = 0;
	private lastQuery = '';

	public static createOrShow(extensionUri: vscode.Uri): void {
		if (ModalFindPanel.currentPanel) {
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

		ModalFindPanel.currentPanel = new ModalFindPanel(panel, extensionUri);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this.panel = panel;
		this.searchService = new SearchService(extensionUri);
		this.panel.webview.html = this.getHtmlForWebview(extensionUri, this.panel.webview);

		this.disposables.push(
			this.searchService,
			this.searchService.onDidChange(() => {
				void this.runSearch(this.lastQuery);
			}),
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(message);
			})
		);
	}

	public dispose(): void {
		if (ModalFindPanel.currentPanel === this) {
			ModalFindPanel.currentPanel = undefined;
		}

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private async handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.runSearch(this.lastQuery);
				return;
			case 'close':
				this.panel.dispose();
				return;
			case 'queryChanged':
				this.lastQuery = message.value;
				await this.runSearch(message.value);
				return;
			case 'openResult':
				await this.openResult(message.resultId);
				return;
		}
	}

	private async runSearch(query: string): Promise<void> {
		const currentVersion = ++this.requestVersion;
		this.postMessage({
			type: 'searching',
			query
		});

		try {
			const response = await this.searchService.search(query);
			if (currentVersion !== this.requestVersion) {
				return;
			}

			this.updateResults(response);
		} catch (error) {
			if (currentVersion !== this.requestVersion) {
				return;
			}

			this.postMessage({
				type: 'error',
				message: error instanceof Error ? error.message : 'Search failed.'
			});
		}
	}

	private updateResults(response: SearchResponse): void {
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

	private async openResult(resultId: string): Promise<void> {
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

		this.panel.dispose();
	}

	private focusQuery(): void {
		this.postMessage({ type: 'focusQuery' });
	}

	private postMessage(message: unknown): void {
		void this.panel.webview.postMessage(message);
	}

	private getHtmlForWebview(extensionUri: vscode.Uri, webview: vscode.Webview): string {
		const nonce = getNonce();
		const cspSource = webview.cspSource;
		const title = 'Modal Find';

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>${title}</title>
	<style>
		:root {
			color-scheme: light dark;
		}

		* {
			box-sizing: border-box;
		}

		html, body {
			margin: 0;
			padding: 0;
			height: 100%;
			background: #111111;
			color: #e6e6e6;
			font-family: var(--vscode-font-family);
		}

		body {
			padding: 18px;
		}

		.shell {
			height: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.modal {
			width: min(1120px, 96vw);
			height: min(760px, 92vh);
			display: grid;
			grid-template-rows: auto minmax(220px, 1fr) minmax(180px, 0.8fr) auto;
			background: #171717;
			border: 1px solid #2b2b2b;
			border-radius: 0;
			box-shadow: none;
			overflow: hidden;
		}

		.header {
			padding: 18px 18px 14px;
			border-bottom: 1px solid #2b2b2b;
			background: #171717;
		}

		.input-row {
			display: grid;
			grid-template-columns: 1fr auto;
			gap: 12px;
			align-items: center;
		}

		.query {
			width: 100%;
			border: 1px solid #313131;
			background: #111111;
			color: #f2f2f2;
			padding: 14px 16px;
			border-radius: 0;
			font-size: 16px;
			outline: none;
		}

		.query:focus {
			border-color: var(--vscode-focusBorder);
			box-shadow: 0 0 0 1px var(--vscode-focusBorder);
		}

		.hint {
			font-size: 12px;
			color: #9a9a9a;
			white-space: nowrap;
		}

		.results {
			overflow: auto;
			padding: 8px;
			background: #171717;
		}

		.result {
			width: 100%;
			border: 1px solid transparent;
			border-radius: 0;
			background: transparent;
			color: inherit;
			padding: 14px 16px;
			text-align: left;
			display: grid;
			grid-template-columns: auto 1fr auto;
			gap: 14px;
			align-items: center;
			cursor: pointer;
		}

		.result:hover {
			background: #1f1f1f;
		}

		.result.is-selected {
			background: #232323;
			border-color: #3a3a3a;
		}

		.badge {
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			padding: 6px 8px;
			border-radius: 0;
			background: rgba(53, 53, 53, 0.55);
			color: #cfcfcf;
			border: 1px solid rgba(110, 110, 110, 0.35);
		}

		.badge.is-line {
			background: rgba(34, 58, 94, 0.58);
			color: #bfd6ff;
			border-color: rgba(77, 117, 187, 0.4);
		}

		.badge.is-file {
			background: rgba(34, 74, 52, 0.58);
			color: #c7efd2;
			border-color: rgba(89, 157, 115, 0.4);
		}

		.result-main {
			min-width: 0;
		}

		.result-title {
			font-size: 14px;
			font-weight: 500;
			word-break: normal;
			overflow-wrap: anywhere;
			white-space: pre-wrap;
		}

		.result-title.is-file {
			color: #d9d9d9;
			font-weight: 600;
		}

		.result-pos {
			font-size: 12px;
			color: #9d9d9d;
			white-space: nowrap;
			text-align: right;
			align-self: center;
		}

		.preview {
			border-top: 1px solid #2b2b2b;
			padding: 14px 18px 18px;
			overflow: auto;
			background: #111111;
			font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
			font-size: 13px;
			line-height: 1.6;
		}

		.preview-header {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			align-items: center;
			margin-bottom: 10px;
			color: #8d8d8d;
			font-size: 12px;
		}

		.code {
			display: grid;
			gap: 2px;
		}

		.code-line {
			display: grid;
			grid-template-columns: 56px 1fr;
			gap: 14px;
			padding: 2px 10px;
			border-radius: 0;
			white-space: pre;
			overflow-x: auto;
		}

		.code-line.is-match {
			background: #1f1f1f;
		}

		.line-number {
			text-align: right;
			color: #6d6d6d;
			user-select: none;
		}

		.footer {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 12px 18px 16px;
			border-top: 1px solid #2b2b2b;
			color: #8d8d8d;
			font-size: 12px;
			background: #171717;
		}

		.empty {
			height: 100%;
			display: grid;
			place-items: center;
			color: #8d8d8d;
			font-size: 13px;
			text-align: center;
			padding: 24px;
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="modal">
			<div class="header">
				<div class="input-row">
					<input id="query" class="query" type="text" spellcheck="false" placeholder="Search files and lines with fuzzy matching..." />
					<div class="hint">Enter open · ↑↓ move · Esc close</div>
				</div>
			</div>
			<div id="results" class="results"></div>
			<div id="preview" class="preview"></div>
			<div id="footer" class="footer">
				<div id="meta">Indexing workspace…</div>
				<div id="status">Type to search</div>
			</div>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const queryInput = document.getElementById('query');
		const resultsRoot = document.getElementById('results');
		const previewRoot = document.getElementById('preview');
		const metaRoot = document.getElementById('meta');
		const statusRoot = document.getElementById('status');

		let results = [];
		let selectedIndex = 0;
		let currentQuery = '';
		let debounceTimer;

		const savedState = vscode.getState();
		if (savedState?.query) {
			currentQuery = savedState.query;
			queryInput.value = currentQuery;
		}

		function escapeHtml(value) {
			return value
				.replaceAll('&', '&amp;')
				.replaceAll('<', '&lt;')
				.replaceAll('>', '&gt;')
				.replaceAll('"', '&quot;')
				.replaceAll("'", '&#39;');
		}

		function postQuery(value) {
			currentQuery = value;
			vscode.setState({ query: value });
			vscode.postMessage({ type: 'queryChanged', value });
		}

		function scheduleQuery(value) {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => postQuery(value), 100);
		}

		function renderResults() {
			if (!results.length) {
				resultsRoot.innerHTML = '<div class="empty">No matches yet.<br />Try a shorter query or fewer terms.</div>';
				return;
			}

			resultsRoot.innerHTML = results.map((result, index) => {
				const selectedClass = index === selectedIndex ? 'is-selected' : '';
				const badgeClass = result.kind === 'line' ? 'is-line' : 'is-file';
				const titleClass = result.kind === 'line' ? 'is-line' : 'is-file';
				return \`
					<button class="result \${selectedClass}" data-result-id="\${escapeHtml(result.id)}" data-index="\${index}">
						<div class="badge \${badgeClass}">\${escapeHtml(result.kind)}</div>
						<div class="result-main">
							<div class="result-title \${titleClass}">\${escapeHtml(result.displayText)}</div>
						</div>
						<div class="result-pos">\${escapeHtml(result.metaText)}</div>
					</button>
				\`;
			}).join('');
		}

		function renderPreview() {
			const selected = results[selectedIndex];
			if (!selected) {
				previewRoot.innerHTML = '<div class="empty">Preview will appear here.</div>';
				return;
			}

			const previewLines = selected.preview.map((line) => \`
				<div class="code-line \${line.isMatch ? 'is-match' : ''}">
					<div class="line-number">\${line.lineNumber}</div>
					<div>\${escapeHtml(line.text || ' ')}</div>
				</div>
			\`).join('');

			previewRoot.innerHTML = \`
				<div class="preview-header">
					<div>\${escapeHtml(selected.relativePath)}</div>
					<div>\${escapeHtml(selected.kind === 'line' ? selected.lineNumber + ':' + selected.column : 'file preview')}</div>
				</div>
				<div class="code">\${previewLines}</div>
			\`;
		}

		function renderAll() {
			renderResults();
			renderPreview();
		}

		function selectIndex(index) {
			if (!results.length) {
				selectedIndex = 0;
				renderAll();
				return;
			}

			selectedIndex = Math.max(0, Math.min(index, results.length - 1));
			renderAll();

			const selectedElement = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]');
			selectedElement?.scrollIntoView({ block: 'nearest' });
		}

		function moveSelection(delta) {
			if (!results.length) {
				return;
			}

			const nextIndex = (selectedIndex + delta + results.length) % results.length;
			selectIndex(nextIndex);
		}

		function openSelected() {
			const selected = results[selectedIndex];
			if (!selected) {
				return;
			}

			vscode.postMessage({ type: 'openResult', resultId: selected.id });
		}

		queryInput.addEventListener('input', (event) => {
			scheduleQuery(event.target.value);
		});

		queryInput.addEventListener('keydown', (event) => {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				moveSelection(1);
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				moveSelection(-1);
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				openSelected();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'close' });
			}
		});

		document.addEventListener('keydown', (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				queryInput.focus();
				queryInput.select();
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'close' });
			}
		});

		resultsRoot.addEventListener('click', (event) => {
			const button = event.target.closest('[data-result-id]');
			if (!button) {
				return;
			}

			const index = Number(button.dataset.index || '0');
			selectIndex(index);
		});

		resultsRoot.addEventListener('dblclick', (event) => {
			const button = event.target.closest('[data-result-id]');
			if (!button) {
				return;
			}

			const index = Number(button.dataset.index || '0');
			selectIndex(index);
			openSelected();
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			switch (message.type) {
				case 'focusQuery':
					queryInput.focus();
					queryInput.select();
					return;
				case 'searching':
					statusRoot.textContent = message.query ? 'Searching…' : 'Loading index…';
					return;
				case 'results':
					currentQuery = message.query;
					results = message.results;
					selectedIndex = 0;
					metaRoot.textContent = message.meta.searchableFileCount + ' searchable / ' + message.meta.indexedFileCount + ' indexed / ' + message.meta.skippedFileCount + ' path-only';
					statusRoot.textContent = results.length + ' results in ' + message.meta.durationMs + ' ms';
					renderAll();
					return;
				case 'error':
					statusRoot.textContent = message.message;
					results = [];
					renderAll();
					return;
			}
		});

		queryInput.focus();
		queryInput.select();
		renderAll();
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index += 1) {
		value += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return value;
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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SearchResult } from './searchTypes';

export interface SerializedSearchResult {
	id: string;
	kind: 'file' | 'line';
	relativePath: string;
	displayText: string;
	metaText: string;
	lineNumber: number;
	column: number;
	preview: SearchResult['preview'];
	imageUri?: string;
}

let cachedAssets: { css: string; script: string } | undefined;

export function warmupAssets(extensionUri: vscode.Uri): void {
	void getCachedAssets(extensionUri);
}

export function getHtmlForWebview(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const assets = getCachedAssets(extensionUri);
	const nonce = getNonce();
	const cspSource = webview.cspSource;
	const highlightJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'highlight.min.js'));

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<title>Fast Fuzzy Finder</title>
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
						<button id="word-toggle" class="toolbar-button" type="button" title="Words" aria-label="Words" aria-pressed="false">W</button>
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

function getCachedAssets(extensionUri: vscode.Uri): { css: string; script: string } {
	if (cachedAssets) {
		return cachedAssets;
	}

	const cssPath = vscode.Uri.joinPath(extensionUri, 'media', 'modal.css').fsPath;
	const scriptPath = vscode.Uri.joinPath(extensionUri, 'media', 'modal.js').fsPath;
	cachedAssets = {
		css: escapeInlineTag(fs.readFileSync(cssPath, 'utf8'), 'style'),
		script: escapeInlineTag(fs.readFileSync(scriptPath, 'utf8'), 'script')
	};
	return cachedAssets;
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

export function getDisplayText(result: SearchResult): string {
	if (result.kind === 'line') {
		return result.preview.find((line) => line.isMatch)?.text ?? '';
	}

	return result.relativePath;
}

export function getMetaText(result: SearchResult): string {
	const fileName = path.basename(result.relativePath);
	if (result.kind === 'line') {
		return `${fileName} ${result.lineNumber}`;
	}

	return fileName;
}

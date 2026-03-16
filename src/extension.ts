import * as vscode from 'vscode';
import { disposeDebugResources, getDebugOptions, traceLifecycle } from './debug';
import { ModalFindPanel } from './ModalFindPanel';
import { SearchService } from './searchService';

export function activate(context: vscode.ExtensionContext): void {
	traceLifecycle('extension.activate.start');

	const searchService = new SearchService(context.extensionUri);
	ModalFindPanel.warmupAssets(context.extensionUri);
	if (getDebugOptions().disableWarmup) {
		traceLifecycle('search.warmup.skipped', {
			source: 'activate',
			reason: 'config.disableWarmup'
		});
	} else {
		void searchService.warmup('activate');
	}

	const openCommand = vscode.commands.registerCommand('fast-fuzzy-finder.open', () => {
		const editor = vscode.window.activeTextEditor;
		const selectedText = editor ? editor.document.getText(editor.selection) : '';
		traceLifecycle('command.invoked', {
			command: 'fast-fuzzy-finder.open',
			hasSelection: Boolean(selectedText)
		});
		ModalFindPanel.createOrShow(context, searchService, selectedText || undefined);
	});

	context.subscriptions.push(searchService, openCommand, { dispose: disposeDebugResources });
	traceLifecycle('extension.activate.end');
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
	disposeDebugResources();
}

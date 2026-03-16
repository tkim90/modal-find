import * as vscode from 'vscode';
import { disposeDebugResources, getDebugOptions, traceLifecycle } from './debug';
import { ModalFindPanel } from './ModalFindPanel';
import { SearchSettingsCache } from './searchSettingsCache';
import { SearchService } from './searchService';

export function activate(context: vscode.ExtensionContext): void {
	traceLifecycle('extension.activate.start');

	const searchService = new SearchService(context.extensionUri);
	const settingsCache = new SearchSettingsCache(context.workspaceState);
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
		const selectedText = editor && !editor.selection.isEmpty
			? editor.document.getText(editor.selection)
			: undefined;
		traceLifecycle('command.invoked', {
			command: 'fast-fuzzy-finder.open',
			hasSelection: Boolean(selectedText)
		});
		ModalFindPanel.createOrShow(context, searchService, settingsCache, selectedText);
	});

	const toggleCaseCommand = vscode.commands.registerCommand('fast-fuzzy-finder.toggleCaseSensitive', () => {
		ModalFindPanel.toggleSearchOption('caseSensitive');
	});
	const toggleWordCommand = vscode.commands.registerCommand('fast-fuzzy-finder.toggleWordMatch', () => {
		ModalFindPanel.toggleSearchOption('wordMatch');
	});
	const toggleRegexCommand = vscode.commands.registerCommand('fast-fuzzy-finder.toggleRegex', () => {
		ModalFindPanel.toggleSearchOption('regexEnabled');
	});

	context.subscriptions.push(searchService, openCommand, toggleCaseCommand, toggleWordCommand, toggleRegexCommand, { dispose: disposeDebugResources });
	traceLifecycle('extension.activate.end');
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
	disposeDebugResources();
}

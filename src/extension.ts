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

	const openCommand = vscode.commands.registerCommand('modal-find.open', () => {
		traceLifecycle('command.invoked', {
			command: 'modal-find.open'
		});
		ModalFindPanel.createOrShow(context, searchService);
	});

	context.subscriptions.push(searchService, openCommand, { dispose: disposeDebugResources });
	traceLifecycle('extension.activate.end');
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
	disposeDebugResources();
}

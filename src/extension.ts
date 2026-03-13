import * as vscode from 'vscode';
import { ModalFindPanel } from './ModalFindPanel';
import { SearchService } from './searchService';

export function activate(context: vscode.ExtensionContext): void {
	const searchService = new SearchService(context.extensionUri);
	ModalFindPanel.warmupAssets(context.extensionUri);
	void searchService.warmup();

	const openCommand = vscode.commands.registerCommand('modal-find.open', () => {
		ModalFindPanel.createOrShow(context, searchService);
	});

	context.subscriptions.push(searchService, openCommand);
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
}

import * as vscode from 'vscode';
import { ModalFindPanel } from './ModalFindPanel';
import { assertBundledSidecarAvailable } from './nativeBinary';

export function activate(context: vscode.ExtensionContext): void {
	assertBundledSidecarAvailable(context.extensionUri);

	const openCommand = vscode.commands.registerCommand('modal-find.open', () => {
		ModalFindPanel.createOrShow(context);
	});

	context.subscriptions.push(openCommand);
}

export function deactivate(): void {
	ModalFindPanel.disposeCurrentPanel();
}

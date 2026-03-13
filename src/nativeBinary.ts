import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PLATFORM_IDS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']);

function getPlatformId(): string {
	return `${process.platform}-${process.arch}`;
}

function getBinaryName(): string {
	return process.platform === 'win32' ? 'fff-bridge.exe' : 'fff-bridge';
}

export function getBundledSidecarPath(extensionUri: vscode.Uri): string {
	const platformId = getPlatformId();
	if (!PLATFORM_IDS.has(platformId)) {
		throw new Error(
			`Modal Find supports only darwin-arm64, darwin-x64, linux-x64, and win32-x64. Current platform: ${platformId}.`
		);
	}

	const binaryPath = path.join(extensionUri.fsPath, 'dist', 'native', platformId, getBinaryName());
	if (!fs.existsSync(binaryPath)) {
		throw new Error(
			`Modal Find could not find the bundled fff sidecar at ${binaryPath}. Run \`npm run build:native\` before launching from source, or install a packaged build for your platform.`
		);
	}

	return binaryPath;
}

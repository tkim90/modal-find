import { performance } from 'perf_hooks';
import * as vscode from 'vscode';

export interface DebugOptions {
	traceLifecycle: boolean;
	disableWarmup: boolean;
	disposeOnClose: boolean;
}

const TRACE_ORIGIN_MS = performance.now();
let traceChannel: vscode.OutputChannel | undefined;

export function getDebugOptions(): DebugOptions {
	const config = vscode.workspace.getConfiguration('modal-find.debug');
	return {
		traceLifecycle: config.get<boolean>('traceLifecycle', false),
		disableWarmup: config.get<boolean>('disableWarmup', false),
		disposeOnClose: config.get<boolean>('disposeOnClose', false)
	};
}

export function traceLifecycle(event: string, details?: Record<string, unknown>): void {
	if (!getDebugOptions().traceLifecycle) {
		return;
	}

	const elapsedMs = performance.now() - TRACE_ORIGIN_MS;
	getTraceChannel().appendLine(
		`[+${elapsedMs.toFixed(1).padStart(8, ' ')}ms] ${event}${formatDetails(details)}`
	);
}

export function disposeDebugResources(): void {
	traceChannel?.dispose();
	traceChannel = undefined;
}

function getTraceChannel(): vscode.OutputChannel {
	if (!traceChannel) {
		traceChannel = vscode.window.createOutputChannel('Modal Find Trace');
	}
	return traceChannel;
}

function formatDetails(details?: Record<string, unknown>): string {
	if (!details || Object.keys(details).length === 0) {
		return '';
	}

	return ` ${JSON.stringify(details, (_key, value) => {
		if (value instanceof Error) {
			return {
				name: value.name,
				message: value.message,
				stack: value.stack
			};
		}
		if (typeof value === 'bigint') {
			return value.toString();
		}
		if (value === undefined) {
			return '[undefined]';
		}
		return value;
	})}`;
}

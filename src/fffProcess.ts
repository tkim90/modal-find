import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { getBundledSidecarPath } from './nativeBinary';

interface InitRequest {
	type: 'init';
	roots: string[];
}

interface SearchRequest {
	type: 'search';
	query: string;
	limit: number;
	currentFile?: string;
	caseSensitive: boolean;
	regexEnabled: boolean;
}

interface RescanRequest {
	type: 'rescan';
}

interface ShutdownRequest {
	type: 'shutdown';
}

type FffRequest = InitRequest | SearchRequest | RescanRequest | ShutdownRequest;

interface ReadyResponse {
	id: number;
	type: 'ready';
}

interface AckResponse {
	id: number;
	type: 'ack';
}

interface ErrorResponse {
	id?: number;
	type: 'error';
	message: string;
}

interface SearchFileResult {
	kind: 'file';
	path: string;
	score: number;
}

interface SearchLineResult {
	kind: 'line';
	path: string;
	score: number;
	lineNumber: number;
	column: number;
	lineText: string;
}

export type FffSearchResult = SearchFileResult | SearchLineResult;

export interface FffSearchResponse {
	results: FffSearchResult[];
	indexedFileCount: number;
	searchableFileCount: number;
	skippedFileCount: number;
	isScanning: boolean;
}

interface ResultsResponse extends FffSearchResponse {
	id: number;
	type: 'results';
}

type FffResponse = ReadyResponse | AckResponse | ErrorResponse | ResultsResponse;

interface PendingRequest {
	resolve: (response: FffResponse) => void;
	reject: (error: Error) => void;
}

export class FffProcess implements vscode.Disposable {
	private process?: ChildProcessWithoutNullStreams;
	private reader?: readline.Interface;
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 0;
	private disposed = false;

	constructor(private readonly extensionUri: vscode.Uri) {}

	public isAlive(): boolean {
		return Boolean(this.process && this.process.exitCode === null && !this.process.killed);
	}

	public async init(roots: string[]): Promise<void> {
		const response = await this.request({ type: 'init', roots });
		if (response.type !== 'ready') {
			throw new Error(`Unexpected init response: ${response.type}`);
		}
	}

	public async search(
		query: string,
		limit: number,
		currentFile: string | undefined,
		caseSensitive: boolean,
		regexEnabled: boolean
	): Promise<FffSearchResponse> {
		const response = await this.request({
			type: 'search',
			query,
			limit,
			currentFile,
			caseSensitive,
			regexEnabled
		});
		if (response.type !== 'results') {
			throw new Error(`Unexpected search response: ${response.type}`);
		}

		return {
			results: response.results,
			indexedFileCount: response.indexedFileCount,
			searchableFileCount: response.searchableFileCount,
			skippedFileCount: response.skippedFileCount,
			isScanning: response.isScanning
		};
	}

	public async rescan(): Promise<void> {
		const response = await this.request({ type: 'rescan' });
		if (response.type !== 'ack') {
			throw new Error(`Unexpected rescan response: ${response.type}`);
		}
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		const process = this.process;
		this.process = undefined;
		this.reader?.removeAllListeners();
		this.reader?.close();
		this.reader = undefined;
		this.rejectPending(new Error('Native fff sidecar stopped.'));

		if (!process) {
			return;
		}

		process.removeAllListeners('error');
		process.removeAllListeners('exit');
		process.stderr.removeAllListeners('data');

		try {
			if (process.stdin.writable) {
				const request = JSON.stringify({
					id: ++this.nextRequestId,
					type: 'shutdown'
				} satisfies { id: number } & ShutdownRequest);
				process.stdin.write(`${request}\n`);
				process.stdin.end();
			}
		} catch {
			// Ignore shutdown failures during disposal.
		}

		if (process.exitCode === null && !process.killed) {
			process.kill();
		}
	}

	private async request(payload: FffRequest): Promise<FffResponse> {
		this.ensureStarted();

		const process = this.process;
		if (!process) {
			throw new Error('Native fff sidecar failed to start.');
		}

		const id = ++this.nextRequestId;
		const request = JSON.stringify({ id, ...payload });

		return new Promise<FffResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });

			try {
				process.stdin.write(`${request}\n`, 'utf8', (error) => {
					if (!error) {
						return;
					}

					this.pending.delete(id);
					reject(error);
				});
			} catch (error) {
				this.pending.delete(id);
				reject(toError(error));
			}
		});
	}

	private ensureStarted(): void {
		if (this.disposed) {
			throw new Error('Native fff sidecar is already disposed.');
		}

		if (this.isAlive()) {
			return;
		}

		this.stopCurrentProcess();

		const binaryPath = getBundledSidecarPath(this.extensionUri);
		const process = spawn(binaryPath, [], {
			cwd: this.extensionUri.fsPath,
			stdio: ['pipe', 'pipe', 'pipe']
		});

		this.process = process;
		this.reader = readline.createInterface({
			input: process.stdout,
			crlfDelay: Infinity
		});

		this.reader.on('line', (line) => {
			if (this.disposed) {
				return;
			}

			this.handleLine(line);
		});

		process.stderr.on('data', (chunk: Buffer | string) => {
			if (this.disposed) {
				return;
			}

			const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
			const message = text.trim();
			if (message) {
				console.error(`[modal-find/native] ${message}`);
			}
		});

		process.on('error', (error) => {
			this.handleProcessExit(new Error(`Failed to start native fff sidecar: ${error.message}`));
		});

		process.on('exit', (code, signal) => {
			if (this.disposed) {
				return;
			}

			const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
			this.handleProcessExit(new Error(`Native fff sidecar exited with ${detail}.`));
		});
	}

	private handleLine(line: string): void {
		if (this.disposed) {
			return;
		}

		let response: FffResponse;
		try {
			response = JSON.parse(line) as FffResponse;
		} catch (error) {
			console.error(`[modal-find/native] Invalid JSON response: ${line}`);
			console.error(error);
			return;
		}

		if (response.type === 'error') {
			const failure = new Error(response.message);
			if (typeof response.id === 'number') {
				const pending = this.pending.get(response.id);
				if (!pending) {
					return;
				}

				this.pending.delete(response.id);
				pending.reject(failure);
				return;
			}

			console.error(`[modal-find/native] ${response.message}`);
			return;
		}

		const pending = this.pending.get(response.id);
		if (!pending) {
			return;
		}

		this.pending.delete(response.id);
		pending.resolve(response);
	}

	private handleProcessExit(error: Error): void {
		if (this.disposed) {
			return;
		}

		this.stopCurrentProcess();
		this.rejectPending(error);
	}

	private stopCurrentProcess(): void {
		const process = this.process;
		this.process = undefined;

		this.reader?.removeAllListeners();
		this.reader?.close();
		this.reader = undefined;

		if (!process) {
			return;
		}

		process.removeAllListeners('error');
		process.removeAllListeners('exit');
		process.stderr.removeAllListeners('data');

		if (process.exitCode === null && !process.killed) {
			process.kill();
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

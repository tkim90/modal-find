import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'native', 'fff-bridge', 'Cargo.toml');

const targetMatrix = {
	'darwin-arm64': 'aarch64-apple-darwin',
	'darwin-x64': 'x86_64-apple-darwin',
	'linux-x64': 'x86_64-unknown-linux-gnu',
	'win32-x64': 'x86_64-pc-windows-msvc'
};

const detectedPlatformId = `${process.platform}-${process.arch}`;
const platformId = process.env.MODAL_FIND_PLATFORM_ID || detectedPlatformId;
const targetTriple = process.env.MODAL_FIND_TARGET_TRIPLE || targetMatrix[platformId];

if (!targetTriple) {
	throw new Error(
		`Unsupported platform ${platformId}. Set MODAL_FIND_PLATFORM_ID and MODAL_FIND_TARGET_TRIPLE explicitly if you need a custom build target.`
	);
}

const cargoArgs = ['build', '--release', '--manifest-path', manifestPath, '--target', targetTriple];
const cargo = spawnSync('cargo', cargoArgs, {
	cwd: repoRoot,
	stdio: 'inherit'
});

if (cargo.status !== 0) {
	process.exit(cargo.status ?? 1);
}

const binaryName = platformId.startsWith('win32-') ? 'fff-bridge.exe' : 'fff-bridge';
const builtBinaryPath = path.join(
	repoRoot,
	'native',
	'fff-bridge',
	'target',
	targetTriple,
	'release',
	binaryName
);

if (!fs.existsSync(builtBinaryPath)) {
	throw new Error(`Native build completed but ${builtBinaryPath} was not produced.`);
}

const outputDirectory = path.join(repoRoot, 'dist', 'native', platformId);
fs.mkdirSync(outputDirectory, { recursive: true });

const outputPath = path.join(outputDirectory, binaryName);
const tempOutputPath = `${outputPath}.tmp`;
const binaryContents = fs.readFileSync(builtBinaryPath);
fs.writeFileSync(tempOutputPath, binaryContents);
if (!platformId.startsWith('win32-')) {
	fs.chmodSync(tempOutputPath, 0o755);
}
fs.rmSync(outputPath, { force: true });
fs.renameSync(tempOutputPath, outputPath);

console.log(`Bundled native sidecar at ${outputPath}`);

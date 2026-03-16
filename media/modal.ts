/// <reference path="webview.d.ts" />

(function () {
	const vscode = acquireVsCodeApi();
	const lifecycleOrigin = performance.now();

	function normalizeLifecycleValue(value: unknown): unknown {
		if (value instanceof Error) {
			return {
				name: value.name,
				message: value.message,
				stack: value.stack
			};
		}
		if (value === undefined) {
			return '[undefined]';
		}
		if (value && typeof value === 'object') {
			try {
				return JSON.parse(JSON.stringify(value));
			} catch {
				return String(value);
			}
		}
		return value;
	}

	function postLifecycle(event: string, detail?: Record<string, unknown>): void {
		const normalizedDetail = detail
			? Object.fromEntries(
				Object.entries(detail).map(([key, value]) => [key, normalizeLifecycleValue(value)])
			)
			: undefined;
		vscode.postMessage({
			type: 'lifecycleTrace',
			event,
			elapsedMs: Number((performance.now() - lifecycleOrigin).toFixed(1)),
			detail: normalizedDetail
		});
	}

	window.addEventListener('error', (event) => {
		postLifecycle('rendererError', {
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
			stack: event.error?.stack
		});
	});

	window.addEventListener('unhandledrejection', (event) => {
		postLifecycle('unhandledRejection', {
			reason: normalizeLifecycleValue(event.reason)
		});
	});

	postLifecycle('bootstrapStart');

	const queryInput = document.getElementById('query') as HTMLInputElement;
	const resultsRoot = document.getElementById('results')!;
	const previewRoot = document.getElementById('preview')!;
	const metaRoot = document.getElementById('meta')!;
	const statusRoot = document.getElementById('status')!;
	const caseToggle = document.getElementById('case-toggle')!;
	const wordToggle = document.getElementById('word-toggle')!;
	const regexToggle = document.getElementById('regex-toggle')!;
	const filterToggle = document.getElementById('filter-toggle')!;
	const filterRow = document.getElementById('filter-row')!;
	const includeFilterInput = document.getElementById('include-filter') as HTMLInputElement;
	const excludeFilterInput = document.getElementById('exclude-filter') as HTMLInputElement;
	const modalRoot = document.querySelector('.modal') as HTMLElement;
	const splitter = document.getElementById('splitter')!;
	const highlightSrc = document.body.dataset.highlightSrc;
	const scriptNonce = document.body.dataset.scriptNonce;

	let results: SerializedResult[] = [];
	let selectedIndex = 0;
	let currentQuery = '';
	let caseSensitive = false;
	let wordMatch = false;
	let regexEnabled = false;
	let filtersVisible = false;
	let includePattern = '';
	let excludePattern = '';
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let modalWidth = 0;
	let modalHeight = 0;
	let splitRatio = 0;
	let lastRenderedResults: SerializedResult[] | null = null;
	let pendingPreviewRaf = 0;
	let pendingHighlightTimer: ReturnType<typeof setTimeout> | 0 = 0;
	let pendingImageTimer: ReturnType<typeof setTimeout> | 0 = 0;
	let pendingResultHighlightRaf = 0;
	let cachedSearchPattern: RegExp | null = null;
	let cachedSearchPatternKey = '';
	let highlightLoaderPromise: Promise<boolean> | null = null;
	let resultHighlightVersion = 0;
	let visibleFrameVersion = 0;

	const savedState = vscode.getState();
	if (savedState?.query) {
		currentQuery = savedState.query;
		queryInput.value = currentQuery;
	}
	if (savedState?.caseSensitive) {
		caseSensitive = true;
	}
	if (savedState?.wordMatch) {
		wordMatch = true;
	}
	if (savedState?.regexEnabled) {
		regexEnabled = true;
	}
	if (savedState?.filtersVisible) {
		filtersVisible = true;
		filterRow.style.display = '';
	}
	if (savedState?.includePattern) {
		includePattern = savedState.includePattern;
		includeFilterInput.value = includePattern;
	}
	if (savedState?.excludePattern) {
		excludePattern = savedState.excludePattern;
		excludeFilterInput.value = excludePattern;
	}
	if (savedState?.modalWidth && savedState?.modalHeight) {
		modalWidth = savedState.modalWidth;
		modalHeight = savedState.modalHeight;
		modalRoot.style.width = modalWidth + 'px';
		modalRoot.style.height = modalHeight + 'px';
	}
	if (savedState?.splitRatio) {
		splitRatio = savedState.splitRatio;
		const r = Math.max(0.1, Math.min(0.9, splitRatio));
		modalRoot.style.gridTemplateRows = 'auto ' + r + 'fr 5px ' + (1 - r) + 'fr auto';
	}

	function escapeHtml(value: string): string {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function truncate(text: string, limit: number): string {
		if (text.length <= limit) {
			return text;
		}
		return text.slice(0, limit) + '\u2026';
	}

	const EXT_TO_LANG: Record<string, string> = {
		js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
		ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
		py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
		java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
		swift: 'swift', m: 'objectivec',
		css: 'css', scss: 'scss', less: 'less',
		html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
		json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
		md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash',
		sql: 'sql', r: 'r', php: 'php', pl: 'perl',
		lua: 'lua', diff: 'diff',
		graphql: 'graphql', gql: 'graphql',
	};

	function detectLanguage(relativePath: string): string | undefined {
		const ext = relativePath.split('.').pop()?.toLowerCase();
		return ext ? EXT_TO_LANG[ext] : undefined;
	}

	function syntaxHighlight(text: string, language: string): string {
		if (!language || typeof hljs === 'undefined') {
			return escapeHtml(text);
		}
		try {
			return hljs.highlight(text, { language, ignoreIllegals: true }).value;
		} catch {
			return escapeHtml(text);
		}
	}

	function ensureHighlightJs(): Promise<boolean> {
		if (typeof hljs !== 'undefined') {
			return Promise.resolve(true);
		}
		if (!highlightSrc) {
			return Promise.resolve(false);
		}
		if (!highlightLoaderPromise) {
			highlightLoaderPromise = new Promise((resolve) => {
				const script = document.createElement('script');
				script.src = highlightSrc;
				if (scriptNonce) {
					script.nonce = scriptNonce;
				}
				script.onload = () => resolve(typeof hljs !== 'undefined');
				script.onerror = () => resolve(false);
				document.body.appendChild(script);
			});
		}
		return highlightLoaderPromise;
	}

	interface TextSegment {
		node: Text;
		start: number;
		end: number;
	}

	function collectTextSegments(container: HTMLElement): { segments: TextSegment[]; fullText: string } {
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				return (node as Text).parentElement?.closest('mark')
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT;
			}
		});
		const segments: TextSegment[] = [];
		let fullText = '';

		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const text = node.textContent || '';
			if (!text) {
				continue;
			}

			const start = fullText.length;
			fullText += text;
			segments.push({
				node,
				start,
				end: fullText.length
			});
		}

		return { segments, fullText };
	}

	function resolveTextOffset(segments: TextSegment[], offset: number, isEndOffset: boolean): { node: Text; offset: number } | null {
		for (const segment of segments) {
			const withinSegment = isEndOffset
				? offset >= segment.start && offset <= segment.end
				: offset >= segment.start && offset < segment.end;
			if (!withinSegment) {
				continue;
			}

			return {
				node: segment.node,
				offset: offset - segment.start
			};
		}

		return null;
	}

	function wrapMatchesWithMarks(segments: TextSegment[], matches: Array<{ start: number; end: number }>): void {
		for (let index = matches.length - 1; index >= 0; index -= 1) {
			const match = matches[index];
			const start = resolveTextOffset(segments, match.start, false);
			const end = resolveTextOffset(segments, match.end, true);
			if (!start || !end) {
				continue;
			}

			const range = document.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);

			const mark = document.createElement('mark');
			mark.appendChild(range.extractContents());
			range.insertNode(mark);
		}
	}

	function getSearchPattern(): RegExp | null {
		const key = `${currentQuery}\0${caseSensitive}\0${wordMatch}\0${regexEnabled}`;
		if (cachedSearchPatternKey === key) {
			return cachedSearchPattern;
		}
		cachedSearchPatternKey = key;
		try {
			let source = regexEnabled
				? currentQuery
				: currentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			if (wordMatch) {
				source = '\\b' + source + '\\b';
			}
			const flags = caseSensitive ? 'g' : 'gi';
			cachedSearchPattern = new RegExp(source, flags);
		} catch {
			cachedSearchPattern = null;
		}
		return cachedSearchPattern;
	}

	function addSearchMarks(container: HTMLElement): void {
		if (!currentQuery) {
			return;
		}

		const pattern = getSearchPattern();
		if (!pattern) {
			return;
		}

		const { segments, fullText } = collectTextSegments(container);
		if (!fullText) {
			return;
		}

		const matches: Array<{ start: number; end: number }> = [];
		pattern.lastIndex = 0;
		let m;
		while ((m = pattern.exec(fullText)) !== null) {
			if (m[0].length === 0) {
				pattern.lastIndex++;
				continue;
			}
			matches.push({ start: m.index, end: pattern.lastIndex });
		}
		if (!matches.length) {
			return;
		}

		wrapMatchesWithMarks(segments, matches);
	}

	function syncState(): void {
		const state: WebviewPersistedState = { query: currentQuery, caseSensitive, wordMatch, regexEnabled, filtersVisible, includePattern, excludePattern };
		if (modalWidth && modalHeight) {
			state.modalWidth = modalWidth;
			state.modalHeight = modalHeight;
		}
		if (splitRatio) {
			state.splitRatio = splitRatio;
		}
		vscode.setState(state);
	}

	function applySplitRatio(ratio: number): void {
		splitRatio = ratio;
		const r = Math.max(0.1, Math.min(0.9, ratio));
		modalRoot.style.gridTemplateRows = 'auto ' + r + 'fr 5px ' + (1 - r) + 'fr auto';
	}

	function scheduleFirstVisibleFrame(source: string): void {
		const version = ++visibleFrameVersion;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (version !== visibleFrameVersion) {
					return;
				}
				postLifecycle('firstVisibleFrame', {
					source,
					hidden: document.hidden
				});
			});
		});
	}

	function syncCaseToggle(): void {
		caseToggle.classList.toggle('is-active', caseSensitive);
		caseToggle.setAttribute('aria-pressed', String(caseSensitive));
	}

	function syncWordToggle(): void {
		wordToggle.classList.toggle('is-active', wordMatch);
		wordToggle.setAttribute('aria-pressed', String(wordMatch));
	}

	function syncRegexToggle(): void {
		regexToggle.classList.toggle('is-active', regexEnabled);
		regexToggle.setAttribute('aria-pressed', String(regexEnabled));
	}

	function toggleCaseSensitive(): void {
		caseSensitive = !caseSensitive;
		syncCaseToggle();
		postQuery(queryInput.value);
	}

	function toggleWordMatch(): void {
		wordMatch = !wordMatch;
		syncWordToggle();
		postQuery(queryInput.value);
	}

	function toggleRegex(): void {
		regexEnabled = !regexEnabled;
		syncRegexToggle();
		postQuery(queryInput.value);
	}

	function updateFilterToggle(): void {
		filterToggle.classList.toggle('is-active', filtersVisible);
		filterToggle.setAttribute('aria-pressed', String(filtersVisible));
		filterRow.style.display = filtersVisible ? '' : 'none';
	}

	function postQuery(value: string): void {
		currentQuery = value;
		syncState();
		vscode.postMessage({ type: 'queryChanged', value, caseSensitive, wordMatch, regexEnabled, filtersVisible, includePattern, excludePattern });
	}

	function scheduleQuery(value: string): void {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => postQuery(value), 20);
	}

	function cancelResultHighlightWork(): void {
		resultHighlightVersion += 1;
		if (pendingResultHighlightRaf) {
			cancelAnimationFrame(pendingResultHighlightRaf);
			pendingResultHighlightRaf = 0;
		}
	}

	function scheduleResultHighlight(): void {
		cancelResultHighlightWork();

		const version = resultHighlightVersion;
		pendingResultHighlightRaf = requestAnimationFrame(() => {
			pendingResultHighlightRaf = 0;
			void highlightResultTitles(version);
		});
	}

	function highlightResultTitles(version: number): Promise<void> {
		const pendingTitles = Array.from(resultsRoot.querySelectorAll<HTMLElement>('.result-title.is-line'))
			.filter((element) => element.dataset.syntaxHighlighted !== 'true');
		if (!pendingTitles.length) {
			return Promise.resolve();
		}

		return ensureHighlightJs().then((ready) => {
			if (!ready || version !== resultHighlightVersion) {
				return;
			}

			processResultTitleBatch(prioritizeResultTitles(pendingTitles), 0, version);
		});
	}

	function prioritizeResultTitles(titles: HTMLElement[]): HTMLElement[] {
		const viewportTop = resultsRoot.scrollTop;
		const viewportBottom = viewportTop + resultsRoot.clientHeight;
		const selected: HTMLElement[] = [];
		const visible: HTMLElement[] = [];
		const remaining: HTMLElement[] = [];
		const seen = new Set<HTMLElement>();

		for (const title of titles) {
			const index = Number(title.dataset.resultIndex || '-1');
			const row = title.closest('.result') as HTMLElement | null;
			const top = row ? row.offsetTop : 0;
			const bottom = row ? top + row.offsetHeight : 0;

			if (index === selectedIndex) {
				selected.push(title);
				seen.add(title);
			}
			if (bottom >= viewportTop && top <= viewportBottom && !seen.has(title)) {
				visible.push(title);
				seen.add(title);
				continue;
			}
			if (!seen.has(title)) {
				remaining.push(title);
			}
		}

		return selected.concat(visible, remaining);
	}

	function processResultTitleBatch(queue: HTMLElement[], startIndex: number, version: number): void {
		if (version !== resultHighlightVersion) {
			return;
		}

		const endIndex = Math.min(startIndex + 12, queue.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			highlightResultTitle(queue[index]);
		}

		if (endIndex >= queue.length) {
			return;
		}

		pendingResultHighlightRaf = requestAnimationFrame(() => {
			pendingResultHighlightRaf = 0;
			processResultTitleBatch(queue, endIndex, version);
		});
	}

	function highlightResultTitle(titleElement: HTMLElement): void {
		const rawText = titleElement.dataset.rawText;
		const language = titleElement.dataset.language;
		if (!rawText || !language) {
			titleElement.dataset.syntaxHighlighted = 'true';
			return;
		}

		titleElement.innerHTML = syntaxHighlight(rawText, language);
		addSearchMarks(titleElement);
		titleElement.dataset.syntaxHighlighted = 'true';
	}

	function renderResults(): void {
		if (!results.length) {
			resultsRoot.innerHTML = '<div class="empty">No matches yet.<br />Try a shorter query or fewer terms.</div>';
			lastRenderedResults = results;
			return;
		}

		resultsRoot.innerHTML = results.map((result, index) => {
			const selectedClass = index === selectedIndex ? 'is-selected' : '';
			const badgeClass = result.kind === 'line' ? 'is-line' : 'is-file';
			const titleClass = result.kind === 'line' ? 'is-line' : 'is-file';
			const displayText = truncate(result.displayText, 120);
			const language = result.kind === 'line' ? detectLanguage(result.relativePath) : '';
			const titleHtml = language
				? syntaxHighlight(displayText, language)
				: escapeHtml(displayText);
			const highlighted = language && typeof hljs !== 'undefined' ? 'true' : '';
			return `
				<button class="result ${selectedClass}" data-result-id="${escapeHtml(result.id)}" data-index="${index}">
					<div class="badge ${badgeClass}">${escapeHtml(result.kind)}</div>
					<div class="result-main">
						<div class="result-title ${titleClass}" data-result-index="${index}" data-raw-text="${escapeHtml(displayText)}" data-language="${escapeHtml(language || '')}" data-syntax-highlighted="${highlighted}">${titleHtml}</div>
					</div>
					<div class="result-pos">${escapeHtml(result.metaText)}</div>
				</button>
			`;
		}).join('');

		resultsRoot.querySelectorAll<HTMLElement>('.result-title').forEach(addSearchMarks);
		scheduleResultHighlight();
		lastRenderedResults = results;
	}

	function renderPreview(): void {
		if (pendingHighlightTimer) {
			clearTimeout(pendingHighlightTimer);
			pendingHighlightTimer = 0;
		}
		if (pendingImageTimer) {
			clearTimeout(pendingImageTimer);
			pendingImageTimer = 0;
		}

		const selected = results[selectedIndex];
		if (!selected) {
			previewRoot.innerHTML = '<div class="empty">Preview will appear here.</div>';
			return;
		}

		// Image preview with 250ms debounce
		if (selected.imageUri) {
			previewRoot.innerHTML = `
				<div class="preview-header">
					<div>${escapeHtml(selected.relativePath)}</div>
					<div></div>
				</div>
				<div class="image-preview"></div>
			`;
			const snapshot = selectedIndex;
			pendingImageTimer = setTimeout(() => {
				pendingImageTimer = 0;
				if (selectedIndex !== snapshot) {
					return;
				}
				const container = previewRoot.querySelector('.image-preview');
				if (container) {
					const img = document.createElement('img');
					img.src = selected.imageUri!;
					img.alt = selected.relativePath;
					container.appendChild(img);
				}
			}, 250);
			return;
		}

		// Render preview with syntax highlighting if hljs is ready, plain text otherwise
		const language = detectLanguage(selected.relativePath);
		const canHighlight = !!language && typeof hljs !== 'undefined';
		const previewLines = selected.preview.map((line) => `
			<div class="code-line ${line.isMatch ? 'is-match' : ''}">
				<div class="line-number">${line.lineNumber}</div>
				<div class="code-text">${canHighlight ? syntaxHighlight(line.text || ' ', language) : escapeHtml(line.text || ' ')}</div>
			</div>
		`).join('');

		previewRoot.innerHTML = `
			<div class="preview-header">
				<div>${escapeHtml(selected.relativePath)}</div>
				<div>${escapeHtml(selected.kind === 'line' ? selected.lineNumber + ':' + selected.column : '')}</div>
			</div>
			<div class="code">${previewLines}</div>
		`;

		const matchLine = previewRoot.querySelector('.code-line.is-match');
		if (matchLine) {
			scrollWithin(previewRoot, matchLine as HTMLElement, 'center');
		}

		if (canHighlight) {
			// Already highlighted synchronously — just add search marks
			previewRoot.querySelectorAll<HTMLElement>('.code-line.is-match > .code-text').forEach(addSearchMarks);
		} else {
			// hljs not loaded yet — defer highlighting
			const snapshot = selectedIndex;
			pendingHighlightTimer = setTimeout(() => {
				pendingHighlightTimer = 0;
				if (selectedIndex !== snapshot) {
					return;
				}
				const markMatches = () => {
					previewRoot.querySelectorAll<HTMLElement>('.code-line.is-match > .code-text').forEach(addSearchMarks);
				};
				if (!language) {
					markMatches();
					return;
				}

				void ensureHighlightJs().then((ready) => {
					if (selectedIndex !== snapshot) {
						return;
					}
					if (ready) {
						previewRoot.querySelectorAll<HTMLElement>('.code-text').forEach((el) => {
							el.innerHTML = syntaxHighlight(el.textContent || ' ', language);
						});
					}
					markMatches();
				});
			}, 100);
		}
	}

	function renderAll(): void {
		cancelResultHighlightWork();
		if (pendingPreviewRaf) {
			cancelAnimationFrame(pendingPreviewRaf);
			pendingPreviewRaf = 0;
		}
		if (pendingHighlightTimer) {
			clearTimeout(pendingHighlightTimer);
			pendingHighlightTimer = 0;
		}
		if (pendingImageTimer) {
			clearTimeout(pendingImageTimer);
			pendingImageTimer = 0;
		}
		renderResults();
		renderPreview();
	}

	function scrollWithin(container: HTMLElement, element: HTMLElement, mode: 'center' | 'nearest'): void {
		const cRect = container.getBoundingClientRect();
		const eRect = element.getBoundingClientRect();
		const eTop = eRect.top - cRect.top + container.scrollTop;
		const eHeight = eRect.height;
		const cHeight = container.clientHeight;

		if (mode === 'center') {
			// Show 5 lines of padding above the match
			const padding = eHeight * 5;
			container.scrollTop = Math.max(0, eTop - padding);
		} else {
			// nearest
			const cTop = container.scrollTop;
			if (eTop < cTop) {
				container.scrollTop = eTop;
			} else if (eTop + eHeight > cTop + cHeight) {
				container.scrollTop = eTop + eHeight - cHeight;
			}
		}
	}

	function updateSelectionClass(oldIndex: number, newIndex: number): void {
		if (oldIndex === newIndex) {
			return;
		}
		const oldEl = resultsRoot.querySelector('[data-index="' + oldIndex + '"]');
		const newEl = resultsRoot.querySelector('[data-index="' + newIndex + '"]');
		if (oldEl) {
			oldEl.classList.remove('is-selected');
		}
		if (newEl) {
			newEl.classList.add('is-selected');
		}
	}

	function schedulePreviewUpdate(): void {
		if (pendingPreviewRaf) {
			return;
		}
		pendingPreviewRaf = requestAnimationFrame(() => {
			pendingPreviewRaf = 0;
			renderPreview();
		});
	}

	function selectIndex(index: number, { focus = false } = {}): void {
		if (!results.length) {
			selectedIndex = 0;
			renderAll();
			return;
		}

		const prevIndex = selectedIndex;
		selectedIndex = Math.max(0, Math.min(index, results.length - 1));

		if (lastRenderedResults === results) {
			updateSelectionClass(prevIndex, selectedIndex);
			schedulePreviewUpdate();
		} else {
			renderAll();
		}

		const selectedElement = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]') as HTMLElement | null;
		if (selectedElement) {
			scrollWithin(resultsRoot, selectedElement, 'nearest');
		}
		if (focus) {
			selectedElement?.focus();
		}
	}

	function moveSelection(delta: number): void {
		if (!results.length) {
			return;
		}

		const nextIndex = (selectedIndex + delta + results.length) % results.length;
		const focusInResults = resultsRoot.contains(document.activeElement);
		selectIndex(nextIndex, { focus: focusInResults });
	}

	function openSelected(): void {
		const selected = results[selectedIndex];
		if (!selected) {
			return;
		}

		vscode.postMessage({ type: 'openResult', resultId: selected.id });
	}

	function focusSelectedButton(): void {
		const el = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]') as HTMLElement | null;
		if (el) {
			el.focus();
		}
	}

	queryInput.addEventListener('input', () => {
		scheduleQuery(queryInput.value);
	});

	caseToggle.addEventListener('click', toggleCaseSensitive);
	wordToggle.addEventListener('click', toggleWordMatch);
	regexToggle.addEventListener('click', toggleRegex);

	filterToggle.addEventListener('click', () => {
		filtersVisible = !filtersVisible;
		updateFilterToggle();
		if (filtersVisible) {
			includeFilterInput.focus();
		}
		postQuery(queryInput.value);
	});

	includeFilterInput.addEventListener('input', () => {
		includePattern = includeFilterInput.value;
		scheduleQuery(queryInput.value);
	});

	excludeFilterInput.addEventListener('input', () => {
		excludePattern = excludeFilterInput.value;
		scheduleQuery(queryInput.value);
	});

	includeFilterInput.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			queryInput.focus();
		}
	});

	excludeFilterInput.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			queryInput.focus();
		}
	});

	queryInput.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveSelection(1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveSelection(-1);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			openSelected();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			vscode.postMessage({ type: 'close' });
		}
	});

	document.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
			event.preventDefault();
			queryInput.focus();
			queryInput.select();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			if (previewRoot.contains(document.activeElement) || document.activeElement === previewRoot) {
				queryInput.focus();
				return;
			}
			vscode.postMessage({ type: 'close' });
			return;
		}
		if (document.activeElement === queryInput) {
			return;
		}
		if (previewRoot.contains(document.activeElement) || document.activeElement === previewRoot) {
			// Let arrow keys scroll the preview naturally
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveSelection(1);
			focusSelectedButton();
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveSelection(-1);
			focusSelectedButton();
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			openSelected();
			return;
		}
	});

	resultsRoot.addEventListener('click', (event) => {
		const button = (event.target as HTMLElement).closest('[data-result-id]') as HTMLElement | null;
		if (!button) {
			return;
		}

		const index = Number(button.dataset.index || '0');
		if (index === selectedIndex) {
			button.focus();
			return;
		}
		selectIndex(index, { focus: true });
	});

	resultsRoot.addEventListener('dblclick', (event) => {
		const button = (event.target as HTMLElement).closest('[data-result-id]') as HTMLElement | null;
		if (!button) {
			return;
		}

		const index = Number(button.dataset.index || '0');
		selectIndex(index);
		openSelected();
	});

	resultsRoot.addEventListener('scroll', () => {
		scheduleResultHighlight();
	});

	interface ResizeState {
		corner: string;
		startX: number;
		startY: number;
		startW: number;
		startH: number;
	}

	window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
		const message = event.data;
		switch (message.type) {
			case 'focusQuery':
				if (message.query) {
					queryInput.value = message.query;
					postQuery(message.query);
				}
				queryInput.focus();
				queryInput.select();
				return;
			case 'searching':
				statusRoot.textContent = message.query ? 'Searching\u2026' : 'Loading index\u2026';
				return;
			case 'idle':
				results = [];
				selectedIndex = 0;
				metaRoot.textContent = message.metaMessage || 'Type to search the workspace.';
				statusRoot.textContent = message.statusMessage || 'Type to search';
				renderAll();
				return;
			case 'results':
				currentQuery = message.query;
				results = message.results;
				if (wordMatch && currentQuery) {
					try {
						const escaped = regexEnabled
							? currentQuery
							: currentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
						const wordPattern = new RegExp('\\b' + escaped + '\\b', caseSensitive ? '' : 'i');
						results = results.filter((r) => {
							const text = r.kind === 'line' ? r.displayText : r.relativePath;
							return wordPattern.test(text);
						});
					} catch {
						// If regex is invalid, skip filtering
					}
				}
				selectedIndex = 0;
				metaRoot.textContent = message.meta.searchableFileCount + ' searchable / ' + message.meta.indexedFileCount + ' indexed / ' + message.meta.skippedFileCount + ' path-only';
				statusRoot.textContent = results.length + ' results in ' + message.meta.durationMs + ' ms';
				renderAll();
				return;
			case 'error':
				statusRoot.textContent = message.message;
				results = [];
				renderAll();
				return;
			case 'restoreDimensions':
				if (message.width && message.height) {
					modalWidth = message.width;
					modalHeight = message.height;
					modalRoot.style.width = modalWidth + 'px';
					modalRoot.style.height = modalHeight + 'px';
				}
				if (message.splitRatio) {
					applySplitRatio(message.splitRatio);
				}
				syncState();
				return;
			case 'restoreSearchSettings':
				currentQuery = message.query;
				queryInput.value = currentQuery;
				caseSensitive = message.caseSensitive;
				wordMatch = message.wordMatch;
				regexEnabled = message.regexEnabled;
				filtersVisible = message.filtersVisible;
				includePattern = message.includePattern;
				excludePattern = message.excludePattern;
				includeFilterInput.value = includePattern;
				excludeFilterInput.value = excludePattern;
				syncCaseToggle();
				syncWordToggle();
				syncRegexToggle();
				updateFilterToggle();
				syncState();
				if (currentQuery) {
					postQuery(currentQuery);
				}
				return;
			case 'toggleSearchOption':
				if (message.option === 'caseSensitive') {
					toggleCaseSensitive();
				} else if (message.option === 'wordMatch') {
					toggleWordMatch();
				} else if (message.option === 'regexEnabled') {
					toggleRegex();
				} else if (message.option === 'filter') {
					filtersVisible = !filtersVisible;
					updateFilterToggle();
					if (filtersVisible) {
						includeFilterInput.focus();
					}
					postQuery(queryInput.value);
				}
				return;
		}
	});

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			return;
		}
		postLifecycle('visibleAgain', {
			visibilityState: document.visibilityState
		});
		scheduleFirstVisibleFrame('visibleAgain');
	});

	// Corner resize handles
	(function initResize() {
		let active: ResizeState | null = null;
		let rafId = 0;

		document.addEventListener('mousedown', (event) => {
			const handle = (event.target as HTMLElement).closest('[data-resize]') as HTMLElement | null;
			if (!handle) {
				return;
			}
			event.preventDefault();
			const rect = modalRoot.getBoundingClientRect();
			active = {
				corner: handle.dataset.resize!,
				startX: event.clientX,
				startY: event.clientY,
				startW: rect.width,
				startH: rect.height
			};
		});

		document.addEventListener('mousemove', (event) => {
			if (!active) {
				return;
			}
			event.preventDefault();

			const cx = event.clientX;
			const cy = event.clientY;

			if (rafId) {
				return;
			}
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				if (!active) {
					return;
				}
				const dx = cx - active.startX;
				const dy = cy - active.startY;
				let newW = active.startW;
				let newH = active.startH;

				if (active.corner === 'se') { newW += dx; newH += dy; }
				else if (active.corner === 'sw') { newW -= dx; newH += dy; }
				else if (active.corner === 'ne') { newW += dx; newH -= dy; }
				else if (active.corner === 'nw') { newW -= dx; newH -= dy; }

				newW = Math.max(480, Math.min(newW, window.innerWidth * 0.96));
				newH = Math.max(400, Math.min(newH, window.innerHeight * 0.92));

				modalRoot.style.width = newW + 'px';
				modalRoot.style.height = newH + 'px';
			});
		});

		document.addEventListener('mouseup', () => {
			if (!active) {
				return;
			}
			if (rafId) {
				cancelAnimationFrame(rafId);
				rafId = 0;
			}
			const rect = modalRoot.getBoundingClientRect();
			modalWidth = Math.round(rect.width);
			modalHeight = Math.round(rect.height);
			active = null;
			syncState();
			vscode.postMessage({ type: 'resizeDimensionsChanged', width: modalWidth, height: modalHeight });
		});
	})();

	// Splitter drag to resize results vs preview
	(function initSplitter() {
		interface SplitterState {
			startY: number;
			startResultsH: number;
			startPreviewH: number;
		}

		let active: SplitterState | null = null;
		let rafId = 0;

		splitter.addEventListener('mousedown', (event) => {
			event.preventDefault();
			const resultsRect = resultsRoot.getBoundingClientRect();
			const previewRect = previewRoot.getBoundingClientRect();
			active = {
				startY: event.clientY,
				startResultsH: resultsRect.height,
				startPreviewH: previewRect.height
			};
		});

		document.addEventListener('mousemove', (event) => {
			if (!active) {
				return;
			}
			event.preventDefault();

			const cy = event.clientY;

			if (rafId) {
				return;
			}
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				if (!active) {
					return;
				}
				const dy = cy - active.startY;
				const totalH = active.startResultsH + active.startPreviewH;
				const newResultsH = Math.max(80, Math.min(totalH - 80, active.startResultsH + dy));
				const ratio = newResultsH / totalH;
				applySplitRatio(ratio);
			});
		});

		document.addEventListener('mouseup', () => {
			if (!active) {
				return;
			}
			if (rafId) {
				cancelAnimationFrame(rafId);
				rafId = 0;
			}
			active = null;
			syncState();
			vscode.postMessage({ type: 'splitRatioChanged', ratio: splitRatio });
		});
	})();

	const isMac = navigator.platform.toUpperCase().includes('MAC') || navigator.userAgent.includes('Macintosh');
	caseToggle.title = isMac ? 'Case Sensitive (⌥⌘C)' : 'Case Sensitive (Ctrl+Alt+C)';
	caseToggle.setAttribute('aria-label', caseToggle.title);
	wordToggle.title = isMac ? 'Words (⌥⌘W)' : 'Words (Ctrl+Alt+W)';
	wordToggle.setAttribute('aria-label', wordToggle.title);
	regexToggle.title = isMac ? 'Regex (⌥⌘R)' : 'Regex (Ctrl+Alt+R)';
	regexToggle.setAttribute('aria-label', regexToggle.title);
	filterToggle.title = isMac ? 'Filter Files (⌥⌘F)' : 'Filter Files (Ctrl+Alt+F)';
	filterToggle.setAttribute('aria-label', filterToggle.title);

	syncCaseToggle();
	syncWordToggle();
	syncRegexToggle();
	updateFilterToggle();
	queryInput.focus();
	queryInput.select();
	renderAll();
	syncState();
	postLifecycle('ready', {
		hasQuery: Boolean(currentQuery),
		caseSensitive,
		wordMatch,
		regexEnabled
	});
	if (!document.hidden) {
		scheduleFirstVisibleFrame('bootstrap');
	}
	vscode.postMessage({
		type: 'ready',
		query: currentQuery,
		caseSensitive,
		wordMatch,
		regexEnabled
	});
})();

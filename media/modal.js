// @ts-nocheck
/* eslint-disable */
(function () {
	const vscode = acquireVsCodeApi();
	const lifecycleOrigin = performance.now();

	function normalizeLifecycleValue(value) {
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

	function postLifecycle(event, detail) {
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

	const queryInput = document.getElementById('query');
	const resultsRoot = document.getElementById('results');
	const previewRoot = document.getElementById('preview');
	const metaRoot = document.getElementById('meta');
	const statusRoot = document.getElementById('status');
	const caseToggle = document.getElementById('case-toggle');
	const regexToggle = document.getElementById('regex-toggle');
	const modalRoot = document.querySelector('.modal');
	const splitter = document.getElementById('splitter');
	const highlightSrc = document.body.dataset.highlightSrc;
	const scriptNonce = document.body.dataset.scriptNonce;

	let results = [];
	let selectedIndex = 0;
	let currentQuery = '';
	let caseSensitive = false;
	let regexEnabled = false;
	let debounceTimer;
	let modalWidth = 0;
	let modalHeight = 0;
	let splitRatio = 0;
	let lastRenderedResults = null;
	let pendingPreviewRaf = 0;
	let pendingHighlightTimer = 0;
	let pendingResultHighlightRaf = 0;
	let highlightLoaderPromise = null;
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
	if (savedState?.regexEnabled) {
		regexEnabled = true;
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

	function escapeHtml(value) {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function truncate(text, limit) {
		if (text.length <= limit) {
			return text;
		}
		return text.slice(0, limit) + '\u2026';
	}

	const EXT_TO_LANG = {
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

	function detectLanguage(relativePath) {
		const ext = relativePath.split('.').pop()?.toLowerCase();
		return ext ? EXT_TO_LANG[ext] : undefined;
	}

	function syntaxHighlight(text, language) {
		if (!language || typeof hljs === 'undefined') {
			return escapeHtml(text);
		}
		try {
			return hljs.highlight(text, { language, ignoreIllegals: true }).value;
		} catch {
			return escapeHtml(text);
		}
	}

	function ensureHighlightJs() {
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

	function collectTextSegments(container) {
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				return node.parentElement?.closest('mark')
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT;
			}
		});
		const segments = [];
		let fullText = '';

		while (walker.nextNode()) {
			const node = walker.currentNode;
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

	function resolveTextOffset(segments, offset, isEndOffset) {
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

	function wrapMatchesWithMarks(segments, matches) {
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

	function addSearchMarks(container) {
		if (!currentQuery) {
			return;
		}

		let pattern;
		try {
			const source = regexEnabled
				? currentQuery
				: currentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const flags = caseSensitive ? 'g' : 'gi';
			pattern = new RegExp(source, flags);
		} catch {
			return;
		}

		const { segments, fullText } = collectTextSegments(container);
		if (!fullText) {
			return;
		}

		const matches = [];
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

	function syncState() {
		const state = { query: currentQuery, caseSensitive, regexEnabled };
		if (modalWidth && modalHeight) {
			state.modalWidth = modalWidth;
			state.modalHeight = modalHeight;
		}
		if (splitRatio) {
			state.splitRatio = splitRatio;
		}
		vscode.setState(state);
	}

	function applySplitRatio(ratio) {
		splitRatio = ratio;
		const r = Math.max(0.1, Math.min(0.9, ratio));
		modalRoot.style.gridTemplateRows = 'auto ' + r + 'fr 5px ' + (1 - r) + 'fr auto';
	}

	function scheduleFirstVisibleFrame(source) {
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

	function updateCaseToggle() {
		caseToggle.classList.toggle('is-active', caseSensitive);
		caseToggle.setAttribute('aria-pressed', String(caseSensitive));
	}

	function updateRegexToggle() {
		regexToggle.classList.toggle('is-active', regexEnabled);
		regexToggle.setAttribute('aria-pressed', String(regexEnabled));
	}

	function postQuery(value) {
		currentQuery = value;
		syncState();
		vscode.postMessage({ type: 'queryChanged', value, caseSensitive, regexEnabled });
	}

	function scheduleQuery(value) {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => postQuery(value), 100);
	}

	function cancelResultHighlightWork() {
		resultHighlightVersion += 1;
		if (pendingResultHighlightRaf) {
			cancelAnimationFrame(pendingResultHighlightRaf);
			pendingResultHighlightRaf = 0;
		}
	}

	function scheduleResultHighlight() {
		cancelResultHighlightWork();

		const version = resultHighlightVersion;
		pendingResultHighlightRaf = requestAnimationFrame(() => {
			pendingResultHighlightRaf = 0;
			void highlightResultTitles(version);
		});
	}

	function highlightResultTitles(version) {
		const pendingTitles = Array.from(resultsRoot.querySelectorAll('.result-title.is-line'))
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

	function prioritizeResultTitles(titles) {
		const viewportTop = resultsRoot.scrollTop;
		const viewportBottom = viewportTop + resultsRoot.clientHeight;
		const selected = [];
		const visible = [];
		const remaining = [];
		const seen = new Set();

		for (const title of titles) {
			const index = Number(title.dataset.resultIndex || '-1');
			const row = title.closest('.result');
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

	function processResultTitleBatch(queue, startIndex, version) {
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

	function highlightResultTitle(titleElement) {
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

	function renderResults() {
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
			const titleHtml = escapeHtml(displayText);
			return `
				<button class="result ${selectedClass}" data-result-id="${escapeHtml(result.id)}" data-index="${index}">
					<div class="badge ${badgeClass}">${escapeHtml(result.kind)}</div>
					<div class="result-main">
						<div class="result-title ${titleClass}" data-result-index="${index}" data-raw-text="${escapeHtml(displayText)}" data-language="${escapeHtml(language || '')}">${titleHtml}</div>
					</div>
					<div class="result-pos">${escapeHtml(result.metaText)}</div>
				</button>
			`;
		}).join('');

		resultsRoot.querySelectorAll('.result-title').forEach(addSearchMarks);
		scheduleResultHighlight();
		lastRenderedResults = results;
	}

	function renderPreview() {
		if (pendingHighlightTimer) {
			clearTimeout(pendingHighlightTimer);
			pendingHighlightTimer = 0;
		}

		const selected = results[selectedIndex];
		if (!selected) {
			previewRoot.innerHTML = '<div class="empty">Preview will appear here.</div>';
			return;
		}

		// Phase 1: fast render with plain text (no syntax highlighting)
		const previewLines = selected.preview.map((line) => `
			<div class="code-line ${line.isMatch ? 'is-match' : ''}">
				<div class="line-number">${line.lineNumber}</div>
				<div class="code-text">${escapeHtml(line.text || ' ')}</div>
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
			scrollWithin(previewRoot, matchLine, 'center');
		}

		// Phase 2: deferred syntax highlighting + search marks after settling
		const snapshot = selectedIndex;
		pendingHighlightTimer = setTimeout(() => {
			pendingHighlightTimer = 0;
			if (selectedIndex !== snapshot) {
				return;
			}
			const markMatches = () => {
				previewRoot.querySelectorAll('.code-line.is-match > .code-text').forEach(addSearchMarks);
			};
			const language = detectLanguage(selected.relativePath);
			if (!language) {
				markMatches();
				return;
			}

			void ensureHighlightJs().then((ready) => {
				if (selectedIndex !== snapshot) {
					return;
				}
				if (ready) {
					previewRoot.querySelectorAll('.code-text').forEach((el) => {
						el.innerHTML = syntaxHighlight(el.textContent || ' ', language);
					});
				}
				markMatches();
			});
		}, 100);
	}

	function renderAll() {
		cancelResultHighlightWork();
		if (pendingPreviewRaf) {
			cancelAnimationFrame(pendingPreviewRaf);
			pendingPreviewRaf = 0;
		}
		if (pendingHighlightTimer) {
			clearTimeout(pendingHighlightTimer);
			pendingHighlightTimer = 0;
		}
		renderResults();
		renderPreview();
	}

	function scrollWithin(container, element, mode) {
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

	function updateSelectionClass(oldIndex, newIndex) {
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

	function schedulePreviewUpdate() {
		if (pendingPreviewRaf) {
			return;
		}
		pendingPreviewRaf = requestAnimationFrame(() => {
			pendingPreviewRaf = 0;
			renderPreview();
		});
	}

	function selectIndex(index, { focus = false } = {}) {
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

		const selectedElement = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]');
		if (selectedElement) {
			scrollWithin(resultsRoot, selectedElement, 'nearest');
		}
		if (focus) {
			selectedElement?.focus();
		}
	}

	function moveSelection(delta) {
		if (!results.length) {
			return;
		}

		const nextIndex = (selectedIndex + delta + results.length) % results.length;
		const focusInResults = resultsRoot.contains(document.activeElement);
		selectIndex(nextIndex, { focus: focusInResults });
	}

	function openSelected() {
		const selected = results[selectedIndex];
		if (!selected) {
			return;
		}

		vscode.postMessage({ type: 'openResult', resultId: selected.id });
	}

	function focusSelectedButton() {
		const el = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]');
		if (el) {
			el.focus();
		}
	}

	queryInput.addEventListener('input', () => {
		scheduleQuery(queryInput.value);
	});

	caseToggle.addEventListener('click', () => {
		caseSensitive = !caseSensitive;
		updateCaseToggle();
		postQuery(queryInput.value);
	});

	regexToggle.addEventListener('click', () => {
		regexEnabled = !regexEnabled;
		updateRegexToggle();
		postQuery(queryInput.value);
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
		const button = event.target.closest('[data-result-id]');
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
		const button = event.target.closest('[data-result-id]');
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

	window.addEventListener('message', (event) => {
		const message = event.data;
		switch (message.type) {
			case 'focusQuery':
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
		let active = null;
		let rafId = 0;

		document.addEventListener('mousedown', (event) => {
			const handle = event.target.closest('[data-resize]');
			if (!handle) {
				return;
			}
			event.preventDefault();
			const rect = modalRoot.getBoundingClientRect();
			active = {
				corner: handle.dataset.resize,
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
		let active = null;
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

	updateCaseToggle();
	updateRegexToggle();
	queryInput.focus();
	queryInput.select();
	renderAll();
	syncState();
	postLifecycle('ready', {
		hasQuery: Boolean(currentQuery),
		caseSensitive,
		regexEnabled
	});
	if (!document.hidden) {
		scheduleFirstVisibleFrame('bootstrap');
	}
	vscode.postMessage({
		type: 'ready',
		query: currentQuery,
		caseSensitive,
		regexEnabled
	});
})();

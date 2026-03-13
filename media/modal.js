// @ts-nocheck
/* eslint-disable */
(function () {
	const vscode = acquireVsCodeApi();
	const queryInput = document.getElementById('query');
	const resultsRoot = document.getElementById('results');
	const previewRoot = document.getElementById('preview');
	const metaRoot = document.getElementById('meta');
	const statusRoot = document.getElementById('status');
	const caseToggle = document.getElementById('case-toggle');
	const regexToggle = document.getElementById('regex-toggle');
	const modalRoot = document.querySelector('.modal');
	const splitter = document.getElementById('splitter');

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

		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes = [];
		while (walker.nextNode()) {
			textNodes.push(walker.currentNode);
		}

		for (const node of textNodes) {
			const text = node.textContent;
			if (!text) {
				continue;
			}

			pattern.lastIndex = 0;
			const matches = [];
			let m;
			while ((m = pattern.exec(text)) !== null) {
				if (m[0].length === 0) {
					pattern.lastIndex++;
					continue;
				}
				matches.push({ start: m.index, end: pattern.lastIndex });
			}
			if (!matches.length) {
				continue;
			}

			const frag = document.createDocumentFragment();
			let lastIdx = 0;
			for (const match of matches) {
				if (match.start > lastIdx) {
					frag.appendChild(document.createTextNode(text.slice(lastIdx, match.start)));
				}
				const mark = document.createElement('mark');
				mark.textContent = text.slice(match.start, match.end);
				frag.appendChild(mark);
				lastIdx = match.end;
			}
			if (lastIdx < text.length) {
				frag.appendChild(document.createTextNode(text.slice(lastIdx)));
			}
			node.parentNode.replaceChild(frag, node);
		}
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
			const titleHtml = result.kind === 'line'
				? syntaxHighlight(displayText, detectLanguage(result.relativePath))
				: escapeHtml(displayText);
			return `
				<button class="result ${selectedClass}" data-result-id="${escapeHtml(result.id)}" data-index="${index}">
					<div class="badge ${badgeClass}">${escapeHtml(result.kind)}</div>
					<div class="result-main">
						<div class="result-title ${titleClass}">${titleHtml}</div>
					</div>
					<div class="result-pos">${escapeHtml(result.metaText)}</div>
				</button>
			`;
		}).join('');

		resultsRoot.querySelectorAll('.result-title').forEach(addSearchMarks);
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
			const language = detectLanguage(selected.relativePath);
			if (language) {
				previewRoot.querySelectorAll('.code-text').forEach((el) => {
					el.innerHTML = syntaxHighlight(el.textContent || ' ', language);
				});
			}
			previewRoot.querySelectorAll('.code-line.is-match > .code-text').forEach(addSearchMarks);
		}, 100);
	}

	function renderAll() {
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
		const eTop = element.offsetTop;
		const eHeight = element.offsetHeight;
		const cTop = container.scrollTop;
		const cHeight = container.clientHeight;

		if (mode === 'center') {
			container.scrollTop = eTop - (cHeight / 2) + (eHeight / 2);
		} else {
			// nearest
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
	vscode.postMessage({
		type: 'ready',
		query: currentQuery,
		caseSensitive,
		regexEnabled
	});
})();

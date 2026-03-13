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

	let results = [];
	let selectedIndex = 0;
	let currentQuery = '';
	let caseSensitive = false;
	let regexEnabled = false;
	let debounceTimer;

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

	function highlightText(text) {
		if (!currentQuery) {
			return escapeHtml(text);
		}

		let pattern;
		try {
			const source = regexEnabled
				? currentQuery
				: currentQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const flags = caseSensitive ? 'g' : 'gi';
			pattern = new RegExp(source, flags);
		} catch {
			return escapeHtml(text);
		}

		const parts = [];
		let lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			if (match[0].length === 0) {
				pattern.lastIndex++;
				continue;
			}
			if (match.index > lastIndex) {
				parts.push(escapeHtml(text.slice(lastIndex, match.index)));
			}
			parts.push('<mark>' + escapeHtml(match[0]) + '</mark>');
			lastIndex = pattern.lastIndex;
		}
		if (lastIndex < text.length) {
			parts.push(escapeHtml(text.slice(lastIndex)));
		}

		return parts.length ? parts.join('') : escapeHtml(text);
	}

	function syncState() {
		vscode.setState({ query: currentQuery, caseSensitive, regexEnabled });
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
			return;
		}

		resultsRoot.innerHTML = results.map((result, index) => {
			const selectedClass = index === selectedIndex ? 'is-selected' : '';
			const badgeClass = result.kind === 'line' ? 'is-line' : 'is-file';
			const titleClass = result.kind === 'line' ? 'is-line' : 'is-file';
			return `
				<button class="result ${selectedClass}" data-result-id="${escapeHtml(result.id)}" data-index="${index}">
					<div class="badge ${badgeClass}">${escapeHtml(result.kind)}</div>
					<div class="result-main">
						<div class="result-title ${titleClass}">${highlightText(truncate(result.displayText, 120))}</div>
					</div>
					<div class="result-pos">${escapeHtml(result.metaText)}</div>
				</button>
			`;
		}).join('');
	}

	function renderPreview() {
		const selected = results[selectedIndex];
		if (!selected) {
			previewRoot.innerHTML = '<div class="empty">Preview will appear here.</div>';
			return;
		}

		const previewLines = selected.preview.map((line) => `
			<div class="code-line ${line.isMatch ? 'is-match' : ''}">
				<div class="line-number">${line.lineNumber}</div>
				<div>${line.isMatch ? highlightText(line.text || ' ') : escapeHtml(line.text || ' ')}</div>
			</div>
		`).join('');

		previewRoot.innerHTML = `
			<div class="preview-header">
				<div>${escapeHtml(selected.relativePath)}</div>
				<div>${escapeHtml(selected.kind === 'line' ? selected.lineNumber + ':' + selected.column : 'file preview')}</div>
			</div>
			<div class="code">${previewLines}</div>
		`;
	}

	function renderAll() {
		renderResults();
		renderPreview();
	}

	function selectIndex(index, { focus = false } = {}) {
		if (!results.length) {
			selectedIndex = 0;
			renderAll();
			return;
		}

		selectedIndex = Math.max(0, Math.min(index, results.length - 1));
		renderAll();

		const selectedElement = resultsRoot.querySelector('[data-index="' + selectedIndex + '"]');
		selectedElement?.scrollIntoView({ block: 'nearest' });
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
			vscode.postMessage({ type: 'close' });
			return;
		}
		if (document.activeElement === queryInput) {
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
		}
	});

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

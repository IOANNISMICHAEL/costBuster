(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  let allData = null;
  let dailyChart = null;
  let modelChart = null;
  const sortState = {};
  const tableDataMap = new Map();

  let activeProvider = 'all';
  const dateFrom = $('#date-from');
  const dateTo = $('#date-to');
  const AGG_COLS = ['key', 'count', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'cost'];

  // --- Provider chips ---

  $$('.provider-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.provider-chips .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeProvider = chip.dataset.provider;
      if (allData) render(allData);
    });
  });

  // --- Tabs ---

  $$('.tab-bar .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const bar = tab.closest('.tab-bar');
      const panel = tab.closest('.tab-panel');
      bar.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      panel.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      const target = panel.querySelector(`#pane-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // --- Theme ---

  function initTheme() {
    const saved = localStorage.getItem('costbuster-theme');
    if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }

  $('#theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('costbuster-theme', isDark ? 'light' : 'dark');
    if (allData) render(allData);
  });

  dateFrom.addEventListener('change', () => { if (allData) render(allData); });
  dateTo.addEventListener('change', () => { if (allData) render(allData); });
  $('#refresh-btn').addEventListener('click', () => fetchData(true));
  $('#export-btn').addEventListener('click', exportCsv);

  // --- Settings modal ---

  const settingsModal = $('#settings-modal');
  const settingsStatus = $('#settings-status');

  let previousFocus = null;
  const FOCUSABLE = 'input, button, [tabindex]:not([tabindex="-1"])';

  function openSettings() {
    settingsStatus.textContent = '';
    previousFocus = document.activeElement;
    settingsModal.classList.remove('hidden');
    loadCurrentSettings();
    const first = settingsModal.querySelector(FOCUSABLE);
    if (first) first.focus();
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
    if (previousFocus) previousFocus.focus();
  }

  settingsModal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = settingsModal.querySelectorAll(FOCUSABLE);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  $('#settings-btn').addEventListener('click', openSettings);
  $('#empty-settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) closeSettings();
  });

  async function loadCurrentSettings() {
    try {
      const resp = await fetch('/api/settings');
      const s = await resp.json();
      $('#set-anthropic-dir').value = s.anthropicDataDir || '';
      $('#set-openai-file').value = s.openaiUsageFile || '';
      $('#set-openai-dir').value = s.openaiLogsDir || '';
      $('#set-sync-days').value = s.anthropicApiSyncDays || 30;

      const keysList = $('#admin-keys-list');
      keysList.innerHTML = '';
      const maskedKeys = s.anthropicAdminKeys || [];
      const keyCount = s.anthropicAdminKeyCount || maskedKeys.length;
      for (let i = 0; i < keyCount; i++) {
        addAdminKeyRow(maskedKeys[i] || '', true, i);
      }

      $$('.validate-indicator').forEach(el => { el.textContent = ''; el.className = 'validate-indicator'; });
    } catch {
      settingsStatus.textContent = 'Could not load current settings';
      settingsStatus.className = 'settings-status error';
    }
  }

  function addAdminKeyRow(placeholder, isMasked, keyIndex) {
    const row = document.createElement('div');
    row.className = 'admin-key-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'admin-key-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.masked = isMasked ? '1' : '0';
    if (isMasked) {
      input.value = placeholder;
      input.readOnly = true;
      if (keyIndex !== undefined) input.dataset.keyIndex = String(keyIndex);
    } else {
      input.placeholder = 'sk-ant-admin...';
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-key';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove key';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(input);
    row.appendChild(removeBtn);
    $('#admin-keys-list').appendChild(row);
    return input;
  }

  $('#add-admin-key').addEventListener('click', () => {
    addAdminKeyRow('', false);
  });

  async function validateSettingPath(inputId, indicatorId) {
    const val = $(`#${inputId}`).value.trim();
    const indicator = $(`#${indicatorId}`);
    if (!val) { indicator.textContent = ''; indicator.className = 'validate-indicator'; return; }
    try {
      const resp = await fetch('/api/settings/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: val }),
      });
      const result = await resp.json();
      indicator.textContent = result.valid ? '✓' : '✗';
      indicator.className = `validate-indicator ${result.valid ? 'valid' : 'invalid'}`;
      indicator.title = result.valid ? `Resolved: ${result.resolved}` : result.reason;
    } catch {
      indicator.textContent = '?';
      indicator.className = 'validate-indicator';
    }
  }

  $('#set-anthropic-dir').addEventListener('blur', () => validateSettingPath('set-anthropic-dir', 'val-anthropic-dir'));
  $('#set-openai-file').addEventListener('blur', () => validateSettingPath('set-openai-file', 'val-openai-file'));
  $('#set-openai-dir').addEventListener('blur', () => validateSettingPath('set-openai-dir', 'val-openai-dir'));

  function collectAdminKeys() {
    const keys = [];
    const errors = [];
    const inputs = $$('.admin-key-input');
    inputs.forEach((input, i) => {
      const val = input.value.trim();
      if (input.readOnly && input.dataset.masked === '1') {
        keys.push('__keep__:' + (input.dataset.keyIndex || '0'));
      } else if (val && val.startsWith('sk-ant-admin')) {
        keys.push(val);
      } else if (val) {
        errors.push(`Key ${i + 1} must start with sk-ant-admin`);
      }
    });
    return { keys, errors };
  }

  $('#settings-save').addEventListener('click', async () => {
    settingsStatus.textContent = 'Saving…';
    settingsStatus.className = 'settings-status';
    try {
      const { keys: collectedKeys, errors: keyErrors } = collectAdminKeys();
      if (keyErrors.length > 0) {
        settingsStatus.textContent = keyErrors[0];
        settingsStatus.className = 'settings-status error';
        return;
      }
      const hasKeyInputs = $$('.admin-key-input').length > 0;
      const allKept = collectedKeys.length > 0 && collectedKeys.every(k => k.startsWith('__keep__:'));
      const body = {
        anthropicDataDir: $('#set-anthropic-dir').value.trim(),
        anthropicApiSyncDays: parseInt($('#set-sync-days').value, 10) || 30,
        openaiUsageFile: $('#set-openai-file').value.trim(),
        openaiLogsDir: $('#set-openai-dir').value.trim(),
      };
      if (allKept) {
        // all masked rows untouched — don't send keys, server keeps existing
      } else if (collectedKeys.length > 0) {
        body.anthropicAdminKeys = collectedKeys;
      } else if (hasKeyInputs) {
        body.anthropicAdminKeys = [];
      }
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let result;
      try {
        result = await resp.json();
      } catch {
        throw new Error(`Server returned ${resp.status}`);
      }
      if (result.ok) {
        settingsStatus.textContent = 'Saved!';
        settingsStatus.className = 'settings-status success';
        setTimeout(() => {
          closeSettings();
          fetchData();
        }, 600);
      } else {
        settingsStatus.textContent = result.error || result.message || 'Save failed';
        settingsStatus.className = 'settings-status error';
      }
    } catch (err) {
      settingsStatus.textContent = `Error: ${err.message}`;
      settingsStatus.className = 'settings-status error';
    }
  });

  $$('.table-search').forEach(input => {
    input.addEventListener('input', () => {
      const tableId = input.dataset.table;
      const query = input.value.toLowerCase();
      const rows = $$(`#${tableId} tbody tr`);
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
      });
    });
  });

  function fmt(n) {
    if (n == null) return '—';
    return n.toLocaleString();
  }

  function fmtCost(n) {
    if (n == null || n === 0) return '$0.00';
    if (n < 0.01) return '$' + n.toFixed(6);
    return '$' + n.toFixed(4);
  }

  async function fetchData(force) {
    const loadingEl = $('#loading');
    loadingEl.textContent = force ? 'Refreshing data…' : 'Loading data…';
    loadingEl.classList.remove('hidden');
    $('#error').classList.add('hidden');
    $$('section').forEach(s => s.classList.add('hidden'));

    const startTime = Date.now();
    const ticker = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      loadingEl.textContent = `${force ? 'Refreshing' : 'Loading'} data… ${elapsed}s`;
    }, 1000);

    try {
      const url = force ? '/api/data?force=1' : '/api/data';
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      allData = await resp.json();
      initDateRange(allData.records);
      render(allData);
    } catch (err) {
      loadingEl.classList.add('hidden');
      const errEl = $('#error');
      errEl.textContent = `Failed to load data: ${err.message}`;
      errEl.classList.remove('hidden');
    } finally {
      clearInterval(ticker);
    }
  }

  function initDateRange(records) {
    if (!records.length) return;
    const dates = records.filter(r => r.date).map(r => r.date.slice(0, 10)).sort();
    if (dates.length) {
      dateFrom.min = dates[0];
      dateTo.min = dates[0];
      dateFrom.max = dates[dates.length - 1];
      dateTo.max = dates[dates.length - 1];
      if (!dateFrom.value) dateFrom.value = dates[0];
      if (!dateTo.value) dateTo.value = dates[dates.length - 1];
    }
  }

  function getFilteredRecords(records) {
    let filtered = records;
    if (activeProvider !== 'all') filtered = filtered.filter(r => r.provider === activeProvider);
    const from = dateFrom.value;
    const to = dateTo.value;
    if (from) filtered = filtered.filter(r => r.date && r.date.slice(0, 10) >= from);
    if (to) filtered = filtered.filter(r => r.date && r.date.slice(0, 10) <= to);
    return filtered;
  }

  function recompute(records) {
    const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
    const byDay = {};
    const byModel = {};
    const byProject = {};
    const bySession = {};
    const byProvider = {};
    for (const r of records) {
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cacheRead += r.cacheRead;
      totals.cacheWrite += r.cacheWrite;
      totals.cost += r.cost || 0;
      totals.count++;

      const day = r.date ? r.date.slice(0, 10) : 'unknown';
      agg(byDay, day, r);
      agg(byModel, r.model, r);
      agg(byProvider, r.provider, r);
      if (r.project) agg(byProject, r.project, r);
      if (r.sessionId) agg(bySession, `${r.provider}:${r.sessionId}`, r);
    }

    return {
      totals,
      byDay: toSorted(byDay, (a, b) => a.key.localeCompare(b.key)),
      byModel: toSorted(byModel, (a, b) => b.cost - a.cost),
      byProject: toSorted(byProject, (a, b) => b.cost - a.cost),
      byProvider: toSorted(byProvider, (a, b) => b.cost - a.cost),
      bySession: Object.entries(bySession)
        .map(([key, v]) => ({ key, provider: key.split(':')[0], sessionId: key.split(':').slice(1).join(':'), ...v }))
        .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
    };
  }

  function agg(map, key, r) {
    if (!map[key]) map[key] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
    map[key].inputTokens += r.inputTokens;
    map[key].outputTokens += r.outputTokens;
    map[key].cacheRead += r.cacheRead;
    map[key].cacheWrite += r.cacheWrite;
    map[key].cost += r.cost || 0;
    map[key].count++;
  }

  function toSorted(map, sortFn) {
    return Object.entries(map).map(([key, v]) => ({ key, ...v })).sort(sortFn);
  }

  function render(data) {
    $('#loading').classList.add('hidden');
    const emptyState = $('#empty-state');

    if (!data.records || data.records.length === 0) {
      $$('section').forEach(s => s.classList.add('hidden'));
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    const records = getFilteredRecords(data.records);
    const aggs = recompute(records);
    const topPrompts = getFilteredRecords(data.topPrompts || []);

    const byApiKey = (data.aggregations && data.aggregations.byApiKey) || [];
    renderSummary(aggs.totals, aggs.byProvider, aggs.byDay);
    renderCharts(aggs.byDay, aggs.byModel);
    renderInsights(data.insights);
    renderTables(aggs, topPrompts, byApiKey);
    renderWarnings(data.warnings);

    $('#meta-info').textContent = `${records.length} records · Generated ${new Date(data.meta.generatedAt).toLocaleString()}`;
  }

  // --- Charts ---

  function getChartColors() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      text: isDark ? '#e4e5e9' : '#2d2d2d',
      grid: isDark ? '#2e313c' : '#e5e7eb',
      barFill: isDark ? '#f0944d' : '#e8772e',
      barBorder: isDark ? '#f0944d' : '#d4691f',
      palette: ['#e8772e', '#1a7a7a', '#6b7280', '#f0944d', '#2cb5b5', '#9ca3af', '#d4691f', '#145a5a'],
    };
  }

  function renderCharts(byDay, byModel) {
    const section = $('#charts-section');
    if (!byDay.length && !byModel.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    const colors = getChartColors();
    const chartOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: colors.text, font: { family: "'Inter', sans-serif", size: 11 } } } },
      scales: {
        x: { ticks: { color: colors.text, font: { family: "'Inter', sans-serif", size: 10 } }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.text, font: { family: "'Inter', sans-serif", size: 10 } }, grid: { color: colors.grid } },
      },
    };

    if (dailyChart) dailyChart.destroy();
    const dailyCtx = $('#daily-chart').getContext('2d');
    dailyChart = new Chart(dailyCtx, {
      type: 'bar',
      data: {
        labels: byDay.map(d => d.key),
        datasets: [{
          label: 'Cost ($)',
          data: byDay.map(d => d.cost),
          backgroundColor: colors.barFill + 'cc',
          borderColor: colors.barBorder,
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: { ...chartOpts, plugins: { ...chartOpts.plugins, legend: { display: false } } },
    });

    if (modelChart) modelChart.destroy();
    modelChart = null;
    const modelCanvas = $('#model-chart');
    const topModels = byModel.slice(0, 8);
    if (topModels.length < 2) {
      modelCanvas.style.display = 'none';
      modelCanvas.parentElement.querySelector('.single-model-note')?.remove();
      const note = document.createElement('p');
      note.className = 'single-model-note';
      note.textContent = topModels.length === 1
        ? `All cost from one model: ${topModels[0].key} (${fmtCost(topModels[0].cost)})`
        : 'No model data available.';
      modelCanvas.parentElement.appendChild(note);
    } else {
      modelCanvas.style.display = '';
      modelCanvas.parentElement.querySelector('.single-model-note')?.remove();
      const modelCtx = modelCanvas.getContext('2d');
      modelChart = new Chart(modelCtx, {
        type: 'doughnut',
        data: {
          labels: topModels.map(m => m.key),
          datasets: [{
            data: topModels.map(m => m.cost),
            backgroundColor: colors.palette.slice(0, topModels.length),
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { position: 'right', labels: { color: colors.text, font: { family: "'Inter', sans-serif", size: 11 }, padding: 10, boxWidth: 12 } },
          },
        },
      });
    }
  }

  // --- Sparklines ---

  function sparklineSvg(values, width, height) {
    if (!values || values.length < 2) return '';
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = max - min || 1;
    const step = width / (values.length - 1);
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  // --- Render functions ---

  function renderInsights(insights) {
    const list = $('#insights-list');
    if (!insights || insights.length === 0) {
      list.innerHTML = '<li class="insight-empty">No insights available.</li>';
      return;
    }
    list.innerHTML = insights.map(i => `<li class="insight-item">${esc(i)}</li>`).join('');
  }

  function renderSummary(totals, byProvider, byDay) {
    const section = $('#summary-section');
    const grid = $('#summary-cards');

    const last7 = byDay.slice(-7);
    const costSpark = sparklineSvg(last7.map(d => d.cost), 60, 20);
    const inputSpark = sparklineSvg(last7.map(d => d.inputTokens), 60, 20);
    const outputSpark = sparklineSvg(last7.map(d => d.outputTokens), 60, 20);

    let cards = `
      <div class="card total">
        <div class="label">Total Cost</div>
        <div class="value">${fmtCost(totals.cost)}</div>
        <div class="sub">${fmt(totals.count)} requests ${costSpark}</div>
      </div>
      <div class="card total">
        <div class="label">Input Tokens</div>
        <div class="value">${fmt(totals.inputTokens)}</div>
        <div class="sub">${inputSpark}</div>
      </div>
      <div class="card total">
        <div class="label">Output Tokens</div>
        <div class="value">${fmt(totals.outputTokens)}</div>
        <div class="sub">${outputSpark}</div>
      </div>
    `;

    if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
      cards += `
        <div class="card total">
          <div class="label">Cache Tokens</div>
          <div class="value">${fmt(totals.cacheRead + totals.cacheWrite)}</div>
          <div class="sub">${fmt(totals.cacheRead)} read · ${fmt(totals.cacheWrite)} write</div>
        </div>
      `;
    }

    if (activeProvider === 'all' && byProvider) {
      for (const p of byProvider) {
        cards += `
          <div class="card ${esc(p.key)}">
            <div class="label"><span class="provider-badge ${esc(p.key)}">${esc(providerLabel(p.key))}</span> Cost</div>
            <div class="value">${fmtCost(p.cost)}</div>
            <div class="sub">${fmt(p.count)} requests</div>
          </div>
        `;
      }
    }

    grid.innerHTML = cards;
    section.classList.remove('hidden');
  }

  function renderTables(aggs, topPrompts, byApiKey) {
    const section = $('#tables-section');

    $$('.tab-panel th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    for (const key of Object.keys(sortState)) delete sortState[key];

    populateAggTable('by-day', aggs.byDay, AGG_COLS);
    populateAggTable('by-model', aggs.byModel, AGG_COLS);
    populateAggTable('by-project', aggs.byProject, AGG_COLS);
    populateAggTable('by-apikey', byApiKey || [], AGG_COLS);
    tableDataMap.set('by-day-table', { rows: aggs.byDay, cols: AGG_COLS });
    tableDataMap.set('by-model-table', { rows: aggs.byModel, cols: AGG_COLS });
    tableDataMap.set('by-project-table', { rows: aggs.byProject, cols: AGG_COLS });
    tableDataMap.set('by-apikey-table', { rows: byApiKey || [], cols: AGG_COLS });

    const sessions = aggs.bySession.slice(0, 50);
    tableDataMap.set('by-session-table', {
      rows: sessions,
      cols: ['provider', 'sessionId', 'count', 'inputTokens', 'outputTokens', 'cost'],
    });

    const sessionTbody = $('#by-session-table tbody');
    sessionTbody.innerHTML = sessions.map(s => `
      <tr>
        <td><span class="provider-badge ${esc(s.provider)}">${esc(providerLabel(s.provider))}</span></td>
        <td title="${esc(s.sessionId)}">${esc(s.sessionId.slice(0, 16))}…</td>
        <td>${fmt(s.count)}</td>
        <td>${fmt(s.inputTokens)}</td>
        <td>${fmt(s.outputTokens)}</td>
        <td>${fmtCost(s.cost)}</td>
      </tr>
    `).join('');

    const promptsTbody = $('#top-prompts-table tbody');
    if (topPrompts && topPrompts.length) {
      promptsTbody.innerHTML = topPrompts.map(p => `
        <tr>
          <td><span class="provider-badge ${esc(p.provider)}">${esc(providerLabel(p.provider))}</span></td>
          <td>${esc(p.model)}</td>
          <td>${fmt(p.inputTokens)}</td>
          <td>${fmt(p.outputTokens)}</td>
          <td>${fmtCost(p.cost)}</td>
          <td class="snippet" title="${esc(p.snippet || '')}">${esc(p.snippet || '—')}</td>
        </tr>
      `).join('');
    } else {
      promptsTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.5rem">No prompt data</td></tr>';
    }

    section.classList.remove('hidden');
  }

  function populateAggTable(prefix, rows, cols) {
    const tbody = $(`#${prefix}-table tbody`);
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${cols.length}" style="text-align:center;color:var(--text-muted);padding:1.5rem">No data</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(row => {
      const cells = cols.map(c => {
        if (c === 'key') return `<td>${esc(row[c])}</td>`;
        if (c === 'cost') return `<td>${fmtCost(row[c])}</td>`;
        return `<td>${fmt(row[c])}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    }).join('');
  }

  function renderWarnings(warnings) {
    const section = $('#warnings-section');
    const list = $('#warnings-list');
    if (!warnings || warnings.length === 0) { section.classList.add('hidden'); return; }
    list.innerHTML = warnings.map(w => `<li>${esc(w)}</li>`).join('');
    section.classList.remove('hidden');
  }

  // --- Sortable columns ---

  document.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const table = th.closest('table');
    if (!table) return;
    const tableId = table.id;
    const data = tableDataMap.get(tableId);
    if (!data) return;

    const col = th.dataset.col;
    const type = th.dataset.type;
    const prev = sortState[tableId];
    const asc = prev && prev.col === col ? !prev.asc : false;
    sortState[tableId] = { col, asc };

    table.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(asc ? 'sort-asc' : 'sort-desc');

    const sorted = [...data.rows].sort((a, b) => {
      let va = a[col], vb = b[col];
      if (type === 'number') {
        va = va || 0; vb = vb || 0;
        return asc ? va - vb : vb - va;
      }
      va = String(va || ''); vb = String(vb || '');
      return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const prefix = tableId.replace('-table', '');
    if (tableId === 'by-session-table') {
      const tbody = $(`#${tableId} tbody`);
      tbody.innerHTML = sorted.map(s => `
        <tr>
          <td><span class="provider-badge ${esc(s.provider)}">${esc(providerLabel(s.provider))}</span></td>
          <td title="${esc(s.sessionId)}">${esc(s.sessionId.slice(0, 16))}…</td>
          <td>${fmt(s.count)}</td>
          <td>${fmt(s.inputTokens)}</td>
          <td>${fmt(s.outputTokens)}</td>
          <td>${fmtCost(s.cost)}</td>
        </tr>
      `).join('');
    } else {
      populateAggTable(prefix, sorted, data.cols);
    }
  });

  // --- CSV Export ---

  function exportCsv() {
    if (!allData) return;
    const records = getFilteredRecords(allData.records);
    if (!records.length) return;

    const cols = ['provider', 'date', 'model', 'project', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'cost', 'workspace', 'contextWindow', 'inferenceGeo', 'speed', 'webSearchCount', 'sessionId', 'promptSnippet'];
    const header = cols.join(',');
    const rows = records.map(r => cols.map(c => {
      const v = r[c];
      if (v == null) return '';
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) return `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(','));

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `costbuster-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Utils ---

  const PROVIDER_LABELS = {
    'anthropic': 'Anthropic Local',
    'anthropic-api': 'Anthropic API',
    'openai': 'OpenAI',
  };

  function providerLabel(key) {
    return PROVIDER_LABELS[key] || key;
  }

  function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  initTheme();
  fetchData();
})();

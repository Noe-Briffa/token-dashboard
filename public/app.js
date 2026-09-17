const number = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMoney = (amount) => money.format(amount).replace(/US$/, '').trimEnd();
let firstLoad = true;
let modelColors = new Map();
let platformColors = new Map();
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const duration = (seconds) => seconds ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : '—';
const metric = (label, value, note = '', title = '') => `<article class="metric"${title ? ` title="${escape(title)}"` : ''}><label>${label}</label><strong>${value}</strong>${note ? `<small class="muted">${note}</small>` : ''}</article>`;
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const readTheme = () => {
  try { return ['light', 'dark', 'system'].includes(localStorage.getItem('usage-monitor-theme')) ? localStorage.getItem('usage-monitor-theme') : 'system'; } catch { return 'system'; }
};
let themePreference = readTheme();
function applyTheme(preference) {
  const dark = preference === 'dark' || (preference === 'system' && themeMedia.matches);
  if (preference === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#26342f' : '#f2f0e9';
  $('#theme').value = preference;
}
const modeLabel = () => $('#cost-mode').value === 'api_cost' ? 'Estimation API' : 'Coût payé';
const value = (row) => Number(row[$('#metric').value === 'cost' ? $('#cost-mode').value : 'total'] ?? 0);
const formatted = (amount) => $('#metric').value === 'cost' ? money.format(amount) : compact.format(amount);

function hue(index, count, offset) { return `hsl(${Math.round((offset + index * 360 / Math.max(count, 1)) % 360)} 68% 62%)`; }
function makeColors(data) {
  const models = [...new Set(data.options.filter((row) => row.model).map((row) => row.model))].sort();
  const platforms = [...new Set(data.options.map((row) => row.platform))].filter(Boolean).sort();
  modelColors = new Map(models.map((key, index) => [key, hue(index, models.length, 18)]));
  platformColors = new Map(platforms.map((key, index) => [key, hue(index, platforms.length, 210)]));
}
function colorFor(row, kind = 'model') {
  return kind === 'platform'
    ? platformColors.get(row.label || row.platform) || '#70e1c8'
    : modelColors.get(row.model || row.label) || '#70e1c8';
}
function mergeByModel(rows) {
  const merged = new Map();
  for (const row of rows) {
    const label = row.label || row.model || 'Modèle inconnu';
    const current = merged.get(label) || { ...row, label, total: 0, api_cost: 0, paid_cost: 0 };
    current.total += Number(row.total) || 0;
    current.api_cost += Number(row.api_cost) || 0;
    current.paid_cost += Number(row.paid_cost) || 0;
    merged.set(label, current);
  }
  return [...merged.values()].sort((a, b) => value(b) - value(a));
}
function setOptions(id, values) {
  const el = $(id), old = el.value, first = el.querySelector('option').outerHTML;
  el.innerHTML = first + values.map((item) => `<option value="${escape(item)}">${escape(item)}</option>`).join('');
  el.value = old;
}
function setPeriod() {
  const custom = $('#period').value === 'custom';
  $('#from').disabled = !custom; $('#to').disabled = !custom;
  if (!custom) { $('#from').value = ''; $('#to').value = ''; }
}
function filterQuery() {
  const query = new URLSearchParams();
  for (const key of ['platform', 'agent', 'model', 'project', 'from', 'to']) if ($(`#${key}`).value) query.set(key, $(`#${key}`).value);
  if ($('#period').value !== 'custom') query.set('period', $('#period').value);
  return query;
}
function renderDonut(id, totalId, rows, target) {
  const usable = rows.filter((row) => value(row) > 0), total = usable.reduce((sum, row) => sum + value(row), 0);
  $(`#${totalId}`).textContent = formatted(total);
  if (!total) { $(`#${id}`).innerHTML = '<span class="muted">Aucune donnée chiffrable.</span>'; return; }
  let offset = 0;
  const arcs = usable.map((row) => {
    const dash = value(row) / total * 263.89, color = colorFor(row, target);
    offset += dash;
    return `<circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="14" stroke-dasharray="${dash} ${263.89 - dash}" stroke-dashoffset="${-(offset - dash)}" transform="rotate(-90 50 50)"/>`;
  }).join('');
  const current = $(`#${target}`)?.value || '';
  const legend = usable.map((row) => {
    const active = current && current === row.label;
    const title = active ? 'Cliquer pour afficher tous' : `Filtrer par ${row.label}`;
     return `<button data-filter="${target}" data-value="${escape(row.label)}" class="${active ? 'active' : ''}" title="${escape(title)}"><i class="dot" style="background:${colorFor(row, target)}"></i><label>${escape(row.label)}</label><small>${formatted(value(row))}</small></button>`;
  }).join('');
  const clearHint = current && usable.length === 1 && usable[0].label === current ? `<button class="legend-clear" data-clear="${target}" title="Revenir à tous les ${target === 'model' ? 'modèles' : 'plateformes'}">↺ Tous</button>` : '';
  $(`#${id}`).innerHTML = `<svg class="donut" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--line)" stroke-width="14"/>${arcs}<text x="50" y="48">${$('#metric').value === 'cost' ? 'COÛT' : 'TOKENS'}</text><text x="50" y="60">${escape(formatted(total))}</text></svg><div class="legend">${legend}${clearHint}</div>`;
  $(`#${id}`).querySelectorAll('button[data-filter]').forEach((button) => button.onclick = () => {
    const isActive = button.classList.contains('active');
    $(`#${button.dataset.filter}`).value = isActive ? '' : button.dataset.value;
    load();
  });
  const clearBtn = $(`#${id}`).querySelector('[data-clear]');
  if (clearBtn) clearBtn.onclick = () => { $(`#${clearBtn.dataset.clear}`).value = ''; load(); };
}
function chartBucket(day, granularity) {
  if (granularity === 'month') return day.slice(0, 7);
  if (granularity !== 'week') return day;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function groupChartDays(days, granularity) {
  const grouped = new Map();
  for (const day of days) {
    const key = chartBucket(day.day, granularity);
    const current = grouped.get(key) || { day: key, series: [] };
    current.series.push(...day.series);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((day) => ({ ...day, series: mergeByModel(day.series) }));
}
function renderChart(days, range, pricing = []) {
  const granularity = $('#chart-granularity').value;
  days = groupChartDays(days, granularity);
  const isTokens = $('#metric').value === 'total';
  // bougies tokens : moins chers en bas (column-reverse => premier segment en bas)
  const inputPrice = new Map(pricing.map((row) => [row.model, Number(row.input_usd_per_million) || 0]));
  const priceOf = (row) => inputPrice.get(row.model || row.label) ?? 0;
  if (isTokens) days = days.map((day) => ({ ...day, series: [...day.series].sort((a, b) => priceOf(a) - priceOf(b)) }));
  const totals = days.map((day) => day.series.reduce((sum, row) => sum + value(row), 0));
  const rawMax = Math.max(...totals, 0), magnitude = 10 ** Math.floor(Math.log10(rawMax || 1));
  const max = Math.ceil(rawMax / magnitude * 4) / 4 * magnitude || 1;
  const ticks = [max, max * .75, max * .5, max * .25, 0];
  const granularityLabel = { day: 'jour', week: 'semaine', month: 'mois' }[granularity];
  $('#daily-title').textContent = `${$('#metric').value === 'cost' ? modeLabel() : 'Tokens'} par ${granularityLabel}`;
  $('#chart-annotation').textContent = isTokens ? 'Coût API au-dessus' : 'Tokens au-dessus';
  $('#daily-range').textContent = `${range.start} — ${range.end}`;
  const dense = days.length > 14;
  const labelStep = days.length > 60 ? 7 : days.length > 30 ? 4 : days.length > 14 ? 2 : 1;
  const tips = [];
  const bars = days.map((day, index) => {
    const rows = day.series.filter((row) => value(row) > 0);
     const apiRows = day.series.filter((row) => row.api_cost != null), apiTotal = apiRows.reduce((sum, row) => sum + Number(row.api_cost), 0);
     const tokenTotal = day.series.reduce((sum, row) => sum + Number(row.total || 0), 0);
     const tipText = rows.map((row) => `${row.model}: ${formatted(value(row))}`).join('\n') || 'Aucune activité';
     const tipRows = rows.map((row) => `<span class="tip-row"><i class="dot" style="background:${colorFor(row)}"></i><label>${escape(row.model || row.label)}</label><small>${escape(formatted(value(row)))}</small></span>`).join('') || '<span class="muted">Aucune activité</span>';
     const tipFoot = `${isTokens && tokenTotal ? `<span class="tip-foot">Total : ${escape(compact.format(tokenTotal))}</span>` : ''}${isTokens && apiRows.length ? `<span class="tip-foot">Estimation API : ${escape(money.format(apiTotal))}</span>` : ''}`;
     tips.push(`<b class="tip-day">${escape(day.day)}</b>${tipRows}${tipFoot}`);
     const height = totals[index] / max * 100, showLabel = index % labelStep === 0 || index === days.length - 1;
     const showValueLabel = days.length <= 31 || index % 2 === 0 || index === days.length - 1;
     const label = granularity === 'month' ? day.day : day.day.slice(5);
      const apiLabel = isTokens && apiRows.length && showValueLabel && (!dense || totals[index] > max * 0.03) ? shortMoney(apiTotal) : '';
     const tokenLabel = !isTokens && tokenTotal && showValueLabel ? compact.format(tokenTotal) : '';
      const topLabel = apiLabel || tokenLabel;
      return `<div class="bar${rows.length ? '' : ' empty'}" style="--bar-height:${height}%" aria-label="${escape(`${day.day}\n${tipText}`)}" data-bar="${index}">${topLabel ? `<b class="bar-api">${topLabel}</b>` : ''}${rows.map((row) => `<i class="bar-segment" style="height:${value(row) / max * 100}%;background:${colorFor(row)}"></i>`).join('')}<span${showLabel ? '' : ' class="muted hidden"'}>${showLabel ? label : ''}</span></div>`;
  }).join('');
  $('#chart').innerHTML = `<div class="chart-axis">${ticks.map((tick) => `<span>${isTokens ? compact.format(tick) : money.format(tick)}</span>`).join('')}</div><div class="chart-plot${dense ? ' dense' : ''}"><div class="chart-grid">${ticks.map(() => '<i></i>').join('')}</div><div class="chart-bars${dense ? ' dense' : ''}">${bars}</div></div>`;
  const tooltip = $('#tooltip');
  const moveTip = (event) => {
    const pad = 14, rect = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(event.clientX + pad, window.innerWidth - rect.width - 8)}px`;
    tooltip.style.top = `${Math.min(event.clientY + pad, window.innerHeight - rect.height - 8)}px`;
  };
  $('#chart').querySelectorAll('.bar').forEach((bar) => {
    bar.addEventListener('mouseenter', (event) => { tooltip.innerHTML = tips[Number(bar.dataset.bar)]; tooltip.hidden = false; moveTip(event); });
    bar.addEventListener('mousemove', moveTip);
    bar.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  });
}
function renderSessions(rows) {
  const field = $('#cost-mode').value === 'api_cost' ? 'api_estimated_cost_usd' : 'out_of_pocket_cost_usd';
  $('#session-count').textContent = `${number.format(rows.length)} affichées`;
  $('#sessions').innerHTML = rows.map((row) => `<tr><td>${escape(row.id.slice(0, 8))}</td><td>${escape(row.platform)}<br><span class="muted">${escape(row.agent)}</span></td><td>${escape(row.model || 'Inconnu')}</td><td class="project" title="${escape(row.project || '')}">${escape(row.project || '—')}</td><td>${duration(row.duration_seconds)}</td><td>${number.format(row.input_tokens)}</td><td>${number.format(row.cached_input_tokens)}</td><td>${number.format(row.output_tokens + row.reasoning_tokens)}</td><td><b>${number.format(row.total_tokens)}</b></td><td>${row[field] == null ? '—' : money.format(row[field])}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">Aucune session.</td></tr>';
}
function renderPricing(rows) {
  $('#pricing-rows').innerHTML = rows.map((row) => `<tr data-platform="${escape(row.platform)}" data-model="${escape(row.model)}"><td>${escape(row.platform)}</td><td>${escape(row.model)}</td>${[['input_usd_per_million', 'input'], ['cached_input_usd_per_million', 'cached'], ['output_usd_per_million', 'output'], ['reasoning_usd_per_million', 'reasoning']].map(([field, name]) => `<td><input class="rate" type="number" min="0" step="any" name="${name}" value="${row[field] ?? ''}" placeholder="—"></td>`).join('')}</tr>`).join('');
}
const resetLabel = (iso) => {
  if (!iso) return 'reset inconnu';
  const date = new Date(iso), now = new Date();
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? `reset ${time}` : `reset ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${time}`;
};
function renderLimits(limits) {
  const el = $('#limits');
  const bar = (label, window) => window
    ? `<div class="limit"><div class="limit-head"><b>${label}</b><span>${Math.round(window.remaining)}% restants · ${resetLabel(window.resetsAt)}</span></div><div class="limit-track"><i style="width:${Math.min(100, Math.max(0, window.remaining))}%"></i></div></div>`
    : `<div class="limit"><div class="limit-head"><b>${label}</b><span class="muted">indisponible</span></div></div>`;
  const note = { auth_expired: 'session Codex expirée, relance Codex', not_connected: 'Codex non connecté', not_applicable: 'sans objet (clé API)', unavailable: 'limites indisponibles pour le moment' }[limits.status];
  el.innerHTML = limits.status === 'connected'
    ? `<div class="panel-head"><h2>Limites Codex${limits.plan ? ` · ${escape(limits.plan)}` : ''}</h2><span>temps réel</span></div><div class="limit-grid">${bar('5 heures', limits.primary)}${bar('Hebdo', limits.secondary)}</div>`
    : `<div class="panel-head"><h2>Limites Codex</h2><span class="muted">${note}</span></div>`;
}
let limitsAt = 0;
async function loadLimits(force = false) {
  if (!force && Date.now() - limitsAt < 60000) return;
  try { renderLimits(await (await fetch('/api/limits')).json()); limitsAt = Date.now(); } catch { /* bandeau garde son état */ }
}
function renderSources(sources) { $('#sources').innerHTML = sources.map((source) => `<span class="source"><i class="status-dot ${source.status === 'connected' ? 'connected' : ''}"></i><b>${escape(source.platform)}</b><span class="muted">${source.status === 'connected' ? `${number.format(source.sessions)} sessions` : 'non connecté'}</span></span>`).join(''); }
function render(data) {
  const s = data.summary, cost = s[$('#cost-mode').value];
  const models = mergeByModel(data.models);
  const daily = data.daily.map((day) => ({ ...day, series: mergeByModel(day.series) }));
  const codexFloat = s.codex_input ? Math.min(1, Number(s.codex_cached) / Number(s.codex_input)) * 100 : null;
  const openTotal = (Number(s.opencode_input)||0) + (Number(s.opencode_cached)||0);
  const openFloat = openTotal ? Math.min(1, Number(s.opencode_cached)/openTotal) * 100 : null;
  const fmt = (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    if (v >= 99.5 && v < 100) return `${v.toFixed(1)}%`;
    if (v > 99.95) return '100%';
    return `${Math.round(v)}%`;
  };
  const cacheValue = `<span class="cache-breakdown"><span><small>Codex</small><b>${fmt(codexFloat)}</b></span><span><small>OpenCode</small><b>${fmt(openFloat)}</b></span></span>`;
  const saved = Number(s.cache_saved) || 0;
  const cacheNote = saved > 0 ? `${money.format(saved)} économisés` : 'Économie calculée sur la période';
  const cacheTitle = 'Prompt cache (période filtrée) : Codex = cached / input, OpenCode = cached / (input + cached). % sur tokens prompt. Économie = cached × (prix input − prix cache) sur période filtrée.';
  $('#subscription').checked = data.settings.openai_subscription;
  $('#metrics').innerHTML = [metric('Sessions', number.format(s.sessions)), metric('Tokens totaux', compact.format(s.total)), metric('Prompt cache', cacheValue, cacheNote, cacheTitle), metric('Modèle principal', models[0]?.label || '—', '', models[0]?.label || ''), metric(modeLabel(), cost == null ? '—' : money.format(cost), cost == null ? 'prix manquants' : $('#cost-mode').value === 'paid_cost' ? 'Codex et OpenAI inclus' : 'tarifs API ou coût exact')].join('');
  renderDonut('model-donut', 'model-total', models, 'model'); renderDonut('platform-donut', 'platform-total', data.platforms, 'platform'); renderChart(daily, data.range, data.pricing); renderSessions(data.sessions); renderPricing(data.pricing); renderSources(data.sources);
}
async function load(refresh = false) {
  if (refresh) await fetch('/api/refresh', { method: 'POST' });
  const data = await (await fetch(`/api/data?${filterQuery()}`)).json();
  makeColors(data);
  if (firstLoad) { setOptions('#platform', [...new Set(data.options.map((row) => row.platform))]); setOptions('#agent', [...new Set(data.options.map((row) => row.agent))]); setOptions('#model', [...new Set(data.options.map((row) => row.model).filter(Boolean))]); firstLoad = false; }
  render(data); $('#status').textContent = `${number.format(data.summary.sessions)} sessions · actualisé ${new Date().toLocaleTimeString('fr-FR')}`;
}
$('#refresh').onclick = () => { load(true); loadLimits(true); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLimits(); });
window.addEventListener('focus', () => loadLimits());
applyTheme(themePreference);
$('#theme').addEventListener('change', () => {
  themePreference = $('#theme').value;
  try { themePreference === 'system' ? localStorage.removeItem('usage-monitor-theme') : localStorage.setItem('usage-monitor-theme', themePreference); } catch { /* preference remains session-only */ }
  applyTheme(themePreference);
});
themeMedia.addEventListener('change', () => { if (themePreference === 'system') applyTheme('system'); });
['#metric', '#cost-mode', '#platform', '#agent', '#model', '#project', '#from', '#to', '#chart-granularity'].forEach((id) => $(id).addEventListener('input', () => { if (id === '#from' || id === '#to') $('#period').value = 'custom'; load(); }));
$('#period').addEventListener('input', () => { setPeriod(); load(); });
$('#subscription').addEventListener('change', async () => { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openai_subscription: $('#subscription').checked }) }); await load(); });
$('#pricing').addEventListener('submit', async (event) => { event.preventDefault(); const pricing = [...$('#pricing-rows').rows].map((row) => ({ platform: row.dataset.platform, model: row.dataset.model, ...Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map((name) => [name, row.querySelector(`[name="${name}"]`).value || 0])) })); const response = await fetch('/api/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricing }) }); if (!response.ok) { alert((await response.json()).error); return; } await load(); });
let assetStamp = 0;
async function checkVersion() {
  try {
    const stamp = (await (await fetch('/api/version')).json()).stamp;
    if (!assetStamp) assetStamp = stamp;
    else if (stamp !== assetStamp) location.reload();
  } catch { /* garde la page telle quelle */ }
}
setPeriod(); load(); loadLimits(true); setInterval(() => { load(true); loadLimits(); checkVersion(); }, 15000);

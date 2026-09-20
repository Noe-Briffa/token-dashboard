const number = new Intl.NumberFormat('fr-FR');
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMoney = (amount) => money.format(amount).replace(/US$/, '').trimEnd();
let modelColors = new Map();
let platformColors = new Map();
let projectColors = new Map();
const shortProject = (label) => {
  if (!label || label === 'Projet inconnu') return 'Projet inconnu';
  const parts = String(label).split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Projet inconnu';
};
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const duration = (seconds) => seconds ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : '—';
const metric = (label, value, note = '', title = '') => `<article class="metric"${title ? ` data-tip="${escape(title)}"` : ''}><label>${label}</label><strong>${value}</strong>${note ? `<small class="muted">${note}</small>` : ''}</article>`;
let barTips = [];
function watchTips() {
  const tooltip = $('#tooltip');
  const moveTip = (event) => {
    const pad = 14, rect = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(event.clientX + pad, window.innerWidth - rect.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(event.clientY + pad, window.innerHeight - rect.height - 8))}px`;
  };
  document.addEventListener('mouseover', (event) => {
    const bar = event.target.closest('[data-bar]');
    const simple = event.target.closest('[data-tip]');
    if (!bar && !simple) return;
    if (bar) tooltip.innerHTML = barTips[Number(bar.dataset.bar)];
    else tooltip.textContent = simple.dataset.tip;
    tooltip.hidden = false;
    moveTip(event);
  });
  document.addEventListener('mousemove', (event) => { if (!tooltip.hidden) moveTip(event); });
  document.addEventListener('mouseout', (event) => {
    if (!event.relatedTarget || !event.relatedTarget.closest?.('[data-bar],[data-tip]')) tooltip.hidden = true;
  });
}
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
const tokenThreshold = () => $('#metric').value === 'total' ? Math.max(0, Number($('#min-tokens')?.value) || 0) * 1e6 : 0;

const modelPalette = [18, 48, 78, 108, 138, 168, 198, 228, 258, 288, 318, 348].map((hue) => `hsl(${hue} 68% 62%)`);
const canonicalModel = (model) => String(model || 'Modèle inconnu').trim().toLowerCase().replace(/\s+/g, ' ');
const knownModelColors = new Map([
  ['codex-auto-review', modelPalette[0]],
  ['gpt-5.3-codex', modelPalette[1]],
  ['gpt-5.4', modelPalette[2]],
  ['gpt-5.4-mini', modelPalette[3]],
  ['gpt-5.5', modelPalette[4]],
  ['gpt-5.6-luna', modelPalette[5]],
  ['gpt-5.6-sol', modelPalette[6]],
  ['gpt-5.6-terra', modelPalette[7]],
  ['mimo-v2.5-free', modelPalette[8]],
  ['muse-spark-1.2-contributor-free', modelPalette[9]],
  ['muse-spark-1.3-contributor-free', modelPalette[10]],
  ['nemotron-3-ultra-free', modelPalette[11]],
]);
function stableColorIndex(value, size) {
  let hash = 2166136261;
  for (const character of canonicalModel(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0) % size;
}
function modelColor(model) {
  const key = canonicalModel(model);
  return knownModelColors.get(key) || modelPalette[stableColorIndex(key, modelPalette.length)];
}
function hue(index, count, offset) { return `hsl(${Math.round((offset + index * 360 / Math.max(count, 1)) % 360)} 68% 62%)`; }
function makeColors(data) {
  const models = [...new Set(data.options.filter((row) => row.model).map((row) => row.model))].sort();
  const platforms = [...new Set(data.options.map((row) => row.platform))].filter(Boolean).sort();
  const projects = [...new Set(data.projects.map((row) => shortProject(row.label)))].sort();
  modelColors = new Map(models.map((key) => [canonicalModel(key), modelColor(key)]));
  platformColors = new Map(platforms.map((key, index) => [key, hue(index, platforms.length, 210)]));
  projectColors = new Map(projects.map((key, index) => [key, hue(index, projects.length, 280)]));
}
function colorFor(row, kind = 'model') {
  if (kind === 'platform') return platformColors.get(row.label || row.platform) || '#70e1c8';
  if (kind === 'project') return projectColors.get(row.label) || '#70e1c8';
  return modelColors.get(canonicalModel(row.model || row.label)) || '#70e1c8';
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
  const minimum = tokenThreshold();
  const usable = rows.filter((row) => (Number(row.total) || 0) >= minimum && value(row) > 0).sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0)); // ordre tokens stable : couleurs et positions fixes entre Tokens et Coût
  const total = usable.reduce((sum, row) => sum + value(row), 0);
  const totalEl = $(`#${totalId}`);
  if (totalEl) totalEl.textContent = formatted(total);
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
      return `<button data-filter="${target}" data-value="${escape(row.label)}" class="${active ? 'active' : ''}" data-tip="${escape(title)}"><i class="dot" style="background:${colorFor(row, target)}"></i><label>${escape(row.label)}</label><small>${formatted(value(row))}</small></button>`;
  }).join('');
  const clearHint = current && usable.length === 1 && usable[0].label === current ? `<button class="legend-clear" data-clear="${target}" data-tip="Revenir à tous les ${target === 'model' ? 'modèles' : target === 'project' ? 'projets' : 'plateformes'}">↺ Tous</button>` : '';
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
  barTips = [];
  const bars = days.map((day, index) => {
    const rows = day.series.filter((row) => value(row) > 0);
     const apiRows = day.series.filter((row) => row.api_cost != null), apiTotal = apiRows.reduce((sum, row) => sum + Number(row.api_cost), 0);
     const tokenTotal = day.series.reduce((sum, row) => sum + Number(row.total || 0), 0);
     const tipText = rows.map((row) => `${row.model}: ${formatted(value(row))}`).join('\n') || 'Aucune activité';
     const tipRows = rows.map((row) => `<span class="tip-row"><i class="dot" style="background:${colorFor(row)}"></i><label>${escape(row.model || row.label)}</label><small>${escape(formatted(value(row)))}</small></span>`).join('') || '<span class="muted">Aucune activité</span>';
     const tipFoot = `${isTokens && tokenTotal ? `<span class="tip-foot">Total : ${escape(compact.format(tokenTotal))}</span>` : ''}${isTokens && apiRows.length ? `<span class="tip-foot">Estimation API : ${escape(money.format(apiTotal))}</span>` : ''}`;
     barTips.push(`<b class="tip-day">${escape(day.day)}</b>${tipRows}${tipFoot}`);
     const height = totals[index] / max * 100, showLabel = index % labelStep === 0 || index === days.length - 1;
     const showValueLabel = days.length <= 31 || index % 2 === 0 || index === days.length - 1;
     const label = granularity === 'month' ? day.day : day.day.slice(5);
      const apiLabel = isTokens && apiRows.length && showValueLabel && (!dense || totals[index] > max * 0.03) ? shortMoney(apiTotal) : '';
     const tokenLabel = !isTokens && tokenTotal && showValueLabel ? compact.format(tokenTotal) : '';
      const topLabel = apiLabel || tokenLabel;
      return `<div class="bar${rows.length ? '' : ' empty'}" style="--bar-height:${height}%" aria-label="${escape(`${day.day}\n${tipText}`)}" data-bar="${index}">${topLabel ? `<b class="bar-api">${topLabel}</b>` : ''}${rows.map((row) => `<i class="bar-segment" style="height:${value(row) / max * 100}%;background:${colorFor(row)}"></i>`).join('')}<span${showLabel ? '' : ' class="muted hidden"'}>${showLabel ? label : ''}</span></div>`;
  }).join('');
  $('#chart').innerHTML = `<div class="chart-axis">${ticks.map((tick) => `<span>${isTokens ? compact.format(tick) : money.format(tick)}</span>`).join('')}</div><div class="chart-plot${dense ? ' dense' : ''}"><div class="chart-grid">${ticks.map(() => '<i></i>').join('')}</div><div class="chart-bars${dense ? ' dense' : ''}">${bars}</div></div>`;
}
const activityDayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const heatThresholds = [20e6, 40e6, 60e6, 80e6];
function renderActivityHeatmap(cells = [], activityVersion = 0) {
  const el = $('#activity-heatmap'), summary = $('#activity-summary'), legend = $('#activity-legend');
  if (!el) return;
  if (legend) legend.innerHTML = `<strong>Tokens par cellule</strong><i class="heat-empty"></i><span>0</span>${heatThresholds.map((threshold, index) => `<i class="heat-level-${index + 1}"></i><span>${index === heatThresholds.length - 1 ? '> 80 M' : `≤ ${threshold / 1e6} M`}</span>`).join('')}<span class="activity-total-note">Totaux : échelle relative à leur maximum</span>`;
  if (activityVersion !== 2 || !Array.isArray(cells) || cells.length !== 168) {
    el.innerHTML = '<p class="muted activity-empty">Redémarre l’application pour actualiser l’historique horaire.</p>';
    if (summary) summary.textContent = 'Version serveur à actualiser';
    return;
  }
  const values = cells.map((cell) => Number(cell.total) || 0), max = Math.max(...values, 0);
  if (!max) { el.innerHTML = '<p class="muted activity-empty">Aucune activité sur la période.</p>'; if (summary) summary.textContent = 'Tokens utilisés · Europe/Paris'; return; }
  const peakIndex = values.indexOf(max), peak = cells[peakIndex];
  const hourTotals = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, sessions: 0 }));
  for (const cell of cells) { hourTotals[cell.hour].total += Number(cell.total) || 0; hourTotals[cell.hour].sessions += Number(cell.sessions) || 0; }
  const hourPeak = hourTotals.reduce((best, cell) => cell.total > best.total ? cell : best, hourTotals[0]);
  const dayTotals = activityDayNames.map((day, dayIndex) => cells.slice(dayIndex * 24, dayIndex * 24 + 24).reduce((total, cell) => ({
    day,
    dayIndex,
    total: total.total + (Number(cell.total) || 0),
    sessions: total.sessions + (Number(cell.sessions) || 0),
  }), { day, dayIndex, total: 0, sessions: 0 }));
  const dayPeak = dayTotals.reduce((best, day) => day.total > best.total ? day : best, dayTotals[0]);
  const periodTotal = dayTotals.reduce((total, day) => ({ total: total.total + day.total, sessions: total.sessions + day.sessions }), { total: 0, sessions: 0 });
  if (summary) summary.textContent = `Pic jour : ${activityDayNames[peak.dayIndex]} ${String(peak.hour).padStart(2, '0')} h · ${compact.format(max)} tokens · Pic horaire : ${String(hourPeak.hour).padStart(2, '0')} h · ${compact.format(hourPeak.total)} tokens`;
  const hourLabels = Array.from({ length: 24 }, (_, hour) => `<span class="activity-hour">${hour % 6 === 0 ? `${String(hour).padStart(2, '0')} h` : ''}</span>`).join('');
  const renderCell = (cell, label, extraClass = '', scaleMax = null) => {
    const value = Number(cell.total) || 0, level = value ? scaleMax ? Math.max(1, Math.ceil(value / scaleMax * 5)) : Math.min(5, heatThresholds.findIndex((threshold) => value <= threshold) + 1 || 5) : 0;
    return `<span class="heat-cell heat-level-${level}${extraClass}" role="img" aria-label="${escape(label)}" data-tip="${escape(label)}"></span>`;
  };
  const rows = activityDayNames.map((day, dayIndex) => {
    const dayTotal = dayTotals[dayIndex];
    const row = cells.slice(dayIndex * 24, dayIndex * 24 + 24).map((cell) => {
      const label = `${day} ${String(cell.hour).padStart(2, '0')} h : ${compact.format(Number(cell.total) || 0)} tokens · ${number.format(cell.sessions)} session${cell.sessions === 1 ? '' : 's'}`;
      return renderCell(cell, label);
    }).join('');
    const label = `${day} · total : ${compact.format(dayTotal.total)} tokens · ${number.format(dayTotal.sessions)} sessions`;
    return `<span class="activity-day">${day}</span>${row}${renderCell(dayTotal, label, ' activity-day-total-cell', dayPeak.total)}`;
  }).join('');
  const totalRow = hourTotals.map((cell) => renderCell(cell, `${String(cell.hour).padStart(2, '0')} h · total : ${compact.format(cell.total)} tokens · ${number.format(cell.sessions)} sessions`, ' activity-total-cell', hourPeak.total)).join('');
  const periodLabel = `Total période : ${compact.format(periodTotal.total)} tokens · ${number.format(periodTotal.sessions)} sessions`;
  el.innerHTML = `<div class="activity-grid"><span class="activity-corner"></span>${hourLabels}<span class="activity-total-hour">Total</span>${rows}<span class="activity-total-day">Total</span>${totalRow}${renderCell(periodTotal, periodLabel, ' activity-total-cell', periodTotal.total)}</div>`;
}
function renderAdtention(balance) {
  const el = $('#adtention-earnings');
  if (!el || !balance?.available) { if (el) el.hidden = true; return; }
  el.hidden = false;
  const note = balance.billableImpressions == null ? '' : `${number.format(balance.billableImpressions)} impressions rémunérées`;
  el.innerHTML = `<span><b>Gains ADtention</b>${note ? `<small>${note}</small>` : ''}</span><strong>${money.format(Number(balance.balanceUsd) || 0)}</strong>`;
}
function renderPricing(rows) {
  $('#pricing-rows').innerHTML = rows.map((row) => `<tr data-platform="${escape(row.platform)}" data-model="${escape(row.model)}"><td>${escape(row.platform)}</td><td>${escape(row.model)}</td>${[['input_usd_per_million', 'input'], ['cached_input_usd_per_million', 'cached'], ['output_usd_per_million', 'output'], ['reasoning_usd_per_million', 'reasoning']].map(([field, name]) => `<td><input class="rate" type="text" inputmode="decimal" name="${name}" value="${row[field] ?? ''}" placeholder="—"></td>`).join('')}</tr>`).join('');
}
const resetLabel = (iso) => {
  if (!iso) return 'reset inconnu';
  const date = new Date(iso), now = new Date();
  const time = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? `reset ${time}` : `reset ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} ${time}`;
};
const LIMIT_ALERT = 20; // seuil fixe : bandeau rouge + ligne pointillée sous ce % restant
const HISTORY_MIN_POINTS = 4; // en dessous : message d'attente plutôt qu'un faux plat
const readHistoryPref = () => { try { return localStorage.getItem('usage-monitor-history') === 'shown'; } catch { return false; } };
const saveHistoryPref = (shown) => { try { localStorage.setItem('usage-monitor-history', shown ? 'shown' : 'hidden'); } catch { /* préférence session uniquement */ } };
let limitsHistory = null, lastLimits = null;
function historyScale(points) {
  const values = points.flatMap((point) => [point.p, point.s]).filter(Number.isFinite);
  return values.length ? { lo: 0, hi: 100 } : null;
}
function paintHistory() {
  if (!readHistoryPref()) return;
  let el = $('#limit-history');
  const points = limitsHistory?.points || [];
  if (points.length < HISTORY_MIN_POINTS) { if (el) el.innerHTML = '<span class="muted limit-history-label">Historique en cours de constitution…</span>'; return; }
  const scale = historyScale(points);
  if (!scale) { el?.remove(); return; }
  if (!el && $('#limits .limit-grid')) { el = document.createElement('div'); el.className = 'limit-history'; el.id = 'limit-history'; $('#limits').appendChild(el); }
  if (!el) return;
  const W = 300, H = 110, T = 4, plotH = H - T - 4; // SVG = traits seuls, tous les textes sont en HTML (non déformés)
  const x = (i) => (i / Math.max(points.length - 1, 1) * W).toFixed(1);
  const y = (v) => (T + (1 - (Math.min(100, Math.max(0, v)) - scale.lo) / (scale.hi - scale.lo)) * plotH).toFixed(1);
  const path = (key) => {
    const usable = points.map((point, i) => ({ i, v: point[key] })).filter((point) => Number.isFinite(point.v));
    if (usable.length < 2) return '';
    return usable.map((point) => `${point === usable[0] ? 'M' : 'L'}${x(point.i)},${y(point.v)}`).join('');
  };
  const series = (key) => points.map((point, i) => ({ i, v: point[key] })).filter((point) => Number.isFinite(point.v));
  const primary = series('p'), secondary = series('s'), lastPoint = primary[primary.length - 1], lastSecondary = secondary[secondary.length - 1];
  const currentValue = (items) => items.length ? `${Math.round(items[items.length - 1].v)} %` : '—';
  const d = path('p'), area = d ? `${d}L${x(points.length - 1)},${y(0)}L0,${y(0)}Z` : '';
  const marker = lastPoint ? `<i class="spark-marker" data-tip="5 heures : ${Math.round(lastPoint.v)} % restants" style="left:${(lastPoint.i / Math.max(points.length - 1, 1) * 100).toFixed(2)}%;top:${y(lastPoint.v)}px"></i>` : '';
  const secondaryMarker = lastSecondary ? `<i class="spark-marker secondary" data-tip="Hebdo : ${Math.round(lastSecondary.v)} % restants" style="left:${(lastSecondary.i / Math.max(points.length - 1, 1) * 100).toFixed(2)}%;top:${y(lastSecondary.v)}px"></i>` : '';
  const spanMs = Date.parse(points[points.length - 1].t) - Date.parse(points[0].t);
  const byHour = spanMs < 24 * 3600000;
  const fmtX = (t) => byHour ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h') : new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const caption = byHour ? `dernières ${Math.max(1, Math.round(spanMs / 3600000))} h` : '7 derniers jours';
  const inAlert = LIMIT_ALERT >= scale.lo && LIMIT_ALERT <= scale.hi;
  const alertChip = inAlert ? `<span class="spark-threshold-chip" style="top:${y(LIMIT_ALERT)}px">${LIMIT_ALERT} %</span>` : '';
  const axis = [100, 50, 0].map((value) => `<span class="spark-y" style="top:${y(value)}px">${value} %</span>`).join('');
  const grid = [100, 50, 20, 0].map((value) => `<i class="spark-grid${value === LIMIT_ALERT ? ' threshold' : ''}" style="top:${y(value)}px"></i>`).join('');
  el.innerHTML = `<div class="spark-head"><div class="spark-legend"><span class="spark-key solid"><span>5 heures</span><b>${currentValue(primary)}</b></span><span class="spark-key dashed"><span>Hebdo</span><b>${currentValue(secondary)}</b></span></div><span class="muted">${escape(caption)} · % restants</span></div>`
    + `<div class="spark-wrap">${axis}<div class="spark-plot">${grid}`
    + `<svg class="limit-spark" role="img" aria-label="Historique des limites Codex, 5 heures et hebdomadaire" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${area ? `<path d="${area}" class="spark-area"/>` : ''}<path d="${path('s')}" class="spark-secondary"/><path d="${d}" class="spark-primary"/></svg>`
    + secondaryMarker + marker + alertChip + `</div></div>`
    + `<div class="spark-x"><span>${escape(fmtX(points[0].t))}</span><span>${escape(fmtX(points[points.length - 1].t))}</span></div>`;
}
let historyAt = 0;
async function loadHistory(force = false) {
  if (!readHistoryPref()) return;
  if (!force && Date.now() - historyAt < 300000) return;
  try { limitsHistory = await (await fetch('/api/limits/history?days=7')).json(); historyAt = Date.now(); paintHistory(); } catch { /* courbe garde son état */ }
}
const ageLabel = (iso) => {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (minutes < 1) return "à l'instant";
  return minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h`;
};
function renderLimits(limits) {
  lastLimits = limits;
  const el = $('#limits');
  const showHistory = readHistoryPref();
  const low = (window) => window && Number.isFinite(window.remaining) && window.remaining < LIMIT_ALERT;
  const bar = (label, window, stale = false) => window
    ? `<div class="limit${stale ? ' stale' : ''}${low(window) ? ' low' : ''}"><div class="limit-head"><b>${label}</b><span>${Math.round(window.remaining)}% restants · ${resetLabel(window.resetsAt)}</span></div><div class="limit-track"><i style="width:${Math.min(100, Math.max(0, window.remaining))}%"></i></div></div>`
    : `<div class="limit"><div class="limit-head"><b>${label}</b><span class="muted">indisponible</span></div></div>`;
  const note = { auth_expired: 'session Codex expirée, relance Codex', not_connected: 'Codex non connecté', not_applicable: 'sans objet (clé API)', network: 'réseau injoignable (chatgpt.com)', rate_limited: 'OpenAI limite les appels, réessaie plus tard', service: 'service OpenAI en erreur', empty: 'réponse OpenAI sans fenêtres de quota' }[limits.status] || 'limites indisponibles pour le moment';
  const title = `Limites Codex${limits.plan ? ` · ${escape(limits.plan)}` : ''}`;
  const alert = [['5 heures', limits.primary], ['Hebdo', limits.secondary]].filter(([, window]) => low(window)).map(([label]) => label).join(' et ');
  const badge = alert ? `<b class="limit-alert">⚠ ${escape(alert)} sous les ${LIMIT_ALERT} %</b>` : '';
  const toggle = `<button id="limits-history-toggle" class="head-toggle" aria-pressed="${showHistory}">${showHistory ? 'Masquer le graphique' : 'Afficher le graphique'}</button>`;
  const grid = `<div class="limit-grid">${bar('5 heures', limits.primary, limits.status !== 'connected')}${bar('Hebdo', limits.secondary, limits.status !== 'connected')}</div>${showHistory ? '<div class="limit-history" id="limit-history"></div>' : ''}`;
  if (limits.status === 'connected') el.innerHTML = `<div class="panel-head"><h2>${title}</h2><span>${badge || 'temps réel'}</span>${toggle}</div>${grid}`;
  else if (limits.primary || limits.secondary) el.innerHTML = `<div class="panel-head"><h2>${title}</h2><span class="muted">${badge ? `${badge} ` : ''}${escape(note)} · ${escape(ageLabel(limits.fetchedAt))}</span><span class="limit-actions"><button id="limits-retry">Réessayer</button>${toggle}</span></div>${grid}`;
  else el.innerHTML = `<div class="panel-head"><h2>Limites Codex</h2><span class="muted">${escape(note)}</span><button id="limits-retry">Réessayer</button></div>`;
  const retry = $('#limits-retry');
  if (retry) retry.onclick = () => { loadLimits(true); loadHistory(true); };
  const toggleBtn = $('#limits-history-toggle');
  if (toggleBtn) toggleBtn.onclick = () => { saveHistoryPref(!readHistoryPref()); renderLimits(lastLimits); loadHistory(true); };
  paintHistory();
}
let limitsAt = 0;
async function loadLimits(force = false) {
  if (!force && Date.now() - limitsAt < 60000) return;
  try { renderLimits(await (await fetch('/api/limits')).json()); limitsAt = Date.now(); } catch { /* bandeau garde son état */ }
  loadHistory(force);
}
function renderSplit(s) {
  const mode = $('#cost-mode').value === 'api_cost' ? 'api' : 'paid';
  const parts = [['Input', 'input', Number(s.input) || 0, 'var(--blue)'], ['Cache', 'cached', Number(s.cached) || 0, 'var(--ink-muted)'], ['Output', 'output', Number(s.output) || 0, 'var(--accent)'], ['Raisonnement', 'reasoning', Number(s.reasoning) || 0, 'var(--violet)']];
  const total = parts.reduce((sum, [, , value]) => sum + value, 0);
  const pct = (value, of) => value && of ? `${(value / of * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '0 %';
  if (!total) { $('#split-bar').innerHTML = ''; $('#split-costbar').innerHTML = ''; $('#split-legend').innerHTML = '<span class="muted">Aucune donnée.</span>'; return; }
  const track = (items, tip) => `<div class="split-track">${items.map(([label, value, color, denom]) => value > 0 ? `<i style="width:${value / denom * 100}%;background:${color}" data-tip="${escape(tip(label, value, denom))}"></i>` : '').join('')}</div>`;
  const costParts = parts.map(([label, key, , color]) => [label, Number(s[`${key}_${mode}_cost`]) || 0, color]);
  const costTotal = costParts.reduce((sum, [, value]) => sum + value, 0);
  $('#split-bar').innerHTML = `<div class="split-row"><span class="split-rowlabel">Tokens</span>${track(parts.map(([label, , value, color]) => [label, value, color, total]), (label, value, denom) => `${label} : ${compact.format(value)} (${pct(value, denom)})`)}</div>`;
  $('#split-costbar').innerHTML = costTotal
    ? `<div class="split-row"><span class="split-rowlabel">${escape(modeLabel())}</span>${track(costParts.map(([label, value, color]) => [label, value, color, costTotal]), (label, value, denom) => `${label} : ${money.format(value)} (${pct(value, denom)})`)}</div>`
    : '<span class="muted">Aucun coût sur la période.</span>';
  $('#split-legend').innerHTML = parts.map(([label, key, value, color]) => `<span class="split-key"><i class="dot" style="background:${color}"></i><span class="split-keycol"><span><label>${escape(label)}</label> <small>${compact.format(value)} · ${pct(value, total)}</small></span><small class="split-cost">${money.format(Number(s[`${key}_${mode}_cost`]) || 0)}</small></span></span>`).join('');
}
function renderSources(sources) { $('#sources').innerHTML = sources.map((source) => `<span class="source"><i class="status-dot ${source.status === 'connected' ? 'connected' : ''}"></i><b>${escape(source.platform)}</b><span class="muted">${source.status === 'connected' ? `${number.format(source.sessions)} sessions` : 'non connecté'}</span></span>`).join(''); }
function render(data) {
  const s = data.summary, cost = s[$('#cost-mode').value];
  const models = mergeByModel(data.models);
  const projects = mergeByModel(data.projects.map((row) => ({ ...row, label: shortProject(row.label) })));
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
  $('#metrics').innerHTML = [metric('Sessions', number.format(s.sessions)), metric('Tokens totaux', compact.format(s.total)), metric('Prompt cache', cacheValue, cacheNote, cacheTitle), metric('Modèle principal', models[0]?.label || '—', '', models[0]?.label || ''), metric(modeLabel(), cost == null ? '—' : money.format(cost), cost == null ? 'prix manquants' : $('#cost-mode').value === 'paid_cost' ? 'Codex et OpenAI inclus' : 'tarifs API ou coût exact')].join('');
  renderDonut('model-donut', 'model-total', models, 'model'); renderDonut('platform-donut', 'platform-total', data.platforms, 'platform'); renderDonut('project-donut', 'project-total', projects, 'project'); renderSplit(s); renderChart(daily, data.range, data.pricing); renderActivityHeatmap(data.activity, data.activityVersion); renderAdtention(data.adtention); if (!$('#pricing').contains(document.activeElement)) renderPricing(data.pricing); renderSources(data.sources);
}
let loadVersion = 0;
let refreshPromise = null;
async function load(refresh = false) {
  const version = ++loadVersion;
  try {
    if (refresh) {
      refreshPromise ||= fetch('/api/refresh', { method: 'POST' });
      const response = await refreshPromise;
      refreshPromise = null;
      if (!response.ok) throw new Error('Refresh impossible');
    }
    const dataResponse = await fetch(`/api/data?${filterQuery()}`);
    if (!dataResponse.ok) throw new Error('Données indisponibles');
    const data = await dataResponse.json();
    if (version !== loadVersion) return;
    makeColors(data);
    render(data); $('#status').textContent = `${number.format(data.summary.sessions)} sessions · actualisé ${new Date().toLocaleTimeString('fr-FR')}`;
    fetch('/api/adtention/balance')
      .then((response) => response.ok ? response.json() : null)
      .then((balance) => { if (version === loadVersion) renderAdtention(balance); })
      .catch(() => { if (version === loadVersion) renderAdtention(null); });
  } catch {
    refreshPromise = null;
    if (version === loadVersion) $('#status').textContent = 'Connexion impossible · nouvelle tentative automatique';
  }
}
$('#refresh').onclick = async () => {
  const button = $('#refresh'), feedback = $('#refresh-feedback');
  button.disabled = true; button.textContent = 'Actualisation…'; button.classList.add('is-refreshing');
  feedback.textContent = 'Mise à jour en cours'; feedback.classList.add('visible');
  try {
    await Promise.all([load(true), loadLimits(true)]);
    button.textContent = 'Actualisé ✓'; feedback.textContent = 'Données à jour';
  } catch {
    button.textContent = 'Réessayer'; feedback.textContent = 'Actualisation impossible';
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = 'Actualiser'; button.classList.remove('is-refreshing'); feedback.classList.remove('visible'); }, 1800);
  }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadLimits(); });
window.addEventListener('focus', () => loadLimits());
applyTheme(themePreference);
$('#theme').addEventListener('change', () => {
  themePreference = $('#theme').value;
  try { themePreference === 'system' ? localStorage.removeItem('usage-monitor-theme') : localStorage.setItem('usage-monitor-theme', themePreference); } catch { /* preference remains session-only */ }
  applyTheme(themePreference);
});
themeMedia.addEventListener('change', () => { if (themePreference === 'system') applyTheme('system'); });
const updateTokenThresholdState = () => { $('#min-tokens').disabled = $('#metric').value !== 'total'; };
['#metric', '#cost-mode', '#platform', '#agent', '#model', '#project', '#from', '#to', '#chart-granularity', '#min-tokens'].forEach((id) => $(id).addEventListener('input', () => { if (id === '#from' || id === '#to') $('#period').value = 'custom'; if (id === '#metric') updateTokenThresholdState(); load(); }));
$('#period').addEventListener('input', () => { setPeriod(); load(); });
const normalizeRate = (input) => {
  const num = Number(input.value.trim().replace(',', '.'));
  if (input.value.trim() !== '' && Number.isFinite(num) && num >= 0) input.value = String(num).replace('.', ',');
};
$('#pricing-rows').addEventListener('focusout', (event) => { if (event.target.matches('.rate')) normalizeRate(event.target); });
$('#pricing').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter || $('#pricing button'), feedback = $('#pricing-feedback');
  const pricing = [...$('#pricing-rows').rows].map((row) => ({ platform: row.dataset.platform, model: row.dataset.model, ...Object.fromEntries(['input', 'cached', 'output', 'reasoning'].map((name) => [name, (row.querySelector(`[name="${name}"]`).value || '0').replace(',', '.')])) }));
  button.disabled = true; button.textContent = 'Enregistrement…'; feedback.textContent = 'Mise à jour en cours'; feedback.classList.add('visible');
  try {
    const response = await fetch('/api/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pricing }) });
    if (!response.ok) throw new Error((await response.json()).error || 'Enregistrement impossible');
    await load();
    button.textContent = 'Prix enregistrés ✓'; feedback.textContent = 'Tarifs mis à jour';
  } catch (error) {
    button.textContent = 'Réessayer'; feedback.textContent = error.message;
  } finally {
    setTimeout(() => { button.disabled = false; button.textContent = 'Enregistrer prix'; feedback.classList.remove('visible'); }, 1800);
  }
});
let assetStamp = 0, localCommit = null;
async function checkVersion() {
  try {
    const info = await (await fetch('/api/version')).json();
    localCommit = info.commit || null;
    if (!assetStamp) assetStamp = info.stamp;
    else if (info.stamp !== assetStamp) location.reload();
  } catch { /* garde la page telle quelle */ }
}
async function checkUpdate() {
  if (!localCommit) return;
  try {
    const remote = (await (await fetch('https://api.github.com/Noe-Briffa/token-dashboard/commits/main')).json()).sha;
    $('#update').hidden = !remote || remote === localCommit;
  } catch { /* garde l'état actuel du bouton */ }
}
$('#update').onclick = async () => {
  if (!confirm('Télécharger et installer la nouvelle version du dashboard ?')) return;
  const button = $('#update');
  button.disabled = true; button.textContent = 'Mise à jour…';
  try {
    const response = await fetch('/api/update', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Mise à jour impossible');
    location.reload();
  } catch (error) { alert(error.message); button.disabled = false; button.textContent = '↓ Nouvelle version'; }
};
setPeriod(); updateTokenThresholdState(); watchTips(); load(); loadLimits(true); checkVersion().then(checkUpdate); setInterval(checkUpdate, 300000); setInterval(() => { load(true); loadLimits(); checkVersion(); }, 15000);

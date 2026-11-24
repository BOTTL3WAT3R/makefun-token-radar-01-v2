// Token Launch Radar — the dashboard's script. Renders window.RADAR (written by
// main.ts beside this page) as a sortable, filterable board with a per-protocol
// detail view. No network, no imports: everything is already on the page.
'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
const moneyFull = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const densityText = (d) => (d >= 100 ? Math.round(d).toLocaleString('en-US') : d.toFixed(2));

const state = { q: '', cat: '', chain: '', verdict: '', flag: '', wl: false, rising: false, sort: 'rank', dir: 1 };

// The band bars share one log scale across the whole board, so bars compare.
const allLow = Math.min(...R.rows.map((r) => r.implied_low_usd));
const allHigh = Math.max(...R.rows.map((r) => r.implied_high_usd));
const logPos = (v) => ((Math.log10(Math.max(v, 1)) - Math.log10(allLow)) / (Math.log10(allHigh) - Math.log10(allLow))) * 100;
function bandBar(r) {
  const l = logPos(r.implied_low_usd), h = logPos(r.implied_high_usd), p = logPos(r.implied_value_usd);
  return `<div class="bandbar"><div class="range" style="left:${l}%;width:${Math.max(2, h - l)}%"></div><div class="point" style="left:${p}%"></div></div>` +
    `<div class="bandtxt">${money(r.implied_low_usd)} – ${money(r.implied_high_usd)}</div>`;
}

function flagPill(r) {
  if (!r.product_flag) return '';
  const label = { wrapper: 'wrapper', cex: 'exchange', versioned: 'versioned' }[r.product_flag];
  return `<span class="flag ${r.product_flag}">${label}</span>`;
}
function changeCell(r) {
  if (r.change_7d === null) return '<span class="flat">—</span>';
  const cls = r.change_7d > 0.05 ? 'up' : r.change_7d < -0.05 ? 'down' : 'flat';
  const arrow = r.change_7d > 0.05 ? '▲' : r.change_7d < -0.05 ? '▼' : '·';
  return `<span class="${cls}">${arrow} ${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%</span>`;
}
function ageText(days) {
  if (days === null) return '—';
  return days >= 365 ? `${(days / 365).toFixed(1)}y` : `${days}d`;
}

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  return R.rows.filter((r) => {
    if (state.wl && !r.watchlist) return false;
    if (state.rising && !(r.change_7d !== null && r.change_7d >= 25)) return false;
    if (state.verdict && r.farm_verdict !== state.verdict) return false;
    if (state.cat && (r.category ?? '') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.flag === 'none' && r.product_flag) return false;
    if (state.flag && state.flag !== 'none' && r.product_flag !== state.flag) return false;
    if (q && !(`${r.name} ${r.slug} ${r.chains.join(' ')}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function sortedRows(rows) {
  const k = state.sort, d = state.dir;
  const val = (r) => (k === 'farm_verdict' ? { farm: 0, thin: 1, skip: 2 }[r.farm_verdict] : k === 'name' || k === 'category' ? (r[k] ?? '') : (r[k] ?? -Infinity));
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return (cmp !== 0 ? cmp : a.rank - b.rank) * (k === 'rank' ? 1 : d);
  });
}

function renderBoard() {
  const rows = sortedRows(visibleRows());
  $('rows').innerHTML = rows.map((r) => `
    <tr data-slug="${esc(r.slug)}">
      <td class="num">${r.rank}</td>
      <td><span class="name">${esc(r.name)}</span>${r.watchlist ? '<span class="wl-dot">● watchlist</span>' : ''}${flagPill(r)}<br><span class="slug">${esc(r.slug)}</span></td>
      <td class="cat">${esc(r.category ?? '—')}</td>
      <td class="num">${money(r.tvl_usd)}</td>
      <td class="num">${changeCell(r)}</td>
      <td class="num">${ageText(r.age_days)}</td>
      <td class="num"><strong>${money(r.implied_value_usd)}</strong></td>
      <td>${bandBar(r)}</td>
      <td class="num">${moneyFull(r.plan_cost_usd)}</td>
      <td class="num">${densityText(r.value_density)}</td>
      <td><span class="pill ${r.farm_verdict}">${r.farm_verdict}</span></td>
    </tr>`).join('');
  $('row-count').textContent = `${rows.length} of ${R.rows.length} protocols`;
  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.addEventListener('click', () => { location.hash = `#/p/${tr.dataset.slug}`; });
  });
  document.querySelectorAll('thead th').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort));
}

function renderLive() {
  $('live').innerHTML = `<div class="live-grid">${R.live.map((p) => `
    <div class="live-card"><span class="nm">${esc(p.name)}</span> <span class="mt">${esc(p.symbol ?? '')}</span><br>
    <span class="mt">mcap ${money(p.mcap_usd)} · TVL ${money(p.tvl_usd)}</span></div>`).join('')}</div>`;
}

function renderHeader() {
  const m = R.model;
  $('version').textContent = `model ${R.model_version}`;
  $('subline').textContent =
    `Every protocol in the sealed DefiLlama snapshot (as of ${R.as_of}) that records no token — ${R.counts.pre_token} of them, ` +
    `the house watchlist's ${R.counts.watchlist} in full — ranked by the implied value of the token it may one day issue, ` +
    `each with a costed farm plan, a plan cost and a value density. The ${R.counts.live} largest traded protocols are set aside below: they are the comparables, never ranked.`;
  const farm = R.rows.filter((r) => r.farm_verdict === 'farm').length;
  const rising = R.rows.filter((r) => r.change_7d !== null && r.change_7d >= 25).length;
  $('model-strip').innerHTML = [
    ['Comps curve', `${m.n_comps} traded protocols`],
    ['Blind error', `×${m.band_ratio} <small>median, tested blind</small>`],
    ['Watchlist covered', `${R.counts.watchlist}/${R.counts.watchlist}`],
    ['Verdicts: farm', `${farm} <small>of ${R.counts.board}</small>`],
    ['Rising ≥25% / 7d', `${rising} <small>momentum signal</small>`],
  ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
}

function renderMethod() {
  const m = R.model;
  const rejected = m.rejected_specs.map((s) => `<li>${esc(s.spec)} — ×${s.median_error_ratio.toFixed(2)}</li>`).join('');
  $('method').innerHTML = `
    <p>The board's implied value is this entry's own claim, fitted on the snapshot's own figures — never a hand-kept list of names:</p>
    <div class="formula">log10(mcap) = ${m.intercept.toFixed(4)} + ${m.tvl_coef.toFixed(4)} · log10(TVL) + ${m.age_coef.toFixed(4)} · log10(1 + age_days)</div>
    <p>Fitted by least absolute deviations on the ${m.n_comps} traded protocols with market cap and TVL both at or above ${money(m.comp_floor_usd)}.
    Tested blind by ${esc(m.validation.method)}: the median held-out prediction is off by ×${m.band_ratio}
    (${m.validation.within_2x_pct}% land within 2×, ${m.validation.within_5x_pct}% within 5×). Every row's band is its value ÷/× that measured error.</p>
    <p>Specs tested blind for this build and rejected on the same folds:</p>
    <ul>${rejected}</ul>
    <p><strong>Momentum:</strong> the 7-day TVL change is a timing signal, not a price input — the blind test above is why.
    It flags rising protocols, sorts the board when asked, and sizes the farm plan's first position (halved when TVL is falling fast).</p>
    <p><strong>Value density:</strong> the plan's closing arithmetic as one number — an assumed early-user pool of ${(m.pool_share * 100).toFixed(0)}% of implied value
    (a labelled assumption, not a promise) divided by the plan's total cost. Rank is implied value alone; density is the priority order across the board.</p>
    <p><strong>Verdicts:</strong> farm / thin / skip net that pool against the plan's cost. Wrapped or staked products of a token that already trades are
    flagged and capped at skip — their launch already happened under the parent asset's name. Capital-passive categories are capped at thin:
    parked capital is their only signal. A protocol here "records no token" in DefiLlama's data; that is a record, not proof it has none.</p>`;
  $('foot').textContent = `Snapshot: ${R.source} · as of ${R.as_of} · watchlist floor ${moneyFull(R.floor_usd)} · model ${R.model_version}. Implied values are this entry's claims, not make.fun's.`;
}

function renderDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) { location.hash = '#/'; return; }
  const plan = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  $('detail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(r.name)}</h2>
      <span class="pill ${r.farm_verdict}">${r.farm_verdict}</span>${flagPill(r)}
      ${r.watchlist ? '<span class="wl-dot">● on the house watchlist</span>' : ''}
    </div>
    <p class="hint">${esc(r.slug)} · ${esc(r.category ?? 'no category recorded')} · ${r.chains.length ? esc(r.chains.join(', ')) : 'no chain recorded'} · records no token in the snapshot</p>
    <div class="detail-grid">
      <div class="stat"><div class="k">Rank</div><div class="v">#${r.rank} <small>of ${R.counts.board}</small></div></div>
      <div class="stat"><div class="k">Implied value</div><div class="v">${money(r.implied_value_usd)}</div></div>
      <div class="stat"><div class="k">TVL</div><div class="v">${money(r.tvl_usd)}</div></div>
      <div class="stat"><div class="k">7d TVL change</div><div class="v">${r.change_7d === null ? '—' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</div></div>
      <div class="stat"><div class="k">Age with no token</div><div class="v">${r.age_days === null ? '—' : `${r.age_days} days`}</div></div>
      <div class="stat"><div class="k">Plan cost</div><div class="v">${moneyFull(r.plan_cost_usd)} <small>+ position</small></div></div>
      <div class="stat"><div class="k">Value density</div><div class="v">${densityText(r.value_density)}</div></div>
      <div class="stat"><div class="k">Momentum</div><div class="v">${r.momentum === null ? '—' : r.momentum.toFixed(2)}</div></div>
    </div>
    <div class="detail-band">
      <div class="k" style="color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.08em">Implied value band — the measured blind error, ÷/×${R.model.band_ratio}</div>
      ${bandBar(r)}
      <p class="hint">The point is the implied value; the bar is its band, ${moneyFull(r.implied_low_usd)} to ${moneyFull(r.implied_high_usd)}, on the board's shared log scale.</p>
    </div>
    <h3 style="margin:18px 0 4px">The farm plan</h3>
    <ol class="plan">${plan}</ol>`;
  $('board-view').hidden = true;
  $('detail-view').hidden = false;
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash || '#/';
  const detail = hash.match(/^#\/p\/(.+)$/);
  if (detail) { renderDetail(decodeURIComponent(detail[1])); return; }
  $('detail-view').hidden = true;
  $('board-view').hidden = false;
  // Board filters may ride in the hash (#/?v=farm&wl=1) so a view can be linked or captured.
  const q = new URLSearchParams(hash.split('?')[1] || '');
  if (q.has('v')) { state.verdict = q.get('v'); $('f-verdict').value = state.verdict; }
  if (q.has('wl')) { state.wl = q.get('wl') === '1'; $('f-wl').checked = state.wl; }
  if (q.has('rising')) { state.rising = q.get('rising') === '1'; $('f-rising').checked = state.rising; }
  if (q.has('sort')) { state.sort = q.get('sort'); state.dir = q.get('dir') === '-1' ? -1 : 1; }
  renderBoard();
}

function fillSelect(el, values, allLabel) {
  el.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

function init() {
  renderHeader();
  renderLive();
  renderMethod();
  fillSelect($('f-cat'), [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort(), 'All categories');
  fillSelect($('f-chain'), [...new Set(R.rows.flatMap((r) => r.chains))].sort(), 'All chains');
  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('f-cat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
  $('f-chain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('f-flag').addEventListener('change', (e) => { state.flag = e.target.value; renderBoard(); });
  $('f-wl').addEventListener('change', (e) => { state.wl = e.target.checked; renderBoard(); });
  $('f-rising').addEventListener('change', (e) => { state.rising = e.target.checked; renderBoard(); });
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'category' ? 1 : -1; }
      if (k === 'rank') state.dir = 1;
      renderBoard();
    });
  });
  window.addEventListener('hashchange', route);
  route();
}

init();

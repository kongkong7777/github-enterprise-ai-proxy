// HTML dashboard for ghe-proxy. Mirrors the jbai layout but adapted for
// GitHub PAT pools.
//
// Inputs: { pools, updatedAt }
//   pools: poolHealth() return value (see github-enterprise-ai-proxy.js)
//   updatedAt: ms epoch of the last quota cache refresh
//
// Output: full HTML string. The proxy serves this from GET /quota.

function fmtRelative(ms) {
  if (!ms) return '从未';
  const d = Date.now() - ms;
  const s = Math.abs(d / 1000) | 0;
  const future = d < 0;
  if (s < 60) return `${future ? '后' : '前'} ${s}秒`;
  const m = (s / 60) | 0;
  if (m < 60) return `${future ? '后' : '前'} ${m}分钟`;
  const h = (m / 60) | 0;
  if (h < 24) return `${future ? '后' : '前'} ${h}小时`;
  return `${future ? '后' : '前'} ${(h / 24) | 0}天`;
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  return (v * 100).toFixed(2) + '%';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function statusBadge(account) {
  if (account.disabled) {
    const reason = account.disabledReason || 'manual';
    return `<span class="badge badge-disabled" title="${esc(reason)}">已禁用</span>`;
  }
  if (!account.hasToken) return '<span class="badge badge-warn">无 Token</span>';
  const q = account.quota;
  if (!q) return '<span class="badge badge-warn">未查询</span>';
  if (!q.ok) return `<span class="badge badge-err" title="${esc(q.error || '')}">查询失败</span>`;
  // Use the per-account effective cap (parity with jbai-proxy). A
  // 50%-capped account turns red at 50%, not 95%.
  const burnt = account.effectiveBurntCap ?? 0.95;
  const warnAt = Math.max(0.05, burnt * 0.7);
  if (q.used_pct >= burnt) return '<span class="badge badge-err">配额耗尽</span>';
  if (q.used_pct >= warnAt) return '<span class="badge badge-warn">即将耗尽</span>';
  if (q.chat_enabled === false) return '<span class="badge badge-err">Chat 关闭</span>';
  if (q.models_available === false) return '<span class="badge badge-warn">无 Models 权限</span>';
  return '<span class="badge badge-ok">活跃</span>';
}
function capBadge(account) {
  if (typeof account.usedPctCap !== 'number') return '';
  const cap = (account.usedPctCap * 100).toFixed(0);
  return `<span class="badge badge-cap" title="tokens.json 设置了 usedPctCap，账号在 ${cap}% 时被视为耗尽">封顶 ${cap}%</span>`;
}
function progressBar(pct, capPct) {
  const v = Math.min(1, Math.max(0, pct ?? 0));
  const cls = v >= 0.95 ? 'bar-err' : v >= 0.8 ? 'bar-warn' : 'bar-ok';
  let line = '';
  if (typeof capPct === 'number' && capPct > 0 && capPct <= 1) {
    line = `<i class="cap-line" style="left:${(capPct * 100).toFixed(1)}%"></i>`;
  }
  return `<div class="bar"><div class="${cls}" style="width:${(v * 100).toFixed(1)}%"></div>${line}</div>`;
}
// Compact descriptor for sub-buckets (chat / completions / premium).
function bucketCell(snap) {
  if (!snap) return '<span class="muted">—</span>';
  if (snap.unlimited) return '<span class="bucket-ok" title="unlimited">∞</span>';
  if (!Number.isFinite(snap.entitlement) || snap.entitlement === 0) {
    return '<span class="muted">—</span>';
  }
  const used = snap.used ?? 0;
  const tot = snap.entitlement;
  const pct = ((used / tot) * 100).toFixed(0);
  const overage = snap.overage_count ? ` <span class="bucket-warn" title="overage_count">+${snap.overage_count}</span>` : '';
  return `<span class="bucket"><b>${used}</b>/${tot} <span class="muted">(${pct}%)</span>${overage}</span>`;
}

// Enterprise-license card. Renders nothing (empty string) when no probe has
// run; renders a "configure GHE_COPILOT_ADMIN_PAT" hint when the probe is
// disabled; renders an error pill when the probe ran but failed; renders a
// seat usage gauge + per-assignee table when the probe succeeded.
function renderEnterpriseCard(enterprise, poolAccountIds) {
  if (!enterprise) return '';
  if (!enterprise.ok) {
    if (enterprise.notConfigured) {
      return `<div class="enterprise enterprise-hint">
        <strong>企业 Copilot 席位监控 未启用</strong>
        <span class="muted"> · 在 proxy 环境里设置 <code>GHE_COPILOT_ADMIN_PAT</code>（带 <code>manage_billing:copilot</code> scope 的 PAT），即可看到 "X / Y 席位已用"</span>
      </div>`;
    }
    return `<div class="enterprise enterprise-err">
      <strong>企业席位查询失败</strong>
      <span class="muted"> · ${esc(enterprise.error || 'unknown')}</span>
      ${enterprise.hint ? `<div class="muted" style="margin-top:4px">${esc(enterprise.hint)}</div>` : ''}
    </div>`;
  }
  const s = enterprise.seats || {};
  const total = s.total ?? 0;
  const used = s.active_this_cycle ?? 0;
  const free = s.free ?? Math.max(0, total - used);
  const pct = total > 0 ? used / total : 0;
  const cls = pct >= 0.95 ? 'bar-err' : pct >= 0.8 ? 'bar-warn' : 'bar-ok';
  const tierBadge = enterprise.tier === 'enterprise'
    ? '<span class="tier-pill tier-enterprise">Enterprise · $39/seat · 1000 premium</span>'
    : enterprise.tier === 'business'
    ? '<span class="tier-pill tier-business">Business · $19/seat · 300 premium</span>'
    : '';

  // Per-assignee table. Set is empty for Enterprise-tier responses where
  // /billing has the seat_breakdown but no assignee list — that path doesn't
  // populate `assignees`. For Business-tier we synthesize from /billing/seats
  // (see refreshEnterpriseLicense). Either way, when present, render every
  // seat the enterprise is paying for, and mark whether the proxy pool has
  // a usable OAuth token for that user (= "在池子里" / "需要 mint OAuth").
  let assigneesHtml = '';
  if (Array.isArray(enterprise.assignees) && enterprise.assignees.length > 0) {
    const poolSet = new Set(poolAccountIds || []);
    // Sort: in-pool first (most actionable), then pending-cancel last.
    const sorted = [...enterprise.assignees].sort((a, b) => {
      const aInPool = poolSet.has(a.login) ? 0 : 1;
      const bInPool = poolSet.has(b.login) ? 0 : 1;
      if (aInPool !== bInPool) return aInPool - bInPool;
      const aPending = a.pending_cancellation_date ? 1 : 0;
      const bPending = b.pending_cancellation_date ? 1 : 0;
      return aPending - bPending;
    });
    const rows = sorted.map(a => {
      const inPool = poolSet.has(a.login);
      const pendingCancel = a.pending_cancellation_date;
      const lastAct = a.last_activity_at ? esc(fmtRelative(Date.parse(a.last_activity_at))) : '<span class="muted">从未活动</span>';
      let stateBadge;
      if (pendingCancel) {
        stateBadge = `<span class="seat-badge seat-cancel">⏱ ${esc(pendingCancel)} 取消</span>`;
      } else if (inPool) {
        stateBadge = `<span class="seat-badge seat-active">✓ 已入池</span>`;
      } else {
        stateBadge = `<span class="seat-badge seat-pending">⏳ 未 mint OAuth</span>`;
      }
      const planLabel = a.plan_type === 'enterprise'
        ? '<span class="plan-tag plan-e">E</span>'
        : '<span class="plan-tag plan-b">B</span>';
      return `<tr class="${pendingCancel ? 'seat-row-cancel' : (inPool ? '' : 'seat-row-pending')}">
        <td><code>${esc(a.login || '?')}</code> ${planLabel}</td>
        <td>${stateBadge}</td>
        <td class="muted">${lastAct}</td>
      </tr>`;
    }).join('');
    const inPoolCount = sorted.filter(a => poolSet.has(a.login) && !a.pending_cancellation_date).length;
    const pendingMintCount = sorted.filter(a => !poolSet.has(a.login) && !a.pending_cancellation_date).length;
    assigneesHtml = `
      <div class="seat-summary muted" style="margin-top:10px">
        <span>共 ${sorted.length} 个坐席</span>
        <span> · 已入池 <strong style="color:#1a7f37">${inPoolCount}</strong></span>
        <span> · 待 mint OAuth <strong style="color:#9a6700">${pendingMintCount}</strong></span>
        <span> · 待取消 <strong style="color:#cf222e">${sorted.length - inPoolCount - pendingMintCount}</strong></span>
      </div>
      <table class="seat-table">
        <thead><tr><th>GitHub 用户</th><th>状态</th><th>最近活动</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  return `<div class="enterprise enterprise-ok">
    <div class="enterprise-line">
      <strong>企业 Copilot 席位</strong>
      <span class="muted"> · ${esc(enterprise.enterprise || '')}</span>
      ${tierBadge}
      <span class="enterprise-fig">${used} / ${total} 已用</span>
      <span class="muted"> · ${free} 可用 · ${s.pending_cancellation || 0} 待取消</span>
    </div>
    <div class="bar enterprise-bar"><div class="${cls}" style="width:${(pct * 100).toFixed(1)}%"></div></div>
    <div class="muted" style="margin-top:6px">
      ${enterprise.tier === 'business' ? `<span class="muted">via <code>/billing/seats</code> fallback</span> · ` : ''}
      ${enterprise.seat_management_setting ? `模式 <code>${esc(enterprise.seat_management_setting)}</code> · ` : ''}
      ${enterprise.ide_chat ? `IDE Chat ${esc(enterprise.ide_chat)} · 平台 Chat ${esc(enterprise.platform_chat || '?')} · CLI ${esc(enterprise.cli || '?')}` : ''}
      ${enterprise.refreshedAt ? ` · 数据 ${esc(fmtRelative(enterprise.refreshedAt))}` : ''}
    </div>
    ${assigneesHtml}
  </div>`;
}

export function renderQuotaDashboard({ pools, updatedAt, enterprise, basePath = '' }) {
  const totalAccounts = pools.reduce((n, p) => n + p.accounts.length, 0);
  const okCount = pools.reduce((n, p) => n + p.accounts.filter(a => a.quota?.ok && a.quota.used_pct < 0.95 && !a.disabled).length, 0);
  const burntCount = pools.reduce((n, p) => n + p.accounts.filter(a => a.quota?.ok && a.quota.used_pct >= 0.95).length, 0);

  const poolsHtml = pools.map(pool => {
    const target = pool.currentRoutingTarget;
    const targetAccount = pool.accounts.find(a => a.id === target);
    const targetPct = targetAccount?.quota?.used_pct;
    const banner = `
      <div class="route-banner">
        <span class="dot"></span>
        当前路由到 →
        <strong>${esc(target || '(无可用账号)')}</strong>
        ${target ? `<span class="muted">(已用 ${fmtPct(targetPct)})</span>` : ''}
        <span class="muted"> 策略 = ${esc(pool.effectiveStrategy)}/${esc(pool.effectiveDirection)}</span>
      </div>`;
    const rows = pool.accounts.map(a => {
      const q = a.quota || {};
      const snaps = q.quota_snapshots || {};
      const isTarget = a.id === target;
      const opBtn = a.disabled
        ? `<button class="op-btn op-enable" data-id="${esc(a.id)}" data-op="enable">启用</button>`
        : `<button class="op-btn op-swap"   data-id="${esc(a.id)}" data-op="swap">切换走</button>`;
      return `<tr class="${isTarget ? 'is-target' : ''}">
        <td>
          <strong>${esc(a.login || a.id)}</strong>
          ${a.login && a.login !== a.id ? `<span class="muted">(${esc(a.id)})</span>` : ''}
          ${isTarget ? '<span class="badge badge-routing">● 路由中</span>' : ''}
          ${capBadge(a)}
        </td>
        <td>${statusBadge(a)}</td>
        <td>${q.ok ? fmtPct(q.used_pct) : '-'}</td>
        <td>${q.ok && q.total != null ? esc(`${q.used} / ${q.total}`) : '-'}</td>
        <td>${q.ok ? progressBar(q.used_pct, a.usedPctCap) : '-'}</td>
        <td>${bucketCell(snaps.premium_interactions)}</td>
        <td>${bucketCell(snaps.chat)}</td>
        <td>${bucketCell(snaps.completions)}</td>
        <td>${q.reset_ms ? esc(new Date(q.reset_ms).toLocaleDateString()) : '-'}</td>
        <td class="ops">${opBtn}</td>
      </tr>`;
    }).join('');
    return `
      <section class="pool">
        <h2>${esc(pool.id)} <span class="muted">(${pool.accounts.length} 个账号, ${pool.clientKeys} 个客户端 Key)</span></h2>
        ${banner}
        <table>
          <thead><tr>
            <th>账号</th><th>状态</th><th>已用 %</th><th>已用/总额</th><th>进度</th>
            <th>Premium</th><th>Chat</th><th>Completions</th><th>重置</th><th>操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>GHE 配额监控</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f6f8fa; margin: 0; padding: 24px; color: #24292f }
  h1 { margin-top: 0 }
  .meta { color: #57606a; font-size: 13px; margin-bottom: 16px }
  .summary { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; min-width: 140px }
  .card .n { font-size: 22px; font-weight: 600 }
  .card .l { font-size: 12px; color: #57606a }
  .pool { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; margin-bottom: 18px; padding: 14px 18px }
  .pool h2 { margin: 0 0 10px; font-size: 16px }
  .muted { color: #57606a; font-weight: normal; font-size: 12px }
  .route-banner { background: #ddf4ff; border: 1px solid #54aeff; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 14px }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #1f883d; margin-right: 6px; animation: pulse 1.4s infinite }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  table { width: 100%; border-collapse: collapse; font-size: 13px }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #eaeef2 }
  th { background: #f6f8fa; font-weight: 600 }
  tr.is-target { background: #fff8c5 }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; margin-left: 6px }
  .badge-ok { background: #dafbe1; color: #1a7f37 }
  .badge-warn { background: #fff8c5; color: #9a6700 }
  .badge-err { background: #ffebe9; color: #cf222e }
  .badge-disabled { background: #eaeef2; color: #57606a }
  .badge-routing { background: #ddf4ff; color: #0969da }
  .bar { width: 80px; height: 6px; background: #eaeef2; border-radius: 3px; overflow: hidden }
  .bar > div { height: 100%; transition: width .3s }
  .bar-ok { background: #1f883d }
  .bar-warn { background: #d4a72c }
  .bar-err { background: #cf222e }
  button { background: #1f883d; color: #fff; border: 0; border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer }
  button:hover { background: #1a7f37 }
  .badge-cap { background: rgba(80,140,255,0.18); color: #4a78d6; border: 1px solid rgba(80,140,255,0.45) }
  .bar { position: relative }
  .bar > .cap-line { position: absolute; top: -2px; bottom: -2px; width: 2px; background: rgba(80,140,255,0.85); pointer-events: none }
  .bucket { font-variant-numeric: tabular-nums; font-size: 12px }
  .bucket-ok { color: #1a7f37; font-weight: 700 }
  .bucket-warn { color: #b07020; font-weight: 600 }
  .ops .op-btn { font: inherit; font-size: 12px; padding: 3px 8px; border: 1px solid #888; background: #fff; cursor: pointer; border-radius: 4px; color: #24292f }
  .ops .op-btn:hover { background: #eaeef2 }
  .ops .op-btn.armed { background: #fff8c5; border-color: #b07020; color: #9a6700 }
  .ops .op-btn.busy { opacity: 0.5; cursor: wait }
  .toast { position: fixed; bottom: 18px; right: 18px; padding: 10px 14px; border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,0.15); font-size: 13px; z-index: 100 }
  .toast-ok { background: #dafbe1; color: #1a7f37 }
  .toast-err { background: #ffebe9; color: #cf222e }
  .enterprise { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 18px }
  .enterprise-ok { border-left: 4px solid #0969da }
  .enterprise-hint { border-left: 4px solid #d4a72c; background: #fff8c5 }
  .enterprise-err { border-left: 4px solid #cf222e; background: #ffebe9 }
  .enterprise-line { font-size: 14px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap }
  .enterprise-fig { font-size: 18px; font-weight: 600; margin-left: 8px; color: #0969da }
  .enterprise-bar { width: 100%; height: 8px; margin-top: 8px }
  code { background: #eaeef2; padding: 1px 4px; border-radius: 3px; font-size: 12px }
  /* Tier pill in the enterprise card header. */
  .tier-pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 4px; border: 1px solid }
  .tier-enterprise { background: #fff3d6; color: #9a6700; border-color: #d4a72c }
  .tier-business   { background: #ddf4ff; color: #0969da; border-color: #54aeff }
  /* Per-seat table. */
  .seat-summary { display: flex; gap: 6px; font-size: 13px; flex-wrap: wrap }
  .seat-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px }
  .seat-table th, .seat-table td { padding: 6px 10px; border-bottom: 1px solid #eaeef2; text-align: left }
  .seat-table th { background: #f6f8fa; font-weight: 600; color: #57606a; font-size: 12px }
  .seat-row-pending { background: #fffbea }
  .seat-row-cancel  { color: #57606a; background: #fafbfc }
  .seat-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600 }
  .seat-active  { background: #dafbe1; color: #1a7f37 }
  .seat-pending { background: #fff8c5; color: #9a6700 }
  .seat-cancel  { background: #ffebe9; color: #cf222e }
  .plan-tag { display: inline-block; width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 50%; font-size: 10px; font-weight: 700; margin-left: 4px; vertical-align: middle }
  .plan-e { background: #fff3d6; color: #9a6700 }
  .plan-b { background: #ddf4ff; color: #0969da }
  /* Top backend switcher — common bar shared by JBA + GHE dashboards. */
  .nav-switch { display: flex; gap: 4px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 4px; margin: 0 0 18px; width: fit-content; box-shadow: 0 1px 2px rgba(0,0,0,0.04) }
  .nav-switch a { display: flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 5px; font-size: 13px; font-weight: 500; color: #57606a; text-decoration: none; transition: all .15s }
  .nav-switch a:hover { background: #f3f4f6; color: #24292f }
  .nav-switch a.active { background: #0969da; color: #fff; cursor: default; pointer-events: none }
  .nav-switch a.active:hover { background: #0969da }
  .nav-switch .badge-route { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(255,255,255,0.25); font-weight: 600 }
  .nav-switch a:not(.active) .badge-route { background: #eaeef2; color: #57606a }
  .nav-switch .icon { font-size: 14px; line-height: 1 }
</style>
</head><body>
  <nav class="nav-switch" aria-label="后端切换">
    <a href="/quota" title="JetBrains Enterprise AI 配额面板"><span class="icon">🧠</span>JBA<span class="badge-route">JetBrains</span></a>
    <a href="/ghe/quota" class="active" title="GitHub Enterprise AI Proxy 配额面板"><span class="icon">🐙</span>GHE<span class="badge-route">Copilot</span></a>
    <a href="/billing/" title="所有上游统一计费 dashboard"><span class="icon">💰</span>计费<span class="badge-route">Billing</span></a>
  </nav>
  <h1>GitHub Enterprise AI Proxy <span class="muted">配额监控</span></h1>
  <div class="meta">
    数据缓存于 <strong>${updatedAt ? esc(new Date(updatedAt).toLocaleString()) : '未刷新'}</strong>
    (${esc(fmtRelative(updatedAt))})
    &nbsp;·&nbsp;
    <button onclick="fetch('${basePath}/quota/refresh',{method:'POST'}).then(()=>location.reload())">立即刷新</button>
  </div>
  <div class="summary">
    <div class="card"><div class="n">${totalAccounts}</div><div class="l">总账号数</div></div>
    <div class="card"><div class="n">${okCount}</div><div class="l">可路由</div></div>
    <div class="card"><div class="n">${burntCount}</div><div class="l">已耗尽</div></div>
    <div class="card"><div class="n">${pools.length}</div><div class="l">池数</div></div>
  </div>
  ${renderEnterpriseCard(enterprise, pools.flatMap(p => p.accounts.filter(a => !a.disabled).map(a => a.id)))}
  ${poolsHtml}
<script>
// Arm-and-confirm pattern for /quota/swap and /quota/enable. We replaced
// window.confirm() (which a CDP-driven dashboard cannot click through)
// with a two-stage button: first click arms (→ "再点一次确认"), second
// click within ARMED_WINDOW_MS actually fires. Mirrors jbai-proxy.
(function() {
  const ARMED = new Map();
  const ARMED_WINDOW_MS = 6000;
  function isArmed(key) {
    const t = ARMED.get(key);
    return typeof t === 'number' && (Date.now() - t) < ARMED_WINDOW_MS;
  }
  function arm(btn, key, label) {
    ARMED.set(key, Date.now());
    const orig = btn.textContent;
    btn.classList.add('armed');
    btn.textContent = label;
    setTimeout(() => {
      if (!isArmed(key)) {
        btn.classList.remove('armed');
        btn.textContent = orig;
      }
    }, ARMED_WINDOW_MS);
  }
  function toast(msg, ok) {
    const t = document.createElement('div');
    t.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.op-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const op = btn.dataset.op;
    const key = op + ':' + id;
    if (!isArmed(key)) {
      const label = op === 'swap' ? '再点一次确认切换走 ' + id : '再点一次确认启用 ' + id;
      arm(btn, key, label);
      return;
    }
    ARMED.delete(key);
    btn.classList.remove('armed');
    btn.classList.add('busy');
    btn.disabled = true;
    try {
      const BASE = '${basePath}';
      const url = op === 'swap' ? BASE + '/quota/swap?id=' + encodeURIComponent(id) + '&reason=manual-dashboard'
                                : BASE + '/quota/enable?id=' + encodeURIComponent(id);
      const r = await fetch(url, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast((op === 'swap' ? '已切换走 ' : '已启用 ') + id, true);
        setTimeout(() => location.reload(), 700);
      } else {
        toast('失败：' + (j.error || r.status), false);
        btn.classList.remove('busy');
        btn.disabled = false;
      }
    } catch (err) {
      toast('网络错误：' + err.message, false);
      btn.classList.remove('busy');
      btn.disabled = false;
    }
  });
})();
</script>
</body></html>`;
}

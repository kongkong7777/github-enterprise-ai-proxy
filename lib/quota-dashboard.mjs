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
  if (account.disabled) return '<span class="badge badge-disabled">已禁用</span>';
  if (!account.hasToken) return '<span class="badge badge-warn">无 Token</span>';
  const q = account.quota;
  if (!q) return '<span class="badge badge-warn">未查询</span>';
  if (!q.ok) return `<span class="badge badge-err" title="${esc(q.error || '')}">查询失败</span>`;
  if (q.used_pct >= 0.95) return '<span class="badge badge-err">配额耗尽</span>';
  if (q.used_pct >= 0.80) return '<span class="badge badge-warn">即将耗尽</span>';
  if (q.models_available === false) return '<span class="badge badge-warn">无 Models 权限</span>';
  return '<span class="badge badge-ok">活跃</span>';
}
function progressBar(pct) {
  const v = Math.min(1, Math.max(0, pct ?? 0));
  const cls = v >= 0.95 ? 'bar-err' : v >= 0.8 ? 'bar-warn' : 'bar-ok';
  return `<div class="bar"><div class="${cls}" style="width:${(v * 100).toFixed(1)}%"></div></div>`;
}

// Enterprise-license card. Renders nothing (empty string) when no probe has
// run; renders a "configure GHE_COPILOT_ADMIN_PAT" hint when the probe is
// disabled; renders an error pill when the probe ran but failed; renders a
// seat usage gauge when the probe succeeded.
function renderEnterpriseCard(enterprise) {
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
  return `<div class="enterprise enterprise-ok">
    <div class="enterprise-line">
      <strong>企业 Copilot 席位</strong>
      <span class="muted"> · ${esc(enterprise.enterprise || '')}</span>
      <span class="enterprise-fig">${used} / ${total} 已用</span>
      <span class="muted"> · ${free} 可用 · ${s.pending_invitation || 0} 待激活 · 本周期新增 +${s.added_this_cycle || 0}</span>
    </div>
    <div class="bar enterprise-bar"><div class="${cls}" style="width:${(pct * 100).toFixed(1)}%"></div></div>
    <div class="muted" style="margin-top:6px">
      模式 <code>${esc(enterprise.seat_management_setting || '?')}</code>
      · IDE Chat ${esc(enterprise.ide_chat || '?')}
      · 平台 Chat ${esc(enterprise.platform_chat || '?')}
      · CLI ${esc(enterprise.cli || '?')}
      ${enterprise.refreshedAt ? ` · 数据 ${esc(fmtRelative(enterprise.refreshedAt))}` : ''}
    </div>
  </div>`;
}

export function renderQuotaDashboard({ pools, updatedAt, enterprise }) {
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
      const isTarget = a.id === target;
      return `<tr class="${isTarget ? 'is-target' : ''}">
        <td>
          <strong>${esc(a.id)}</strong>
          ${isTarget ? '<span class="badge badge-routing">● 路由中</span>' : ''}
        </td>
        <td>${statusBadge(a)}</td>
        <td>${q.ok ? fmtPct(q.used_pct) : '-'}</td>
        <td>${q.ok ? esc(`${q.used} / ${q.total}`) : '-'}</td>
        <td>${q.ok ? esc(String(q.remaining)) : '-'}</td>
        <td>${q.ok ? progressBar(q.used_pct) : '-'}</td>
        <td>${q.reset_ms ? esc(new Date(q.reset_ms).toLocaleString()) : '-'}</td>
        <td>${q.models_available === true ? '✓' : q.models_available === false ? '✗' : '-'}</td>
      </tr>`;
    }).join('');
    return `
      <section class="pool">
        <h2>${esc(pool.id)} <span class="muted">(${pool.accounts.length} 个账号, ${pool.clientKeys} 个客户端 Key)</span></h2>
        ${banner}
        <table>
          <thead><tr>
            <th>账号</th><th>状态</th><th>使用 %</th><th>已用 / 总额</th><th>剩余</th><th>进度</th><th>重置时间</th><th>Models</th>
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
  .enterprise { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin-bottom: 18px }
  .enterprise-ok { border-left: 4px solid #0969da }
  .enterprise-hint { border-left: 4px solid #d4a72c; background: #fff8c5 }
  .enterprise-err { border-left: 4px solid #cf222e; background: #ffebe9 }
  .enterprise-line { font-size: 14px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap }
  .enterprise-fig { font-size: 18px; font-weight: 600; margin-left: 8px; color: #0969da }
  .enterprise-bar { width: 100%; height: 8px; margin-top: 8px }
  code { background: #eaeef2; padding: 1px 4px; border-radius: 3px; font-size: 12px }
</style>
</head><body>
  <h1>GitHub Enterprise AI Proxy <span class="muted">配额监控</span></h1>
  <div class="meta">
    数据缓存于 <strong>${updatedAt ? esc(new Date(updatedAt).toLocaleString()) : '未刷新'}</strong>
    (${esc(fmtRelative(updatedAt))})
    &nbsp;·&nbsp;
    <button onclick="fetch('/quota/refresh',{method:'POST'}).then(()=>location.reload())">立即刷新</button>
  </div>
  <div class="summary">
    <div class="card"><div class="n">${totalAccounts}</div><div class="l">总账号数</div></div>
    <div class="card"><div class="n">${okCount}</div><div class="l">可路由</div></div>
    <div class="card"><div class="n">${burntCount}</div><div class="l">已耗尽</div></div>
    <div class="card"><div class="n">${pools.length}</div><div class="l">池数</div></div>
  </div>
  ${renderEnterpriseCard(enterprise)}
  ${poolsHtml}
</body></html>`;
}

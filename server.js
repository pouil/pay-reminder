// Pay Reminder MVP — merchant QR -> buyer calendar subscription
// Zero-dependency Node HTTP server. Data persisted to data.json next to this file.
//
// Routes:
//   GET  /                      merchant admin page (passcode gated)
//   POST /api/login             { pin } -> admin cookie
//   GET  /api/orders            list orders (admin)
//   POST /api/orders            create order { buyer, item, depositAmount, depositDate }
//   DELETE /api/orders/:id      delete order
//   POST /api/orders/:id/reminders   add reminder { title, amount, due, remindDays, note }
//   DELETE /api/orders/:id/reminders/:rid
//   GET  /t/:token              buyer subscribe page (public, via QR)
//   GET  /ics/:token.ics        calendar feed (public)
//
// Default admin passcode: 8888  (change ADMIN_PIN below)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = '8888';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ---------- request diagnostics (helps debug calendar clients that fail) ----------
const DEBUG_KEY = process.env.DEBUG_KEY || 'dbg7x2';
const REQ_LOG = [];
function logReq(req, url) {
  const rec = {
    t: new Date().toISOString(),
    m: req.method,
    p: url.pathname,
    q: url.search ? 1 : 0,
    sc: /(?:^|[?&])sharecode=/.test(url.search) ? 1 : 0,
    ua: String(req.headers['user-agent'] || '').slice(0, 140),
    acc: String(req.headers.accept || '').slice(0, 60),
    xf: String(req.headers['x-forwarded-for'] || '').slice(0, 60),
    pr: String(req.headers['x-forwarded-proto'] || ''),
    host: String(req.headers.host || ''),
  };
  REQ_LOG.push(rec);
  if (REQ_LOG.length > 300) REQ_LOG.shift();
  try { fs.appendFileSync(path.join(__dirname, 'requests.log'), JSON.stringify(rec) + '\n'); } catch (e) {}
}

// ---------- storage ----------
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { orders: [] };
  }
}
function saveData(db) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('saveData failed:', e.message);
  }
}
const uid = () => crypto.randomBytes(8).toString('hex');

// ---------- helpers ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}
function isAdmin(req) {
  const cookies = req.headers.cookie || '';
  return cookies.split(/;\s*/).some((c) => c === 'admin=1');
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  // fold at 74 chars per RFC 5545
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  let rest = line.slice(74);
  while (rest.length > 0) {
    out += '\r\n ' + rest.slice(0, 73);
    rest = rest.slice(73);
  }
  return out;
}
function icsDate(d) {
  // d: 'YYYY-MM-DD' -> 'YYYYMMDD'
  return d.replace(/-/g, '');
}
function addDays(dateStr, n) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function buildIcs(order, origin) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//PayReminder//MVP//CN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(icsFold('X-WR-CALNAME:' + esc('补款提醒 · ' + (order.item || order.buyer || '订单'))));
  lines.push('X-WR-TIMEZONE:Asia/Shanghai');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT15M');
  lines.push('X-PUBLISHED-TTL:PT15M');
  for (const r of order.reminders || []) {
    const amount = r.amount ? ' ¥' + r.amount : '';
    const title = r.title || '补款';
    const base = title + amount + ' · ' + (order.item || '');
    // main event: due date (all-day)
    const seq = String(r.seq || 0);
    const lm = (r.updatedAt || order.updatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + r.id + '@payreminder');
    lines.push('SEQUENCE:' + seq);
    lines.push('LAST-MODIFIED:' + lm);
    lines.push('DTSTAMP:' + now);
    lines.push('DTSTART;VALUE=DATE:' + icsDate(r.due));
    lines.push('DTEND;VALUE=DATE:' + icsDate(addDays(r.due, 1)));
    lines.push(icsFold('SUMMARY:' + esc('💰 补款到期：' + base)));
    lines.push(icsFold('DESCRIPTION:' + esc(
      (r.note ? r.note + '\n' : '') +
      '买家：' + (order.buyer || '-') + '\n' +
      '订单：' + (order.item || '-') + '\n' +
      '定金已付：' + (order.depositAmount ? '¥' + order.depositAmount : '-') +
      '（' + (order.depositDate || '-') + '）')));
    lines.push('TRANSP:TRANSPARENT');
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push(icsFold('DESCRIPTION:' + esc('今天到期：' + base)));
    lines.push('TRIGGER:-PT9H');
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
    // advance-notice event (guarantees a visible alert on Google Calendar too)
    const rd = parseInt(r.remindDays, 10);
    if (rd && rd > 0) {
      const adv = addDays(r.due, -rd);
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + r.id + '-adv@payreminder');
      lines.push('SEQUENCE:' + seq);
      lines.push('LAST-MODIFIED:' + lm);
      lines.push('DTSTAMP:' + now);
      lines.push('DTSTART;VALUE=DATE:' + icsDate(adv));
      lines.push('DTEND;VALUE=DATE:' + icsDate(addDays(adv, 1)));
      lines.push(icsFold('SUMMARY:' + esc('⏰ ' + rd + ' 天后补款：' + base)));
      lines.push(icsFold('DESCRIPTION:' + esc('到期日 ' + r.due + '。' + (r.note || ''))));
      lines.push('TRANSP:TRANSPARENT');
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(icsFold('DESCRIPTION:' + esc(rd + ' 天后补款：' + base)));
      lines.push('TRIGGER:-PT9H');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

// ---------- pages ----------
const adminHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>补款提醒 · 商家后台</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<style>
  :root { --brand:#A61B1B; --ink:#1a1a1a; --muted:#666; --line:#e5e0dc; --bg:#faf7f5; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); padding:20px 16px 60px; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:22px; font-weight:600; margin-bottom:4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:24px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:16px; }
  h2 { font-size:15px; font-weight:600; margin-bottom:12px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:9px; font-size:14px; }
  .row { display:flex; gap:10px; }
  .row > div { flex:1; }
  button { background:var(--brand); color:#fff; border:0; border-radius:9px; padding:10px 16px; font-size:14px; cursor:pointer; margin-top:14px; }
  button.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  button.small { padding:4px 10px; font-size:12px; margin-top:0; }
  .order { border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:16px; background:#fff; }
  .ohead { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
  .ohead b { font-size:15px; }
  .meta { color:var(--muted); font-size:13px; margin-top:4px; line-height:1.7; }
  .qr { text-align:center; }
  .qr canvas { border:8px solid #fff; border-radius:8px; box-shadow:0 0 0 1px var(--line); }
  .qr .hint { font-size:11px; color:var(--muted); margin-top:6px; }
  .grid { display:grid; grid-template-columns:1fr 220px; gap:16px; align-items:start; }
  @media (max-width:640px) { .grid { grid-template-columns:1fr; } }
  .rem { border-top:1px dashed var(--line); margin-top:12px; padding-top:10px; }
  .rem li { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; font-size:13px; list-style:none; }
  .rem ul { padding:0; }
  .pill { background:#EAF3DE; color:#3B6D11; border-radius:99px; padding:2px 9px; font-size:11px; }
  .toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); background:#1a1a1a; color:#fff; padding:9px 18px; border-radius:99px; font-size:13px; opacity:0; transition:.25s; pointer-events:none; }
  .toast.on { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>补款提醒 · 商家后台</h1>
  <div class="sub">创建订单 → 买家扫码订阅日历 → 随时添加补款日程，买家日历自动同步</div>

  <div class="card" id="loginCard" style="display:none">
    <h2>商家登录</h2>
    <div class="sub" style="margin:0 0 10px">输入后台口令进入（默认 <b>8888</b>，可在 server.js 里改 ADMIN_PIN）</div>
    <div class="row">
      <div style="flex:1"><label>口令</label><input id="pin" type="password" inputmode="numeric" placeholder="8888" onkeydown="if(event.key==='Enter')doLogin()"></div>
      <div style="flex:0 0 120px;display:flex;align-items:flex-end"><button style="width:100%" onclick="doLogin()">进入后台</button></div>
    </div>
  </div>

  <div class="card" id="newCard" style="display:none">
    <h2>新建订单（收到定金后建）</h2>
    <div class="row">
      <div><label>买家称呼</label><input id="buyer" placeholder="如：王女士"></div>
      <div><label>商品</label><input id="item" placeholder="如：手动咖啡磨豆机"></div>
    </div>
    <div class="row">
      <div><label>已收定金（¥）</label><input id="dep" type="number" placeholder="200"></div>
      <div><label>定金日期</label><input id="depd" type="date"></div>
    </div>
    <button onclick="createOrder()">创建订单并生成二维码</button>
  </div>

  <div id="list"></div>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
if (location.search.includes('sharecode=')) { try { localStorage.setItem('shareQs', location.search); } catch(e){} }
const SHARE_QS = location.search.includes('sharecode=') ? location.search : (function(){ try { return localStorage.getItem('shareQs') || ''; } catch(e){ return ''; } })();
const buyerUrl = (path) => location.origin + path + (SHARE_QS || '');
function toast(t){ const el=$('toast'); el.textContent=t; el.classList.add('on'); setTimeout(()=>el.classList.remove('on'),1800); }
async function api(method, url, body){
  const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: body?JSON.stringify(body):undefined });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(d.error || ('HTTP '+r.status));
  return d;
}
async function load(){
  try {
    const d = await api('GET','/api/orders');
    render(d.orders||[]);
  } catch(e){ render(null); }
}
let currentOrders = [];
const editing = {};
function render(orders){
  if (orders===null){
    $('loginCard').style.display='';
    $('newCard').style.display='none';
    $('list').innerHTML='';
    return;
  }
  $('loginCard').style.display='none';
  $('newCard').style.display='';
  currentOrders = orders;
  if (!orders.length){ $('list').innerHTML='<div class="card" style="text-align:center;color:#888">还没有订单。上面创建第一个试试。</div>'; return; }
  $('list').innerHTML = orders.map(o => \`
  <div class="order">
    <div class="grid">
      <div>
        <div class="ohead">
          <div><b>\${escHtml(o.buyer)} · \${escHtml(o.item)}</b>
            <div class="meta">定金 ¥\${o.depositAmount||'-'}（\${o.depositDate||'-'}）</div>
          </div>
          <button class="ghost small" onclick="delOrder('\${o.id}')">删除</button>
        </div>
        <div class="rem">
          <ul id="rem-\${o.id}">
            \${ (o.reminders||[]).map(r => \`<li><span>📅 \${escHtml(r.title)} ¥\${r.amount||'-'} · 到期 \${r.due} · 提前\${r.remindDays}天\${r.note?' · '+escHtml(r.note):''}</span><span><button class="ghost small" onclick="editRem('\${o.id}','\${r.id}')">改</button> <button class="ghost small" onclick="delRem('\${o.id}','\${r.id}')">删</button></span></li>\`).join('') || '<li style="color:#999">暂无补款日程 —— 货到了随时加</li>' }
          </ul>
          <div class="row" style="margin-top:8px">
            <div><label>事项</label><input id="rt-\${o.id}" placeholder="尾款"></div>
            <div><label>金额(¥)</label><input id="ra-\${o.id}" type="number"></div>
          </div>
          <div class="row" style="margin-top:8px">
            <div><label>补款到期日</label><input id="rd-\${o.id}" type="date"></div>
            <div><label>提前提醒(天)</label><input id="rr-\${o.id}" type="number" value="3"></div>
          </div>
          <div class="row"><div><label>备注（选填）</label><input id="rn-\${o.id}" placeholder="货已到，等通知"></div></div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:14px">
            <button id="btn-\${o.id}" onclick="saveRem('\${o.id}')" style="margin-top:0">添加补款日程</button>
            <button class="ghost small" id="cancel-\${o.id}" style="display:none" onclick="cancelEdit('\${o.id}')">取消修改</button>
          </div>
        </div>
      </div>
      <div class="qr">
        <div id="qr-\${o.id}"></div>
        <div class="hint">买家扫码 → 订阅到他的日历</div>
        <button class="ghost small" onclick="copyLink('\${o.token}')">复制链接</button>
      </div>
    </div>
  </div>\`).join('');
  for (const o of orders){
    const el = $('qr-'+o.id);
    if (el && window.QRCode){
      el.innerHTML='';
      const cv = document.createElement('canvas');
      el.appendChild(cv);
      QRCode.toCanvas(cv, buyerUrl('/t/' + o.token), { width:180, margin:1 }, ()=>{});
    }
  }
}
function escHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function doLogin(){
  const pin = ($('pin').value || '').trim();
  if (!pin){ toast('请输入口令'); return; }
  try {
    await api('POST','/api/login',{ pin });
    $('pin').value='';
    toast('已进入后台');
    load();
  } catch(e){ toast('口令不对，请重试'); }
}
async function createOrder(){
  try {
    await api('POST','/api/orders',{ buyer:$('buyer').value.trim(), item:$('item').value.trim(), depositAmount:$('dep').value, depositDate:$('depd').value });
    ['buyer','item','dep'].forEach(i=>$(i).value='');
    toast('订单已创建，二维码已生成'); load();
  } catch(e){ toast(e.message.includes('admin')||e.message.includes('登录')?e.message:'创建失败：'+e.message); }
}
function fillRem(id, r){
  $('rt-'+id).value = r.title || '';
  $('ra-'+id).value = r.amount || '';
  $('rd-'+id).value = r.due || '';
  $('rr-'+id).value = r.remindDays || 0;
  $('rn-'+id).value = r.note || '';
}
function editRem(oid, rid){
  const o = currentOrders.find(x=>x.id===oid); if(!o) return;
  const r = (o.reminders||[]).find(x=>x.id===rid); if(!r) return;
  fillRem(oid, r);
  editing[oid] = rid;
  const b = $('btn-'+oid); b.textContent = '保存修改'; b.dataset.editing='1';
  $('cancel-'+oid).style.display = '';
  toast('已载入「' + r.title + '」，改完点保存');
  $('rd-'+oid).scrollIntoView({block:'center', behavior:'smooth'});
}
function cancelEdit(oid){
  delete editing[oid];
  const b = $('btn-'+oid); b.textContent = '添加补款日程'; b.dataset.editing='';
  $('cancel-'+oid).style.display = 'none';
  ['rt-','ra-','rd-','rn-'].forEach(p=>$(p+oid).value='');
  $('rr-'+oid).value = 3;
}
async function saveRem(id){
  const body = {
    title:$('rt-'+id).value.trim()||'尾款', amount:$('ra-'+id).value,
    due:$('rd-'+id).value, remindDays:$('rr-'+id).value||3, note:$('rn-'+id).value.trim() };
  if (!body.due){ toast('请先选择补款到期日'); return; }
  const rid = editing[id];
  try {
    if (rid) {
      await api('PUT','/api/orders/'+id+'/reminders/'+rid, body);
      delete editing[id];
      toast('已保存修改，买家日历会在下次刷新时更新');
    } else {
      await api('POST','/api/orders/'+id+'/reminders', body);
      toast('已添加，买家日历将自动同步');
    }
    load();
  } catch(e){ toast((rid?'保存失败：':'添加失败：')+e.message); }
}
async function delOrder(id){ if(!confirm('删除该订单及其全部日程？'))return; await api('DELETE','/api/orders/'+id); load(); }
async function delRem(oid,rid){ await api('DELETE','/api/orders/'+oid+'/reminders/'+rid); load(); }
function copyLink(token){ navigator.clipboard.writeText(buyerUrl('/t/'+token)).then(()=>toast('链接已复制')); }
load();
</script>
</body>
</html>`;

const buyerHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>订阅补款提醒</title>
<style>
  :root { --brand:#A61B1B; --ink:#1a1a1a; --muted:#666; --line:#e5e0dc; --bg:#faf7f5; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); padding:32px 18px; }
  .wrap { max-width:430px; margin:0 auto; }
  .card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:22px; margin-bottom:14px; }
  h1 { font-size:19px; font-weight:600; }
  .sub { color:var(--muted); font-size:13px; margin-top:6px; line-height:1.7; }
  .meta { font-size:14px; line-height:2; margin-top:12px; }
  .meta b { font-size:16px; }
  li { list-style:none; padding:9px 0; border-bottom:1px dashed var(--line); font-size:14px; }
  ul { padding:0; margin-top:8px; }
  .due { color:var(--brand); font-weight:600; }
  a.btn { display:block; text-align:center; background:var(--brand); color:#fff; text-decoration:none; border-radius:12px; padding:14px; font-size:16px; font-weight:600; margin-top:6px; }
  a.alt { display:block; text-align:center; color:var(--muted); font-size:13px; margin-top:12px; }
  .ok { color:#3B6D11; font-size:13px; margin-top:10px; line-height:1.8; }
  button.btn2 { display:block; width:100%; text-align:center; background:#fff; color:var(--brand); border:1px solid var(--brand); border-radius:12px; padding:13px; font-size:15px; font-weight:600; margin-top:10px; cursor:pointer; font-family:inherit; }
  .link { word-break:break-all; font-size:11px; color:#999; margin-top:10px; background:#f6f3f1; border-radius:8px; padding:8px; line-height:1.6; }
  details { margin-top:12px; }
  summary { font-size:13px; color:var(--brand); cursor:pointer; }
  .help { font-size:12.5px; color:#555; line-height:1.9; margin-top:8px; background:#faf8f6; border-radius:10px; padding:10px 12px; }
  .warn { background:#FFF7E6; border:1px solid #F5D08A; border-radius:14px; padding:14px 16px; margin-bottom:14px; font-size:13px; color:#8a5a00; line-height:1.8; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>📅 订单补款提醒</h1>
    <div class="sub">订阅一次，补款日程会自动出现在你手机自带的日历里。无需下载 App，无需注册关注。</div>
    <div class="meta" id="info">加载中…</div>
  </div>
  <div class="warn" id="wxCard" style="display:none">
    <b>微信 / QQ 里打不开日历订阅</b><br>
    请点右上角「⋯」→「在浏览器打开」，再点下面的按钮。或者直接用 ② 复制链接，去日历里手动添加。
  </div>
  <div class="warn" id="noShare" style="display:none">
    <b>⚠️ 当前链接不完整</b><br>本页面地址缺少 sharecode 参数，复制出去的订阅链接会导致日历添加失败（Validation failed）。请让商家把<b>原始购买链接</b>重新发给你，从那条链接打开本页后再复制。
  </div>
  <div class="card">
    <a class="btn" id="sub" href="#">① 一键订阅（先试这个）</a>
    <button class="btn2" id="copy" type="button">② 复制订阅链接（手动添加到日历）</button>
    <a class="alt" id="dl" href="#">③ 下载 .ics 文件一次性导入</a>
    <div class="link" id="feedUrl">…</div>
    <div class="ok">iPhone 优先点 ①：若弹出的窗口里地址以 <b>http://</b> 开头，请手动改成 <b>https://</b>（只改这 5 个字母）再点「下一步」，否则会提示 <b>Validation failed</b>。<br>① 失败就用 ② 复制链接，去 <b>设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历</b> 粘贴（务必 https 开头、末尾带 ?sharecode=…）。安卓多数浏览器不支持 ①，请用 ②。今后商家新增的补款日程会自动同步。</div>
    <details>
      <summary>打不开？点这里看手动添加方法</summary>
      <div class="help">
        <b>iPhone</b>：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历 → 粘贴链接 → 存储<br>
        <b>Google 日历</b>：电脑打开 calendar.google.com → 左侧「其他日历」旁的 + → 通过网址 → 粘贴链接<br>
        <b>小米 / 华为 / OPPO / vivo 自带日历</b>：日历设置 → 订阅日历 / 日历账户 → 通过网址订阅 → 粘贴链接
      </div>
    </details>
  </div>
</div>
<script>
const token = location.pathname.split('/').pop();
// sharecode 必须出现在订阅链接里（日历 App 与 Safari 不共享 cookie）
try { if (location.search.indexOf('sharecode=') > -1) localStorage.setItem('shareQs', location.search); } catch(e){}
const QS = (location.search.indexOf('sharecode=') > -1) ? location.search : (function(){ try { return localStorage.getItem('shareQs') || ''; } catch(e){ return ''; } })();
const ORIGIN = 'https://' + location.host; // 强制 https，避免 http 触发跳转导致日历校验失败
const FEED = '/ics/' + token + '.ics' + QS;
document.getElementById('feedUrl').textContent = ORIGIN + FEED;
document.getElementById('sub').href = 'webcal://' + location.host + FEED;
document.getElementById('dl').href = FEED;
document.getElementById('dl').download = 'pay-reminder.ics';
if (QS.indexOf('sharecode=') === -1) {
  var ns = document.getElementById('noShare');
  if (ns) ns.style.display = 'block';
}
fetch('/api/public/order/' + token).then(r=>r.json()).then(d=>{
  const o = d.order;
  if (!o){ document.getElementById('info').textContent='链接无效或订单已删除。'; return; }
  document.getElementById('info').innerHTML =
    '订单：<b>' + esc(o.item) + '</b><br>定金：' + (o.depositAmount?'¥'+o.depositAmount:'-') +
    '（' + (o.depositDate||'-') + '）已收到<br>补款日程：' +
    ((o.reminders&&o.reminders.length) ? '<ul>' + o.reminders.map(r=>
      '<li>' + esc(r.title) + ' ¥' + (r.amount||'-') + ' · <span class="due">' + r.due + ' 到期</span> · 提前' + r.remindDays + '天提醒</li>').join('') + '</ul>'
      : '商家暂未安排，订阅后新增会自动出现');
});
if (/MicroMessenger|QQ\/|AlipayClient|Weibo/i.test(navigator.userAgent)) {
  document.getElementById('wxCard').style.display = 'block';
}
document.getElementById('copy').onclick = function(){
  const t = document.getElementById('feedUrl').textContent;
  const okText = function(){ document.getElementById('copy').textContent = '✓ 已复制，去日历里粘贴'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(okText).catch(function(){ fallbackCopy(t, okText); });
  } else { fallbackCopy(t, okText); }
};
function fallbackCopy(t, cb){
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb(); } catch(e){ alert('请在下方灰色框里长按链接手动复制 ' + t); }
  document.body.removeChild(ta);
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
</script>
</body>
</html>`;

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    logReq(req, url);

    // diagnostics: recent requests (protected by key)
    if (p === '/api/debug/log') {
      if (url.searchParams.get('key') !== DEBUG_KEY) return json(res, 403, { error: 'bad key' });
      return json(res, 200, { count: REQ_LOG.length, recent: REQ_LOG.slice(-40) });
    }

    // auth
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (String(b.pin) === ADMIN_PIN) {
        res.setHeader('Set-Cookie', 'admin=1; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax');
        json(res, 200, { ok: true });
      } else {
        json(res, 401, { error: '口令不对' });
      }
      return;
    }

    // admin: list
    if (p === '/api/orders' && req.method === 'GET') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const db = loadData();
      return json(res, 200, { orders: db.orders });
    }
    // admin: create order
    if (p === '/api/orders' && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const b = await readBody(req);
      if (!b.item && !b.buyer) return json(res, 400, { error: '至少填写买家或商品' });
      const db = loadData();
      const order = {
        id: uid(), token: uid(),
        buyer: String(b.buyer || '').slice(0, 40),
        item: String(b.item || '').slice(0, 60),
        depositAmount: String(b.depositAmount || '').slice(0, 12),
        depositDate: String(b.depositDate || ''),
        createdAt: new Date().toISOString(),
        reminders: [],
      };
      db.orders.unshift(order);
      saveData(db);
      return json(res, 200, { order });
    }
    // admin: delete order
    let m = p.match(/^\/api\/orders\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const db = loadData();
      db.orders = db.orders.filter((o) => o.id !== m[1]);
      saveData(db);
      return json(res, 200, { ok: true });
    }
    // admin: add reminder
    m = p.match(/^\/api\/orders\/([\w-]+)\/reminders$/);
    if (m && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const b = await readBody(req);
      if (!b.due) return json(res, 400, { error: '请选择补款到期日' });
      const db = loadData();
      const order = db.orders.find((o) => o.id === m[1]);
      if (!order) return json(res, 404, { error: '订单不存在' });
      order.reminders.push({
        id: uid(),
        title: String(b.title || '尾款').slice(0, 30),
        amount: String(b.amount || '').slice(0, 12),
        due: String(b.due),
        remindDays: Math.max(0, Math.min(60, parseInt(b.remindDays, 10) || 0)),
        note: String(b.note || '').slice(0, 80),
        seq: 0,
        updatedAt: new Date().toISOString(),
      });
      saveData(db);
      return json(res, 200, { ok: true });
    }
    // admin: edit reminder
    m = p.match(/^\/api\/orders\/([\w-]+)\/reminders\/([\w-]+)$/);
    if (m && req.method === 'PUT') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const b = await readBody(req);
      const db = loadData();
      const order = db.orders.find((o) => o.id === m[1]);
      if (!order) return json(res, 404, { error: '订单不存在' });
      const r = (order.reminders || []).find((x) => x.id === m[2]);
      if (!r) return json(res, 404, { error: '日程不存在' });
      if (b.title !== undefined) r.title = String(b.title || '尾款').slice(0, 30);
      if (b.amount !== undefined) r.amount = String(b.amount || '').slice(0, 12);
      if (b.due !== undefined) r.due = String(b.due);
      if (b.remindDays !== undefined) r.remindDays = Math.max(0, Math.min(60, parseInt(b.remindDays, 10) || 0));
      if (b.note !== undefined) r.note = String(b.note || '').slice(0, 80);
      r.seq = (r.seq || 0) + 1;
      r.updatedAt = new Date().toISOString();
      saveData(db);
      return json(res, 200, { ok: true, reminder: r });
    }
    // admin: delete reminder
    m = p.match(/^\/api\/orders\/([\w-]+)\/reminders\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      if (!isAdmin(req)) return json(res, 401, { error: '请先登录后台' });
      const db = loadData();
      const order = db.orders.find((o) => o.id === m[1]);
      if (order) order.reminders = order.reminders.filter((r) => r.id !== m[2]);
      saveData(db);
      return json(res, 200, { ok: true });
    }

    // public: buyer order info
    m = p.match(/^\/api\/public\/order\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const db = loadData();
      const order = db.orders.find((o) => o.token === m[1]);
      if (!order) return json(res, 404, { error: 'not found' });
      return json(res, 200, {
        order: {
          item: order.item, buyer: order.buyer,
          depositAmount: order.depositAmount, depositDate: order.depositDate,
          reminders: order.reminders.map((r) => ({
            title: r.title, amount: r.amount, due: r.due, remindDays: r.remindDays,
          })),
        },
      });
    }
    // public: ics feed (GET/HEAD/OPTIONS — some calendar clients probe with HEAD first)
    m = p.match(/^\/ics\/([\w-]+)\.ics$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
      const db = loadData();
      const order = db.orders.find((o) => o.token === m[1]);
      const ics = order ? buildIcs(order, url.origin) : buildIcs({ item: '订单不存在', buyer: '', reminders: [] }, url.origin);
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="pay-reminder.ics"',
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'GET') return res.end(ics);
      return res.end();
    }
    // pages
    if (p === '/' || p === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(adminHtml);
    }
    m = p.match(/^\/t\/([\w-]+)$/);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(buyerHtml);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { error: '服务器出错：' + e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Pay Reminder MVP running at http://0.0.0.0:' + PORT);
  console.log('Admin passcode: ' + ADMIN_PIN + '  (change ADMIN_PIN in server.js)');
});

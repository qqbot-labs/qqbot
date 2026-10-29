'use strict';

let csrf = '', cfg = null, rev = 0, status = null, page = 'overview';
let renderVersion = 0, sessionVersion = 0, busy = false, toastTimer;
let testSendUncertain = false;
const dirty = new Set();
const qrTimers = new Set();
const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const names = {
  overview: ['◈', '总览'], connection: ['⇄', '接入与登录'], models: ['◇', '模型与工具'],
  persona: ['◎', '人格与成长'], friends: ['♧', '好友与权限'], qzone: ['▤', 'QQ 空间'],
  memory: ['▱', '记忆与活动'], system: ['⚙', '系统与备份']
};
const permissionNames = {reply: '被动私聊', proactive: '主动联系', read: '空间读取', like: '空间点赞', comment: '空间评论'};
const fmt = t => Number.isFinite(Number(t)) && Number(t) > 0 ? new Date(Number(t) * 1000).toLocaleString('zh-CN', {hour12: false}) : '尚无记录';
const numberText = value => Number.isFinite(value) ? String(value) : '未知';
const tag = (text, good = false) => `<span class="tag ${good ? 'good' : 'warn'}">${esc(text)}</span>`;
const heading = (title, sub, extra = '') => `<div class="page-title"><div><h1 tabindex="-1">${esc(title)}</h1><p class="muted">${esc(sub)}</p></div>${extra}</div>`;
const field = (key, title, value, type = 'text', note = '', attrs = '') => `<div><label for="${key}">${esc(title)}</label><input id="${key}" type="${type}" value="${esc(value)}" ${attrs}>${note ? `<div class="field-note">${esc(note)}</div>` : ''}</div>`;
const check = (key, title, value, attrs = '') => `<label class="check"><input id="${key}" type="checkbox" ${value === true ? 'checked' : ''} ${attrs}>${esc(title)}</label>`;
const empty = text => `<div class="empty">${esc(text)}</div>`;
function table(cols, rows, message = '当前范围暂无记录。') {
  return rows.length ? `<div class="table-wrap" tabindex="0" aria-label="可横向滚动的数据表"><table><thead><tr>${cols.map(x => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty(message);
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = error ? 'error' : '';
  $('#toast').setAttribute('role', error ? 'alert' : 'status');
  $('#toast').hidden = false;
  if (!error) toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 7000);
}
function clearQRs() {
  qrTimers.forEach(clearTimeout);
  qrTimers.clear();
  document.querySelectorAll('.login-qr').forEach(el => el.replaceChildren());
}
function endSession(message = '') {
  sessionVersion += 1;
  renderVersion += 1;
  csrf = ''; cfg = null; status = null; rev = 0;
  dirty.clear(); clearQRs();
  $('#main').replaceChildren(); $('#nav').replaceChildren();
  $('#main').removeAttribute('aria-busy'); $('#main').inert = false; delete $('#main').dataset.page;
  $('#toast').hidden = true;
  $('#shell').hidden = true; $('#login').hidden = false;
  $('#password').value = ''; $('#login-error').textContent = message;
  $('#password').focus();
}
function responseError(detail, code) {
  if (typeof detail === 'string') return detail;
  // 校验错误中的 input/ctx 可能含密钥，绝不直接序列化展示。
  if (Array.isArray(detail)) return detail.map(e => `${Array.isArray(e.loc) ? e.loc.join('.') : '输入'}：${e.type || '校验失败'}`).join('；');
  return `请求失败（HTTP ${code}），请检查输入或稍后重试。`;
}
async function api(path, method = 'GET', data) {
  const version = sessionVersion;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 135000);
  try {
    const res = await fetch('/api/' + path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (version !== sessionVersion) throw Error('会话已变化，忽略先前请求结果。');
    if (res.status === 401 && path !== 'login') {
      endSession('登录已失效，请重新登录。未保存内容已从页面清除。');
      throw Error('登录已失效，请重新登录。');
    }
    let value;
    try { value = await res.json(); } catch { throw Error(`服务响应无效（HTTP ${res.status}）；写入结果可能未知，请先刷新核对，勿重复提交。`); }
    if (!res.ok) throw Error(responseError(value.detail, res.status));
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw Error('请求超时。写入结果可能未知，请先核对状态，勿盲目重试。');
    if (error instanceof TypeError) throw Error('无法连接管理后端。请检查服务与 SSH 隧道；写入结果可能未知，勿盲目重试。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function bind(el, fn, safety = false) {
  if (!el) return;
  el.addEventListener('click', async () => {
    if ((!safety && busy) || el.disabled) return;
    const version = sessionVersion;
    el.disabled = true;
    if (!safety) { busy = true; $('#main').inert = true; $('#nav').inert = true; }
    try { await fn(); }
    catch (error) { if (version === sessionVersion) toast(error.message, true); }
    finally {
      if (!safety) { busy = false; $('#main').inert = false; $('#nav').inert = false; }
      if (el.isConnected && el.dataset.keepDisabled !== 'true') el.disabled = false;
    }
  });
}
const on = (id, fn, safety = false) => bind($('#' + id), fn, safety);
function markClean(section) { dirty.delete(section); }
function confirmLeave() { return !dirty.size || window.confirm('当前有未保存的修改。离开会丢弃这些修改，继续吗？'); }
function watchForms() {
  $('#main').querySelectorAll('section[data-section]').forEach(section => {
    const mark = event => { if (!event.target.matches('[data-filter]')) dirty.add(section.dataset.section); };
    section.addEventListener('input', mark);
    section.addEventListener('change', mark);
  });
}
function setControls() {
  const controls = status?.controls;
  $('#pause').textContent = controls?.pause_active === false ? '暂停主动行为' : controls?.pause_active === true ? '恢复主动行为' : '暂停主动行为（状态待刷新）';
  $('#stop').textContent = controls?.stop_all === false ? '停止所有发信' : controls?.stop_all === true ? '解除全部发信停止' : '停止所有发信（状态待刷新）';
}
async function refreshStatus() { status = await api('status'); setControls(); }
async function saveConfig(next) {
  const result = await api('config', 'PUT', {revision: rev, config: next});
  // 只有持久化成功才提交本地快照，失败的编辑不能被其他保存按钮带入。
  cfg = next; rev = result.revision;
  return result;
}
function draftConfig() { return structuredClone(cfg); }
function saved(message, section) { markClean(section); toast(message + '；连接与发送能力仍以自检和后端门禁为准。'); }
function numeric(id, min, max, integer = true) {
  const raw = $('#' + id).value.trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < min || (max!=null && value > max) || (integer && !Number.isInteger(value))) {
    $('#' + id).focus();
    throw Error(`${document.querySelector(`label[for="${id}"]`)?.textContent || '数值'}须为 ${min}–${max??'不限'} ${integer ? '之间的整数' : '之间的数值'}。`);
  }
  return value;
}
function exportFile(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function download(path, filename) {
  // 备份/诊断文本必须原样保存：parse 后再序列化会把 5.0 变成 5，破坏备份校验和。
  const version = sessionVersion;
  const res = await fetch('/api/' + path, {credentials: 'same-origin', cache: 'no-store'});
  if (version !== sessionVersion) throw Error('会话已变化，忽略先前请求结果。');
  if (res.status === 401) { endSession('登录已失效，请重新登录。未保存内容已从页面清除。'); throw Error('登录已失效，请重新登录。'); }
  if (!res.ok) throw Error(`下载失败（HTTP ${res.status}），请稍后重试。`);
  exportFile(await res.text(), filename, 'application/json');
}
function channelSummary(channel) {
  const health = status.channels?.[channel] || {};
  if (cfg[channel === 'qq' ? 'channel' : 'qzone']?.enabled !== true) return '连接未启用';
  if (health.verified !== true || !health.checked) return '未检查 / 未验证';
  if (Date.now() / 1000 - health.checked > 300) return '上次检查已过期，待重新自检';
  return health.online === true ? '上次检查在线' : '上次检查未连接';
}
function operationState() {
  const c = status.controls || {};
  if (c.stop_all !== false) return '全部发信停止';
  if (c.social_running !== true) return '社交业务未启动';
  if (!status.persona?.active) return '人格未启用';
  if (cfg.policy.enabled !== true) return '正式社交关闭';
  if (c.pause_active !== false) return '主动行为暂停';
  return '调度已启用，仍受逐项门禁约束';
}
const pageData = {
  persona: () => api('personas'), friends: () => api('friends'),
  memory: () => api('friends'), qzone: () => api('qzone/events')
};
async function show(next = page, force = false) {
  if (!names[next] || (!force && (busy || !confirmLeave()))) return;
  const version = ++renderVersion;
  clearQRs();
  $('#main').setAttribute('aria-busy', 'true');
  $('#main').inert = true;
  try {
    const [configuration, currentStatus, data] = await Promise.all([api('config'), api('status'), pageData[next]?.()]);
    if (version !== renderVersion || !csrf) return;
    cfg = configuration.config; rev = configuration.revision; status = currentStatus; page = next;
    dirty.clear();
    $('#crumb').textContent = '工作空间 / ' + names[page][1];
    $('#nav').innerHTML = Object.entries(names).map(([key, [icon, title]]) => `<button type="button" data-page="${key}" ${key === page ? 'class="active" aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${title}</button>`).join('');
    $('#nav').querySelectorAll('button').forEach(button => { button.onclick = () => show(button.dataset.page); });
    setControls(); views[page](data); watchForms();
    $('#main').dataset.page = page;
    $('#main h1')?.focus({preventScroll: true});
  } catch (error) {
    if (version === renderVersion && csrf) {
      $('#main').innerHTML = heading('页面加载失败', '没有取得完整状态，不能使用旧数据继续操作。') + `<section class="card"><p role="alert">${esc(error.message)}</p><button id="retry-page">重新加载此页</button></section>`;
      delete $('#main').dataset.page;
      on('retry-page', () => show(next, true));
      toast(error.message, true);
    }
  } finally {
    if (version === renderVersion) { $('#main').removeAttribute('aria-busy'); $('#main').inert = busy; }
  }
}
function healthResult(target, result) {
  target.replaceChildren();
  const title = document.createElement('p');
  title.textContent = result.online === true && result.verified === true ? '本次连接自检通过；不等于真实收发与社交验收通过。' : '本次自检未通过或尚未验证。';
  const reason = document.createElement('p'); reason.className = 'muted'; reason.textContent = result.reason || '后端未提供原因。';
  const time = document.createElement('p'); time.className = 'field-note'; time.textContent = '检查时间：' + fmt(result.checked);
  target.append(title, reason, time); target.hidden = false;
}
function secretField(id, name, label, multiline = false) {
  return `<label for="${id}">${esc(label)} <span id="${id}-state">${tag(status.secrets?.[name] ? '已配置' : '未配置', !!status.secrets?.[name])}</span></label>${multiline ? `<textarea id="${id}" class="secret-text" spellcheck="false" autocomplete="off" placeholder="空白保留已有凭据"></textarea>` : `<input id="${id}" type="password" autocomplete="new-password" placeholder="空白保留已有凭据">`}<button type="button" class="text-btn" data-clear-secret="${name}" data-secret-input="${id}">清除已保存的${esc(label)}</button>`;
}
function updateSecretState(id, name, configured) {
  status.secrets[name] = configured === true;
  $('#' + id + '-state').innerHTML = tag(configured ? '已配置' : '未配置', configured === true);
}
async function saveSecret(id, name) {
  const input = $('#' + id);
  if (!input.value) return false;
  const result = await api('secrets', 'PUT', {name, value: input.value});
  input.value = ''; updateSecretState(id, name, result.configured);
  return true;
}
function bindSecretClears() {
  $('#main').querySelectorAll('[data-clear-secret]').forEach(button => bind(button, async () => {
    if (!confirm('清除后端保存的凭据？已登录桥接组件的会话可能仍存在，清除不等于平台退出。')) return;
    const result = await api('secrets', 'PUT', {name: button.dataset.clearSecret, clear: true});
    $('#' + button.dataset.secretInput).value = '';
    updateSecretState(button.dataset.secretInput, button.dataset.clearSecret, result.configured);
    toast('管理后端凭据已清除；如需退出平台，还应停止或退出对应组件。');
  }));
}
async function loginQR(channel) {
  const target = $('#' + channel + '-qr'); target.replaceChildren();
  let result = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await api('login/' + channel, 'POST', {});
    if (!target.isConnected) return;
    if (result.image) break;
    target.replaceChildren();
    const waiting = document.createElement('p'); waiting.className = 'muted';
    waiting.textContent = (attempt === 0 ? '正在生成二维码，请稍候… ' : '') + (result.note || result.reason || '未获得可用二维码，请检查组件。');
    target.append(waiting);
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1200));
  }
  if (!target.isConnected) return;
  if (!result.image) return;
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = result.note || '二维码已生成，请在手机端扫码。';
  target.replaceChildren(note);
  // 二维码只接收内嵌 PNG/JPEG，拒绝外站 URL、SVG 和执行协议。
  if (typeof result.image !== 'string' || result.image.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image)) throw Error('后端返回的二维码格式不安全或过大，已拒绝显示。');
  const image = document.createElement('img'); image.alt = channel === 'qq' ? 'QQ 登录二维码' : 'QQ 空间登录二维码'; image.width = 220; image.src = result.image;
  image.onerror = () => { image.remove(); note.textContent = '二维码图片无效，请重新获取。'; };
  target.prepend(image);
  const expiry = Number(result.expires_at || result.expires);
  const ttl = Number.isFinite(expiry) && expiry > 1e9 ? Math.max(0, Math.min(120000, expiry * 1000 - Date.now())) : 60000;
  const timer = setTimeout(() => { if (target.isConnected) target.textContent = '二维码显示已过期。请重新获取，并通过连接自检确认登录状态。'; qrTimers.delete(timer); }, ttl);
  qrTimers.add(timer);
}

const views = {
  overview() {
    const versions = status.versions || {}, usage = status.usage || {};
    const usedTokens = Number.isFinite(usage.input) && Number.isFinite(usage.output) ? usage.input + usage.output : null;
    const cards = [
      ['QQ 消息通道', channelSummary('qq'), `NapCat ${versions.napcat || '未验证'} · QQ ${versions.qq || '未验证'}`],
      ['QQ 空间', channelSummary('qzone'), '空间独立鉴权；轮询可能缺项，不代表真实动作验收通过'],
      ['核心人格', status.persona.active ? '版本 #' + status.persona.active : '等待你填写', '仅保存你提供的原文，需手动启用']
    ];
    $('#main').innerHTML = heading('工作空间', '照看连接、人格和每一次互动。', tag(operationState())) +
      `<div class="banner"><strong>开始前，先把控制权留在你手中。</strong><p>业务调度${status.controls.social_running ? '已启动' : '未启动'}；${status.controls.stop_all ? '全部发信停止' : '发信停止已解除'}；${status.controls.pause_active ? '主动行为暂停' : '主动行为可评估'}。登录不会自动启用社交或补发历史任务。</p></div>
      <div class="grid">${cards.map(([title, value, note]) => `<section class="card"><span class="pill">${esc(title)}</span><div class="metric">${esc(value)}</div><p class="muted">${esc(note)}</p></section>`).join('')}</div>
      <div class="grid two section-gap"><section class="card"><h2>接管步骤</h2>${[['connection', '配置并登录 QQ 与空间'], ['models', '填写模型供应商与凭据'], ['persona', '填写并显式启用人格'], ['friends', '选择允许互动的好友'], ['system', '测试后显式开启社交']].map(([target, title], index) => `<div class="next-step"><span class="num">${index + 1}</span><p>${title}</p><button class="text-btn" data-go="${target}">前往 →</button></div>`).join('')}</section>
      <section class="card"><div class="card-head"><h2>运行概况</h2><button id="health" class="text-btn">刷新管理状态</button></div><div class="info-list"><span>固定组件校验</span><span>${tag(versions.ok === true ? '通过' : '尚未通过', versions.ok === true)}</span><span>最近版本核验</span><span>${esc(fmt(versions.checked))}</span><span>模型请求 / 日预算</span><span>${esc(numberText(usage.requests))} / ${esc(cfg.policy.model_daily||'不限')}</span><span>Token / 日预算</span><span>${usedTokens === null ? '未知' : esc(usedTokens)} / ${esc(cfg.policy.token_daily||'不限')}</span><span>费用估算 / 日预算</span><span>${Number.isFinite(usage.cost) ? esc(usage.cost.toFixed(4)) : '未知'} / ${esc(cfg.policy.cost_daily||'不限')}</span><span>未知用量请求</span><span>${esc(numberText(usage.unknown))}；供应商未返回时不可当作零</span><span>可用磁盘</span><span>${Number.isFinite(status.disk_free) ? (status.disk_free / 1024 ** 3).toFixed(1) + ' GB' : '未知'}</span></div><div class="actions"><button id="run" class="primary">启动社交业务</button><button id="halt">停止社交业务</button></div><p class="field-note">仅刷新管理状态不会调用 QQ、空间或模型。启动仍受人格、权限和发信开关约束。</p></section></div>
      <section class="card"><h2>最近异常与阻止记录</h2>${table(['时间', '动作', '结果', '说明'], (status.recent_errors || []).map(r => [esc(fmt(r.created)), esc(r.action), esc(r.result), esc(r.detail)]), '暂无异常记录；这不表示真实平台已通过验收。')}</section>
      <section class="card"><div class="card-head"><h2>隔离工程验收</h2><button id="simulate">运行模拟验收</button></div><p class="muted">不接触真实 QQ、空间或模型，测试数据不会写入正式记忆。</p><div id="simulation-result" aria-live="polite"></div></section>`;
    $('#main').querySelectorAll('[data-go]').forEach(button => { button.onclick = () => show(button.dataset.go); });
    on('health', () => show(page, true));
    on('run', async () => {
      if (!confirm('启动社交调度？若正式社交和发信权限已开启，可能产生真实互动。')) return;
      const controls = await api('control', 'POST', {running: true});
      toast(controls.social_running === true ? '业务调度已启动；实际发送仍由后端门禁判断。' : '后端未确认业务已启动。', controls.social_running !== true);
      await show(page, true);
    });
    on('halt', async () => { await api('control', 'POST', {running: false, stop: true}); await show(page, true); });
    on('simulate', async () => {
      const target = $('#simulation-result'); target.textContent = '模拟验收运行中…';
      try {
        const result = await api('simulate', 'POST', {});
        target.innerHTML = `<p>${tag(result.passed === true ? '全部通过' : '存在失败', result.passed === true)} <span class="muted">${esc(result.mode)}</span></p>` + table(['验收项', '结果'], result.results.map(r => [esc(r.name), r.passed === true ? '通过' : '失败']));
      } catch (error) { target.textContent = '模拟验收未完成：' + error.message; throw error; }
    });
  },
  connection() {
    const channel = cfg.channel;
    $('#main').innerHTML = heading('接入与登录', 'QQ 消息与空间各自独立鉴权；连接检查会访问已配置的桥接。') +
      `<div class="grid two"><section class="card" data-section="qq"><h2>QQ 消息通道</h2><p class="muted">${esc(channelSummary('qq'))} · ${esc(fmt(status.channels.qq?.checked))}</p><div class="form-grid">${field('qq-id', '小号 QQ', channel.qq_id, 'text', '', 'inputmode="numeric" maxlength="12"')}${field('owner-id', '主人 QQ', channel.owner_id, 'text', '', 'inputmode="numeric" maxlength="12"')}${field('qq-http', 'OneBot HTTP', channel.http_url)}${field('qq-ws', 'OneBot WebSocket', channel.ws_url)}</div>${check('qq-enabled', '启用 QQ 连接', channel.enabled)}${secretField('qq-token', 'qq_token', 'OneBot Token')}<div class="actions"><button id="save-qq" class="primary">保存接入</button><button id="check-qq">连接自检</button><button id="qq-login">获取登录二维码</button></div><div id="qq-check" aria-live="polite"></div><div id="qq-qr" class="login-qr" aria-live="polite"></div><details><summary>组件控制（作用于部署机器）</summary><div class="actions">${['start', 'restart', 'stop'].map((action, index) => `<button data-component="napcat" data-action="${action}">${['启动', '重启', '停止'][index]} NapCat</button>`).join('')}</div><p class="field-note">重启/停止会中断连接；本地未部署时操作可能不可用。组件操作完成不等于登录或版本验证通过。</p></details></section>
      <section class="card" data-section="qzone-secret"><h2>QQ 空间鉴权</h2><p class="muted">${esc(channelSummary('qzone'))} · ${esc(fmt(status.channels.qzone?.checked))}。Cookie 仅在后端保存，不回传明文。</p>${secretField('qzone-cookie', 'qzone_cookie', 'QQ 空间 Cookie', true)}${secretField('qzone-token', 'qzone_token', '空间桥接 Token')}<div class="actions"><button id="save-qzone-secret" class="primary">保存并应用鉴权</button><button id="check-qzone">连接自检</button><button id="qzone-login">扫码登录</button></div><div id="qzone-check" aria-live="polite"></div><div id="qzone-qr" class="login-qr" aria-live="polite"></div><p class="field-note">二维码仅当前登录会话可见，离页/会话失效/显示到期即清除；二维码出现不代表账号在线。</p></section></div>
      <section class="card"><h2>主人固定内容测试（真实发信）</h2><p class="muted">只发送给已保存的主人 QQ：${esc(channel.owner_id || '尚未配置')}。不会调用模型；即使没有人格也可测试，但需后端允许并启动业务。结果未知时不得重发。</p>${field('test-text', '测试内容', '', 'text', '', 'maxlength="1000"')}<div class="actions"><button id="test-send" ${testSendUncertain ? 'disabled data-keep-disabled="true"' : ''}>向主人发送上述固定内容</button></div><pre id="test-result" ${testSendUncertain ? '' : 'hidden'}>${testSendUncertain ? '上次发送结果未知，已禁止本会话继续测试发送。请先检查活动账本和主人接收情况。' : ''}</pre></section>`;
    bindSecretClears();
    on('save-qq', async () => {
      const next = draftConfig();
      Object.assign(next.channel, {qq_id: $('#qq-id').value.trim(), owner_id: $('#owner-id').value.trim(), http_url: $('#qq-http').value.trim(), ws_url: $('#qq-ws').value.trim(), enabled: $('#qq-enabled').checked});
      await saveConfig(next);
      try { await saveSecret('qq-token', 'qq_token'); }
      catch (error) { throw Error('接入配置已保存，但 Token 保存失败：' + error.message); }
      saved('接入配置与所填凭据已保存', 'qq');
    });
    for (const name of ['qq', 'qzone']) {
      on('check-' + name, async () => {
        if (dirty.has(name === 'qq' ? 'qq' : 'qzone-secret')) throw Error('请先保存当前接入或凭据修改；自检使用后端已保存配置。');
        const target = $('#' + name + '-check'); target.textContent = '连接检查中…';
        try { healthResult(target, await api('check/' + name, 'POST', {})); await refreshStatus(); }
        catch (error) { target.textContent = '自检未完成：' + error.message; throw error; }
      });
      on(name + '-login', () => loginQR(name));
    }
    on('save-qzone-secret', async () => {
      let savedCount = 0;
      try { for (const [id, name] of [['qzone-cookie', 'qzone_cookie'], ['qzone-token', 'qzone_token']]) savedCount += Number(await saveSecret(id, name)); }
      catch (error) { throw Error(`本次已有 ${savedCount} 项凭据保存，其余未完成：${error.message}`); }
      markClean('qzone-secret');
      try { const result = await api('qzone/apply', 'POST', {}); toast(result.note || '凭据应用请求完成；请自检确认实际登录状态。'); }
      catch (error) { throw Error('凭据保存步骤已完成，但桥接应用失败：' + error.message); }
    });
    $('#main').querySelectorAll('[data-component]').forEach(button => bind(button, async () => {
      if (!confirm(`确认${{start: '启动', restart: '重启', stop: '停止'}[button.dataset.action]}部署机器的 NapCat？这可能中断 QQ 连接。`)) return;
      const result = await api('components', 'POST', {component: button.dataset.component, action: button.dataset.action});
      toast(result.success === true ? '组件命令已完成；请另行自检确认登录和版本。' : result.note || result.reason || '组件操作未成功或组件尚未就绪。', result.success !== true);
      await refreshStatus();
    }));
    on('test-send', async () => {
      const text = $('#test-text').value;
      if (dirty.has('qq')) throw Error('请先保存接入信息；测试使用已保存的主人 QQ。');
      if (!cfg.channel.owner_id || !text.trim()) throw Error('请先配置主人 QQ 并填写非空测试内容。');
      if (!confirm(`这会向主人 QQ ${cfg.channel.owner_id} 发送真实固定内容。确认发送一次？`)) return;
      const target = $('#test-result'); target.hidden = false; target.textContent = '等待后端发送结果…';
      try {
        const result = await api('test-send', 'POST', {text, request_id: crypto.randomUUID()});
        target.textContent = `结果：${result.status || '未知'}\n说明：${result.detail || '后端未提供说明'}`;
        testSendUncertain = !['sent', 'blocked', 'cancelled', 'failed'].includes(result.status);
      } catch (error) { testSendUncertain = true; target.textContent = '发送结果未知：' + error.message; throw error; }
      finally { if (testSendUncertain) { $('#test-send').dataset.keepDisabled = 'true'; target.textContent += '\n已禁止本会话再次发送，请先核对账本和主人接收情况。'; } }
    });
  },
  models() {
    let active = 'model';
    let catalog = null;
    const secretName = () => active === 'model' ? 'model_key' : 'vision_key';
    const effortNames = {low: '低（更快更省）', medium: '中', high: '高', max: '最高'};
    const entryFor = name => (catalog?.models || []).find(item => item.id === name);
    function updateHint() {
      const hint = $('#model-hint'), input = $('#model-name');
      if (!hint || !input) return;
      const entry = entryFor(input.value.trim());
      hint.textContent = entry
        ? `${entry.note}；可保存上下文 ${Math.min(entry.context, 128000)}（目录 ${entry.context}），输出 ${Math.min(entry.max_output, 8000)}（目录 ${entry.max_output}）；目录单价 ${entry.input_price} / ${entry.output_price} 美元每百万 token；可用强度 ${(entry.efforts || []).join('/') || '供应商默认'}`
        : '可从建议列表选择，或手动填写其他 OpenAI-compatible 模型。';
    }
    function modelForm() {
      const model = cfg[active];
      const effort = model.reasoning_effort ?? 'low';
      $('#model-fields').innerHTML = `<div class="form-grid">
        ${field('model-url', 'Base URL', model.base_url, 'url', '填写包含 /v1 的 OpenAI-compatible 服务地址')}
        <div><label for="model-name">模型名称</label><input id="model-name" type="text" value="${esc(model.name)}" list="model-preset-list" autocomplete="off"><datalist id="model-preset-list"></datalist><div class="field-note" id="model-hint">可从建议列表选择，或手动填写其他 OpenAI-compatible 模型。</div></div>
        <div><label for="model-effort">推理强度</label><select id="model-effort"><option value="" ${effort === '' ? 'selected' : ''}>不发送（供应商默认）</option>${Object.entries(effortNames).map(([id, name]) => `<option value="${id}" ${effort === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><div class="field-note">默认 low；越高越慢、推理 token 越多。留空表示不发送该参数。</div></div>
        ${field('model-timeout', '超时（秒）', model.timeout, 'number', '', 'min="3" step="1"')}${field('model-context', '上下文上限', model.context_limit, 'number', '', 'min="1000" step="1"')}${field('model-output', '输出 Token 上限', model.output_limit, 'number', '', 'min="16" step="1"')}${field('input-price', '每百万输入 Token 单价', model.input_price, 'number', '', 'min="0" step="any"')}${field('output-price', '每百万输出 Token 单价', model.output_price, 'number', '', 'min="0" step="any"')}</div>${secretField('model-key', secretName(), 'API Key')}`;
      bindSecretClears();
      $('#model-name').addEventListener('input', updateHint);
      hydrateCatalog();
    }
    async function hydrateCatalog() {
      try { catalog = await api('model-catalog'); } catch { catalog = null; }
      const list = $('#model-preset-list');
      if (!list) return;
      list.innerHTML = (catalog?.models || []).map(item => `<option value="${esc(item.id)}">${esc(item.label)}${item.vision ? ' · 支持图片' : ''}</option>`).join('');
      updateHint();
    }
    $('#main').innerHTML = heading('模型与工具', '供应商、预算和工具由你配置。未实现能力不会显示为可用。') +
      `<section class="card" data-section="model"><h2>模型供应商</h2><label for="model-kind">编辑模型</label><select id="model-kind" data-filter><option value="model">主模型</option><option value="vision_model">可选图片模型</option></select><div id="model-fields"></div><div class="actions"><button id="apply-preset">按所选模型填推荐参数</button><button id="save-model" class="primary">保存模型</button><button id="test-model">主模型最小连接测试（可能计费）</button></div><div id="model-result" aria-live="polite" hidden></div><p class="field-note">连接测试只测试后端已保存的主模型，不测试当前编辑中的图片模型。</p></section>
      <section class="card" data-section="search"><h2>联网搜索</h2>${check('search-enabled', '启用受控联网检索（模型只能提交查询词）', cfg.tools.search)}<div class="form-grid">${field('search-url', '搜索 Base URL', cfg.search.base_url, 'url', '后端会请求 <Base URL>/search')}${field('search-max', '返回条数', cfg.search.max_results, 'number', '', 'min="1" step="1"')}${field('search-timeout', '超时（秒）', cfg.search.timeout, 'number', '', 'min="3" step="1"')}${field('search-daily', '每日搜索次数', cfg.search.daily, 'number', '', 'min="0" step="1"')}</div>${secretField('search-key', 'search_key', '搜索 API Key')}<div class="actions"><button id="save-search" class="primary">保存搜索配置</button><button id="test-search">搜索连通测试（计费/计数）</button></div><div id="search-result" aria-live="polite" hidden></div><p class="field-note">只有模型明确请求检索时才发送查询词；结果作为不可信资料注入，不改变权限或人格。搜索服务商只接收查询词与条数。</p></section>
      <section class="card" data-section="tools"><h2>工具开关</h2>${check('vision', '图片理解（调用图片模型或主模型）', cfg.tools.vision)}${check('stickers', '表情库 / 图片主动发送（尚未实现，不可启用）', false, 'disabled')}<p class="muted">可选判断模型尚未接入独立调用；已有判断模型配置只作保留，不用于决策。生图与表情库暂不支持。QQ 图片接收解析与图片理解不等于主动图片发送。</p><div class="actions"><button id="save-tools">保存工具设置</button></div></section>`;
    modelForm();
    $('#model-kind').onchange = event => {
      if (dirty.has('model') && !confirm('切换模型会丢弃当前未保存的模型字段和 API Key，继续吗？')) { event.target.value = active; return; }
      active = event.target.value; markClean('model'); modelForm();
    };
    on('apply-preset', async () => {
      if (!catalog) { try { catalog = await api('model-catalog'); } catch { catalog = null; } }
      if (!catalog) throw Error('暂时无法获取模型建议目录；可直接手动填写字段。');
      const entry = entryFor($('#model-name').value.trim());
      if (!entry) throw Error('请先从模型建议列表选择，或直接手动填写字段。');
      const preset = {context: String(Math.min(entry.context, 128000)), output: String(Math.min(entry.max_output, 8000)),
        input: String(entry.input_price), outputPrice: String(entry.output_price)};
      const changed = [['#model-context', preset.context], ['#model-output', preset.output],
        ['#input-price', preset.input], ['#output-price', preset.outputPrice]].some(([id, value]) => $(id).value && $(id).value !== value);
      if (changed && !confirm('将用推荐值覆盖当前上下文、输出上限和价格字段，继续吗？')) return;
      $('#model-context').value = preset.context;
      $('#model-output').value = preset.output;
      $('#input-price').value = preset.input;
      $('#output-price').value = preset.outputPrice;
      const supported = entry.efforts || Object.keys(effortNames);
      if (!supported.includes($('#model-effort').value)) $('#model-effort').value = entry.default_effort;
      dirty.add('model'); updateHint(); toast(`已填入 ${entry.id} 的推荐参数；保存后生效。`);
    });
    on('save-model', async () => {
      const next = draftConfig();
      next[active] = {base_url: $('#model-url').value.trim(), name: $('#model-name').value.trim(), timeout: numeric('model-timeout', 3, null), context_limit: numeric('model-context', 1000, null), output_limit: numeric('model-output', 16, null), input_price: numeric('input-price', 0, null, false), output_price: numeric('output-price', 0, null, false), reasoning_effort: $('#model-effort').value};
      await saveConfig(next);
      try { await saveSecret('model-key', secretName()); }
      catch (error) { throw Error('模型配置已保存，但 API Key 保存失败：' + error.message); }
      saved('模型配置与所填凭据已保存，未执行连接测试', 'model');
    });
    on('test-model', async () => {
      if (dirty.has('model')) throw Error('请先保存模型配置；连接测试只使用已保存的主模型。');
      if (!confirm('向已保存的主模型发送最小真实请求？此操作可能计费，不测试图片模型。')) return;
      const target = $('#model-result'); target.hidden = false; target.textContent = '主模型测试中…';
      try { healthResult(target, await api('check/model', 'POST', {})); }
      catch (error) { target.textContent = '测试未完成：' + error.message; throw error; }
    });
    on('save-search', async () => {
      const next = draftConfig();
      next.tools.search = $('#search-enabled').checked;
      next.search = {base_url: $('#search-url').value.trim(), max_results: numeric('search-max', 1, null), timeout: numeric('search-timeout', 3, null), daily: numeric('search-daily', 0, null)};
      await saveConfig(next);
      try { await saveSecret('search-key', 'search_key'); }
      catch (error) { throw Error('搜索配置已保存，但 API Key 保存失败：' + error.message); }
      saved('搜索配置与所填凭据已保存，未执行检索测试', 'search');
    });
    on('test-search', async () => {
      if (dirty.has('search')) throw Error('请先保存搜索配置；测试使用已保存的设置。');
      if (!confirm('执行一次真实搜索请求？会计入搜索次数与供应商用量。')) return;
      const target = $('#search-result'); target.hidden = false; target.textContent = '搜索测试中…';
      try { healthResult(target, await api('check/search', 'POST', {})); }
      catch (error) { target.textContent = '搜索测试未完成：' + error.message; throw error; }
    });
    on('save-tools', async () => { const next = draftConfig(); next.tools.vision = $('#vision').checked; next.tools.stickers = false; await saveConfig(next); saved('工具策略已保存', 'tools'); });
  },
  persona(data) {
    const active = data.versions.find(v => v.id === data.active);
    $('#main').innerHTML = heading('人格与成长', '核心人格只保存你的原文；成长记录单独存储，不能改写核心。', tag(data.active ? '生效版本 #' + data.active : '人格待填写', !!data.active)) +
      `<section class="card" data-section="persona"><h2>人格原文</h2><p class="muted">没有默认人设或自动补全。草稿不会自动启用；空白原文不能启用。</p><label for="persona-file">导入 UTF-8 Markdown / TXT</label><input id="persona-file" type="file" accept=".md,.txt" class="file-input"><label for="persona-body">人格正文</label><textarea id="persona-body" rows="12" maxlength="100000" spellcheck="false"></textarea><div class="actions"><button id="draft">保存草稿</button><button id="activate-new" class="primary">保存并启用此原文</button><button id="disable-persona">停用人格</button><button id="export-persona">导出编辑器原文</button></div></section>
      <section class="card"><h2>版本历史</h2>${table(['版本', '保存时间', '字符数', '状态', '操作'], data.versions.map(v => [esc('#' + v.id), esc(fmt(v.created)), esc(Array.from(v.body).length), v.id === data.active ? tag('已启用', true) : '草稿 / 历史', `<button data-view="${esc(v.id)}">查看原文</button> <button data-activate="${esc(v.id)}">恢复并启用</button>`]), '尚未保存任何人格。请填写你自己的原文。')}<details id="persona-compare"><summary>与当前生效版本比较原文</summary><p id="compare-summary" class="muted">选择“查看原文”后比较；原文不会被自动修改。</p><div class="compare"><div><h3>当前生效原文</h3><pre id="active-original"></pre></div><div><h3>选中版本原文</h3><pre id="chosen-original"></pre></div></div><h3>逐行差异</h3><pre id="persona-diff"></pre></details></section>
      <section class="card" data-section="growth"><h2>成长记录</h2>${check('growth', '启用有来源的成长记录', cfg.policy.growth)}<p class="muted">先启用人格；在“记忆与活动”选择公开成长素材或好友隔离记录，可查看、更正、删除。不会覆盖核心。</p><button id="save-growth">保存成长策略</button></section>`;
    $('#active-original').textContent = active?.body || '';
    $('#persona-file').onchange = async event => {
      const file = event.target.files[0], target = $('#persona-body');
      if (!file) return;
      try {
        if (file.size > 400000) throw Error('人格文件超过 400 KB。');
        const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(await file.arrayBuffer());
        if (text.length > 100000) throw Error('人格正文超过 100000 字符。');
        if (target.isConnected) { target.value = text; dirty.add('persona'); }
      } catch (error) { toast(error instanceof TypeError ? '文件不是有效 UTF-8，原有编辑内容未被替换。' : error.message, true); }
    };
    for (const [id, enable] of [['draft', false], ['activate-new', true]]) on(id, async () => {
      const body = $('#persona-body').value;
      if (enable && !body.trim()) throw Error('空白人格不能启用，请填写你自己的原文。');
      if (enable && !confirm('保存并启用此原文？已开启的社交业务随后将使用这个版本。')) return;
      if (dirty.has('growth')) throw Error('请先保存成长策略，再保存人格，以免刷新丢失修改。');
      await api('personas', 'POST', {body, enable}); markClean('persona');
      toast(enable ? '原文已保存并启用。' : '草稿已保存；尚未启用。'); await show(page, true);
    });
    on('disable-persona', async () => { if (!confirmLeave()) return; await api('personas/activate', 'POST', {id: null}); await show(page, true); });
    on('export-persona', () => exportFile($('#persona-body').value, 'persona.txt', 'text/plain;charset=utf-8'));
    $('#main').querySelectorAll('[data-view]').forEach(button => bind(button, async () => {
      if (dirty.has('persona') && !confirm('查看历史原文会替换编辑器中未保存的修改，继续吗？')) return;
      const selected = data.versions.find(v => String(v.id) === button.dataset.view);
      $('#persona-body').value = selected.body; $('#chosen-original').textContent = selected.body; markClean('persona');
      const before = (active?.body || '').split('\n'), after = selected.body.split('\n');
      let prefix = 0, suffix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
      while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
      $('#compare-summary').textContent = selected.body === (active?.body || '') ? '两份原文完全相同。' : `按共同首尾行定位：原版 ${before.length - prefix - suffix} 行与选中版本 ${after.length - prefix - suffix} 行不同（从第 ${prefix + 1} 行开始；不是语义合并）。`;
      const difference = await api(`personas/diff?base=${data.active || 0}&target=${selected.id}`);
      $('#persona-diff').textContent = difference.diff || '两份原文完全相同。';
      $('#persona-compare').open = true;
    }));
    $('#main').querySelectorAll('[data-activate]').forEach(button => bind(button, async () => {
      if (!confirmLeave() || !confirm('恢复并启用所选历史原文？此操作不会合并当前编辑内容。')) return;
      await api('personas/activate', 'POST', {id: Number(button.dataset.activate)}); await show(page, true);
    }));
    on('save-growth', async () => { const next = draftConfig(); next.policy.growth = $('#growth').checked; await saveConfig(next); saved('成长策略已保存', 'growth'); });
  },
  friends(list) {
    $('#main').innerHTML = heading('好友与权限', '私聊、主动联系、空间读取、点赞与评论分别授权。', '<button id="sync-friends" class="primary">同步真实好友</button>') +
      `<section class="card" data-section="defaults"><h2>全局默认权限</h2><div class="inline-checks">${Object.entries(permissionNames).map(([key, label]) => check('default-' + key, label, cfg.policy.defaults[key])).join('')}</div><button id="save-default">保存默认权限</button><p class="field-note">逐人覆盖优先，退订再次优先。默认权限变更不会清除好友已保存的独立覆盖。</p></section><section class="card"><label for="friend-search">搜索 QQ / 备注</label><input id="friend-search" placeholder="搜索 QQ / 备注"><div id="friend-table"></div></section>`;
    function parseObject(raw) {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('好友权限数据无效，请刷新或检查数据。');
      return value;
    }
    const drafts = new Map();
    for (const friend of list) {
      try { drafts.set(friend.id, {...cfg.policy.defaults, ...parseObject(friend.permissions)}); }
      catch { drafts.set(friend.id, null); }
    }
    function render(query = '') {
      const filtered = list.filter(f => (f.id + ' ' + f.name).toLowerCase().includes(query.toLowerCase()));
      $('#friend-table').innerHTML = table(['好友', '独立权限', '退订', '最近互动 / 主动冷却', '操作'], filtered.map(friend => {
        const permissions = drafts.get(friend.id);
        return [`${esc(friend.name)}<br><span class="muted">${esc(friend.id)}</span>`, permissions ? `<div class="inline-checks">${Object.entries(permissionNames).map(([key, label]) => `<label class="check"><input type="checkbox" data-friend="${esc(friend.id)}" data-perm="${key}" ${permissions[key] === true ? 'checked' : ''}>${label}</label>`).join('')}</div>` : '权限数据无效，拒绝修改', esc(friend.optout === '{}' ? '无' : friend.optout), `${esc(fmt(friend.last_interaction))}<br><span class="muted">冷却至：${esc(fmt(friend.cooldown_until))}</span>`, `<button data-savefriend="${esc(friend.id)}" ${permissions ? '' : 'disabled'}>保存</button>`];
      }), list.length ? '没有匹配的好友，请修改搜索条件。' : '尚无已同步好友。同步会读取真实 QQ 好友列表；不会自动开启权限。');
      $('#friend-table').querySelectorAll('[data-friend]').forEach(input => input.onchange = () => {
        drafts.get(input.dataset.friend)[input.dataset.perm] = input.checked; dirty.add('friend:' + input.dataset.friend);
      });
      $('#friend-table').querySelectorAll('[data-savefriend]').forEach(button => bind(button, async () => {
        const id = button.dataset.savefriend, permissions = drafts.get(id);
        if (!permissions) throw Error('权限数据无效，拒绝保存。');
        if (Object.values(permissions).some(v => v === true) && !confirm(`保存好友 ${id} 的独立授权？正式社交开启后，勾选项可能触发真实互动；退订仍优先。`)) return;
        await api('friends', 'PUT', {id, permissions: Object.fromEntries(Object.keys(permissionNames).map(key => [key, permissions[key] === true]))});
        list.find(f => f.id === id).permissions = JSON.stringify(permissions); markClean('friend:' + id); toast('好友独立权限已保存，退订状态保持不变。');
      }));
    }
    render(); $('#friend-search').oninput = event => render(event.target.value);
    on('sync-friends', async () => { if (!confirmLeave()) return; const result = await api('friends/sync', 'POST', {}); toast('已同步 ' + result.count + ' 位真实好友。'); await show(page, true); });
    on('save-default', async () => {
      if ([...dirty].some(key => key.startsWith('friend:'))) throw Error('请先保存已修改的好友独立权限，再修改默认权限。');
      const next = draftConfig(); for (const key of Object.keys(permissionNames)) next.policy.defaults[key] = $('#default-' + key).checked;
      if (Object.values(next.policy.defaults).some(Boolean) && !confirm('保存全局默认授权？未单独覆盖的好友将继承这些权限。')) return;
      await saveConfig(next); saved('默认权限已保存', 'defaults');
      for (const friend of list) { try { drafts.set(friend.id, {...cfg.policy.defaults, ...parseObject(friend.permissions)}); } catch { drafts.set(friend.id, null); } }
      render($('#friend-search').value);
    });
  },
  qzone(data) {
    const q = cfg.qzone;
    $('#main').innerHTML = heading('QQ 空间', '独立桥接、明确动作、首次接入仅建立历史基线。') +
      `<div class="banner"><strong>读取能力：${esc(channelSummary('qzone'))}</strong><p>${esc(data.coverage)}。读取失败与没有新动态分别记录；连接检查不等于点赞/评论/发布验收。</p></div><section class="card" data-section="qzone"><h2>空间能力开关</h2>${check('qz-enabled', '启用独立空间桥接', q.enabled)}<div class="inline-checks">${Object.entries({read: '动态读取', like: '自动点赞', comment: '自动评论', reply: '回复本人动态评论', publish: '自动发布说说'}).map(([key, label]) => check('qz-' + key, label, q[key])).join('')}</div><div class="form-grid">${field('qz-http', '桥接 HTTP 地址', q.http_url)}${field('qz-ws', '事件 WebSocket 地址', q.ws_url)}${field('qz-poll', '轮询间隔（分钟）', q.poll_minutes, 'number', '', 'min="2"')}${field('qz-pages', '最大页数', q.pages, 'number', '', 'min="1"')}${field('qz-candidates', '每次候选上限', q.candidates, 'number', '', 'min="1"')}${field('qz-retention', '内容保留期（天）', q.retention_days, 'number', '', 'min="0"')}</div><div class="actions"><button id="save-qzone" class="primary">保存空间策略</button><button id="qzone-probe">只读连接检查</button></div><div id="qzone-probe-result" aria-live="polite" hidden></div></section><section class="card"><h2>最近空间事件</h2><p class="muted">首次基线：${esc(fmt(data.baseline))}；历史分页不会补赞补评。</p>${table(['事件', '好友', '时间', '状态'], data.events.map(e => [esc(e.id), esc(e.friend), esc(fmt(e.created)), esc(e.state)]), '暂无已记录空间事件；未登录、未轮询与没有新动态不是同一状态。')}</section>`;
    on('save-qzone', async () => {
      const next = draftConfig(), qzone = next.qzone;
      for (const key of ['enabled', 'read', 'like', 'comment', 'reply', 'publish']) qzone[key] = $('#qz-' + key).checked;
      qzone.http_url = $('#qz-http').value.trim(); qzone.ws_url = $('#qz-ws').value.trim();
      qzone.poll_minutes = numeric('qz-poll', 2, null); qzone.pages = numeric('qz-pages', 1, null); qzone.candidates = numeric('qz-candidates', 1, null); qzone.retention_days = numeric('qz-retention', 0, null);
      if (['like', 'comment', 'reply', 'publish'].some(key => qzone[key] && !cfg.qzone[key]) && !confirm('开启空间自动写入能力？正式社交、人格和权限就绪后可能进行真实动作。')) return;
      await saveConfig(next); saved('空间策略已保存', 'qzone');
    });
    on('qzone-probe', async () => {
      if (dirty.has('qzone')) throw Error('请先保存空间策略；检查只使用已保存的地址。');
      const target = $('#qzone-probe-result'); target.hidden = false; target.textContent = '连接检查中…';
      try { healthResult(target, await api('check/qzone', 'POST', {})); }
      catch (error) { target.textContent = '连接检查未完成：' + error.message; throw error; }
    });
  },
  memory(friends) {
    let records = [], loadedScope = null, editing = null;
    $('#main').innerHTML = heading('记忆与活动', '好友私聊记录与可用于公开说说的素材严格分开。') +
      `<section class="card" data-section="memory"><div class="form-grid"><div><label for="memory-scope">数据范围</label><select id="memory-scope" data-filter><option value="friend">指定好友（隔离）</option><option value="public">主人公开成长素材（允许公开使用）</option></select></div><div><label for="memory-friend">好友 QQ</label><input id="memory-friend" list="friend-options" data-filter><datalist id="friend-options">${friends.map(friend => `<option value="${esc(friend.id)}">${esc(friend.name)}</option>`).join('')}</datalist></div><div><label for="memory-kind">类型</label><select id="memory-kind" data-filter><option value="memory">长期记忆</option><option value="growth">成长记录</option></select></div>${field('memory-search', '搜索正文', '', 'text', '', 'data-filter')}</div><p id="memory-scope-note" class="field-note">请输入好友 QQ 后查询，不能跨好友检索。</p><div class="actions"><button id="search-memory">查询当前范围</button><button id="export-memory">导出当前范围记录</button></div><div id="memory-table">${empty('尚未查询，请选择范围。')}</div><details id="memory-editor"><summary>新增或更正记录</summary><label for="memory-id">记录 ID（仅可从查询结果选择更正）</label><input id="memory-id" readonly><label for="memory-body">正文</label><textarea id="memory-body" maxlength="5000"></textarea><label for="memory-source">来源</label><input id="memory-source" maxlength="500"><label for="memory-label">事实标记</label><select id="memory-label"><option value="fact">明确事实</option><option value="inference">推断</option><option value="unverified">待核实</option></select><div class="actions"><button id="save-memory">保存记录</button><button id="new-memory">清空编辑器 / 新增</button></div></details></section>
      <section class="card"><h2>活动与发送账本</h2><div class="form-grid">${field('log-friend', '按好友筛选', '')}${field('log-action', '按动作筛选', '')}${field('log-result', '按结果筛选', '')}</div><div class="actions"><button id="load-activity">读取活动</button></div><p class="field-note">显示后端返回范围中的最近记录；最多 200 条。未知发送结果不得盲目重试。</p><div id="activity-table">${empty('尚未读取活动。')}</div></section>`;
    function scope() {
      const isPublic = $('#memory-scope').value === 'public';
      const friend = isPublic ? '' : $('#memory-friend').value.trim();
      if (!isPublic && !friend) throw Error('请填写好友 QQ；公开素材须显式选择“主人公开成长素材”。');
      return {friend, kind: isPublic ? 'growth' : $('#memory-kind').value};
    }
    const key = value => JSON.stringify([value.friend, value.kind]);
    const path = value => 'memories?' + new URLSearchParams({...value, q: $('#memory-search').value});
    function resetEditor() { editing = null; $('#memory-id').value = ''; $('#memory-body').value = ''; $('#memory-source').value = ''; $('#memory-label').value = 'fact'; markClean('memory'); }
    function changedScope() {
      const isPublic = $('#memory-scope').value === 'public';
      $('#memory-friend').disabled = isPublic; $('#memory-kind').disabled = isPublic;
      if (isPublic) $('#memory-kind').value = 'growth';
      $('#memory-scope-note').textContent = isPublic ? '警告：这里录入的内容可能用于公开说说，勿填任何好友私聊或隐私。仅在人格与成长策略启用后可保存。' : '请输入好友 QQ 后查询。切换范围后必须重新查询，旧记录不可继续更正。';
      records = []; loadedScope = null; editing = null;
      $('#memory-id').value = ''; $('#memory-table').innerHTML = empty('范围已变化，请重新查询。');
      // 不把旧范围的正文带入新的好友或公开范围。
      $('#memory-body').value = ''; $('#memory-source').value = ''; markClean('memory');
    }
    for (const id of ['memory-scope', 'memory-friend', 'memory-kind']) $('#' + id).addEventListener('change', changedScope);
    function renderRecords() {
      $('#memory-table').innerHTML = table(['ID', '正文 / 来源', '标记', '时间', '操作'], records.map(record => [esc(record.id), esc(record.body) + '<br><span class="muted">' + esc(record.source) + '</span>', esc(record.label), esc(fmt(record.created)), `<button data-editmemory="${esc(record.id)}">更正</button> <button data-delete="${esc(record.id)}">删除</button>`]), '当前范围没有匹配记录。最多返回 500 条；不代表其他好友没有记录。');
      $('#memory-table').querySelectorAll('[data-editmemory]').forEach(button => bind(button, () => {
        if (!loadedScope || key(scope()) !== key(loadedScope)) throw Error('范围已变化，请重新查询。');
        if (dirty.has('memory') && !confirm('更正此记录会替换编辑器中未保存的内容，继续吗？')) return;
        const record = records.find(r => String(r.id) === button.dataset.editmemory);
        editing = {id: record.id, ...loadedScope};
        $('#memory-id').value = record.id; $('#memory-body').value = record.body; $('#memory-source').value = record.source; $('#memory-label').value = record.label; $('#memory-editor').open = true; markClean('memory');
      }));
      $('#memory-table').querySelectorAll('[data-delete]').forEach(button => bind(button, async () => {
        if (!loadedScope || key(scope()) !== key(loadedScope)) throw Error('范围已变化，请重新查询。');
        if (!confirm('删除这条运行库记录？历史备份仍可能包含它，删除无法撤销。')) return;
        const result = await api('memories/' + encodeURIComponent(button.dataset.delete), 'DELETE');
        records = records.filter(r => String(r.id) !== button.dataset.delete);
        if (String(editing?.id) === button.dataset.delete) resetEditor();
        renderRecords(); toast(result.note || '记录已删除；历史备份不随之修改。');
      }));
    }
    async function query() {
      const selected = scope(); const result = await api(path(selected));
      // 即便后端错误地返回其他好友数据，也不把它渲染或带入编辑器。
      if (!Array.isArray(result) || result.some(r => r.friend !== selected.friend || r.kind !== selected.kind)) throw Error('后端返回的数据范围不符，已拒绝显示。');
      records = result; loadedScope = selected; renderRecords();
    }
    on('search-memory', async () => { $('#memory-table').innerHTML = empty('查询中…'); try { await query(); } catch (error) { loadedScope = null; records = []; $('#memory-table').innerHTML = empty('查询未完成：' + error.message); throw error; } });
    on('save-memory', async () => {
      const selected = scope();
      if (editing && key(selected) !== key(editing)) throw Error('更正范围与所选记录不符，请重新查询。');
      const body = $('#memory-body').value, source = $('#memory-source').value;
      if (!body.trim() || !source.trim()) throw Error('正文和来源不能为空。');
      if (!selected.friend && !confirm('确认这是主人允许公开使用的成长素材，不含好友私聊或隐私？')) return;
      await api('memories' + (editing ? '/' + encodeURIComponent(editing.id) : ''), editing ? 'PUT' : 'POST', {...selected, body, source, label: $('#memory-label').value});
      resetEditor(); toast('记录已保存。'); await query();
    });
    on('new-memory', () => { if (!dirty.has('memory') || confirm('丢弃当前未保存的记录内容并开始新增？')) resetEditor(); });
    on('export-memory', async () => {
      const selected = scope(), result = await api(path(selected));
      if (!Array.isArray(result) || result.some(r => r.friend !== selected.friend || r.kind !== selected.kind)) throw Error('后端返回的数据范围不符，已拒绝导出。');
      exportFile(JSON.stringify(result, null, 2), selected.friend ? 'friend-memories.json' : 'public-growth.json', 'application/json');
    });
    on('load-activity', async () => {
      const filter = {friend: $('#log-friend').value.trim(), action: $('#log-action').value.trim(), result: $('#log-result').value.trim()};
      const target = $('#activity-table'); target.innerHTML = empty('读取中…');
      try {
        const data = await api('activity?' + new URLSearchParams(filter));
        const matches = row => (!filter.friend || row.friend === filter.friend) && (!filter.action || row.action === filter.action) && (!filter.result || (row.result ?? row.status) === filter.result);
        target.innerHTML = table(['时间', '好友', '动作', '结果', '说明'], data.logs.filter(matches).map(r => [esc(fmt(r.created)), esc(r.friend), esc(r.action), esc(r.result), esc(r.detail)])) + '<h3 class="section-gap">发送账本</h3>' + table(['时间', '渠道 / 好友', '动作', '结果', '说明'], data.ledger.filter(matches).map(r => [esc(fmt(r.created)), esc(r.channel + ' / ' + r.friend), esc(r.action), esc(r.status), esc(r.detail)]));
      } catch (error) { target.innerHTML = empty('读取失败：' + error.message); throw error; }
    });
  },
  system() {
    const policy = cfg.policy;
    const numbers = {
      quiet_start: ['安静开始（时）', 0, 23], quiet_end: ['安静结束（时）', 0, 23], proactive_daily: ['每日主动私聊', 0, null], comment_daily: ['每日空间评论/回复', 0, null], publish_daily: ['每日说说', 0, null], like_daily: ['每日点赞', 0, null], total_daily: ['每日总发信', 0, null], model_daily: ['每日模型请求', 0, null], token_daily: ['每日 Token 预算', 0, null], cost_daily: ['每日费用估算预算', 0, null, false], cooldown_hours: ['同好友主动冷却（小时）', 0, null], decision_minutes: ['自主决策间隔（分钟）', 1, null], retention_days: ['会话保留（天）', 0, null], log_days: ['活动日志保留（天）', 0, null]
    };
    $('#main').innerHTML = heading('系统与备份', '配置持久化、可恢复、默认安全暂停。') +
      `<section class="card" data-section="policy"><h2>社交与预算策略</h2><p class="muted">每日次数、Token、费用预算及冷却设为0表示不限制；保留天数设为0表示不自动删除。检查间隔是调度周期，不限制每日次数。</p>${check('social-enabled', '显式启用正式社交（仍需人格、渠道和好友许可）', policy.enabled)}${check('quiet-reply', '安静时段允许被动回复', policy.reply_in_quiet)}<div class="form-grid">${field('timezone', '时区', policy.timezone)}${Object.entries(numbers).map(([key, [title, min, max, integer]]) => field('policy-' + key, title, policy[key], 'number', '', `min="${min}" ${max==null?'':`max="${max}"`} step="${integer === false ? 'any' : '1'}"`)).join('')}</div><div class="actions"><button id="save-policy" class="primary">保存策略</button></div></section>
      <section class="card"><h2>项目备份与恢复</h2><p class="muted">备份包含配置、人格、私人记忆、调度和发送账本，不含密钥/Cookie。本项目备份不替代 VPS 整机备份；导出文件仍须妥善保护。</p><div class="actions"><button id="backup">下载项目备份</button><button id="diagnostics">导出脱敏诊断</button></div><label for="restore-file">选择备份 JSON</label><input id="restore-file" class="file-input" type="file" accept=".json"><div class="actions"><button id="restore" class="danger">校验并恢复（恢复后全部暂停）</button></div><p class="field-note">恢复会替换当前数据，后端校验通过后才执行。恢复后须重新登录；原密钥不从此备份还原，历史任务不补发。</p></section>
      <section class="card"><h2>后台任务</h2>${table(['任务', '下次运行', '最近运行', '失败次数', '最近结果'], (status.tasks || []).map(t => [esc(t.name), esc(fmt(t.next)), esc(fmt(t.last)), esc(t.failures), esc(t.detail)]), '暂无任务记录，不能据此认定后台调度已运行。')}<p class="field-note">当前接口未提供任务耗时；不展示虚构的耗时或预算使用值。</p></section>`;
    on('save-policy', async () => {
      const next = draftConfig(); next.policy.enabled = $('#social-enabled').checked; next.policy.reply_in_quiet = $('#quiet-reply').checked; next.policy.timezone = $('#timezone').value.trim();
      for (const [key, [, min, max, integer]] of Object.entries(numbers)) next.policy[key] = numeric('policy-' + key, min, max, integer !== false);
      if (next.policy.enabled && !cfg.policy.enabled && !confirm('显式启用正式社交？当业务、人格、渠道和权限就绪且停止解除时，可能调用真实模型并互动。')) return;
      await saveConfig(next); saved('社交与预算策略已保存', 'policy');
    });
    on('backup', () => download('backup', 'qq-agent-backup.json'));
    on('diagnostics', () => download('diagnostics', 'qq-agent-diagnostics.json'));
    on('restore', async () => {
      const file = $('#restore-file').files[0];
      if (!file) throw Error('请先选择备份文件。');
      if (file.size > 8 * 1024 * 1024) throw Error('备份超过 8 MB。');
      let raw, data;
      try { raw = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()); data = JSON.parse(raw); }
      catch { throw Error('备份不是有效的 UTF-8 JSON；未发送恢复请求。'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('备份顶层必须是对象；未发送恢复请求。');
      if (!confirm('确认校验并恢复此备份？它会替换当前项目数据并使管理会话失效，恢复后保持全部暂停。')) return;
      // 原样发送文件文本：JSON.parse→stringify 会把 5.0 变成 5，改变校验和。
      const res = await fetch('/api/backup/restore', {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: raw});
      if (res.status === 401) { endSession('登录已失效，请重新登录。未保存内容已从页面清除。'); throw Error('登录已失效，请重新登录。'); }
      let value;
      try { value = await res.json(); } catch { throw Error('恢复响应无效；写入结果可能未知，请先核对状态，勿重复提交。'); }
      if (!res.ok) throw Error(responseError(value.detail, res.status));
      endSession('恢复完成；全部发信停止，请重新登录核对配置。');
    });
  }
};

$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button');
  if (button.disabled) return;
  button.disabled = true; $('#login-error').textContent = ''; $('#toast').hidden = true;
  try {
    const result = await api('login', 'POST', {password: $('#password').value});
    csrf = result.csrf; $('#password').value = ''; $('#login').hidden = true; $('#shell').hidden = false;
    await show(page, true);
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
};
on('logout', async () => {
  if (!confirmLeave()) return;
  await api('logout', 'POST', {}); endSession('已退出管理台。');
});
on('pause', async () => {
  const current = await api('status');
  const pause = current.controls.pause_active !== true;
  if (!pause && !confirm('恢复主动行为评估？在正式社交、人格和权限就绪时可能触发真实互动。')) return;
  await api('control', 'POST', {pause}); await refreshStatus();
  toast(status.controls.pause_active ? '主动行为已暂停；被动回复仍受独立门禁约束。' : '主动行为暂停已解除；仍受其他门禁约束。');
  if (!dirty.size && !busy) await show(page, true);
}, true);
on('stop', async () => {
  // 紧急停止在状态加载失败时也可用；解除前必须重新读取真实状态并二次确认。
  let stop = true;
  if (status?.controls.stop_all === true) {
    const current = await api('status');
    if (current.controls.stop_all === true) {
      if (!confirm('解除全部发信停止？其他条件就绪时可能立即进行真实发信。')) return;
      stop = false;
    }
  }
  await api('control', 'POST', {stop}); await refreshStatus();
  toast(status.controls.stop_all ? '全部发信已停止；待发任务按后端规则冻结。' : '全部发信停止已解除；其他门禁继续生效。');
  if (!dirty.size && !busy) await show(page, true);
}, true);
window.addEventListener('beforeunload', event => { if (dirty.size) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden) clearQRs(); });
(async () => {
  try {
    const result = await api('session'); csrf = result.csrf;
    $('#login').hidden = true; $('#shell').hidden = false; await show(page, true);
  } catch (error) { if (!$('#login').hidden && !$('#login-error').textContent) $('#login-error').textContent = error.message; }
})();

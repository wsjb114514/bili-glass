'use strict';
/* BiliGlass 渲染进程逻辑 */
(() => {
  const api = window.biliglass;
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const MODE = params.get('mode') || 'main';
  const VIEW = params.get('view') || '';
  const PERF = params.get('perf') || 'full';
  const MATERIAL = params.get('material') || 'acrylic';

  let state = null;
  let autostartEnabled = false;
  let running = false;
  let progressTimer = null;
  let progress = 0;

  document.body.dataset.mode = MODE;
  if (document.getElementById('app')) {
    const appEl = document.getElementById('app');
    appEl.dataset.mode = MODE;
    if (PERF !== 'full') appEl.classList.add('perf-lite');
    // 窗口创建时就已经确定材质，首帧前就把圆角/底色方案套上，避免闪一下
    if (MATERIAL === 'opaque') appEl.classList.add('no-acrylic', 'opaque-frame');
  }

  /* ------------------------------------------------ 图标按钮 */
  function decorateGlass() {
    // .lg 的折射/染色/高光由 CSS 伪元素承担，这里只负责指针高光追踪
    document.querySelectorAll('.lg').forEach((el) => {
      if (el.dataset.lgBound) return;
      el.dataset.lgBound = '1';
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
      });
      el.addEventListener('pointerleave', () => {
        el.style.setProperty('--mx', '50%');
        el.style.setProperty('--my', '-20%');
      });
    });
  }

  /* ------------------------------------------------ 窗口拖拽 */
  function setupDrag() {
    const selfDrag = !state || !state.config || state.config.dragSelf !== false;
    document.body.classList.toggle('self-drag', selfDrag);
    if (!selfDrag) return; // 用系统拖拽，交给 -webkit-app-region

    document.querySelectorAll('.drag').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button, input, .no-drag')) return;
        if (window.getSelection && String(window.getSelection())) return;
        e.preventDefault();
        api.dragStart();
      });
    });
    // 主进程还会用 GetAsyncKeyState 兜底判断左键松开，这里只是尽快收尾
    document.addEventListener('mouseup', () => api.dragEnd());
    window.addEventListener('blur', () => api.dragEnd());
  }

  /* ------------------------------------------------ 日志 */
  const logBody = $('#logBody');
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function addLog(entry) {
    if (!logBody) return;
    const near = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;
    const div = document.createElement('div');
    div.className = `log-line ${entry.level || 'info'}`;
    div.innerHTML = `<span class="t">${esc(entry.time)}</span><span class="m">${esc(entry.msg)}</span>`;
    logBody.appendChild(div);
    while (logBody.childElementCount > 300) logBody.removeChild(logBody.firstChild);
    if (near) logBody.scrollTop = logBody.scrollHeight;
  }
  function renderLogs(list) {
    if (!logBody) return;
    logBody.innerHTML = '';
    (list || []).forEach(addLog);
    logBody.scrollTop = logBody.scrollHeight;
  }

  /* ------------------------------------------------ 状态渲染 */
  function setStatus(kind, text) {
    const pill = $('#statusPill');
    if (!pill) return;
    pill.className = `status-pill ${kind || ''}`.trim();
    $('#statusText').textContent = text;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderAccount(info) {
    if (!info || !info.uname) {
      $('#uname').textContent = '未登录';
      $('#vipBadge').textContent = '未获取登录态';
      $('#vipBadge').className = 'badge vip off';
      $('#lvBadge').classList.add('hidden');
      $('#accountSub').textContent = '尚未获取登录态：可扫码登录，或先登录 B 站客户端由本程序自动读取';
      $('#expText').textContent = '经验 --';
      $('#expFill').style.width = '0%';
      const fb = $('#avatarFallback');
      fb.textContent = 'B';
      const old = $('#avatar img');
      if (old) old.remove();
      fb.classList.remove('hidden');
      return;
    }
    $('#uname').textContent = info.uname;
    const vip = Number(info.vipStatus) === 1;
    $('#vipBadge').textContent = vip ? `${info.vipLabel || '大会员'}` : '非大会员';
    $('#vipBadge').className = `badge vip${vip ? '' : ' off'}`;
    const lvBadge = $('#lvBadge');
    lvBadge.classList.remove('hidden');
    lvBadge.textContent = `Lv${info.level ?? '--'}`;

    const exp = Number(info.exp) || 0;
    const next = Number(info.nextExp) || 0;
    const pct = next > 0 ? Math.min(100, Math.max(2, (exp / next) * 100)) : 100;
    $('#expFill').style.width = `${pct}%`;
    $('#expText').textContent = next > 0 ? `${exp}/${next}` : `${exp} 经验`;
    $('#accountSub').textContent = vip
      ? `大会员状态正常${info.vipDueDate ? ' · 有效期至 ' + new Date(Number(info.vipDueDate)).toLocaleDateString('zh-CN') : ''}`
      : '当前账号不是大会员，无法领取大会员每日经验';

    const face = info.face ? String(info.face).replace(/^http:/, 'https:') : '';
    const fb = $('#avatarFallback');
    if (face) {
      let img = $('#avatar img');
      if (!img) {
        img = document.createElement('img');
        img.referrerPolicy = 'no-referrer';
        img.onload = () => fb.classList.add('hidden');
        img.onerror = () => {
          img.remove();
          fb.classList.remove('hidden');
        };
        $('#avatar').appendChild(img);
      }
      if (img.getAttribute('src') !== face) img.src = face;
    } else {
      fb.textContent = info.uname.slice(0, 1).toUpperCase();
      fb.classList.remove('hidden');
    }
  }

  function renderAutostart(st) {
    autostartEnabled = !!(state && state.config && state.config.autostart);
    const pill = $('#btnAutostart');
    const sw = $('#asSwitch');
    const sw2 = $('#swAutostart');
    if (pill) pill.classList.toggle('on', autostartEnabled);
    if (sw) sw.setAttribute('aria-checked', String(autostartEnabled));
    if (sw2) sw2.setAttribute('aria-checked', String(autostartEnabled));
    if ($('#asSub')) {
      const method = state && state.autostart && state.autostart.method;
      $('#asSub').textContent = autostartEnabled
        ? `已开启 · ${method === 'task' ? '计划任务' : '注册表'}`
        : '未开启';
    }
  }

  function renderConfigToSettings(cfg) {
    const setSeg = (id, value) => {
      const box = $(id);
      if (!box) return;
      box.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)));
    };
    const setSw = (id, on) => {
      const el = $(id);
      if (el) el.setAttribute('aria-checked', String(!!on));
    };
    setSeg('#segAutostartMethod', cfg.autostartMethod);
    setSeg('#segAuthPrefer', cfg.authPrefer);
    setSeg('#segMaterial', cfg.material);
    setSw('#swAutostart', cfg.autostart);
    setSw('#swLaunchClient', cfg.launchClient);
    setSw('#swAutoClaim', cfg.autoClaim);
    setSw('#swAllowClient', cfg.allowClientCredentials);
    setSw('#swWatchBeforeClaim', cfg.watchBeforeClaim !== false);
    setSw('#swDragSelf', cfg.dragSelf !== false);
    setSw('#swPrecheckFirst', cfg.precheckFirst !== false);

    const rngDelay = $('#rngDelay');
    rngDelay.value = cfg.startupDelaySec;
    $('#delayVal').textContent = cfg.startupDelaySec;
    const rngWait = $('#rngWait');
    rngWait.value = cfg.clientWaitSec;
    $('#waitVal').textContent = cfg.clientWaitSec;
    const rngWatch = $('#rngWatchSeconds');
    if (rngWatch) {
      rngWatch.value = cfg.watchSeconds;
      $('#watchVal').textContent = cfg.watchSeconds;
    }
    const txtBvid = $('#txtWatchBvid');
    if (txtBvid && document.activeElement !== txtBvid) txtBvid.value = cfg.watchBvid || '';
    renderResolvedLine(cfg);

    const cp = state.client && state.client.detected;
    $('#clientPathText').textContent = cp || '未检测到客户端，请手动指定';
    $('#clientPathText').title = cp || '';
  }

  function renderResolvedLine(cfg) {
    const line = $('#resolvedLine');
    if (!line) return;
    if (cfg.watchBvid) {
      line.className = 'resolved-line ok';
      line.textContent = `已指定：${cfg.watchBvid}${cfg.watchBvidTitle ? `《${cfg.watchBvidTitle}》` : ''}`;
    } else {
      line.className = 'resolved-line';
      line.textContent = '当前：自动从排行榜挑选';
    }
  }

  function renderResult(res) {
    if (!res) return;
    const icon = $('#resultIcon');
    const title = $('#resultTitle');
    const msg = $('#resultMsg');
    const meta = $('#resultMeta');
    if (!icon) return;

    if (res.pending) {
      icon.className = 'result-icon loading';
      title.textContent = '正在执行…';
      msg.textContent = res.message || '开机自动任务正在运行';
      meta.textContent = '';
      return;
    }
    icon.className = `result-icon ${res.ok ? '' : 'err'}`;
    title.textContent = res.ok ? (res.skipped ? '今日已完成' : '领取成功') : res.needLogin ? '需要登录' : '领取未成功';
    msg.textContent = res.message || '';
    const parts = [];
    if (res.uname) parts.push(`账号：${res.uname}`);
    if (res.at) parts.push(fmtTime(res.at));
    meta.textContent = parts.join(' · ');
    if ($('#footer')) $('#footer').classList.toggle('hidden', MODE === 'result');
  }

  function applyState(s) {
    state = s;
    renderAutostart();
    renderConfigToSettings(s.config);
    renderAccount(s.account);
    renderLogs(s.logs);
    if ($('#versionLine')) {
      $('#versionLine').innerHTML =
        `BiliGlass v${s.versions.app} · Electron ${s.versions.electron} · Node ${s.versions.node}<br>` +
        `${s.platform}${s.nativeMaterial ? ' · 原生亚克力可用' : ' · 原生亚克力不可用（CSS 毛玻璃）'}`;
    }
    const last = s.config.lastRun;
    if (last && $('#statusTime')) {
      $('#statusTime').textContent = `${last.date} ${last.ok ? '成功' : '未成功'}`;
    }
    if (last && !running) {
      setStatus(last.ok ? 'ok' : 'err', last.ok ? (last.skipped ? '今日已完成' : '上次领取成功') : '上次未成功');
    }
    if (MODE === 'result' && s.lastResult) renderResult(s.lastResult);
  }

  /* ------------------------------------------------ 执行流程 */
  function startProgress() {
    progress = 6;
    const bar = $('#btnProgress');
    if (!bar) return;
    bar.classList.add('on');
    bar.style.width = '6%';
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      progress = Math.min(88, progress + Math.random() * 7);
      bar.style.width = `${progress}%`;
    }, 420);
  }
  function stopProgress(ok) {
    clearInterval(progressTimer);
    const bar = $('#btnProgress');
    if (!bar) return;
    bar.style.width = '100%';
    setTimeout(() => {
      bar.classList.remove('on');
      bar.style.width = '0%';
    }, 700);
  }

  async function doRun(manual = true) {
    if (running) return;
    running = true;
    const btn = $('#btnRun');
    if (btn) btn.classList.add('busy');
    setStatus('running', '正在执行…');
    startProgress();
    try {
      const res = await api.run({ manual });
      const r = res.result || {};
      stopProgress(!!r.ok);
      if (r.needLogin) {
        setStatus('warn', '需要登录');
        openQr();
      } else if (r.ok) {
        setStatus('ok', r.skipped ? '今日已完成' : '领取成功');
      } else {
        setStatus('err', '未成功');
      }
      if (r.info) renderAccount(r.info);
      state = res.state || state;
      if (state) applyState(state);
    } catch (err) {
      stopProgress(false);
      setStatus('err', '执行异常');
      addLog({ time: new Date().toLocaleTimeString('zh-CN'), level: 'error', msg: String(err.message || err) });
    } finally {
      running = false;
      if (btn) btn.classList.remove('busy');
    }
  }

  /* ------------------------------------------------ 扫码 */
  let qrOpen = false;
  function openQr() {
    $('#qrMask').classList.add('open');
    qrOpen = true;
    startQr();
  }
  function closeQr() {
    $('#qrMask').classList.remove('open');
    qrOpen = false;
    api.qrStop();
  }
  async function startQr() {
    $('#qrStatus').className = 'qr-status';
    $('#qrStatus').textContent = '正在获取二维码…';
    $('#qrOverlay').classList.remove('show');
    $('#qrImg').removeAttribute('src');
    const r = await api.qrStart();
    if (!r.ok) {
      $('#qrStatus').className = 'qr-status err';
      $('#qrStatus').textContent = r.error || '二维码获取失败';
      return;
    }
    $('#qrImg').src = r.image;
    $('#qrStatus').textContent = '请使用哔哩哔哩手机客户端扫码';
  }

  /* ------------------------------------------------ 设置交互 */
  function bindSwitch(sel, key, after) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('click', async () => {
      const next = el.getAttribute('aria-checked') !== 'true';
      el.setAttribute('aria-checked', String(next));
      if (key === 'autostart') {
        const r = await api.setAutostart({ enabled: next });
        state = r.state;
        applyState(state);
        if (!r.result.ok) {
          if ($('#asSub')) $('#asSub').textContent = `开启失败：${r.result.error || ''}`;
        } else if (r.result.note) {
          addLog({ time: new Date().toLocaleTimeString('zh-CN'), level: 'warn', msg: r.result.note });
        }
        return;
      }
      state = await api.saveConfig({ [key]: next });
      applyState(state);
      if (after) after(next);
    });
  }

  function bindSegment(sel, key, after) {
    const box = $(sel);
    if (!box) return;
    box.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        box.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state = await api.saveConfig({ [key]: btn.dataset.value });
        if (key === 'material') {
          await api.setMaterial(btn.dataset.value);
        }
        applyState(state);
        if (after) after(btn.dataset.value);
      });
    });
  }

  function bindRange(sel, key, labelSel, suffix) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      $(labelSel).textContent = el.value;
    });
    el.addEventListener('change', async () => {
      state = await api.saveConfig({ [key]: Number(el.value) });
      applyState(state);
    });
  }

  /* ------------------------------------------------ 事件绑定 */
  function bind() {
    decorateGlass();
    setupDrag();
    $('#btnMin')?.addEventListener('click', () => api.minimize());
    $('#btnClose')?.addEventListener('click', () => api.close());
    $('#btnRun')?.addEventListener('click', () => doRun(true));
    $('#btnClient')?.addEventListener('click', async () => {
      setStatus('running', '正在拉起客户端…');
      const r = await api.launchClient();
      setStatus(r.ok ? 'ok' : 'err', r.ok ? (r.alreadyRunning ? '客户端已在运行' : '客户端已拉起') : r.error || '拉起失败');
      addLog({ time: new Date().toLocaleTimeString('zh-CN'), level: r.ok ? 'ok' : 'error', msg: r.ok ? `已拉起客户端：${r.path}` : `拉起失败：${r.error}` });
    });
    $('#btnQr')?.addEventListener('click', openQr);
    $('#btnQrClose')?.addEventListener('click', closeQr);
    $('#btnQrRefresh')?.addEventListener('click', startQr);
    $('#btnOpenLog')?.addEventListener('click', () => api.openLog());
    $('#btnClearLog')?.addEventListener('click', () => { if (logBody) logBody.innerHTML = ''; });

    $('#btnAutostart')?.addEventListener('click', async () => {
      const r = await api.setAutostart({ enabled: !autostartEnabled });
      state = r.state;
      applyState(state);
      if (!r.result.ok) setStatus('err', `设置自启失败：${r.result.error || ''}`);
      else setStatus('ok', autostartEnabled ? '已开启开机自启' : '已关闭开机自启');
    });
    $('#asSwitch')?.addEventListener('click', (e) => { e.stopPropagation(); $('#btnAutostart').click(); });

    const sheet = $('#sheet');
    const mask = $('#sheetMask');
    const openSheet = () => { sheet.classList.add('open'); mask.classList.add('open'); };
    const closeSheet = () => { sheet.classList.remove('open'); mask.classList.remove('open'); };
    $('#btnSettings')?.addEventListener('click', openSheet);
    $('#btnSheetClose')?.addEventListener('click', closeSheet);
    mask?.addEventListener('click', closeSheet);

    bindSwitch('#swAutostart', 'autostart');
    bindSwitch('#swLaunchClient', 'launchClient');
    bindSwitch('#swAutoClaim', 'autoClaim');
    bindSwitch('#swAllowClient', 'allowClientCredentials');
    bindSwitch('#swWatchBeforeClaim', 'watchBeforeClaim');
    bindSwitch('#swDragSelf', 'dragSelf', (v) => setupDrag());
    bindSwitch('#swPrecheckFirst', 'precheckFirst');
    bindSegment('#segAutostartMethod', 'autostartMethod', async () => {
      // 切换方式时，若当前已开启需要重新注册
      if (autostartEnabled) {
        const r = await api.setAutostart({ enabled: true });
        state = r.state;
        applyState(state);
      }
    });
    bindSegment('#segAuthPrefer', 'authPrefer');
    bindSegment('#segMaterial', 'material');
    bindRange('#rngDelay', 'startupDelaySec', '#delayVal');
    bindRange('#rngWait', 'clientWaitSec', '#waitVal');
    bindRange('#rngWatchSeconds', 'watchSeconds', '#watchVal');

    const txtBvid = $('#txtWatchBvid');
    const btnResolve = $('#btnResolveBvid');
    const doResolve = async () => {
      const raw = txtBvid ? txtBvid.value.trim() : '';
      const line = $('#resolvedLine');
      if (line) {
        line.className = 'resolved-line';
        line.textContent = raw ? '正在解析…' : '当前：自动从排行榜挑选';
      }
      const r = await api.resolveWatchVideo(raw);
      state = r.state;
      const res = r.result || {};
      if (res.ok && res.empty) {
        if (txtBvid) txtBvid.value = '';
        renderResolvedLine(state.config);
      } else if (res.ok) {
        if (txtBvid) txtBvid.value = res.bvid;
        if (line) {
          line.className = 'resolved-line ok';
          line.textContent = `已指定：${res.bvid}《${res.title}》${res.duration ? ` · ${res.duration}s` : ''}（${res.via}）`;
        }
      } else {
        if (line) {
          line.className = 'resolved-line err';
          line.textContent = res.error || '解析失败';
        }
      }
      applyState(state);
      if (line && res.ok && res.bvid) {
        line.className = 'resolved-line ok';
        line.textContent = `已指定：${res.bvid}《${res.title}》${res.duration ? ` · ${res.duration}s` : ''}（${res.via}）`;
      }
    };
    if (btnResolve) btnResolve.addEventListener('click', doResolve);
    if (txtBvid) {
      txtBvid.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doResolve();
      });
    }
    $('#btnClearBvid')?.addEventListener('click', async () => {
      if (txtBvid) txtBvid.value = '';
      state = await api.saveConfig({ watchBvid: '', watchBvidTitle: '' });
      renderResolvedLine(state.config);
      applyState(state);
    });

    $('#btnPickClient')?.addEventListener('click', async () => {
      const r = await api.pickClient();
      if (r.state) { state = r.state; applyState(state); }
    });
    $('#btnRedetect')?.addEventListener('click', async () => {
      const r = await api.redetectClient();
      state = r.state;
      applyState(state);
      addLog({ time: new Date().toLocaleTimeString('zh-CN'), level: r.path ? 'ok' : 'warn', msg: r.path ? `已检测到客户端：${r.path}` : '未检测到哔哩哔哩客户端' });
    });
    $('#btnLogout')?.addEventListener('click', async () => {
      state = await api.logout();
      applyState(state);
      renderAccount(null);
      setStatus('warn', '已清除本地登录态');
    });
    $('#btnOpenData')?.addEventListener('click', () => api.openUserData());
    $('#btnOpenLog2')?.addEventListener('click', () => api.openLog());

    $('#btnResultMain')?.addEventListener('click', () => api.openMain());
    $('#btnResultClose')?.addEventListener('click', () => api.quit());
  }

  /* ------------------------------------------------ 主进程事件 */
  api.onLog((entry) => addLog(entry));
  api.onMaterial((p) => {
    const app = $('#app');
    if (!app) return;
    const effective = p && p.effective;
    const opaque = effective === 'opaque' || !(p && p.native && p.native.ok && p.material !== 'none');
    app.classList.toggle('no-acrylic', opaque);
    app.classList.toggle('opaque-frame', opaque);
    if (opaque && !app.dataset.opaqueLogged) {
      app.dataset.opaqueLogged = '1';
      addLog({
        time: new Date().toLocaleTimeString('zh-CN'),
        level: 'info',
        msg: '本机窗口模糊不可用：已关闭原生亚克力（消除拖拽迟滞），改用 CSS 圆角 + 投影 + 不透明玻璃底',
      });
    }
  });
  api.onQr((evt) => {
    const st = $('#qrStatus');
    if (!st) return;
    if (evt.state === 'waiting') {
      st.className = 'qr-status';
      st.textContent = evt.message || '等待扫码…';
      $('#qrOverlay').classList.remove('show');
    } else if (evt.state === 'scanned') {
      st.className = 'qr-status';
      st.textContent = evt.message;
      $('#qrOverlay').classList.add('show');
    } else if (evt.state === 'success') {
      st.className = 'qr-status ok';
      st.textContent = `登录成功：${evt.info ? evt.info.uname : ''}`;
      $('#qrOverlay').classList.remove('show');
      if (evt.info) renderAccount(evt.info);
      setStatus('ok', '扫码登录成功');
      setTimeout(() => closeQr(), 900);
    } else if (evt.state === 'expired') {
      st.className = 'qr-status err';
      st.textContent = evt.message;
    } else if (evt.state === 'error') {
      st.className = 'qr-status err';
      st.textContent = evt.message;
    }
  });
  api.onStatePatch((p) => {
    if (!state) return;
    Object.assign(state.config, p);
    renderAutostart();
    renderConfigToSettings(state.config);
  });
  api.onDetected((p) => {
    if (!state) return;
    if (p.autostart) state.autostart = p.autostart;
    if (p.client) state.client = p.client;
    renderAutostart();
    renderConfigToSettings(state.config);
  });
  api.onRun((evt) => {
    if (evt.phase === 'finished') {
      const r = evt.result || {};
      if (MODE === 'result') renderResult(r);
      if (r.info) renderAccount(r.info);
      return;
    }
    if (evt.message) setStatus(evt.warn ? 'warn' : 'running', evt.message);
    if (evt.info) renderAccount(evt.info);
    if (evt.phase === 'need-login') setStatus('warn', '需要登录');
  });

  function applyDemo() {
    renderAccount({
      uname: '哔哩哔哩大会员',
      level: 5,
      exp: 12300,
      nextExp: 15000,
      vipStatus: 1,
      vipLabel: '年度大会员',
      vipDueDate: Date.now() + 31 * 86400000,
      face: '',
    });
    renderLogs([
      { time: '07:31:02.114', level: 'info', msg: 'BiliGlass 启动（v1.0.0，Electron 44.4.5）' },
      { time: '07:31:02.220', level: 'info', msg: '运行模式：开机自启' },
      { time: '07:31:14.380', level: 'ok', msg: '已拉起哔哩哔哩客户端：哔哩哔哩.exe' },
      { time: '07:31:14.402', level: 'step', msg: '校验本地扫码登录态…' },
      { time: '07:31:15.117', level: 'ok', msg: '登录态来源：扫码登录，账号：哔哩哔哩大会员' },
      { time: '07:31:15.140', level: 'step', msg: '正在领取大会员每日经验…' },
      { time: '07:31:15.688', level: 'ok', msg: '大会员每日经验 +10 领取成功（返回码 0）' },
      { time: '07:31:16.204', level: 'info', msg: '本次执行结束：大会员每日经验 +10 领取成功（耗时 1.8s）' },
    ]);
    setStatus('ok', '领取成功');
    $('#statusTime').textContent = '今天 07:31 成功';
  }

  /* ------------------------------------------------ 启动 */
  (async function boot() {
    bind();
    try {
      state = await api.getState();
      applyState(state);
    } catch (err) {
      addLog({ time: '--:--:--', level: 'error', msg: `初始化失败：${err.message}` });
    }

    if (VIEW === 'demo') applyDemo();
    if (VIEW === 'qr') openQr();
    if (VIEW === 'settings') {
      $('#sheet').classList.add('open');
      $('#sheetMask').classList.add('open');
      if (params.get('scroll') === 'bottom') {
        setTimeout(() => {
          const body = document.querySelector('.sheet-body');
          if (body) body.scrollTop = body.scrollHeight;
        }, 900);
      }
    }
    if (MODE === 'result') {
      $('#footer')?.classList.add('hidden');
      if (VIEW === 'demo') {
        renderResult({ ok: true, message: '大会员每日经验 +10 领取成功', uname: '哔哩哔哩大会员', at: Date.now() });
      } else if (!state || !state.lastResult) {
        renderResult({ pending: true, message: '开机自动任务正在运行，请稍候…' });
      }
    }
    if (VIEW === 'result' && MODE !== 'result') { api.openResultView(); }
  })();
})();

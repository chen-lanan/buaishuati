(() => {
  'use strict';

  const moduleFactories = Object.create(null);
  const moduleCache = Object.create(null);
  const pageDefinitions = Object.create(null);
  let appDefinition = null;
  let appInstance = null;
  let loadingPageRoute = '';
  let currentEntry = null;
  const navigationStack = [];
  const utilityRoutes = new Set(['pages/statistics/statistics', 'pages/settings/settings']);
  let pendingFileRequest = null;
  let toastTimer = null;
  let activeOverlayDismiss = null;
  let activeImageViewerDismiss = null;

  const $ = id => document.getElementById(id);
  const pageRoot = () => $('page-root');

  window.__define = (id, factory) => {
    moduleFactories[normalizeModuleId(id)] = factory;
  };

  function normalizeModuleId(id) {
    const parts = [];
    String(id || '').replace(/\\/g, '/').split('/').forEach(part => {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
    let value = parts.join('/');
    if (!/\.js$/i.test(value)) value += '.js';
    return value;
  }

  function resolveModule(request, parentId) {
    if (request.startsWith('.')) {
      const base = parentId.split('/').slice(0, -1).join('/');
      return normalizeModuleId(base + '/' + request);
    }
    return normalizeModuleId(request);
  }

  window.__require = function __require(request, parentId = '') {
    const id = resolveModule(request, parentId || 'app.js');
    if (moduleCache[id]) return moduleCache[id].exports;
    const factory = moduleFactories[id];
    if (!factory) throw new Error(`模块不存在：${id}`);
    const module = { exports: {} };
    moduleCache[id] = module;
    const localRequire = child => window.__require(child, id);
    factory(localRequire, module, module.exports);
    return module.exports;
  };

  window.App = definition => {
    appDefinition = definition || {};
  };

  window.Page = definition => {
    if (!loadingPageRoute) throw new Error('无法确定页面路径');
    pageDefinitions[loadingPageRoute] = definition || {};
  };

  window.getApp = () => appInstance;

  function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function setDeep(target, path, value) {
    const normalized = String(path).replace(/\[(\d+)\]/g, '.$1');
    const parts = normalized.split('.').filter(Boolean);
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      const nextKey = parts[i + 1];
      if (cursor[key] == null || typeof cursor[key] !== 'object') {
        cursor[key] = /^\d+$/.test(nextKey) ? [] : {};
      }
      cursor = cursor[key];
    }
    if (parts.length) cursor[parts[parts.length - 1]] = value;
  }

  function makePageInstance(route, query) {
    if (!pageDefinitions[route]) {
      loadingPageRoute = route;
      window.__require(`${route}.js`);
      loadingPageRoute = '';
    }
    const definition = pageDefinitions[route];
    if (!definition) throw new Error(`页面未注册：${route}`);
    const instance = {};
    Object.keys(definition).forEach(key => {
      instance[key] = key === 'data' ? deepClone(definition.data || {}) : definition[key];
    });
    instance.route = route;
    instance.options = query || {};
    instance.__renderQueued = false;
    instance.__suspendRender = false;
    instance.__pendingSetDataCallbacks = [];
    instance.__flushSetDataCallbacks = function flushSetDataCallbacks() {
      const callbacks = instance.__pendingSetDataCallbacks.splice(0);
      callbacks.forEach(fn => setTimeout(() => fn.call(instance), 0));
    };
    instance.setData = function setData(patch, callback) {
      Object.keys(patch || {}).forEach(key => setDeep(instance.data, key, patch[key]));
      if (typeof callback === 'function') instance.__pendingSetDataCallbacks.push(callback);
      if (instance.__suspendRender) return;
      if (!currentEntry || currentEntry.instance !== instance) {
        instance.__flushSetDataCallbacks();
        return;
      }
      if (instance.__renderQueued) return;
      instance.__renderQueued = true;
      const schedule = typeof queueMicrotask === 'function' ? queueMicrotask : fn => Promise.resolve().then(fn);
      schedule(() => {
        instance.__renderQueued = false;
        if (currentEntry && currentEntry.instance === instance) {
          const keepScrollY = window.scrollY || document.documentElement.scrollTop || 0;
          renderCurrentPage(false);
          requestAnimationFrame(() => window.scrollTo(0, keepScrollY));
        }
        instance.__flushSetDataCallbacks();
      });
    };
    return instance;
  }

  function parseUrl(url) {
    const raw = String(url || '').replace(/^\//, '');
    const q = raw.indexOf('?');
    const route = q >= 0 ? raw.slice(0, q) : raw;
    const query = {};
    if (q >= 0) {
      const search = new URLSearchParams(raw.slice(q + 1));
      search.forEach((value, key) => { query[key] = value; });
    }
    return { route, query };
  }

  const fullscreenRoutes = new Set(['pages/practice/practice', 'pages/exam/exam']);
  let fullscreenEnabled = null;
  function immersivePreference() {
    try {
      const raw = bridge().storageGet('qb_settings_v1');
      if (!raw) return true;
      const settings = JSON.parse(raw);
      return settings.immersivePractice !== false;
    } catch (_) { return true; }
  }
  function syncFullscreenRoute(route) {
    const activeRoute = String(route || (currentEntry && currentEntry.route) || '');
    const enabled = immersivePreference();
    document.body.classList.toggle('global-immersive', enabled);
    document.body.classList.toggle('practice-immersive', fullscreenRoutes.has(activeRoute) && enabled);
    try {
      const nativeBridge = window.AndroidBridge;
      if (nativeBridge && typeof nativeBridge.getStatusBarHeight === 'function') {
        const physicalHeight = Math.max(0, Number(nativeBridge.getStatusBarHeight()) || 0);
        const ratio = Math.max(1, Number(window.devicePixelRatio) || 1);
        document.documentElement.style.setProperty('--native-status-bar-height', `${physicalHeight / ratio}px`);
      }
    } catch (_) {}
    fullscreenEnabled = enabled;
    try { applyAppTheme(); } catch (_) {}
  }
  window.__syncPracticeChrome = () => syncFullscreenRoute(currentEntry ? currentEntry.route : '');

  function pageTitle(route) {
    const project = window.__PROJECT__ || {};
    const page = project.pages && project.pages[route];
    return (page && page.config && page.config.navigationBarTitleText)
      || (project.appConfig && project.appConfig.window && project.appConfig.window.navigationBarTitleText)
      || '不爱刷题';
  }

  function updateAppBar(title) {
    const route = currentEntry ? currentEntry.route : '';
    const isHome = route === 'pages/home/home';
    const appBar = $('app-bar');
    if (appBar) appBar.classList.toggle('home-mode', isHome);
    $('app-title').textContent = title || pageTitle(route);
    $('back-button').classList.toggle('hidden', isHome || navigationStack.length <= 1);
    const statisticsButton = $('global-statistics-button');
    const settingsButton = $('global-settings-button');
    if (statisticsButton) {
      statisticsButton.classList.toggle('hidden', !isHome);
      statisticsButton.classList.remove('active');
    }
    if (settingsButton) settingsButton.classList.toggle('active', route === 'pages/settings/settings');
  }

  function openGlobalPage(route) {
    if (currentEntry && currentEntry.route === route) return;
    const currentRoute = currentEntry ? currentEntry.route : '';
    // 统计与设置属于同一层工具页：互相切换时替换当前页，避免反复压栈。
    enterPage(route, utilityRoutes.has(currentRoute) ? 'replace' : 'push');
  }

  function captureEntryScrollState(entry) {
    if (!entry) return;
    entry.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const root = pageRoot();
    const preserved = {};
    if (root) {
      root.querySelectorAll('[data-preserve-scroll]').forEach(element => {
        const key = element.dataset.preserveScroll;
        if (!key) return;
        preserved[key] = { left: element.scrollLeft || 0, top: element.scrollTop || 0 };
      });
    }
    entry.preservedScroll = preserved;
  }

  function restoreEntryScrollState(entry) {
    if (!entry) return;
    const restore = () => {
      if (currentEntry !== entry) return;
      window.scrollTo(0, Number(entry.scrollY) || 0);
      const root = pageRoot();
      const preserved = entry.preservedScroll || {};
      if (!root) return;
      Object.keys(preserved).forEach(key => {
        const element = root.querySelector(`[data-preserve-scroll="${key}"]`);
        if (!element) return;
        element.scrollLeft = Number(preserved[key].left) || 0;
        element.scrollTop = Number(preserved[key].top) || 0;
      });
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 30);
    setTimeout(restore, 120);
  }

  function callLifecycle(instance, name, ...args) {
    try {
      if (instance && typeof instance[name] === 'function') return instance[name].apply(instance, args);
    } catch (error) {
      console.error(`${name} 执行失败`, error);
      showFatalError(error);
    }
    return undefined;
  }

  function enterPage(url, mode = 'push') {
    const { route, query } = parseUrl(url);
    if (!window.__PROJECT__.pages[route]) {
      wx.showModal({ title: '页面不存在', content: route, showCancel: false });
      return;
    }
    syncFullscreenRoute(route);
    if (currentEntry) {
      captureEntryScrollState(currentEntry);
      callLifecycle(currentEntry.instance, 'onHide');
    }
    if (mode === 'replace' && navigationStack.length) {
      const old = navigationStack.pop();
      callLifecycle(old.instance, 'onUnload');
    } else if (mode === 'relaunch') {
      while (navigationStack.length) {
        const old = navigationStack.pop();
        callLifecycle(old.instance, 'onUnload');
      }
    }
    const instance = makePageInstance(route, query);
    const entry = { route, query, instance, title: pageTitle(route) };
    navigationStack.push(entry);
    currentEntry = entry;
    updateAppBar(entry.title);
    // 首次进入时先完成 onLoad/onShow 的同步数据准备，再一次性绘制页面。
    // 旧实现会先绘制默认 data，再被多个 setData 连续重建，肉眼会感觉进入页面拖沓。
    instance.__suspendRender = true;
    callLifecycle(instance, 'onLoad', query);
    callLifecycle(instance, 'onShow');
    instance.__suspendRender = false;
    renderCurrentPage(true);
    instance.__flushSetDataCallbacks();
  }

  function navigateBack(delta = 1) {
    if (navigationStack.length <= 1) return false;
    const count = Math.max(1, Number(delta) || 1);
    for (let i = 0; i < count && navigationStack.length > 1; i += 1) {
      const old = navigationStack.pop();
      callLifecycle(old.instance, 'onUnload');
    }
    currentEntry = navigationStack[navigationStack.length - 1];
    syncFullscreenRoute(currentEntry.route);
    updateAppBar(currentEntry.title);
    // 返回已有页面时先让 onShow 更新数据，再只渲染一次，减少返回时的二次闪动。
    currentEntry.instance.__suspendRender = true;
    callLifecycle(currentEntry.instance, 'onShow');
    currentEntry.instance.__suspendRender = false;
    renderCurrentPage(true);
    currentEntry.instance.__flushSetDataCallbacks();
    restoreEntryScrollState(currentEntry);
    return true;
  }

  function dismissTopOverlay() {
    if (activeImageViewerDismiss) {
      const dismissed = activeImageViewerDismiss();
      if (dismissed) return true;
    }
    const customOverlay = document.querySelector('[data-back-dismiss="true"]');
    if (customOverlay) {
      const action = customOverlay.querySelector('[data-back-dismiss-action="true"]');
      if (action) action.click();
      else customOverlay.click();
      return true;
    }
    const layer = $('modal-layer');
    if (activeOverlayDismiss && layer && !layer.classList.contains('hidden')) {
      const dismiss = activeOverlayDismiss;
      dismiss();
      return true;
    }
    return false;
  }

  window.__androidBack = () => {
    if (dismissTopOverlay()) return true;
    if (!navigateBack(1)) {
      const b = bridge();
      if (b && b.finishApp) b.finishApp();
    }
    return true;
  };

  function evaluateExpression(expression, data, scope) {
    try {
      return Function('data', 'scope', `with(data){with(scope){return (${expression});}}`)(data, scope);
    } catch (error) {
      return undefined;
    }
  }

  function interpolate(value, data, scope, raw = false) {
    const text = String(value == null ? '' : value);
    const exact = /^\s*\{\{([\s\S]+)\}\}\s*$/.exec(text);
    if (exact) {
      const result = evaluateExpression(exact[1], data, scope);
      return raw ? result : (result == null ? '' : String(result));
    }
    return text.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
      const result = evaluateExpression(expr, data, scope);
      return result == null ? '' : String(result);
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeTemplate(template) {
    return String(template || '')
      .replace(/<(image|input|textarea|slider|switch)(\b[^>]*?)\/>/gi, '<$1$2></$1>');
  }

  function nextElementIndex(nodes, start) {
    let index = start;
    while (index < nodes.length) {
      const node = nodes[index];
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) index += 1;
      else return index;
    }
    return index;
  }

  function renderChildren(parent, data, scope) {
    const nodes = Array.from(parent.childNodes);
    let html = '';
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('wx:if')) {
        const candidates = [node];
        let cursor = i + 1;
        while (cursor < nodes.length) {
          cursor = nextElementIndex(nodes, cursor);
          if (cursor >= nodes.length) break;
          const candidate = nodes[cursor];
          if (candidate.nodeType === Node.ELEMENT_NODE && (candidate.hasAttribute('wx:elif') || candidate.hasAttribute('wx:else'))) {
            candidates.push(candidate);
            cursor += 1;
          } else break;
        }
        let selected = null;
        for (const candidate of candidates) {
          if (candidate.hasAttribute('wx:if')) {
            if (Boolean(interpolate(candidate.getAttribute('wx:if'), data, scope, true))) { selected = candidate; break; }
          } else if (candidate.hasAttribute('wx:elif')) {
            if (Boolean(interpolate(candidate.getAttribute('wx:elif'), data, scope, true))) { selected = candidate; break; }
          } else {
            selected = candidate;
            break;
          }
        }
        if (selected) html += renderNode(selected, data, scope, { ignoreCondition: true });
        const last = candidates[candidates.length - 1];
        i = nodes.indexOf(last);
        continue;
      }
      if (node.nodeType === Node.ELEMENT_NODE && (node.hasAttribute('wx:elif') || node.hasAttribute('wx:else'))) continue;
      html += renderNode(node, data, scope, {});
    }
    return html;
  }

  function renderNode(node, data, scope, options) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(interpolate(node.textContent, data, scope));
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    if (!options.ignoreFor && node.hasAttribute('wx:for')) {
      const value = interpolate(node.getAttribute('wx:for'), data, scope, true);
      const list = Array.isArray(value) ? value : [];
      const itemName = node.getAttribute('wx:for-item') || 'item';
      const indexName = node.getAttribute('wx:for-index') || 'index';
      return list.map((item, index) => {
        const childScope = Object.assign({}, scope, { [itemName]: item, [indexName]: index });
        return renderNode(node, data, childScope, { ignoreFor: true, ignoreCondition: options.ignoreCondition });
      }).join('');
    }

    if (!options.ignoreCondition && node.hasAttribute('wx:if')) {
      if (!Boolean(interpolate(node.getAttribute('wx:if'), data, scope, true))) return '';
    }

    const sourceTag = node.tagName.toLowerCase();
    if (sourceTag === 'block') return renderChildren(node, data, scope);

    let tag = sourceTag;
    if (sourceTag === 'view' || sourceTag === 'scroll-view') tag = 'div';
    else if (sourceTag === 'text') tag = 'span';
    else if (sourceTag === 'image') tag = 'img';
    else if (sourceTag === 'picker') tag = 'div';
    else if (sourceTag === 'switch') tag = 'input';
    else if (sourceTag === 'slider') tag = 'input';

    const attrs = [];
    const eventMap = {
      bindtap: 'click', catchtap: 'click',
      bindinput: 'input', bindchange: 'change', bindconfirm: 'confirm',
      bindtouchstart: 'touchstart', bindtouchend: 'touchend', bindtouchcancel: 'touchcancel'
    };
    let catchClick = false;
    let pickerRange = null;
    let pickerValue = 0;
    let pickerRangeKey = '';
    let textareaValue = '';

    Array.from(node.attributes).forEach(attribute => {
      const name = attribute.name;
      const value = attribute.value;
      if (name.startsWith('wx:')) return;
      if (eventMap[name]) {
        attrs.push(`data-event-${eventMap[name]}="${escapeHtml(value)}"`);
        if (name === 'catchtap') catchClick = true;
        return;
      }
      if (name === 'mode' || name === 'scroll-y' || name === 'show-value' || name === 'activeColor' || name === 'color') return;
      if (sourceTag === 'picker' && name === 'range') {
        const range = interpolate(value, data, scope, true);
        pickerRange = Array.isArray(range) ? range : [];
        return;
      }
      if (sourceTag === 'picker' && name === 'range-key') {
        pickerRangeKey = interpolate(value, data, scope);
        return;
      }
      if (sourceTag === 'picker' && name === 'value') {
        pickerValue = Number(interpolate(value, data, scope, true)) || 0;
        return;
      }
      if (name === 'class') {
        attrs.push(`class="${escapeHtml(interpolate(value, data, scope))}"`);
        return;
      }
      if (name === 'style') {
        const style = interpolate(value, data, scope).replace(/(-?\d+(?:\.\d+)?)rpx/g, 'calc($1 * var(--rpx))');
        attrs.push(`style="${escapeHtml(style)}"`);
        return;
      }
      if (name === 'src') {
        let src = interpolate(value, data, scope);
        if (/^\//.test(src)) src = `file://${encodeURI(src)}`;
        attrs.push(`src="${escapeHtml(src)}"`);
        return;
      }
      if (name === 'disabled' || name === 'checked') {
        const boolValue = Boolean(interpolate(value, data, scope, true));
        if (boolValue) attrs.push(name);
        return;
      }
      if (sourceTag === 'textarea' && name === 'value') {
        textareaValue = interpolate(value, data, scope);
        return;
      }
      if (name === 'maxlength' && String(value) === '-1') return;
      if (name.startsWith('data-')) {
        attrs.push(`${name}="${escapeHtml(interpolate(value, data, scope))}"`);
        return;
      }
      const rendered = interpolate(value, data, scope);
      attrs.push(`${name}="${escapeHtml(rendered)}"`);
    });

    if (catchClick) attrs.push('data-catch-click="true"');

    if (sourceTag === 'picker') {
      attrs.push('class="wx-picker"');
      attrs.push(`data-picker-range="${escapeHtml(encodeURIComponent(JSON.stringify(pickerRange || [])))}"`);
      attrs.push(`data-picker-value="${pickerValue}"`);
      attrs.push(`data-picker-range-key="${escapeHtml(pickerRangeKey || '')}"`);
    }

    if (sourceTag === 'switch') {
      const checked = node.hasAttribute('checked') && Boolean(interpolate(node.getAttribute('checked'), data, scope, true));
      const event = node.getAttribute('bindchange') || '';
      return `<label class="wx-switch"><input type="checkbox" ${checked ? 'checked' : ''} data-event-change="${escapeHtml(event)}"><span class="wx-switch-track"><span class="wx-switch-thumb"></span></span></label>`;
    }

    if (sourceTag === 'slider') {
      const min = interpolate(node.getAttribute('min') || '0', data, scope);
      const max = interpolate(node.getAttribute('max') || '100', data, scope);
      const step = interpolate(node.getAttribute('step') || '1', data, scope);
      const value = interpolate(node.getAttribute('value') || '0', data, scope);
      const event = node.getAttribute('bindchange') || '';
      return `<input class="wx-slider" type="range" min="${escapeHtml(min)}" max="${escapeHtml(max)}" step="${escapeHtml(step)}" value="${escapeHtml(value)}" data-event-change="${escapeHtml(event)}">`;
    }

    if (sourceTag === 'image') return `<img ${attrs.join(' ')}>`;
    if (sourceTag === 'input') return `<input ${attrs.join(' ')}>`;
    if (sourceTag === 'textarea') return `<textarea ${attrs.join(' ')}>${escapeHtml(textareaValue)}</textarea>`;

    const inner = renderChildren(node, data, scope);
    return `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`;
  }

  function renderCurrentPage(animate) {
    if (!currentEntry) return;
    const route = currentEntry.route;
    const projectPage = window.__PROJECT__.pages[route];
    try {
      const holder = document.createElement('template');
      holder.innerHTML = normalizeTemplate(projectPage.template);
      const html = renderChildren(holder.content, currentEntry.instance.data, {});
      const root = pageRoot();
      // 搜索框输入时页面数据会更新。旧实现用 innerHTML 重建整页，会把正在输入的
      // input/textarea 从 DOM 中删除，Android 输入法因此每输入或删除一个字就关闭。
      // 这里保留当前获得焦点的真实控件节点，只替换页面其余内容。
      const activeControl = document.activeElement && root.contains(document.activeElement) &&
        document.activeElement.matches('input[data-event-input], textarea[data-event-input]')
        ? document.activeElement : null;
      const activeControls = activeControl
        ? Array.from(root.querySelectorAll('input[data-event-input], textarea[data-event-input]'))
        : [];
      const activeControlIndex = activeControl ? activeControls.indexOf(activeControl) : -1;
      const selectionStart = activeControl && Number.isFinite(activeControl.selectionStart)
        ? activeControl.selectionStart : null;
      const selectionEnd = activeControl && Number.isFinite(activeControl.selectionEnd)
        ? activeControl.selectionEnd : null;

      // setData 会重建整页 DOM。对筛选胶囊等显式标记的滚动区，
      // 在重建前记录位置，重建后恢复，避免筛选和题卡跳回开头。
      const preservedScroll = {};
      root.querySelectorAll('[data-preserve-scroll]').forEach(element => {
        const key = element.dataset.preserveScroll;
        if (!key) return;
        preservedScroll[key] = { left: element.scrollLeft || 0, top: element.scrollTop || 0 };
      });

      const nextRoot = document.createElement('div');
      nextRoot.innerHTML = html;
      if (activeControl && activeControlIndex >= 0) {
        const replacements = Array.from(nextRoot.querySelectorAll('input[data-event-input], textarea[data-event-input]'));
        const replacement = replacements[activeControlIndex];
        if (replacement) {
          // 数据层可能由“清除”按钮修改了值；同步新值但保留原控件、焦点和输入法会话。
          if (activeControl.value !== replacement.value) activeControl.value = replacement.value;
          activeControl.className = replacement.className;
          ['placeholder', 'maxlength', 'inputmode', 'type'].forEach(name => {
            if (replacement.hasAttribute(name)) activeControl.setAttribute(name, replacement.getAttribute(name));
            else activeControl.removeAttribute(name);
          });
          replacement.replaceWith(activeControl);
        }
      }
      root.dataset.page = route;
      if (typeof root.replaceChildren === 'function') root.replaceChildren(...Array.from(nextRoot.childNodes));
      else {
        while (root.firstChild) root.removeChild(root.firstChild);
        while (nextRoot.firstChild) root.appendChild(nextRoot.firstChild);
      }
      $('page-style').textContent = projectPage.style || '';
      Object.keys(preservedScroll).forEach(key => {
        const element = root.querySelector(`[data-preserve-scroll="${key}"]`);
        if (!element) return;
        element.scrollLeft = preservedScroll[key].left;
        element.scrollTop = preservedScroll[key].top;
      });
      if (activeControl && root.contains(activeControl)) {
        try {
          activeControl.focus({ preventScroll: true });
          if (selectionStart !== null && selectionEnd !== null) {
            const length = String(activeControl.value || '').length;
            activeControl.setSelectionRange(Math.min(selectionStart, length), Math.min(selectionEnd, length));
          }
        } catch (_) {}
      }
      bindRenderedEvents(root, currentEntry.instance);
      // 练习页会依据真实 DOM 高度分配题干、选项和答案区域。这里必须在当前
      // 渲染任务内同步完成，避免浏览器先绘制自然高度、随后再改高度造成点击时闪跳。
      if (currentEntry.instance && typeof currentEntry.instance.onAfterRender === 'function') {
        try { currentEntry.instance.onAfterRender(); }
        catch (error) { console.error('页面布局更新失败', error); }
      }
      if (animate) {
        root.classList.remove('page-enter');
        void root.offsetWidth;
        root.classList.add('page-enter');
      }
    } catch (error) {
      console.error(error);
      showFatalError(error);
    }
  }

  function buildEvent(element, nativeEvent, type) {
    let value = element.value;
    if (element.type === 'checkbox') value = element.checked;
    if (element.type === 'range') value = Number(element.value);
    return {
      type,
      target: { dataset: Object.assign({}, element.dataset) },
      currentTarget: { dataset: Object.assign({}, element.dataset) },
      detail: { value, checked: Boolean(element.checked) },
      touches: nativeEvent && nativeEvent.touches ? nativeEvent.touches : [],
      changedTouches: nativeEvent && nativeEvent.changedTouches ? nativeEvent.changedTouches : [],
      nativeEvent
    };
  }

  function invokePageMethod(instance, methodName, event) {
    if (!methodName || !instance || typeof instance[methodName] !== 'function') return;
    try {
      instance[methodName].call(instance, event);
    } catch (error) {
      console.error(`事件 ${methodName} 执行失败`, error);
      wx.showModal({ title: '操作失败', content: error.message || String(error), showCancel: false });
    }
  }

  function bindRenderedEvents(root, instance) {
    root.querySelectorAll('[data-picker-range]').forEach(element => {
      element.addEventListener('click', nativeEvent => {
        nativeEvent.stopPropagation();
        const range = JSON.parse(decodeURIComponent(element.dataset.pickerRange || '%5B%5D'));
        const selected = Number(element.dataset.pickerValue) || 0;
        const rangeKey = element.dataset.pickerRangeKey || '';
        showPicker(range, selected, rangeKey).then(index => {
          if (index == null) return;
          invokePageMethod(instance, element.dataset.eventChange, {
            currentTarget: { dataset: Object.assign({}, element.dataset) },
            target: { dataset: Object.assign({}, element.dataset) },
            detail: { value: String(index) }
          });
        });
      });
    });
    root.querySelectorAll('[data-event-click]').forEach(element => {
      element.addEventListener('click', nativeEvent => {
        if (element.dataset.catchClick === 'true') nativeEvent.stopPropagation();
        invokePageMethod(instance, element.dataset.eventClick, buildEvent(element, nativeEvent, 'tap'));
      });
    });
    root.querySelectorAll('[data-event-input]').forEach(element => {
      if (element.dataset.runtimeInputBound === '1') return;
      element.dataset.runtimeInputBound = '1';
      element.addEventListener('input', nativeEvent => invokePageMethod(instance, element.dataset.eventInput, buildEvent(element, nativeEvent, 'input')));
    });
    root.querySelectorAll('[data-event-change]').forEach(element => {
      if (element.closest('.wx-picker')) return;
      element.addEventListener('change', nativeEvent => invokePageMethod(instance, element.dataset.eventChange, buildEvent(element, nativeEvent, 'change')));
    });
    root.querySelectorAll('[data-event-confirm]').forEach(element => {
      if (element.dataset.runtimeConfirmBound === '1') return;
      element.dataset.runtimeConfirmBound = '1';
      element.addEventListener('keydown', nativeEvent => {
        if (nativeEvent.key === 'Enter') invokePageMethod(instance, element.dataset.eventConfirm, buildEvent(element, nativeEvent, 'confirm'));
      });
    });

    root.querySelectorAll('[data-event-touchstart]').forEach(element => {
      element.addEventListener('touchstart', nativeEvent => {
        invokePageMethod(instance, element.dataset.eventTouchstart, buildEvent(element, nativeEvent, 'touchstart'));
      }, { passive: true });
    });
    root.querySelectorAll('[data-event-touchend]').forEach(element => {
      element.addEventListener('touchend', nativeEvent => {
        invokePageMethod(instance, element.dataset.eventTouchend, buildEvent(element, nativeEvent, 'touchend'));
      }, { passive: true });
    });
    root.querySelectorAll('[data-event-touchcancel]').forEach(element => {
      element.addEventListener('touchcancel', nativeEvent => {
        invokePageMethod(instance, element.dataset.eventTouchcancel, buildEvent(element, nativeEvent, 'touchcancel'));
      }, { passive: true });
    });

  }

  function showFatalError(error) {
    pageRoot().innerHTML = `<div class="error-screen"><h2>页面运行失败</h2><p>${escapeHtml(error && (error.stack || error.message) || String(error))}</p></div>`;
  }

  function showToast(options) {
    const title = typeof options === 'string' ? options : (options && options.title) || '';
    const duration = Number(options && options.duration) || 1800;
    const layer = $('toast-layer');
    clearTimeout(toastTimer);
    layer.innerHTML = `<div class="toast">${escapeHtml(title)}</div>`;
    toastTimer = setTimeout(() => { layer.innerHTML = ''; }, duration);
  }

  function showModal(options = {}) {
    const layer = $('modal-layer');
    layer.classList.remove('hidden');
    const showCancel = options.showCancel !== false;
    const editable = Boolean(options.editable);
    layer.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${escapeHtml(options.title || '提示')}</div>
        ${editable ? '' : `<div class="modal-content">${escapeHtml(options.content || '')}</div>`}
        ${editable ? `<input class="modal-input" value="${escapeHtml(options.content || '')}" placeholder="${escapeHtml(options.placeholderText || '')}">` : ''}
        <div class="modal-actions ${showCancel ? '' : 'one'}">
          ${showCancel ? `<button class="modal-btn cancel">${escapeHtml(options.cancelText || '取消')}</button>` : ''}
          <button class="modal-btn confirm">${escapeHtml(options.confirmText || '确定')}</button>
        </div>
      </div>`;
    const finish = result => {
      activeOverlayDismiss = null;
      layer.classList.add('hidden');
      layer.innerHTML = '';
      if (typeof options.success === 'function') options.success(result);
      if (typeof options.complete === 'function') options.complete(result);
    };
    activeOverlayDismiss = () => finish({ confirm: false, cancel: true, content: '' });
    const confirm = layer.querySelector('.confirm');
    const cancel = layer.querySelector('.cancel');
    const input = layer.querySelector('.modal-input');
    confirm.addEventListener('click', () => finish({ confirm: true, cancel: false, content: input ? input.value : '' }));
    if (cancel) cancel.addEventListener('click', () => finish({ confirm: false, cancel: true, content: input ? input.value : '' }));
    if (input) setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 80);
  }

  function showPicker(range, selectedIndex, rangeKey = '') {
    return new Promise(resolve => {
      const layer = $('modal-layer');
      layer.classList.remove('hidden');
      const displayText = item => {
        if (item == null) return '';
        if (rangeKey && typeof item === 'object' && item[rangeKey] != null) return String(item[rangeKey]);
        if (typeof item === 'object') return String(item.label != null ? item.label : JSON.stringify(item));
        return String(item);
      };
      layer.innerHTML = `
        <div class="modal-card picker-modal-card">
          <div class="picker-modal-header">
            <div class="modal-title">请选择</div>
            <button class="picker-modal-close" type="button" aria-label="关闭选择框">×</button>
          </div>
          <div class="picker-list">
            ${range.map((item, index) => `<button class="picker-item ${index === selectedIndex ? 'active' : ''}" data-index="${index}"><span class="picker-item-label">${escapeHtml(displayText(item))}</span><span class="picker-item-check" aria-hidden="true">✓</span></button>`).join('')}
          </div>
        </div>`;
      const finish = value => {
        activeOverlayDismiss = null;
        layer.classList.add('hidden');
        layer.innerHTML = '';
        resolve(value);
      };
      activeOverlayDismiss = () => finish(null);
      layer.querySelectorAll('.picker-item').forEach(button => button.addEventListener('click', () => finish(Number(button.dataset.index))));
      layer.querySelector('.picker-modal-close').addEventListener('click', () => finish(null));
      layer.addEventListener('click', event => { if (event.target === layer) finish(null); }, { once: true });
    });
  }

  const browserFiles = new Map();
  const browserDirs = new Set(['/browser-data']);
  function browserParent(path) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
  function ensureBrowserDir(path) {
    if (!path || browserDirs.has(path)) return;
    ensureBrowserDir(browserParent(path));
    browserDirs.add(path);
  }
  const browserBridge = {
    getUserDataPath: () => '/browser-data',
    storageGet: key => localStorage.getItem(key) || '',
    getStatusBarHeight: () => 0,
    isSystemDarkMode: () => Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
    setSystemBars: () => {},
    setImmersive: () => {},
    storageSet: (key, value) => localStorage.setItem(key, value),
    storageRemove: key => localStorage.removeItem(key),
    chooseFile: () => setTimeout(() => window.__onNativeFileError && window.__onNativeFileError('浏览器预览不支持文件选择'), 0),
    exists: path => browserDirs.has(path) || browserFiles.has(path),
    mkdir: path => ensureBrowserDir(path),
    readText: path => { if (!browserFiles.has(path)) throw new Error('文件不存在'); return browserFiles.get(path).text; },
    writeText: (path, text) => { ensureBrowserDir(browserParent(path)); browserFiles.set(path, { text: String(text), size: new Blob([String(text)]).size }); },
    readBase64: path => browserFiles.get(path)?.base64 || '',
    writeBase64: (path, base64) => { ensureBrowserDir(browserParent(path)); browserFiles.set(path, { base64, text: '', size: Math.ceil(base64.length * .75) }); },
    copyFile: (source, target) => { const value = browserFiles.get(source); if (!value) throw new Error('文件不存在'); ensureBrowserDir(browserParent(target)); browserFiles.set(target, Object.assign({}, value)); },
    stat: path => JSON.stringify({ directory: browserDirs.has(path), size: browserFiles.get(path)?.size || 0 }),
    readdir: path => {
      const prefix = path.replace(/\/$/, '') + '/';
      const names = new Set();
      [...browserDirs, ...browserFiles.keys()].forEach(value => { if (value.startsWith(prefix)) { const rest = value.slice(prefix.length); if (rest && !rest.includes('/')) names.add(rest); } });
      return JSON.stringify([...names]);
    },
    unlink: path => browserFiles.delete(path),
    rmdir: path => browserDirs.delete(path),
    unzip: () => { throw new Error('浏览器预览不支持 DOCX 解压'); },
    directorySize: path => {
      const prefix = path.replace(/\/$/, '') + '/';
      let total = 0; browserFiles.forEach((value, key) => { if (key === path || key.startsWith(prefix)) total += value.size || 0; }); return total;
    },
    shareFile: () => showToast({ title: '浏览器预览不支持分享' }),
    toast: message => showToast({ title: message })
  };

  function bridge() {
    return window.AndroidBridge || browserBridge;
  }


  const validAppearanceModes = new Set(['system', 'light', 'dark']);
  const validMonetThemes = new Set(['ocean', 'violet', 'mint', 'rose', 'amber']);
  let systemThemeListenerInstalled = false;

  function readThemeSettings() {
    try {
      const raw = bridge().storageGet('qb_settings_v1');
      const settings = raw ? JSON.parse(raw) : {};
      const legacyAmoled = settings.appearanceMode === 'amoled';
      return {
        appearanceMode: legacyAmoled ? 'dark' : (validAppearanceModes.has(settings.appearanceMode) ? settings.appearanceMode : 'system'),
        amoledBlack: legacyAmoled || Boolean(settings.amoledBlack),
        monetTheme: validMonetThemes.has(settings.monetTheme) ? settings.monetTheme : 'ocean'
      };
    } catch (_) {
      return { appearanceMode: 'system', amoledBlack: false, monetTheme: 'ocean' };
    }
  }

  function resolvedAppearance(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    try {
      const nativeBridge = window.AndroidBridge;
      if (nativeBridge && typeof nativeBridge.isSystemDarkMode === 'function') {
        return nativeBridge.isSystemDarkMode() ? 'dark' : 'light';
      }
    } catch (_) {}
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyAppTheme() {
    const settings = readThemeSettings();
    const baseAppearance = resolvedAppearance(settings.appearanceMode);
    const appearance = baseAppearance === 'dark' && settings.amoledBlack ? 'amoled' : baseAppearance;
    const root = document.documentElement;
    root.dataset.appearanceMode = settings.appearanceMode;
    root.dataset.baseAppearance = baseAppearance;
    root.dataset.appearance = appearance;
    root.dataset.amoledBlack = settings.amoledBlack ? 'true' : 'false';
    root.dataset.monetTheme = settings.monetTheme;
    const themeColor = appearance === 'amoled' ? '#000000' : (appearance === 'dark' ? '#1c1b1f' : '#fffbfe');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColor);
    try {
      const nativeBridge = bridge();
      if (nativeBridge && typeof nativeBridge.setSystemBars === 'function') {
        nativeBridge.setSystemBars(fullscreenEnabled !== false, appearance !== 'light');
      } else if (nativeBridge && typeof nativeBridge.setImmersive === 'function') {
        nativeBridge.setImmersive(fullscreenEnabled !== false);
      }
    } catch (_) {}
    return { ...settings, baseAppearance, appearance };
  }
  window.__applyAppTheme = applyAppTheme;

  function installSystemThemeListener() {
    if (systemThemeListenerInstalled || !window.matchMedia) return;
    systemThemeListenerInstalled = true;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      const settings = readThemeSettings();
      if (settings.appearanceMode === 'system') applyAppTheme();
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', listener);
    else if (typeof media.addListener === 'function') media.addListener(listener);
  }

  window.__onNativeSystemThemeChanged = () => {
    const settings = readThemeSettings();
    if (settings.appearanceMode === 'system') applyAppTheme();
  };

  function jsError(message) {
    const error = new Error(message || '文件操作失败');
    error.errMsg = message || '文件操作失败';
    return error;
  }

  const fsManager = {
    accessSync(path) { if (!bridge().exists(path)) throw jsError('文件不存在'); },
    mkdirSync(path) { bridge().mkdir(path); },
    readFileSync(path, encoding) {
      if (encoding === 'base64') return bridge().readBase64(path);
      return bridge().readText(path);
    },
    writeFileSync(path, data, encoding) {
      if (encoding === 'base64') bridge().writeBase64(path, data);
      else bridge().writeText(path, String(data));
    },
    copyFileSync(source, target) { bridge().copyFile(source, target); },
    statSync(path) {
      const value = JSON.parse(bridge().stat(path));
      return { size: value.size || 0, isDirectory: () => Boolean(value.directory), isFile: () => !value.directory };
    },
    readdirSync(path) { return JSON.parse(bridge().readdir(path)); },
    unlinkSync(path) { bridge().unlink(path); },
    rmdirSync(path) { bridge().rmdir(path); },
    unzip(options) {
      try {
        bridge().unzip(options.zipFilePath, options.targetPath);
        setTimeout(() => options.success && options.success({}), 0);
      } catch (error) {
        setTimeout(() => options.fail && options.fail(error), 0);
      }
    }
  };

  window.__onNativeFileChosen = file => {
    if (!pendingFileRequest) return;
    const request = pendingFileRequest;
    pendingFileRequest = null;
    request.success && request.success({ tempFiles: [file] });
    request.complete && request.complete({ tempFiles: [file] });
  };

  window.__onNativeFileError = message => {
    if (!pendingFileRequest) return;
    const request = pendingFileRequest;
    pendingFileRequest = null;
    const error = jsError(message || 'cancel');
    request.fail && request.fail(error);
    request.complete && request.complete(error);
  };

  window.wx = {
    env: { USER_DATA_PATH: bridge().getUserDataPath() },
    getFileSystemManager: () => fsManager,
    getStorageSync(key) {
      const raw = bridge().storageGet(String(key));
      if (!raw) return '';
      try { return JSON.parse(raw); } catch (_) { return raw; }
    },
    setStorageSync(key, value) { bridge().storageSet(String(key), JSON.stringify(value)); },
    removeStorageSync(key) { bridge().storageRemove(String(key)); },
    chooseMessageFile(options = {}) {
      if (pendingFileRequest) {
        options.fail && options.fail(jsError('已有文件选择任务'));
        return;
      }
      pendingFileRequest = options;
      try { bridge().storageSet('__picker_supported_extensions_v1', JSON.stringify(options.extension || [])); } catch (_) {}
      bridge().chooseFile();
    },
    navigateTo({ url }) { enterPage(url, 'push'); },
    redirectTo({ url }) { enterPage(url, 'replace'); },
    reLaunch({ url }) { enterPage(url, 'relaunch'); },
    navigateBack({ delta = 1 } = {}) { navigateBack(delta); },
    showModal,
    showToast,
    showLoading({ title = '处理中' } = {}) { $('loading-text').textContent = title; $('loading-layer').classList.remove('hidden'); },
    hideLoading() { $('loading-layer').classList.add('hidden'); },
    setNavigationBarTitle({ title }) {
      if (currentEntry) currentEntry.title = title;
      updateAppBar(title);
    },
    shareFileMessage({ filePath, success, fail, complete }) {
      try {
        bridge().shareFile(filePath);
        success && success({});
        complete && complete({});
      } catch (error) {
        fail && fail(error);
        complete && complete(error);
      }
    },
  };


  function installImageViewer() {
    if (document.getElementById('image-viewer-layer')) return;
    const layer = document.createElement('div');
    layer.id = 'image-viewer-layer';
    layer.className = 'hidden';
    layer.innerHTML = '<button class="image-viewer-close" aria-label="关闭">×</button><div class="image-viewer-stage"><img alt="题目图片大图" draggable="false" /></div><div class="image-viewer-tools"><button data-action="minus">−</button><span>双指或按钮缩放</span><button data-action="plus">＋</button></div>';
    document.body.appendChild(layer);
    const image = layer.querySelector('img');
    const stage = layer.querySelector('.image-viewer-stage');
    let scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0, startX = 0, startY = 0;
    let pinchDistance = 0, pinchScale = 1;
    const pointers = new Map();

    const isOpen = () => !layer.classList.contains('hidden');
    const bounds = () => {
      const stageWidth = Math.max(1, stage.clientWidth || window.innerWidth || 1);
      const stageHeight = Math.max(1, stage.clientHeight || window.innerHeight || 1);
      const baseWidth = Math.max(1, image.offsetWidth || image.naturalWidth || 1);
      const baseHeight = Math.max(1, image.offsetHeight || image.naturalHeight || 1);
      const renderedWidth = baseWidth * scale;
      const renderedHeight = baseHeight * scale;
      return {
        maxX: Math.max(0, (renderedWidth - stageWidth) / 2),
        maxY: Math.max(0, (renderedHeight - stageHeight) / 2)
      };
    };
    const clampPosition = () => {
      const { maxX, maxY } = bounds();
      tx = maxX ? Math.max(-maxX, Math.min(maxX, tx)) : 0;
      ty = maxY ? Math.max(-maxY, Math.min(maxY, ty)) : 0;
    };
    const apply = (animate = false) => {
      clampPosition();
      image.classList.toggle('image-viewer-settling', Boolean(animate));
      image.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${scale})`;
      if (animate) setTimeout(() => image.classList.remove('image-viewer-settling'), 190);
    };
    const setScale = nextScale => {
      scale = Math.max(1, Math.min(5, Number(nextScale) || 1));
      apply(true);
    };
    const reset = () => {
      scale = 1; tx = 0; ty = 0; dragging = false; pinchDistance = 0; pointers.clear();
      apply(false);
    };
    const close = () => {
      if (!isOpen()) return false;
      layer.classList.add('hidden');
      image.removeAttribute('src');
      reset();
      return true;
    };
    activeImageViewerDismiss = close;
    const pointerDistance = () => {
      const values = Array.from(pointers.values());
      if (values.length < 2) return 0;
      return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
    };
    layer.querySelector('.image-viewer-close').addEventListener('click', close);
    layer.addEventListener('click', event => { if (event.target === layer || event.target === stage) close(); });
    layer.querySelector('[data-action="plus"]').addEventListener('click', event => { event.stopPropagation(); setScale(scale + .5); });
    layer.querySelector('[data-action="minus"]').addEventListener('click', event => { event.stopPropagation(); setScale(scale - .5); });
    stage.addEventListener('dblclick', event => { event.preventDefault(); scale === 1 ? setScale(2) : reset(); });
    stage.addEventListener('pointerdown', event => {
      if (!image.src) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { stage.setPointerCapture(event.pointerId); } catch (_) {}
      if (pointers.size === 1) {
        dragging = true; sx = event.clientX; sy = event.clientY; startX = tx; startY = ty;
      } else if (pointers.size === 2) {
        dragging = false; pinchDistance = pointerDistance(); pinchScale = scale;
      }
    });
    stage.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        const distance = pointerDistance();
        if (pinchDistance > 0 && distance > 0) scale = Math.max(1, Math.min(5, pinchScale * distance / pinchDistance));
        apply(false);
        return;
      }
      if (!dragging || scale <= 1) return;
      tx = startX + event.clientX - sx;
      ty = startY + event.clientY - sy;
      apply(false);
    });
    const releasePointer = event => {
      pointers.delete(event.pointerId);
      if (pointers.size === 1) {
        const remaining = Array.from(pointers.values())[0];
        dragging = true; sx = remaining.x; sy = remaining.y; startX = tx; startY = ty; pinchDistance = 0;
      } else if (!pointers.size) {
        dragging = false; pinchDistance = 0; apply(true);
      }
    };
    stage.addEventListener('pointerup', releasePointer);
    stage.addEventListener('pointercancel', releasePointer);
    stage.addEventListener('wheel', event => {
      event.preventDefault();
      setScale(scale + (event.deltaY < 0 ? .25 : -.25));
    }, { passive: false });
    image.addEventListener('load', () => requestAnimationFrame(reset));
    window.addEventListener('resize', () => { if (isOpen()) apply(true); }, { passive: true });
    document.getElementById('page-root').addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement) || !target.src) return;
      event.preventDefault();
      event.stopPropagation();
      image.src = target.src;
      layer.classList.remove('hidden');
      reset();
    });
  }

  window.__bootMiniApp = () => {
    try {
      applyAppTheme();
      installSystemThemeListener();
      installImageViewer();
      $('app-style').textContent = window.__PROJECT__.appStyle || '';
      window.__require('app.js');
      appInstance = Object.assign({}, appDefinition || {});
      appInstance.globalData = deepClone((appDefinition && appDefinition.globalData) || {});
      if (typeof appInstance.onLaunch === 'function') appInstance.onLaunch();
      $('back-button').addEventListener('click', () => window.__androidBack());
      const statisticsButton = $('global-statistics-button');
      const settingsButton = $('global-settings-button');
      if (statisticsButton) statisticsButton.addEventListener('click', () => openGlobalPage('pages/statistics/statistics'));
      if (settingsButton) settingsButton.addEventListener('click', () => openGlobalPage('pages/settings/settings'));
      enterPage(window.__PROJECT__.appConfig.pages[0], 'relaunch');
    } catch (error) {
      console.error(error);
      showFatalError(error);
    }
  };
})();

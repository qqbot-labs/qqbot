/* 主题初始化：在 <head> 中同步执行，先于样式表写入 data-theme，刷新时不闪烁。
   存储键 qqagent-theme（light/dark）；无存储值时跟随系统 prefers-color-scheme。
   禁用 JavaScript 时由 style.css 的 prefers-color-scheme 媒体查询兜底。 */
(function () {
  'use strict';
  var KEY = 'qqagent-theme';
  var root = document.documentElement;
  var media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function stored() {
    try {
      var value = window.localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : null;
    } catch (error) {
      return null;
    }
  }

  function system() {
    return media && media.matches ? 'dark' : 'light';
  }

  function syncButton(theme) {
    var button = document.getElementById('theme-toggle');
    if (!button) return;
    var dark = theme === 'dark';
    button.setAttribute('aria-pressed', dark ? 'true' : 'false');
    button.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    var label = button.querySelector('[data-theme-label]');
    if (label) label.textContent = dark ? '深色' : '浅色';
    var icon = button.querySelector('[data-theme-icon]');
    if (icon) icon.textContent = dark ? '☾' : '☀';
  }

  function syncMeta(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#10161d' : '#f3f5f7');
  }

  function paint(theme, persist) {
    var next = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    if (persist) {
      try {
        window.localStorage.setItem(KEY, next);
      } catch (error) {
        /* 存储不可用时仅当前页面生效，不阻断切换。 */
      }
    }
    syncButton(next);
    syncMeta(next);
    return next;
  }

  // 尽早写入，保证 CSS 首次绘制就使用正确主题；同时标记脚本已运行，展示切换按钮。
  root.setAttribute('data-js', 'on');
  paint(stored() || system(), false);

  function onReady() {
    paint(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('#theme-toggle') : null;
    if (!button) return;
    event.preventDefault();
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    paint(next, true);
  });

  // 未手动选择时继续跟随系统；已有存储值时以用户选择为准。
  if (media) {
    var followSystem = function () {
      if (!stored()) paint(system(), false);
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', followSystem);
    else if (typeof media.addListener === 'function') media.addListener(followSystem);
  }

  // 多标签页之间同步用户选择。
  window.addEventListener('storage', function (event) {
    if (event.key === KEY && (event.newValue === 'light' || event.newValue === 'dark')) {
      paint(event.newValue, false);
    }
  });
})();

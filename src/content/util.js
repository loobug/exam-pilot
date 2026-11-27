/* 通用小工具：全部挂在内容脚本隔离世界的局部命名空间上，不污染页面 window */
var qxUtil = (function () {
  'use strict';

  const CJK = /[\u4e00-\u9fa5]/;

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\r]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ ]{2,}/g, ' ')
      .trim();
  }

  function oneLine(s) {
    return norm(s).replace(/\n+/g, ' ');
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  }

  function ownText(el, skipSelectors) {
    // 只取自身文本，剔除子节点（选项、按钮、脚本）里的内容
    const skip = skipSelectors || 'script,style,noscript,button,button *,svg,img[role=presentation]';
    const clone = el.cloneNode(true);
    clone.querySelectorAll(skip).forEach(n => n.remove());
    return norm(clone.textContent || '');
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function deepQueryAll(selector) {
    const out = [];
    const walk = root => {
      let nodes;
      try { nodes = root.querySelectorAll(selector); } catch (e) { return; }
      nodes.forEach(n => { if (!out.includes(n)) out.push(n); });
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(document);
    return out;
  }

  function closestAcross(el, predicate) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (predicate(node)) return node;
      if (node.parentElement) { node = node.parentElement; continue; }
      const root = node.getRootNode && node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return null;
  }

  function textLength(el) {
    return norm(el.innerText || el.textContent || '').length;
  }

  function letter(i) {
    return String.fromCharCode(65 + i);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  return { norm, oneLine, visible, ownText, hash, deepQueryAll, closestAcross, textLength, letter, sleep, CJK };
})();

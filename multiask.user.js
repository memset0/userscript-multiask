// ==UserScript==
// @name         Multi Ask: ChatGPT & Gemini
// @namespace    https://example.com/multi-ask
// @version      0.1.0
// @description  在任意页面输入问题，同时自动发送到 ChatGPT 和 Gemini
// @author       you
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_PREFIX = 'multiAsk:';
  const QUERY_KEY = 'multiAskKey';

  // 生成一个简易 ID，用作存储 key
  function generateId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  // 读取 URL query 参数
  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  // 兼容 GM_getValue / GM.getValue
  function gmGetValue(key, defaultValue = null) {
    if (typeof GM_getValue === 'function') {
      try {
        const value = GM_getValue(key, defaultValue);
        return Promise.resolve(value);
      } catch (e) {
        console.error('[MultiAsk] GM_getValue error', e);
        return Promise.resolve(defaultValue);
      }
    } else if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
      return GM.getValue(key, defaultValue);
    }
    return Promise.resolve(defaultValue);
  }

  // 兼容 GM_setValue / GM.setValue
  function gmSetValue(key, value) {
    if (typeof GM_setValue === 'function') {
      try {
        GM_setValue(key, value);
        return Promise.resolve();
      } catch (e) {
        console.error('[MultiAsk] GM_setValue error', e);
        return Promise.resolve();
      }
    } else if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
      return GM.setValue(key, value);
    }
    return Promise.resolve();
  }

  // 兼容 GM_deleteValue / GM.deleteValue
  function gmDeleteValue(key) {
    if (typeof GM_deleteValue === 'function') {
      try {
        GM_deleteValue(key);
        return Promise.resolve();
      } catch (e) {
        console.error('[MultiAsk] GM_deleteValue error', e);
        return Promise.resolve();
      }
    } else if (typeof GM !== 'undefined' && typeof GM.deleteValue === 'function') {
      return GM.deleteValue(key);
    }
    return Promise.resolve();
  }

  // 等待某个元素出现（MutationObserver）
  function waitForElement(selectors, timeout = 15000) {
    if (!Array.isArray(selectors)) selectors = [selectors];
    return new Promise((resolve, reject) => {
      function find() {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        return null;
      }

      const found = find();
      if (found) {
        resolve(found);
        return;
      }

      const observer = new MutationObserver(() => {
        const el = find();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error('Timeout waiting for element: ' + selectors.join(', ')));
      }, timeout);
    });
  }

  // 尽量用“原生方式”设置 React / Vue 管控下的 input/textarea
  function setNativeValue(element, value) {
    const tag = element.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const valueDesc = Object.getOwnPropertyDescriptor(element, 'value');
      const valueSetter = valueDesc && valueDesc.set;
      const prototype = Object.getPrototypeOf(element);
      const prototypeDesc = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
      const prototypeValueSetter = prototypeDesc && prototypeDesc.set;

      if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
        prototypeValueSetter.call(element, value);
      } else if (valueSetter) {
        valueSetter.call(element, value);
      } else {
        element.value = value;
      }
    } else {
      // contenteditable
      element.innerText = value;
    }

    const event = new Event('input', { bubbles: true });
    element.dispatchEvent(event);
  }

  // 通用的“填入内容 + 点击发送”逻辑
  async function fillAndSend({ inputSelectors, buttonSelectors }, text) {
    try {
      const input = await waitForElement(inputSelectors, 20000).catch(() => null);
      if (!input) {
        console.warn('[MultiAsk] input element not found');
        return;
      }

      setNativeValue(input, text);
      input.focus();

      let button = null;

      if (input.form) {
        for (const sel of buttonSelectors) {
          button = input.form.querySelector(sel);
          if (button) break;
        }
      }

      if (!button) {
        for (const sel of buttonSelectors) {
          const found = document.querySelectorAll(sel);
          if (found && found.length) {
            button = found[found.length - 1];
            break;
          }
        }
      }

      if (button) {
        button.click();
      } else {
        // 没找到按钮就模拟回车发送
        const keydown = new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
        });
        input.dispatchEvent(keydown);
      }
    } catch (e) {
      console.error('[MultiAsk] fillAndSend error', e);
    }
  }

  // 消费一条消息（标记是 chatgpt 还是 gemini 用过；两边都用完自动删）
  async function consumeMessage(key, siteName) {
    const record = await gmGetValue(key, null);
    if (!record) return null;

    // 兼容：如果以前只是存了字符串
    if (typeof record === 'string') {
      return record;
    }

    const text = record.text || '';
    const usedBy = record.usedBy || {};
    usedBy[siteName] = true;

    const newRecord = {
      text,
      usedBy,
      createdAt: record.createdAt || Date.now(),
    };

    await gmSetValue(key, newRecord);

    if (usedBy.chatgpt && usedBy.gemini) {
      await gmDeleteValue(key);
    }

    return text;
  }

  // 在当前页面发起一次“同时问 ChatGPT & Gemini”
  function openAskWindows(text) {
    const id = STORAGE_PREFIX + generateId();

    const record = {
      text,
      usedBy: {},     // { chatgpt: true/false, gemini: true/false }
      createdAt: Date.now(),
    };

    // 这里不强制 await，以尽量减少弹窗被浏览器拦截的概率
    gmSetValue(id, record);

    const chatgptUrl = 'https://chatgpt.com/?' + QUERY_KEY + '=' + encodeURIComponent(id);
    const geminiUrl = 'https://gemini.google.com/app?' + QUERY_KEY + '=' + encodeURIComponent(id);

    window.open(chatgptUrl, '_blank');
    window.open(geminiUrl, '_blank');
  }

  // 弹出输入框的对话框
  function createDialog() {
    if (document.getElementById('multi-ask-dialog')) return;

    const overlay = document.createElement('div');
    overlay.id = 'multi-ask-dialog';
    overlay.style.cssText = [
      'position: fixed',
      'inset: 0',
      'z-index: 999999',
      'background: rgba(0,0,0,0.35)',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    ].join(';');

    overlay.innerHTML = `
      <div style="
        background: #fff;
        color: #111;
        padding: 16px 18px 12px;
        border-radius: 10px;
        box-shadow: 0 12px 30px rgba(0,0,0,0.15);
        width: min(520px, 90vw);
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        gap: 10px;
      ">
        <div style="font-size: 15px; font-weight: 600; display:flex; justify-content: space-between; align-items:center;">
          <span>发送到 ChatGPT & Gemini</span>
          <button type="button" id="multi-ask-close" style="
            border: none;
            background: transparent;
            font-size: 18px;
            cursor: pointer;
            line-height: 1;
          ">&times;</button>
        </div>
        <textarea id="multi-ask-textarea" rows="5" placeholder="在这里输入你的问题..."
          style="
            width: 100%;
            resize: vertical;
            box-sizing: border-box;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid #ddd;
            outline: none;
            font-size: 14px;
            line-height: 1.5;
          "
        ></textarea>
        <div style="display:flex; justify-content: space-between; align-items:center; margin-top: 4px;">
          <div style="font-size: 12px; color:#888;">提示：快捷键 Ctrl+Enter / Cmd+Enter 发送</div>
          <div style="display:flex; gap: 8px;">
            <button type="button" id="multi-ask-cancel" style="
              padding: 4px 10px;
              border-radius: 6px;
              border: 1px solid #ddd;
              background: #f5f5f5;
              cursor: pointer;
              font-size: 13px;
            ">取消</button>
            <button type="button" id="multi-ask-send" style="
              padding: 4px 12px;
              border-radius: 6px;
              border: none;
              background: #10a37f;
              color: #fff;
              cursor: pointer;
              font-size: 13px;
              font-weight: 600;
            ">发送</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const textarea = overlay.querySelector('#multi-ask-textarea');
    const sendBtn = overlay.querySelector('#multi-ask-send');
    const cancelBtn = overlay.querySelector('#multi-ask-cancel');
    const closeBtn = overlay.querySelector('#multi-ask-close');

    function close() {
      overlay.remove();
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        close();
      }
    });

    cancelBtn.addEventListener('click', close);
    closeBtn.addEventListener('click', close);

    sendBtn.addEventListener('click', () => {
      const text = textarea.value.trim();
      if (!text) {
        alert('请先输入要发送的问题');
        return;
      }
      openAskWindows(text);
      close();
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendBtn.click();
      }
    });

    textarea.focus();
  }

  // 右下角悬浮按钮
  function createFloatingButton() {
    if (window.top !== window.self) return; // 避免在 iframe 里插
    if (document.getElementById('multi-ask-fab')) return;

    const btn = document.createElement('button');
    btn.id = 'multi-ask-fab';
    btn.textContent = '问\nGPT+Gemini';
    btn.style.cssText = [
      'position: fixed',
      'right: 16px',
      'bottom: 16px',
      'z-index: 999998',
      'padding: 8px 10px',
      'border-radius: 999px',
      'border: none',
      'background: #10a37f',
      'color: #fff',
      'font-size: 12px',
      'line-height: 1.2',
      'cursor: pointer',
      'box-shadow: 0 6px 16px rgba(0,0,0,0.18)',
      'white-space: pre-line',
      'font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    ].join(';');

    btn.addEventListener('click', () => {
      createDialog();
    });

    document.body.appendChild(btn);

    // 也加一个菜单项，方便从扩展图标点击
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('问 ChatGPT + Gemini', () => {
        createDialog();
      });
    }
  }

  // ChatGPT 页面：自动取出消息并发送
  async function handleChatGPTPage() {
    const key = getQueryParam(QUERY_KEY);
    if (!key) return;

    const text = await consumeMessage(key, 'chatgpt');
    if (!text) return;

    await fillAndSend(
      {
        inputSelectors: [
          'textarea[data-id="root"]',
          'form textarea',
          'textarea',
          'div[contenteditable="true"][data-id="root"]',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
        ],
        buttonSelectors: [
          'button[data-testid="send-button"]',
          'button[aria-label="Send message"]',
          'button[aria-label="Send"]',
          'button[aria-label="发送"]',
          'button[type="submit"]',
        ],
      },
      text,
    );
  }

  // Gemini 页面：自动取出消息并发送
  async function handleGeminiPage() {
    const key = getQueryParam(QUERY_KEY);
    if (!key) return;

    const text = await consumeMessage(key, 'gemini');
    if (!text) return;

    await fillAndSend(
      {
        inputSelectors: [
          'textarea[aria-label]',
          'form textarea',
          'textarea',
          'div[contenteditable="true"][aria-label]',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]',
        ],
        buttonSelectors: [
          'button[aria-label="Send message"]',
          'button[aria-label="Send"]',
          'button[aria-label="发送"]',
          'button[type="submit"]',
        ],
      },
      text,
    );
  }

  function main() {
    createFloatingButton();

    const host = window.location.hostname;

    if (/chatgpt\.com$/.test(host) || /chat\.openai\.com$/.test(host)) {
      handleChatGPTPage();
    } else if (/gemini\.google\.com$/.test(host)) {
      handleGeminiPage();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();

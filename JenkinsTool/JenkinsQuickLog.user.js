// ==UserScript==
// @name         Jenkins 快速日志
// @namespace    local.jenkins.tools
// @version      1.3.0
// @description  虚拟滚动查看 Jenkins 日志，范围内位置跳转、搜索、错误上下文和增量跟踪
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
    'use strict';
    if (!document.head?.hasAttribute('data-rooturl') ||
        !document.head?.hasAttribute('data-resurl') || document.body?.id !== 'jenkins') return;

    const PAGE = 300;
    const LINE_HEIGHT = 20;
    const TAIL = 192 * 1024;
    const LIMIT = 128 * 1024 * 1024;
    const ERROR = /\b(error|exception|failed|fatal)\b|失败|异常/i;
    let closeCurrent = () => {};

    function buildUrl(value) {
        const url = new URL(value, location.href);
        if (url.origin !== location.origin) return null;
        const match = url.pathname.match(/^(.*\/job\/[^/]+\/\d+)(?:\/|$)/);
        return match ? `${url.origin}${match[1]}/` : null;
    }

    function button(text, action, parent) {
        const item = document.createElement('button');
        item.type = 'button';
        item.textContent = text;
        item.addEventListener('click', action);
        parent.append(item);
        return item;
    }

    function openLog(base) {
        closeCurrent();
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;inset:12px;z-index:2147483647';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>
            :host{font:14px system-ui;color:#dbe5ef}*{box-sizing:border-box}
            .panel{height:100%;display:flex;flex-direction:column;background:#17212b;border:1px solid #718096;border-radius:8px;padding:12px;gap:10px}
            .bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}button,input,a{font:inherit}
            button,a{background:#2e4255;color:#fff;border:1px solid #667c90;border-radius:4px;padding:6px 10px;cursor:pointer;text-decoration:none}
            button:disabled{opacity:.5;cursor:wait}input[type=search]{flex:1;min-width:180px;padding:7px}
            .status{color:#acc6db;white-space:pre-wrap}.rows{overflow:auto;flex:1;min-height:0;background:#101820;padding:8px}
            .line{white-space:pre;height:20px;font:13px/20px Consolas,monospace}.error{color:#ffaaa5}
            .rows{overflow-anchor:none}.position{flex:1;min-width:180px}
            .hit{background:#493f1d}.selected{background:#665322;outline:1px solid #d4b95c}.result{cursor:pointer}
            .number{color:#8296aa;user-select:none;margin-right:14px}.title{flex:1;overflow-wrap:anywhere}
        </style><section class="panel"><div class="bar titlebar"><strong class="title"></strong></div>
        <div class="bar actions"></div><div class="bar filters"><input type="search" placeholder="搜索已加载日志（普通文本）"><label><input type="checkbox">仅错误及前后 3 行</label></div>
        <div class="bar"><label>已加载范围内位置</label><input class="position" type="range" min="0" max="100" value="100" step="0.1" aria-label="已加载范围内位置"><span class="percent">100%</span></div>
        <div class="status"></div><div class="rows"></div><div class="bar pages"></div></section>`;
        document.body.append(host);
        root.querySelector('.title').textContent = `快速日志 v1.3.0 · ${decodeURI(new URL(base).pathname)}`;
        const actions = root.querySelector('.actions');
        const status = root.querySelector('.status');
        const rows = root.querySelector('.rows');
        const search = root.querySelector('input[type=search]');
        const errors = root.querySelector('input[type=checkbox]');
        const position = root.querySelector('.position');
        const percent = root.querySelector('.percent');
        let text = '', cursor = 0, partial = true, more = false, busy = false, closed = false;
        let indices = [], lines = [], timer, debounce, controller, note = '';
        let follow = false, resize;
        let matches = [], matchSet = new Set(), selected = -1, contextMode = false, appliedQuery = '';

        const close = () => {
            closed = true;
            clearTimeout(timer);
            clearTimeout(debounce);
            controller?.abort();
            resize?.disconnect();
            host.remove();
        };
        closeCurrent = close;
        button('关闭', close, root.querySelector('.titlebar'));

        // Probe only consumes headers. Servers/proxies may still generate or buffer the body.
        // X-Text-Size is a raw Jenkins cursor; never derive it from decoded string length.
        async function request(start, probe = false) {
            controller = new AbortController();
            let timeout = setTimeout(() => controller.abort(), 30000);
            try {
                const response = await fetch(`${base}logText/progressiveText?start=${start}`, {
                    credentials: 'same-origin', redirect: 'error', cache: 'no-store',
                    headers: { Accept: 'text/plain' }, signal: controller.signal
                });
                const rawCursor = response.headers.get('X-Text-Size');
                if (!response.ok || !/^text\/plain\b/i.test(response.headers.get('Content-Type') || '') ||
                    !/^\d+$/.test(rawCursor || '') || !Number.isSafeInteger(Number(rawCursor))) {
                    await response.body?.cancel();
                    throw new Error(`日志接口不可用（HTTP ${response.status}）。请检查登录状态或使用原始日志。`);
                }
                const result = { cursor: Number(rawCursor), more: response.headers.get('X-More-Data') === 'true', text: '' };
                if (probe) { await response.body?.cancel(); return result; }
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let size = 0;
                let lastProgress = 0;
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    clearTimeout(timeout);
                    timeout = setTimeout(() => controller.abort(), 30000);
                    size += chunk.value.byteLength;
                    if (size > LIMIT) {
                        await reader.cancel();
                        throw new Error('单次日志超过 128 MiB，未替换当前内容。请下载后用本地查看器打开。');
                    }
                    result.text += decoder.decode(chunk.value, { stream: true });
                    if (Date.now() - lastProgress > 200) {
                        note = `正在下载：${(size / 1048576).toFixed(1)} MiB（完成后建立全文索引）`;
                        render();
                        lastProgress = Date.now();
                    }
                }
                result.text += decoder.decode();
                return result;
            } finally { clearTimeout(timeout); }
        }

        function render() {
            const top = rows.scrollTop || 0;
            const visible = Math.min(300, Math.ceil((rows.clientHeight || 600) / LINE_HEIGHT) + 20);
            const first = Math.max(0, Math.min(Math.floor(top / LINE_HEIGHT) - 10, indices.length - visible));
            const end = Math.min(indices.length, first + visible);
            const fragment = document.createDocumentFragment();
            const before = document.createElement('div');
            before.style.height = `${first * LINE_HEIGHT}px`;
            fragment.append(before);
            for (const index of indices.slice(first, end)) {
                const row = document.createElement('div');
                row.className = `line${ERROR.test(lines[index]) ? ' error' : ''}`;
                if (matchSet.has(index)) row.className += ' hit';
                if (index === matches[selected]) row.className += ' selected';
                if (!contextMode && matchSet.has(index)) {
                    row.className += ' result';
                    row.title = '点击跳转到原始日志上下文';
                    row.addEventListener('click', () => showMatch(matches.indexOf(index)));
                }
                const number = document.createElement('span');
                number.className = 'number';
                number.textContent = `${partial ? '~' : ''}${index + 1}`;
                // Jenkins output is untrusted text, never HTML.
                row.append(number, document.createTextNode(lines[index] || ' '));
                fragment.append(row);
            }
            const after = document.createElement('div');
            after.style.height = `${(indices.length - end) * LINE_HEIGHT}px`;
            fragment.append(after);
            const left = rows.scrollLeft;
            rows.replaceChildren(fragment);
            rows.scrollTop = top;
            rows.scrollLeft = left;
            const max = Math.max(0, indices.length * LINE_HEIGHT - (rows.clientHeight || 600));
            position.value = max ? String(Math.min(100, top / max * 100)) : '0';
            percent.textContent = `${Number(position.value).toFixed(1)}%`;
            label.textContent = `${indices.length ? first + 1 : 0}–${end} / ${indices.length} 行匹配 · 连续滚动`;
            matchLabel.textContent = search.value ? `${selected < 0 ? 0 : selected + 1} / ${matches.length} 处匹配 · ${contextMode ? '原文上下文' : '点击结果看上下文'}` : '';
            status.textContent = `${partial ? '范围：末尾片段（~ 为片段内行号）' : '范围：从开头加载'} · ${more ? '构建仍在输出' : '日志已结束'} · 搜索仅覆盖已加载内容${busy ? ' · 正在读取…' : ''}${note ? '\n' + note : ''}`;
        }

        function filter(last = false) {
            lines = text.replace(/\r\n/g, '\n').split('\n');
            if (lines.at(-1) === '') lines.pop();
            const query = search.value.toLocaleLowerCase();
            appliedQuery = search.value;
            const context = new Set();
            if (errors.checked) lines.forEach((line, i) => {
                if (ERROR.test(line)) for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) context.add(j);
            });
            indices = [];
            matches = [];
            lines.forEach((line, i) => {
                if (query && line.toLocaleLowerCase().includes(query)) matches.push(i);
                if (contextMode || ((!errors.checked || context.has(i)) && (!query || line.toLocaleLowerCase().includes(query)))) indices.push(i);
            });
            matchSet = new Set(matches);
            selected = Math.min(selected, matches.length - 1);
            render();
            rows.scrollTop = last ? Math.max(0, indices.length * LINE_HEIGHT - (rows.clientHeight || 600)) : 0;
            render();
        }

        function showMatch(ordinal) {
            if (!matches.length) return;
            selected = (ordinal + matches.length) % matches.length;
            contextMode = true;
            // Context always uses original line indices, regardless of error filtering.
            indices = lines.map((_, i) => i);
            follow = false;
            clearTimeout(timer);
            followButton.textContent = '跟踪新增';
            render();
            jump(Math.max(0, matches[selected] - 8) * LINE_HEIGHT);
            rows.scrollLeft = 0;
        }

        function navigateMatch(direction) {
            clearTimeout(debounce);
            if (appliedQuery !== search.value) { selected = -1; filter(); }
            showMatch(direction < 0 && selected < 0 ? matches.length - 1 : selected + direction);
        }

        async function load(mode) {
            if (busy || closed) return;
            busy = true;
            note = '';
            clearTimeout(timer);
            render();
            try {
                let start = cursor;
                if (mode === 'tail') {
                    const probe = await request(0, true);
                    start = Math.max(0, probe.cursor - TAIL);
                } else if (mode === 'full') start = 0;
                const result = await request(start);
                if (closed) return;
                if (mode === 'append' && result.cursor < cursor) throw new Error('远端日志已重置，请重新读取末尾。');
                let incoming = result.text;
                if (mode === 'tail' && start > 0) {
                    // Offset can land inside a UTF-8 character or Jenkins annotation/line.
                    const newline = incoming.indexOf('\n');
                    incoming = newline < 0 ? '' : incoming.slice(newline + 1);
                }
                if (mode === 'append' && text.length + incoming.length > LIMIT) {
                    throw new Error('累计内容达到内存上限，已暂停跟踪并保留现有日志。');
                }
                if (mode === 'append') text += incoming;
                else { text = incoming; partial = start > 0; }
                note = `已加载 ${(new TextEncoder().encode(text).byteLength / 1048576).toFixed(1)} MiB`;
                cursor = result.cursor;
                more = result.more;
                filter(mode !== 'full');
                if (!more) follow = false;
            } catch (error) {
                if (closed) return;
                note = error.name === 'AbortError' ? '读取超时，请重试。' : error.message;
                follow = false;
            } finally {
                busy = false;
                if (!closed) {
                    followButton.textContent = follow ? '暂停跟踪' : '跟踪新增';
                    render();
                    if (follow && more) timer = setTimeout(() => load('append'), 3000);
                }
            }
        }

        button('读取末尾', () => load('tail'), actions);
        button('加载全文（≤128 MiB）', () => load('full'), actions);
        const followButton = button('跟踪新增', () => {
            follow = !follow;
            followButton.textContent = follow ? '暂停跟踪' : '跟踪新增';
            if (follow) load('append'); else clearTimeout(timer);
        }, actions);
        const original = document.createElement('a');
        original.textContent = '原始文本 / 另存为';
        original.href = `${base}consoleText`;
        original.target = '_blank';
        original.rel = 'noopener';
        actions.append(original);
        const pages = root.querySelector('.pages');
        const filters = root.querySelector('.filters');
        const matchLabel = document.createElement('span');
        filters.append(matchLabel);
        button('上一个匹配', () => navigateMatch(-1), filters);
        button('下一个匹配', () => navigateMatch(1), filters);
        button('返回搜索结果', () => { contextMode = false; filter(); }, filters);
        function jump(top) {
            rows.scrollTop = Math.max(0, Math.min(top, indices.length * LINE_HEIGHT - (rows.clientHeight || 600)));
            render();
        }
        button('开头', () => jump(0), pages);
        button('上移 300 行', () => jump(rows.scrollTop - PAGE * LINE_HEIGHT), pages);
        const label = document.createElement('span');
        pages.append(label);
        button('下移 300 行', () => jump(rows.scrollTop + PAGE * LINE_HEIGHT), pages);
        button('末尾', () => jump(indices.length * LINE_HEIGHT), pages);
        position.addEventListener('input', () => jump(Number(position.value) / 100 * Math.max(0, indices.length * LINE_HEIGHT - (rows.clientHeight || 600))));
        rows.addEventListener('scroll', render, { passive: true });
        resize = new ResizeObserver(render);
        resize.observe(rows);
        search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { contextMode = false; selected = -1; filter(); }, 200); });
        search.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            navigateMatch(event.shiftKey ? -1 : 1);
        });
        errors.addEventListener('change', () => { contextMode = false; filter(); });
        load('tail');
    }

    const current = buildUrl(location.href);
    if (current) {
        const entry = button('⚡ 快速日志', () => openLog(current), document.body);
        entry.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10000;padding:10px 16px;background:#234d70;color:white;border:1px solid #7ca5c7;border-radius:6px;cursor:pointer';
    }
    // Add an adjacent shortcut without changing native console links or existing scripts.
    function enhance() {
        document.querySelectorAll('a[href]').forEach(link => {
            if (link.dataset.jenkinsQuickLog || !/\/console(?:Full)?\/?(?:[?#].*)?$/.test(link.getAttribute('href'))) return;
            const base = buildUrl(link.href);
            if (!base) return;
            link.dataset.jenkinsQuickLog = '1';
            const quick = document.createElement('a');
            quick.href = base;
            quick.textContent = ' ⚡快速日志';
            quick.style.cssText = 'margin-left:8px;font-size:12px';
            quick.addEventListener('click', event => { event.preventDefault(); openLog(base); });
            link.after(quick);
        });
    }
    enhance();
    let refresh;
    new MutationObserver(() => {
        clearTimeout(refresh);
        refresh = setTimeout(enhance, 300);
    }).observe(document.body, { childList: true, subtree: true });
})();

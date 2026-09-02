// ==UserScript==
// @name         Jenkins 通用精确构建耗时
// @namespace    local.jenkins.tools
// @version      2.0.0
// @description  在任意 Jenkins 的构建详情和时间趋势页面显示秒级构建耗时
// @match        *://*/job/*
// @match        *://*/*/job/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const SCRIPT_PREFIX = '[Jenkins Exact Duration]';
    const EXACT_CLASS = 'jenkins-tools-exact-duration';

    /*
     * Jenkins 页面识别。
     *
     * Jenkins 官方页面会在 head 上设置：
     *   data-rooturl
     *   data-resurl
     *
     * body 通常为：
     *   <body id="jenkins" ...>
     */
    const isJenkins =
        document.head?.hasAttribute('data-rooturl') &&
        document.head?.hasAttribute('data-resurl') &&
        document.body?.id === 'jenkins';

    if (!isJenkins) {
        return;
    }

    const normalizedPath = location.pathname.replace(/\/+$/, '');

    const isBuildTimeTrend =
        normalizedPath.endsWith('/buildTimeTrend');

    const isBuildDetail =
        /\/\d+$/.test(normalizedPath);

    if (!isBuildTimeTrend && !isBuildDetail) {
        return;
    }

    installStyles();

    if (isBuildTimeTrend) {
        enhanceBuildTimeTrend().catch(reportError);
    } else {
        enhanceBuildDetail().catch(reportError);
    }

    /*
     * 公共方法
     */

    function reportError(error) {
        console.warn(SCRIPT_PREFIX, error);
    }

    async function fetchJson(url) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                Accept: 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(
                `读取 Jenkins API 失败：HTTP ${response.status}，${url}`
            );
        }

        return response.json();
    }

    function installStyles() {
        if (document.getElementById('jenkins-tools-exact-duration-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'jenkins-tools-exact-duration-style';

        style.textContent = `
            .${EXACT_CLASS} {
                color: var(--text-color-secondary, #666);
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
            }

            .${EXACT_CLASS}--detail {
                display: inline-block;
                margin-left: 0.6em;
            }

            .${EXACT_CLASS}--trend {
                display: inline;
                margin-left: 0.4em;
                font-size: 0.92em;
            }
        `;

        document.head.appendChild(style);
    }

    function formatClock(milliseconds) {
        const safeMs = Math.max(0, Number(milliseconds) || 0);
        const totalSeconds = Math.floor(safeMs / 1000);

        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return [
                hours,
                String(minutes).padStart(2, '0'),
                String(seconds).padStart(2, '0')
            ].join(':');
        }

        return [
            minutes,
            String(seconds).padStart(2, '0')
        ].join(':');
    }

    function getCurrentDuration(state) {
        if (!state?.building) {
            return Math.max(0, Number(state?.duration) || 0);
        }

        const fetchedAt = Number(state.fetchedAt) || Date.now();
        const apiDuration = Number(state.duration) || 0;

        /*
         * Jenkins API 对运行中的构建通常会返回当前 duration。
         * 使用 API duration 作为基准，再加上本地经过时间。
         */
        if (apiDuration > 0) {
            return Math.max(
                0,
                apiDuration + Date.now() - fetchedAt
            );
        }

        /*
         * 某些 Jenkins 版本运行中 duration 返回 0，
         * 这时使用 timestamp 兜底。
         */
        const timestamp = Number(state.timestamp) || Date.now();

        return Math.max(0, Date.now() - timestamp);
    }

    function formatExactText(state, prefix = '') {
        const duration = getCurrentDuration(state);
        const clock = formatClock(duration);

        if (state.building) {
            const seconds = Math.floor(duration / 1000);

            return `${prefix}${clock} / ${seconds} 秒，构建中`;
        }

        const seconds = (duration / 1000).toFixed(3);

        return `${prefix}${clock} / ${seconds} 秒`;
    }

    function setTextIfChanged(element, text) {
        /*
         * 避免设置相同 textContent。
         * 这也是防止 MutationObserver 高频触发的重要措施。
         */
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }

    function waitForElement(selector, timeoutMs = 15000) {
        const existing = document.querySelector(selector);

        if (existing) {
            return Promise.resolve(existing);
        }

        return new Promise(resolve => {
            let completed = false;

            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);

                if (!element || completed) {
                    return;
                }

                completed = true;
                observer.disconnect();
                clearTimeout(timeout);
                resolve(element);
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });

            const timeout = setTimeout(() => {
                if (completed) {
                    return;
                }

                completed = true;
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
        });
    }

    /*
     * 单次构建详情页
     */

    async function enhanceBuildDetail() {
        const buildUrl = new URL(location.href);

        buildUrl.search = '';
        buildUrl.hash = '';

        if (!buildUrl.pathname.endsWith('/')) {
            buildUrl.pathname += '/';
        }

        const apiUrl = new URL(
            `api/json?tree=${encodeURIComponent(
                'number,building,timestamp,duration'
            )}`,
            buildUrl
        );

        let state = null;
        let liveTimer = null;
        let syncTimer = null;
        let syncing = false;

        function findMountPoint() {
            const links = [...document.querySelectorAll('a[href]')];

            const trendLink = links.find(link => {
                try {
                    const url = new URL(link.href, location.href);

                    return /\/buildTimeTrend\/?$/.test(url.pathname);
                } catch {
                    return false;
                }
            });

            if (trendLink?.parentElement) {
                return trendLink.parentElement;
            }

            return (
                document.querySelector('.jenkins-build-details') ||
                document.querySelector('#main-panel') ||
                document.body
            );
        }

        function ensureDisplayElement() {
            let element = document.getElementById(
                'jenkins-tools-build-exact-duration'
            );

            if (element) {
                return element;
            }

            element = document.createElement('span');
            element.id = 'jenkins-tools-build-exact-duration';
            element.className =
                `${EXACT_CLASS} ${EXACT_CLASS}--detail`;
            element.title = '来自 Jenkins API 的精确构建耗时';

            findMountPoint().appendChild(element);

            return element;
        }

        function render() {
            if (!state) {
                return;
            }

            const element = ensureDisplayElement();
            const text = `精确耗时：${formatExactText(state)}`;

            setTextIfChanged(element, text);
        }

        function updateTimers() {
            if (state?.building) {
                if (!liveTimer) {
                    liveTimer = setInterval(render, 1000);
                }

                if (!syncTimer) {
                    syncTimer = setInterval(sync, 15000);
                }
            } else {
                if (liveTimer) {
                    clearInterval(liveTimer);
                    liveTimer = null;
                }

                if (syncTimer) {
                    clearInterval(syncTimer);
                    syncTimer = null;
                }
            }
        }

        async function sync() {
            if (syncing) {
                return;
            }

            syncing = true;

            try {
                const data = await fetchJson(apiUrl);

                state = {
                    ...data,
                    fetchedAt: Date.now()
                };

                render();
                updateTimers();
            } catch (error) {
                reportError(error);
            } finally {
                syncing = false;
            }
        }

        await sync();
    }

    /*
     * 构建时间趋势页
     */

    async function enhanceBuildTimeTrend() {
        const jobUrl = new URL(location.href);

        jobUrl.search = '';
        jobUrl.hash = '';

        jobUrl.pathname = jobUrl.pathname.replace(
            /buildTimeTrend\/?$/,
            ''
        );

        if (!jobUrl.pathname.endsWith('/')) {
            jobUrl.pathname += '/';
        }

        /*
         * 限制读取最近 100 条，避免构建历史非常多时返回过大数据。
         */
        const tree = encodeURIComponent(
            'builds[number,duration,building,timestamp]{0,100}'
        );

        const apiUrl = new URL(
            `api/json?tree=${tree}`,
            jobUrl
        );

        const buildStates = new Map();

        let tbody = null;
        let rowObserver = null;
        let liveTimer = null;
        let syncTimer = null;
        let renderScheduled = false;
        let syncing = false;

        function getDurationColumnIndex() {
            const headers = [
                ...document.querySelectorAll('#trend thead th')
            ];

            const index = headers.findIndex(header => {
                const text = header.textContent.trim();

                return /持续时间|Duration/i.test(text);
            });

            /*
             * 当前 Jenkins 默认趋势表：
             * 0 状态
             * 1 构建
             * 2 距今时间
             * 3 持续时间
             */
            return index >= 0 ? index : 3;
        }

        function getBuildNumber(row) {
            for (const link of row.querySelectorAll('a[href]')) {
                try {
                    const url = new URL(link.href, location.href);
                    const match = url.pathname.match(/\/(\d+)\/?$/);

                    if (match) {
                        return Number(match[1]);
                    }
                } catch {
                    // 忽略无效链接
                }
            }

            return null;
        }

        function renderRows() {
            renderScheduled = false;

            if (!tbody) {
                return;
            }

            const durationColumnIndex =
                getDurationColumnIndex();

            for (const row of tbody.rows) {
                const buildNumber = getBuildNumber(row);
                const state = buildStates.get(buildNumber);

                if (!state) {
                    continue;
                }

                const cell = row.cells[durationColumnIndex];

                if (!cell) {
                    continue;
                }

                let exact = cell.querySelector(
                    `.${EXACT_CLASS}--trend`
                );

                if (!exact) {
                    exact = document.createElement('span');
                    exact.className =
                        `${EXACT_CLASS} ${EXACT_CLASS}--trend`;
                    exact.title =
                        '来自 Jenkins API 的精确构建耗时';

                    cell.appendChild(exact);
                }

                const text = `（${formatExactText(state)}）`;

                setTextIfChanged(exact, text);
            }
        }

        function scheduleRender() {
            if (renderScheduled) {
                return;
            }

            renderScheduled = true;
            requestAnimationFrame(renderRows);
        }

        function updateLiveTimer() {
            const hasBuilding = [...buildStates.values()]
                .some(state => state.building);

            if (hasBuilding && !liveTimer) {
                liveTimer = setInterval(renderRows, 1000);
            } else if (!hasBuilding && liveTimer) {
                clearInterval(liveTimer);
                liveTimer = null;
            }
        }

        async function sync() {
            if (syncing) {
                return;
            }

            syncing = true;

            try {
                const data = await fetchJson(apiUrl);
                const fetchedAt = Date.now();

                buildStates.clear();

                for (const build of data.builds || []) {
                    buildStates.set(Number(build.number), {
                        ...build,
                        fetchedAt
                    });
                }

                scheduleRender();
                updateLiveTimer();
            } catch (error) {
                reportError(error);
            } finally {
                syncing = false;
            }
        }

        tbody = await waitForElement('#trend tbody');

        if (!tbody) {
            throw new Error(
                '等待 Jenkins 时间趋势表格超时，未找到 #trend tbody'
            );
        }

        /*
         * 只监听 tbody 的直接子元素。
         *
         * Jenkins 渐进式加载构建行时会向 tbody 添加 tr。
         * 脚本对单元格文字的修改不会再触发这个 Observer，
         * 因而不会形成之前的循环。
         */
        rowObserver = new MutationObserver(mutations => {
            const hasNewRow = mutations.some(mutation =>
                [...mutation.addedNodes].some(node => {
                    if (
                        node.nodeType !== Node.ELEMENT_NODE &&
                        node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
                    ) {
                        return false;
                    }

                    return (
                        node.matches?.('tr') ||
                        Boolean(node.querySelector?.('tr'))
                    );
                })
            );

            if (hasNewRow) {
                scheduleRender();
            }
        });

        rowObserver.observe(tbody, {
            childList: true
        });

        await sync();

        /*
         * 30 秒同步一次 API，处理构建完成、新构建出现等状态变化。
         * 无论表格多少行，都只有一个 API 请求。
         */
        syncTimer = setInterval(sync, 30000);

        window.addEventListener(
            'pagehide',
            () => {
                rowObserver?.disconnect();

                if (liveTimer) {
                    clearInterval(liveTimer);
                }

                if (syncTimer) {
                    clearInterval(syncTimer);
                }
            },
            { once: true }
        );
    }
})();
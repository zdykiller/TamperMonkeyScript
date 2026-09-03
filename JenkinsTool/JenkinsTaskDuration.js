// ==UserScript==
// @name         Jenkins 通用精确构建耗时
// @namespace    local.jenkins.tools
// @version      2.1.0
// @description  在任意 Jenkins 的构建详情、左侧构建历史和时间趋势页面显示秒级耗时
// @match        *://*/job/*
// @match        *://*/*/job/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
    'use strict';

    const LOG_PREFIX = '[Jenkins Exact Duration]';
    const EXACT_CLASS = 'jenkins-tools-exact-duration';

    /*
     * 识别 Jenkins 页面。
     */
    const isJenkins =
        document.head?.hasAttribute('data-rooturl') &&
        document.head?.hasAttribute('data-resurl') &&
        document.body?.id === 'jenkins';

    if (!isJenkins) {
        return;
    }

    const rootPath = document.head.dataset.rooturl || '';
    const instanceId = `${location.origin}${rootPath}`;

    /*
     * 左侧构建耗时开关按 Jenkins 实例分别保存。
     * 新 Jenkins 默认开启。
     */
    const sidebarStorageKey =
        `sidebar-duration-enabled:${instanceId}`;

    const sidebarEnabled =
        GM_getValue(sidebarStorageKey, true);

    GM_registerMenuCommand(
        sidebarEnabled
            ? '关闭当前 Jenkins 的左侧构建耗时'
            : '开启当前 Jenkins 的左侧构建耗时',
        () => {
            GM_setValue(
                sidebarStorageKey,
                !sidebarEnabled
            );

            location.reload();
        }
    );

    const normalizedPath =
        location.pathname.replace(/\/+$/, '');

    const isBuildTimeTrend =
        normalizedPath.endsWith('/buildTimeTrend');

    const isBuildDetail =
        /\/\d+$/.test(normalizedPath);

    installStyles();

    /*
     * 左侧构建历史和趋势页共用同一个 Job API Store，
     * 避免同一页面重复请求。
     */
    let buildStore = null;

    if (sidebarEnabled || isBuildTimeTrend) {
        buildStore = createJobBuildStore(
            getCurrentJobUrl()
        );
    }

    if (sidebarEnabled && buildStore) {
        enhanceBuildHistory(buildStore)
            .catch(reportError);
    }

    if (isBuildTimeTrend && buildStore) {
        enhanceBuildTimeTrend(buildStore)
            .catch(reportError);
    }

    if (isBuildDetail) {
        enhanceBuildDetail()
            .catch(reportError);
    }

    /*
     * 公共工具
     */

    function reportError(error) {
        console.warn(LOG_PREFIX, error);
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
                `Jenkins API 请求失败：HTTP ${response.status}，${url}`
            );
        }

        return response.json();
    }

    function installStyles() {
        const styleId =
            'jenkins-tools-exact-duration-style';

        if (document.getElementById(styleId)) {
            return;
        }

        const style = document.createElement('style');
        style.id = styleId;

        style.textContent = `
            .${EXACT_CLASS} {
                color: var(--text-color-secondary, #666);
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
            }

            .${EXACT_CLASS}--detail {
                display: inline-block;
                margin-left: 0.4em;
            }

            .${EXACT_CLASS}--trend {
                display: inline;
                margin-left: 0.4em;
                font-size: 0.92em;
            }

            .${EXACT_CLASS}--sidebar {
                display: inline-block;
                margin-left: 0.35em;
                font-size: 0.9em;
                font-weight: 500;
            }
        `;

        document.head.appendChild(style);
    }

    function formatClock(milliseconds) {
        const safeMs =
            Math.max(0, Number(milliseconds) || 0);

        const totalSeconds =
            Math.floor(safeMs / 1000);

        const hours =
            Math.floor(totalSeconds / 3600);

        const minutes =
            Math.floor((totalSeconds % 3600) / 60);

        const seconds =
            totalSeconds % 60;

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
            return Math.max(
                0,
                Number(state?.duration) || 0
            );
        }

        const fetchedAt =
            Number(state.fetchedAt) || Date.now();

        const apiDuration =
            Number(state.duration) || 0;

        /*
         * 以 Jenkins API 返回的当前 duration 为基准，
         * 再加上本地经过时间。
         */
        if (apiDuration > 0) {
            return Math.max(
                0,
                apiDuration + Date.now() - fetchedAt
            );
        }

        /*
         * 某些 Jenkins 版本运行中 duration 为 0，
         * 使用 timestamp 兜底。
         */
        const timestamp =
            Number(state.timestamp) || Date.now();

        return Math.max(
            0,
            Date.now() - timestamp
        );
    }

    function formatExactText(state) {
        const duration =
            getCurrentDuration(state);

        const clock =
            formatClock(duration);

        if (state.building) {
            return (
                `${clock} / ` +
                `${Math.floor(duration / 1000)} 秒，构建中`
            );
        }

        return (
            `${clock} / ` +
            `${(duration / 1000).toFixed(3)} 秒`
        );
    }

    function setTextIfChanged(element, text) {
        /*
         * 避免重复修改 DOM，防止 MutationObserver 循环。
         */
        if (element.textContent !== text) {
            element.textContent = text;
        }
    }

    function waitForElement(
        selector,
        timeoutMs = 15000
    ) {
        const existing =
            document.querySelector(selector);

        if (existing) {
            return Promise.resolve(existing);
        }

        return new Promise(resolve => {
            let finished = false;

            const observer =
                new MutationObserver(() => {
                    const element =
                        document.querySelector(selector);

                    if (!element || finished) {
                        return;
                    }

                    finished = true;
                    observer.disconnect();
                    clearTimeout(timeout);
                    resolve(element);
                });

            observer.observe(
                document.documentElement,
                {
                    childList: true,
                    subtree: true
                }
            );

            const timeout = setTimeout(() => {
                if (finished) {
                    return;
                }

                finished = true;
                observer.disconnect();
                resolve(null);
            }, timeoutMs);
        });
    }

    function ensureTrailingSlash(url) {
        const result = new URL(url);

        result.search = '';
        result.hash = '';

        if (!result.pathname.endsWith('/')) {
            result.pathname += '/';
        }

        return result;
    }

    /*
     * 从 buildHistoryPage 的 page-ajax 获取 Job 地址。
     *
     * 这比直接拼 location.pathname 更可靠，
     * 支持 View、Folder 和 Jenkins 子目录。
     */
    function getCurrentJobUrl() {
        const historyPage =
            document.querySelector(
                '#buildHistoryPage[page-ajax]'
            );

        const ajaxPath =
            historyPage?.getAttribute('page-ajax');

        if (ajaxPath) {
            const url =
                new URL(ajaxPath, location.href);

            url.pathname = url.pathname.replace(
                /buildHistory\/ajax\/?$/,
                ''
            );

            return ensureTrailingSlash(url);
        }

        const url = new URL(location.href);

        url.search = '';
        url.hash = '';

        if (isBuildTimeTrend) {
            url.pathname = url.pathname.replace(
                /buildTimeTrend\/?$/,
                ''
            );
        } else if (isBuildDetail) {
            url.pathname = url.pathname.replace(
                /\d+\/?$/,
                ''
            );
        }

        return ensureTrailingSlash(url);
    }

    function getBuildNumberFromUrl(href) {
        try {
            const url =
                new URL(href, location.href);

            const match =
                url.pathname.match(/\/(\d+)\/?$/);

            return match
                ? Number(match[1])
                : null;
        } catch {
            return null;
        }
    }

    /*
     * Job 构建数据 Store
     *
     * 左侧历史和趋势页共享：
     * - 一个 API 请求
     * - 一个 30 秒同步定时器
     * - 一个运行中构建刷新定时器
     */
    function createJobBuildStore(jobUrl) {
        const states = new Map();
        const subscribers = new Set();

        const tree = encodeURIComponent(
            'builds[number,duration,building,timestamp]{0,100}'
        );

        const apiUrl = new URL(
            `api/json?tree=${tree}`,
            ensureTrailingSlash(jobUrl)
        );

        let started = false;
        let syncing = false;
        let syncTimer = null;
        let liveTimer = null;

        function notify() {
            for (const subscriber of subscribers) {
                try {
                    subscriber(states);
                } catch (error) {
                    reportError(error);
                }
            }
        }

        function updateLiveTimer() {
            const hasRunningBuild =
                [...states.values()]
                    .some(state => state.building);

            if (hasRunningBuild && !liveTimer) {
                liveTimer = setInterval(
                    notify,
                    1000
                );
            } else if (
                !hasRunningBuild &&
                liveTimer
            ) {
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
                const data =
                    await fetchJson(apiUrl);

                const fetchedAt =
                    Date.now();

                states.clear();

                for (const build of data.builds || []) {
                    states.set(
                        Number(build.number),
                        {
                            ...build,
                            fetchedAt
                        }
                    );
                }

                notify();
                updateLiveTimer();
            } catch (error) {
                reportError(error);
            } finally {
                syncing = false;
            }
        }

        function start() {
            if (started) {
                return;
            }

            started = true;

            sync();

            syncTimer = setInterval(
                sync,
                30000
            );
        }

        function subscribe(callback) {
            subscribers.add(callback);
            callback(states);

            return () => {
                subscribers.delete(callback);
            };
        }

        function destroy() {
            if (syncTimer) {
                clearInterval(syncTimer);
            }

            if (liveTimer) {
                clearInterval(liveTimer);
            }

            subscribers.clear();
        }

        window.addEventListener(
            'pagehide',
            destroy,
            { once: true }
        );

        return {
            states,
            start,
            sync,
            subscribe
        };
    }

    /*
     * 左侧 Builds 构建历史
     */

    async function enhanceBuildHistory(store) {
        const container =
            await waitForElement(
                '#jenkins-build-history'
            );

        if (!container) {
            return;
        }

        let renderScheduled = false;

        function render(states) {
            renderScheduled = false;

            const items =
                container.querySelectorAll(
                    '.app-builds-container__item'
                );

            for (const item of items) {
                const buildLink =
                    item.querySelector(
                        'a.app-builds-container__item__inner__link[href]'
                    );

                if (!buildLink) {
                    continue;
                }

                const buildNumber =
                    getBuildNumberFromUrl(
                        buildLink.href
                    );

                const state =
                    states.get(buildNumber);

                if (!state) {
                    continue;
                }

                const timeContainer =
                    item.querySelector(
                        '.app-builds-container__item__time'
                    );

                if (!timeContainer) {
                    continue;
                }

                const timeHost =
                    timeContainer.querySelector('div') ||
                    timeContainer;

                let exact =
                    timeHost.querySelector(
                        `.${EXACT_CLASS}--sidebar`
                    );

                if (!exact) {
                    exact =
                        document.createElement('span');

                    exact.className =
                        `${EXACT_CLASS} ` +
                        `${EXACT_CLASS}--sidebar`;

                    timeHost.appendChild(exact);
                }

                const duration =
                    getCurrentDuration(state);

                const text = state.building
                    ? ` · 已运行 ${formatClock(duration)}`
                    : ` · 耗时 ${formatClock(duration)}`;

                setTextIfChanged(exact, text);

                exact.title = state.building
                    ? `当前已运行 ${Math.floor(duration / 1000)} 秒`
                    : (
                        `精确耗时 ${formatClock(duration)} / ` +
                        `${(duration / 1000).toFixed(3)} 秒`
                    );
            }
        }

        function scheduleRender() {
            if (renderScheduled) {
                return;
            }

            renderScheduled = true;

            requestAnimationFrame(() => {
                render(store.states);
            });
        }

        /*
         * 左侧历史由 Jenkins AJAX 填充。
         *
         * 只观察容器的直接子节点：
         * - 初始构建列表加载
         * - 点击上一页/下一页
         *
         * 脚本追加的耗时 span 不是直接子节点，
         * 不会反向触发 Observer。
         */
        const observer =
            new MutationObserver(scheduleRender);

        observer.observe(container, {
            childList: true
        });

        store.subscribe(scheduleRender);
        store.start();

        window.addEventListener(
            'pagehide',
            () => observer.disconnect(),
            { once: true }
        );
    }

    /*
     * 时间趋势页
     */

    async function enhanceBuildTimeTrend(store) {
        const tbody =
            await waitForElement('#trend tbody');

        if (!tbody) {
            throw new Error(
                '未找到时间趋势表格 #trend tbody'
            );
        }

        let renderScheduled = false;

        function getDurationColumnIndex() {
            const headers = [
                ...document.querySelectorAll(
                    '#trend thead th'
                )
            ];

            const index =
                headers.findIndex(header =>
                    /持续时间|Duration/i.test(
                        header.textContent.trim()
                    )
                );

            return index >= 0 ? index : 3;
        }

        function getRowBuildNumber(row) {
            for (
                const link of
                row.querySelectorAll('a[href]')
            ) {
                const number =
                    getBuildNumberFromUrl(
                        link.href
                    );

                if (number !== null) {
                    return number;
                }
            }

            return null;
        }

        function render(states) {
            renderScheduled = false;

            const durationColumnIndex =
                getDurationColumnIndex();

            for (const row of tbody.rows) {
                const buildNumber =
                    getRowBuildNumber(row);

                const state =
                    states.get(buildNumber);

                if (!state) {
                    continue;
                }

                const cell =
                    row.cells[durationColumnIndex];

                if (!cell) {
                    continue;
                }

                let exact =
                    cell.querySelector(
                        `.${EXACT_CLASS}--trend`
                    );

                if (!exact) {
                    exact =
                        document.createElement('span');

                    exact.className =
                        `${EXACT_CLASS} ` +
                        `${EXACT_CLASS}--trend`;

                    cell.appendChild(exact);
                }

                setTextIfChanged(
                    exact,
                    `（${formatExactText(state)}）`
                );

                exact.title =
                    '来自 Jenkins API 的精确构建耗时';
            }
        }

        function scheduleRender() {
            if (renderScheduled) {
                return;
            }

            renderScheduled = true;

            requestAnimationFrame(() => {
                render(store.states);
            });
        }

        /*
         * 只观察 tbody 的直接构建行，
         * 不观察脚本自己修改的单元格内容。
         */
        const observer =
            new MutationObserver(scheduleRender);

        observer.observe(tbody, {
            childList: true
        });

        store.subscribe(scheduleRender);
        store.start();

        window.addEventListener(
            'pagehide',
            () => observer.disconnect(),
            { once: true }
        );
    }

    /*
     * 单次构建详情页
     */

    async function enhanceBuildDetail() {
        const buildUrl =
            ensureTrailingSlash(location.href);

        const tree = encodeURIComponent(
            'number,building,timestamp,duration'
        );

        const apiUrl = new URL(
            `api/json?tree=${tree}`,
            buildUrl
        );

        let state = null;
        let syncing = false;
        let liveTimer = null;
        let syncTimer = null;

        function ensureDisplayElement() {
            let element =
                document.getElementById(
                    'jenkins-tools-build-exact-duration'
                );

            if (element) {
                return element;
            }

            element =
                document.createElement('span');

            element.id =
                'jenkins-tools-build-exact-duration';

            element.className =
                `${EXACT_CLASS} ` +
                `${EXACT_CLASS}--detail`;

            const trendLink = [
                ...document.querySelectorAll(
                    '#main-panel a[href]'
                )
            ].find(link => {
                try {
                    return /\/buildTimeTrend\/?$/.test(
                        new URL(
                            link.href,
                            location.href
                        ).pathname
                    );
                } catch {
                    return false;
                }
            });

            if (trendLink) {
                trendLink.insertAdjacentElement(
                    'afterend',
                    element
                );
            } else {
                (
                    document.querySelector(
                        '#main-panel'
                    ) ||
                    document.body
                ).appendChild(element);
            }

            return element;
        }

        function render() {
            if (!state) {
                return;
            }

            const element =
                ensureDisplayElement();

            setTextIfChanged(
                element,
                `（${formatExactText(state)}）`
            );

            element.title =
                '来自 Jenkins API 的精确构建耗时';
        }

        function updateTimers() {
            if (state?.building) {
                if (!liveTimer) {
                    liveTimer =
                        setInterval(
                            render,
                            1000
                        );
                }

                if (!syncTimer) {
                    syncTimer =
                        setInterval(
                            sync,
                            15000
                        );
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
                const data =
                    await fetchJson(apiUrl);

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

        window.addEventListener(
            'pagehide',
            () => {
                if (liveTimer) {
                    clearInterval(liveTimer);
                }

                if (syncTimer) {
                    clearInterval(syncTimer);
                }
            },
            { once: true }
        );

        await sync();
    }
})();
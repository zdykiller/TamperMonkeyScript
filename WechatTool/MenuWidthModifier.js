// ==UserScript==
// @name         修改下拉菜单宽度
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  修改网页上的特定下拉菜单宽度
// @author       zdykiller
// @match        https://bita.*.net/
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    // 配置数组，可以根据需要修改
    const configs = [
        {
            targetSelector: '.chart-tooltip-scroll', // 要修改的元素的 CSS 选择器
            style: {
                minWidth: 'auto',
                maxWidth: 'none',
                width: 'auto',
            },
        },
        {
            targetSelector: '.ta-check-item-pop', // 要修改的元素的 CSS 选择器
            style: {
                minWidth: 'auto',
                maxWidth: 'none',
                width: '1200px',
            },
        },
        {
            targetSelector: '.ta-check-item-pop .ta-check-item-lines .ta-check-item-line .ta-check-item-name', // 要修改的元素的 CSS 选择器
            style: {
                minWidth: 'auto',
                maxWidth: 'none',
                width: '1200px',
            },
        },
        {
            targetSelector: '.ant-input-affix-wrapper.tant-input.tant-input-noborder.ta-check-item-search', // 要修改的元素的 CSS 选择器
            style: {
                minWidth: 'auto',
                maxWidth: 'none',
                width: 'auto',
            },
        },
        {
            targetSelector: '.ant-dropdown.tant-dropdown.ta-check-item-dropdown.ant-dropdown-placement-bottomLeft',
            style: {
                minWidth: 'auto',
                maxWidth: 'none',
                width: 'auto',
            },
        },
    ];

    // 添加自定义样式
    const style = document.createElement('style');
    style.innerHTML = configs
        .map((config) => {
            const styleRules = Object.entries(config.style)
                .map(([property, value]) => `${property}: ${value} !important;`)
                .join(' ');
            return `
                ${config.targetSelector} {
                    ${styleRules}
                }
            `;
        })
        .join('\n');
    document.head.appendChild(style);

    // 创建一个观察器实例
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'childList') {
                configs.forEach((config) => {
                    const elements = document.querySelectorAll(config.targetSelector);
                    elements.forEach((element) => {
                        Object.entries(config.style).forEach(([property, value]) => {
                            element.style[property] = value;
                        });
                    });
                });
            }
        });
    });


    // 配置观察器选项
    const observerOptions = { childList: true, subtree: true };

    setTimeout(() => {
        // 开始观察目标节点
        observer.observe(document.body, observerOptions);
    }, 2000);
})();
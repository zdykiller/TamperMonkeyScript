// ==UserScript==
// @name         微信读书宽度修改器
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  修改微信读书页面的 max-width 为更大值
// @author       You
// @match        https://weread.qq.com/web/reader/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function() {
    'use strict';

    // 创建一个 style 元素来注入 CSS
    var style = document.createElement('style');
    style.type = 'text/css';

    let w_precent = GM_getValue("width_precent");
    if(!w_precent){
      w_precent = "100";
      GM_setValue(w_precent);
    }
    style.innerHTML = `
        /* 通用规则：所有屏幕都适配 */
        .readerContent .app_content {
            max-width: ${w_precent}% !important;
        }
        @media (max-width: 1365px) {
            .readerContent .app_content {
                max-width: ${w_precent}% !important;  /* 这里修改 max-width 的值，例如 1200px 或 100% */
            }
        }
    `;

    // 将 style 元素添加到 head 中
    document.head.appendChild(style);
})();
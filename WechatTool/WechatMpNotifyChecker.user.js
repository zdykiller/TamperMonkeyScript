// ==UserScript==
// @name         WechatMpNotifyChecker
// @namespace    http://tampermonkey.net/
// @version      2024-04-23
// @description  polling wechat mp page and notifiy new message
// @author       zdykiller
// @match        https://mp.weixin.qq.com/wxopen/wasysnotify?action=list&token=*&lang=zh_CN
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // 获取第一个notify_id
    function getFirstNotify() {
        let firstItem = document.querySelector('#notification .notice_item');
        return firstItem;
    }

    // 发送webhook通知
    function sendWebhookNotification(notifyId, title, content) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: '', // 将此替换为你的webhook URL
            headers: {
                'Content-Type': 'application/json'
            },
            data: JSON.stringify(
                {"msg_type":"text","content":{"text":`notify_id:${notifyId}\n${title}\n${content}`}}
            ),
            onload: function(response) {
                GM_setValue('lastSendSuccessId', notifyId);
                console.log('webhook通知发送成功:', response);
            },
            onerror: function(error) {
                GM_setValue('lastSendFailId', notifyId);
                console.error('webhook通知发送失败:', error);
            }
        });
    }

    // 检查notify_id是否发生变化
    function checkForUpdates() {
        debugger;
        let firstNotify = getFirstNotify();

        if(!firstNotify){
            console.log("not found notify");
            const sendFailedMsg = GM_getValue('sendFailedMsg');
            if(sendFailedMsg !== "send"){
                let unknownId = "unknownId"
                sendWebhookNotification(unknownId, "没找到mp页面中的通知", "请查看是否是账号登录过期");
                GM_setValue('sendFailedMsg', "send");
            }
            return;
        }

        const previousNotifyId = GM_getValue('previousNotifyId');
        const currentNotifyId = firstNotify.getAttribute("notify_id");
        if (currentNotifyId && currentNotifyId !== previousNotifyId) {
            console.log('检测到新的通知内容');
            // 在此处添加处理新通知内容的逻辑
            GM_setValue('previousNotifyId', currentNotifyId);
            let title = firstNotify.querySelector("[class='notice_title']").innerText;
            let notifyContent = firstNotify.querySelector("[class='dn']").innerText;
            sendWebhookNotification(currentNotifyId, title, notifyContent);
        }
    }

    // 页面加载完毕后检查更新并开始定时刷新
    window.addEventListener('load', function () {
        setTimeout(()=>{
            checkForUpdates();
        }, 10 * 1000);
        setInterval(function () {
            GM_setValue("lastReload", new Date().toLocaleString());
            location.reload();
        }, 1 * 60 * 1000);
    });
})();
// ==UserScript==
// @name         WechatMpNotifyChecker
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  定时检查微信mp后台新通知消息，并发送到webhook
// @author       zdykiller
// @match        https://mp.weixin.qq.com/wxopen/wasysnotify?action=list&token=*&lang=zh_CN
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // 获取第一个notify_id
    function getFirstNotify() {
        let firstItem = document.querySelector('#notification .notice_item');
        return firstItem;
    }

    // 发送webhook通知
    async function sendWebhookNotification(notifyId, title, content) {
        return new Promise((resolve, reject) => {
            // 将此替换为你的webhook URL
            let url = GM_getValue("notifyUrl");
            GM_xmlhttpRequest({
                method: "POST",
                url: url,
                headers: {
                    "Content-Type": "application/json"
                },
                data: JSON.stringify(
                    {"msg_type": "text", "content": {"text": `notify_id:${notifyId}\n${title}\n${content}`}}
                ),
                onload: function (response) {
                    GM_setValue("lastSendSuccessId", notifyId);
                    console.log('webhook通知发送成功:', response);
                    resolve(response);
                },
                onerror: function (error) {
                    GM_setValue("lastSendFailId", notifyId);
                    console.error('webhook通知发送失败:', error);
                    reject(error);
                }
            });
        });
    }

    // 检查notify_id是否发生变化
    function checkForUpdates() {
        let firstNotify = getFirstNotify();
        if (!firstNotify) {
            console.log("not found notify");
            const sendFailedMsg = GM_getValue("sendFailedMsg");
            if (sendFailedMsg !== "send") {
                let unknownId = "unknownId"
                sendWebhookNotification(unknownId, "没找到mp页面中的通知", "请查看是否是账号登录过期");
                GM_setValue('sendFailedMsg', "send");
            }
            return;
        }

        const previousNotifyId = GM_getValue("previousNotifyId");
        const currentNotifyId = firstNotify.getAttribute("notify_id");
        if (currentNotifyId && currentNotifyId !== previousNotifyId) {
            console.log("检测到新的通知内容");
            // 在此处添加处理新通知内容的逻辑
            GM_setValue("previousNotifyId", currentNotifyId);
            let title = firstNotify.querySelector("[class='notice_title']").innerText;
            let notifyContent = firstNotify.querySelector("[class='dn']").innerText;
            sendWebhookNotification(currentNotifyId, title, notifyContent);
        }
    }

    function testSend() {
        sendWebhookNotification("测试", "测试消息", "发送测试通知").then((resp) => {
            alert(`${resp.status} ${resp.responseText}，发送完成`)
        }).catch((err) => {
            alert(`${err.error}，请确保在存储中配置 notifyUrl={你想发送的webhook}`)
        })
    }

    GM_registerMenuCommand("测试发送通知", function (event) {
        testSend()
    });

    // 页面加载完毕后检查更新并开始定时刷新
    window.addEventListener("load", function () {
        setTimeout(() => {
            checkForUpdates();
        }, 10 * 1000);
        setInterval(function () {
            GM_setValue("lastReload", new Date().toLocaleString());
            location.reload();
        }, 1 * 60 * 1000);
    });
})();
// ==UserScript==
// @name         WeDataJsErrorStackParser
// @namespace    http://tampermonkey.net/
// @version      0.16
// @description  wedata网页上解析错误栈，按照符号表解析成可读形式
// @author       zdykiller
// @match        https://wedata.weixin.qq.com/mp2/js-error-*
// @match        https://mp.weixin.qq.com/wxamp/manage/feedback*
// @icon         https://res.wx.qq.com/wxawedata/mp2/assets/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    class SymbolConfig {
        static _instance = null;

        static unknownVersion = "unknownVersion";

        // symbol的url链接的存储key
        static configUrlKey = "configUrl";
        static configUrlDefaultValue = "http://127.0.0.1:8080/${version}/webgl.wasm.symbols.unityweb";

        static get configUrl() {
            return GM_getValue(SymbolConfig.configUrlKey, SymbolConfig.configUrlDefaultValue);
        }

        static set configUrl(value) {
            GM_setValue(SymbolConfig.configUrlKey, value);
        }

        // symbol的版本号字符串的存储key
        static configVersionKey = "defaultVersion";
        static configVersionDefaultValue = "1.5.45";

        static get configVersion() {
            return GM_getValue(SymbolConfig.configVersionKey, SymbolConfig.configVersionDefaultValue);
        }

        static set configVersion(value) {
            GM_setValue(SymbolConfig.configVersionKey, value);
        }

        static configOnlyShowFuncNameKey = "onlyShowFuncName";
        static configOnlyShowFuncNameDefaultValue = true;

        static get onlyShowFuncName() {
            return GM_getValue(SymbolConfig.configOnlyShowFuncNameKey, SymbolConfig.configOnlyShowFuncNameDefaultValue);
        }

        static set onlyShowFuncName(value) {
            GM_setValue(SymbolConfig.configOnlyShowFuncNameKey, value);
        }

        constructor() {
            // 保存已经请求过的版本的Rewriter对象
            this.rewriters = {};
        }

        /**
         * 获取单例对象
         * @returns {SymbolConfig}
         * @constructor
         */
        static GetInstance() {
            if (!SymbolConfig._instance) {
                SymbolConfig._instance = new SymbolConfig();
            }
            return SymbolConfig._instance;
        }

        /**
         * 根据版本号获取Rewriter对象
         * @param version 版本号
         * @returns {Promise<SymbolRewriter>} 返回Promise对象，resolve的参数是Rewriter对象
         */
        async getRewriter(version) {
            return new Promise((resolve, reject) => {
                if (this.rewriters[version]) {
                    resolve(this.rewriters[version]);
                } else {
                    if (version === SymbolConfig.unknownVersion) {
                        version = SymbolConfig.configVersion;
                    }
                    let urlStrTemplate = GM_getValue(SymbolConfig.configUrlKey, SymbolConfig.configUrlDefaultValue);
                    let requestUrl = urlStrTemplate.replace("${version}", version);
                    GM_xmlhttpRequest({
                        url: requestUrl,
                        method: "GET",
                        responseType: "text",
                        timeout: 5000,
                        onreadystatechange: (response) => {
                            if (response.readyState === 4) {
                                if (response.status === 200) {
                                    this.rewriters[version] = new SymbolRewriter(version, response.responseText);
                                    resolve(this.rewriters[version]);
                                } else {
                                    console.log("error", response);
                                    reject();
                                }
                            }
                        },
                        onerror(response) {
                            console.log("error", response);
                            reject();
                        },
                        onabort(response) {
                            console.log("abort", response);
                            reject();
                        }
                    });
                }
            });
        }
    }

    /**
     * 状态检查器，用于检查页面元素状态，进行解析
     */
    class StateChecker {
        // 记录处理过的元素不再处理
        static parsedStackSignal = "parsedStack";

        insertParseButton(element) {
            let customClassName = "_custom__parse__button";
            if (element.querySelector(customClassName)) {
                return;
            }
            const button = document.createElement('div');
            button.textContent = "解析";
            button.className = customClassName;
            button.onclick = (mouseEvent) => {
                this.parseDetail(element);
            }
            if (element.children[0]) {
                element.insertBefore(button, element.children[0]);
            }
        }

        async parseTextWithNode(targetTextNode) {
            let stackList = [];
            let maxLineLength = 0;
            for (let child of targetTextNode.children) {
                stackList.push(child.innerText);
                maxLineLength = Math.max(maxLineLength, child.innerText.length);
            }
            console.log(stackList);
            let stackVersionStr = SymbolConfig.unknownVersion;
            let rewriter = await SymbolConfig.GetInstance().getRewriter(stackVersionStr);

            let parsedStackList = [];
            if (SymbolConfig.onlyShowFuncName) {
                // 仅展示函数名，则用按行文本替换的方式
                for (let stackExceptionStr of stackList) {
                    let res = rewriter.parseStack(stackExceptionStr);
                    let parsedStackText = "";
                    if (res.matched) {
                        // 把set展开成array拼接成字符串
                        parsedStackText = [...res.funcNameSet].join(" ");
                    }
                    parsedStackList.push(parsedStackText);
                }
            } else {
                // 整个文本替换的方式
                let exceptionText = stackList.join("\n");
                let res = rewriter.parseStack(exceptionText);
                let parsedStackText = res.output;
                parsedStackList = parsedStackText.split("\n");
            }

            let brElement = document.createElement("div");
            brElement.innerText = `『${stackVersionStr}版本，以${rewriter.versionText}符号表解析』${targetTextNode.children[0].innerText}`;

            if (stackList.length === parsedStackList.length) {
                let index = 0;
                for (let child of targetTextNode.children) {
                    let originText = child.innerText.padEnd(maxLineLength, ".");
                    child.innerText = originText + " // " + parsedStackList[index];
                    index++;
                }
            }

            targetTextNode.insertBefore(brElement, targetTextNode.children[0]);
        }

        // 错误对战解析成可读形式
        async parseDetail(node) {
            // let targetEle = element.querySelector("detail__text detail__text--expanded");
            let targetEle = node.querySelector(".detail__content");
            if (!targetEle) {
                return;
            }
            if (targetEle.classList.contains(StateChecker.parsedStackSignal)) {
                return;
            }

            console.log(`开始转换 ${targetEle}`);
            let targetTextNode = node.querySelector(".detail__text");
            if (!targetTextNode.classList.contains("detail__text--expanded")) {
                return;
            }

            await this.parseTextWithNode(targetTextNode);
            targetEle.classList.add(StateChecker.parsedStackSignal);
        }


        // 监听节点变动
        replaceJsErrorListPage() {
            // 选择要观察变动的节点
            const targetNode = document.body;

            // 观察器的配置（需要观察什么变动）
            const config = {childList: false, subtree: true, attributes: true};

            // 当观察到变动时执行的回调函数
            const callback = (mutationsList, observer) => {
                // console.log('mutationsList', mutationsList);
                // 遍历所有变动
                for (const mutation of mutationsList) {
                    switch (mutation.type) {
                        case "childList":
                            break;
                        case "attributes":
                            this.parseDetail(mutation.target.parentNode);
                            break;
                    }
                }
            };

            // 创建一个观察器实例并传入回调函数
            const observer = new MutationObserver(callback);

            // 以上面的配置开始观察目标节点
            observer.observe(targetNode, config);
        }

        replaceJsErrorDetailWeb() {
            let targetTextNodeList = document.body.querySelectorAll(".js-error__code");
            if (targetTextNodeList.length > 0) {
                this.parseTextWithNode(targetTextNodeList[0]);
            }
        }
    }

    class ErrorStackTranslateWeb {
        // 创建一个新的页面的HTML内容
        html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>错误栈替换</title>
            </head>
            <body>
                <h1>错误栈替换</h1>
                <div id="input-container" style="display: flex;">
                    <textarea id="left-input" style="flex: 1; margin-right: 5px; height: 800px;" placeholder="这里输入"></textarea>
                    <textarea id="right-output" style="flex: 1; margin-left: 5px; height: 800px;" placeholder="这里输出"></textarea>
                </div>
            </body>
            </html>`;

        async handleInput(outputNode) {
            let value = event.target.value;
            // 在这里处理输入事件
            console.log('Input value:', value);
            let rewriter = await SymbolConfig.GetInstance().getRewriter(SymbolConfig.unknownVersion);
            let res = rewriter.parseStack(value);
            outputNode.value = `符号表版本${rewriter.versionText}\n`+ res.output;
        }

        openWindow() {
            // 使用window.open()打开一个新窗口，并且使用data:URI方式加载HTML内容
            let newWindow = window.open("", "CustomErrorStackWeb", "width=1400,height=1000");
            if (newWindow) {
                // 对于一些浏览器，需要先进行一次写入操作，才能使用data URI
                newWindow.document.write('<title>自定义弹窗</title>');
                // 使用data:URI方式加载HTML内容
                newWindow.document.write('<body style="margin:0;">' + this.html + '</body>');
                newWindow.document.close(); // 关闭文档
                let inputEle = newWindow.document.getElementById("left-input");
                let outputEle = newWindow.document.getElementById("right-output");
                inputEle.addEventListener("input", ()=>{
                    this.handleInput(outputEle)
                });
            } else {
                alert("窗口打开失败，请允许弹窗。");
            }
        }
    }

    GM_registerMenuCommand("配置DebugSymbol的Url", function (event) {
        let userConfig = window.prompt(`样例『${SymbolConfig.configUrlDefaultValue}』，$\{version}要保留用于不同版本路径替换`, SymbolConfig.configUrl);
        if (userConfig != null) {
            SymbolConfig.configUrl = userConfig;
            console.log("配置DebugSymbol的Url", userConfig);
        } else {
            console.log("取消配置");
        }
    });

    GM_registerMenuCommand("配置DebugSymbol的版本号", function (event) {
        let userConfig = window.prompt(`样例『${SymbolConfig.configVersionDefaultValue}』，会替换到$\{version}，作为url请求debugsymbol链接`, SymbolConfig.configVersion);
        if (userConfig != null) {
            SymbolConfig.configVersion = userConfig;
            console.log("配置DebugSymbol的版本号", userConfig);
        } else {
            console.log("取消配置");
        }
    });

    GM_registerMenuCommand("设置仅展示函数名", function (event) {
        SymbolConfig.onlyShowFuncName = !SymbolConfig.onlyShowFuncName;
        alert(`仅展示函数名，不展示参数类型 ${SymbolConfig.onlyShowFuncName}`);
    });

    GM_registerMenuCommand("错误栈翻译工具", function (event) {
        let debugSymbolWeb = new ErrorStackTranslateWeb();
        debugSymbolWeb.openWindow();
    });

    let checker = new StateChecker();
    if (document.URL.includes("js-error-detail")) {
        // js-error-detail只展示一条内容
        window.addEventListener("load", () => {
            checker.replaceJsErrorDetailWeb();
        });
    } else if (document.URL.includes("js-error-list")) {
        // js-error-list以列表形式呈现每条错误信息
        window.addEventListener("load", () => {
            checker.replaceJsErrorListPage();
        });
    }

    // wechatminigame tool
    // https://github.com/wechat-miniprogram/minigame-unity-webgl-transform/blob/main/tools/rewrite_exception_symbol.js
    class SymbolRewriter {
        constructor(versionText, symbolText) {
            this.versionText = versionText;
            // this.symbolText = symbolText;
            this.symbolMap = this.parseSymbol(symbolText);
        }

        /**
         * 解析调用栈
         * @param exceptionText 异常调用栈文本，可以是单行或者拼接的多行字符串
         * @return {{output: string, matched: boolean, funcNameSet: Set}}
         */
        parseStack(exceptionText) {
            var symbolMap = this.symbolMap;
            let funcNameSet = new Set();
            var res = this.replaceWithSymbol(
                exceptionText,
                symbolMap,
                /j(\d+)(.*)wasm-function\[(\d+)]/g,
                (match_info, symbolMap) => {
                    var s = symbolMap.get(match_info.value[1]);
                    if (!s) {
                        return null;
                    }

                    funcNameSet.add(match_info.value[3]);

                    return (
                        s + match_info.value[2] + "wasm-function[" + match_info.value[3] + "]"
                    );
                }
            );
            if (!res.matched) {
                res = this.replaceWithSymbol(
                    exceptionText,
                    symbolMap,
                    /wasm-function\[j(\d+)]/g,
                    (match_info, symbolMap) => {
                        var s = symbolMap.get(match_info.value[1]);
                        if (!s) {
                            return null;
                        }

                        funcNameSet.add(s);

                        return "wasm-function[" + s + "]";
                    }
                );
            }
            if (!res.matched) {
                res = this.replaceWithSymbol(
                    exceptionText,
                    symbolMap,
                    /wasm-function\[(\d+)\]/g,
                    (match_info, symbolMap) => {
                        var s = symbolMap.get(match_info.value[1]);
                        if (!s) {
                            return null;
                        }

                        funcNameSet.add(s);

                        return "wasm-function[" + s + "]";
                    }
                );
            }
            console.log(res.output);
            res.funcNameSet = funcNameSet;
            return res;
        }

        demangle(func) {
            // var hasLibcxxabi = !!Module["___cxa_demangle"];
            var hasLibcxxabi = false;
            // if (hasLibcxxabi) {
            //   try {
            //     var buf = _malloc(func.length);
            //     writeStringToMemory(func.substr(1), buf);
            //     var status = _malloc(4);
            //     var ret = Module["___cxa_demangle"](buf, 0, 0, status);
            //     if (getValue(status, "i32") === 0 && ret) {
            //       return Pointer_stringify(ret);
            //     }
            //   } catch (e) {
            //   } finally {
            //     if (buf) _free(buf);
            //     if (status) _free(status);
            //     if (ret) _free(ret);
            //   }
            // }
            var i = 3;
            var basicTypes = {
                v: "void",
                b: "bool",
                c: "char",
                s: "short",
                i: "int",
                l: "long",
                f: "float",
                d: "double",
                w: "wchar_t",
                a: "signed char",
                h: "unsigned char",
                t: "unsigned short",
                j: "unsigned int",
                m: "unsigned long",
                x: "long long",
                y: "unsigned long long",
                z: "...",
            };
            var subs = [];
            var first = true;

            function dump(x) {
                if (x) Module.print(x);
                Module.print(func);
                var pre = "";
                for (var a = 0; a < i; a++) pre += " ";
                Module.print(pre + "^");
            }

            function parseNested() {
                i++;
                if (func[i] === "K") i++;
                var parts = [];
                while (func[i] !== "E") {
                    if (func[i] === "S") {
                        i++;
                        var next = func.indexOf("_", i);
                        var num = func.substring(i, next) || 0;
                        parts.push(subs[num] || "?");
                        i = next + 1;
                        continue;
                    }
                    if (func[i] === "C") {
                        parts.push(parts[parts.length - 1]);
                        i += 2;
                        continue;
                    }
                    var size = parseInt(func.substr(i));
                    var pre = size.toString().length;
                    if (!size || !pre) {
                        i--;
                        break;
                    }
                    var curr = func.substr(i + pre, size);
                    parts.push(curr);
                    subs.push(curr);
                    i += pre + size;
                }
                i++;
                return parts;
            }

            function parse(rawList, limit, allowVoid) {
                limit = limit || Infinity;
                var ret = "",
                    list = [];

                function flushList() {
                    return "(" + list.join(", ") + ")";
                }

                var name;
                if (func[i] === "N") {
                    name = parseNested().join("::");
                    limit--;
                    if (limit === 0) return rawList ? [name] : name;
                } else {
                    if (func[i] === "K" || (first && func[i] === "L")) i++;
                    var size = parseInt(func.substr(i));
                    if (size) {
                        var pre = size.toString().length;
                        name = func.substr(i + pre, size);
                        i += pre + size;
                    }
                }
                first = false;
                if (func[i] === "I") {
                    i++;
                    var iList = parse(true);
                    var iRet = parse(true, 1, true);
                    ret += iRet[0] + " " + name + "<" + iList.join(", ") + ">";
                } else {
                    ret = name;
                }
                paramLoop: while (i < func.length && limit-- > 0) {
                    var c = func[i++];
                    if (c in basicTypes) {
                        list.push(basicTypes[c]);
                    } else {
                        switch (c) {
                            case "P":
                                list.push(parse(true, 1, true)[0] + "*");
                                break;
                            case "R":
                                list.push(parse(true, 1, true)[0] + "&");
                                break;
                            case "L": {
                                i++;
                                var end = func.indexOf("E", i);
                                var size = end - i;
                                list.push(func.substr(i, size));
                                i += size + 2;
                                break;
                            }
                            case "A": {
                                var size = parseInt(func.substr(i));
                                i += size.toString().length;
                                if (func[i] !== "_") throw "?";
                                i++;
                                list.push(parse(true, 1, true)[0] + " [" + size + "]");
                                break;
                            }
                            case "E":
                                break paramLoop;
                            default:
                                ret += "?" + c;
                                break paramLoop;
                        }
                    }
                }
                if (!allowVoid && list.length === 1 && list[0] === "void") list = [];
                if (rawList) {
                    if (ret) {
                        list.push(ret + "?");
                    }
                    return list;
                } else {
                    return ret + flushList();
                }
            }

            var parsed = func;
            try {
                if (func == "Object._main" || func == "_main") {
                    return "main()";
                }
                // if (typeof func === "number") func = Pointer_stringify(func);
                if (func[0] !== "_") return func;
                if (func[1] !== "_") return func;
                if (func[2] !== "Z") return func;
                switch (func[3]) {
                    case "n":
                        return "operator new()";
                    case "d":
                        return "operator delete()";
                }
                parsed = parse();
            } catch (e) {
                parsed += "?";
            }
            if (parsed.indexOf("?") >= 0 && !hasLibcxxabi) {
                // Runtime.warnOnce(
                //   "warning: a problem occurred in builtin C++ name demangling; build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling"
                // );
                return func;
            }
            return parsed;
        }

        parseSymbol(symbolText) {
            var symbolMap = new Map();
            try {
                var symbols = JSON.parse(symbolText);
                console.log("json symbols");
                Object.entries(symbols).forEach(function (value) {
                    symbolMap.set(value[0], value[1]);
                });
                return symbolMap;
            } catch (e) {
            }
            var startLine = "var debugSymbols = {";
            var start = symbolText.indexOf(startLine);
            start += startLine.length;
            for (; ;) {
                var next = symbolText.indexOf(",", start);
                var s = symbolText.substr(start, next - start).trim();
                // console.log("symbol line:", s);
                var b = s.length > 0 ? s.charCodeAt(0) : 0;
                if (b < 48 || b > 57) {
                    // not in [0-9]
                    break;
                }
                var mid = s.indexOf(":");
                if (mid < 0) {
                    break;
                }
                var left = s.substr(0, mid);
                var right = s.substr(mid + 1, s.length - mid - 1);
                if (right[0] === "'" && right[right.length - 1] === "'") {
                    right = right.substr(1, right.length - 2);
                }
                // console.log("symbol:", left, right);
                right = this.demangle(right);
                // console.log("after demangle:", right);

                // console.log("symbol:", start, mid, left, right);
                symbolMap.set(left, right);
                start = next + 1;
            }
            return symbolMap;
        }

        /**
         *
         * @param src 调用栈字符串
         * @param symbolMap 符号表map
         * @param regex 匹配替换的正则式
         * @param replaceFunc 替换函数，用于根据符号表自行替换函数
         * @return {{output: string, matched: boolean}} 返回替换后的字符串和是否有匹配到
         */
        replaceWithSymbol(src, symbolMap, regex, replaceFunc) {
            var res = src.matchAll(regex);
            // console.log("to replace symbol:", src, regex);
            var output = "";
            var start = 0;
            var matched = false;
            for (; ;) {
                var d = res.next();
                if (d.value) {
                    matched = true;
                    var ret = replaceFunc(d, symbolMap);
                    output += src.substr(start, d.value.index - start);
                    if (ret) {
                        output += ret;
                    } else {
                        output += d.value[0];
                    }
                    start = d.value.index + d.value[0].length;
                }
                if (d.done) {
                    output += src.substr(start);
                    break;
                }
            }
            return {output: output, matched: matched};
        }

    }
})();

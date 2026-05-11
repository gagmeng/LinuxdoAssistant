// ==UserScript==
// @name         Linuxdo活跃
// @namespace    http://tampermonkey.net/
// @version      2.2.0
// @description  Linuxdo小助手（修正阅读追踪：使用 window.scrollBy 触发 Discourse screen-track，让小蓝点能正常消失被统计）
// @author       Cressida
// @match        https://linux.do/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 常量定义 ====================
    
    /** 默认配置参数
     *  说明：Discourse 阅读追踪需要每个 post 在视口中累计停留 ~4 秒才会计入"已读"，
     *  默认值已调慢，目的是让右侧小蓝点能正常消失、Connect 浏览话题数被统计到。
     */
    const DEFAULT_CONFIG = {
        scrollInterval: 1500,       // 滚动间隔(毫秒)
        scrollStep: 220,           // 每次滚动的像素（小一点，让每个 post 能驻留够久）
        waitForElement: 3000,      // 找不到评论的最大等待时间(毫秒)
        waitingTime: { min: 4500, max: 7500 }  // 看完一帖后随机等待(让 timings 上报完成)
    };

    /** 速度滑块配置 */
    const SPEED_SLIDER_CONFIG = {
        min: 0.1,
        max: 5.0,
        step: 0.1,
        default: 1.0
    };

    /** 元素选择器配置 */
    const SELECTORS = {
        chatButton: 'li.chat-header-icon',
        chatLink: 'a[href="/chat"]',
        headerButtons: '.header-buttons',
        headerIcons: '.d-header-icons',
        headerDropdown: 'ul.header-dropdown-toggle',
        header: 'header.d-header',
        commentList: 'html.desktop-view.not-mobile-device',
        rawLinks: '.raw-link'
    };

    /** 存储键名 */
    const STORAGE_KEYS = {
        enabled: 'linuxdoHelperEnabled',
        baseConfig: 'linuxdoHelperBaseConfig',
        speedRatio: 'linuxdoHelperSpeedRatio',
        visitedLinks: 'visitedLinks',
        homeUrls: 'linuxdoHelperHomeUrls',
        selectedHomeUrl: 'linuxdoHelperSelectedHomeUrl',
        mode: 'linuxdoHelperMode'
    };

    /** 默认主页面 URL 列表（用户可配置） */
    const DEFAULT_HOME_URLS = [
        'https://linux.do/new',
        'https://linux.do/new?subset=topics'
    ];

    /** 主页面 URL 下拉框可选项 */
    const HOME_URL_PRESETS = [
        'https://linux.do/new',
        'https://linux.do/new?subset=topics',
        'https://linux.do/latest',
        'https://linux.do/latest?subset=topics',
        'https://linux.do/unread',
        'https://linux.do/top',
        'https://linux.do/hot',
        'https://linux.do/categories'
    ];

    /** 运行模式 */
    const MODES = {
        /** 单次进入主页面：进入主页后顺着帖子页内的 .raw-link 链条继续访问（当前默认行为） */
        single: 'single',
        /** 每次进入主页面：读完一个帖子后总是回到主页 URL 再随机挑选 */
        every: 'every'
    };
    const DEFAULT_MODE = MODES.single;

    /** 元素等待超时时间（毫秒） */
    const ELEMENT_WAIT_TIMEOUT = 2000;

    // ==================== 配置管理 ====================

    /** 基础配置（用于速度比例计算） */
    let baseConfig = null;

    /**
     * 获取基础配置（从存储中读取，如果没有则使用默认值）
     * @returns {Object} 基础配置对象
     */
    function getBaseConfig() {
        const savedConfig = GM_getValue(STORAGE_KEYS.baseConfig, null);
        return savedConfig ? savedConfig : { ...DEFAULT_CONFIG };
    }

    /**
     * 保存基础配置
     * @param {Object} newConfig - 新的基础配置
     */
    function saveBaseConfig(newConfig) {
        GM_setValue(STORAGE_KEYS.baseConfig, newConfig);
        baseConfig = newConfig;
    }

    /**
     * 获取速度比例
     * @returns {number} 速度比例（0.1 - 5.0）
     */
    function getSpeedRatio() {
        return GM_getValue(STORAGE_KEYS.speedRatio, SPEED_SLIDER_CONFIG.default);
    }

    /**
     * 保存速度比例
     * @param {number} ratio - 速度比例
     */
    function saveSpeedRatio(ratio) {
        GM_setValue(STORAGE_KEYS.speedRatio, ratio);
    }

    /**
     * 获取主页面 URL 列表
     * @returns {string[]}
     */
    function getHomeUrls() {
        const saved = GM_getValue(STORAGE_KEYS.homeUrls, null);
        if (Array.isArray(saved) && saved.length > 0) {
            return saved.slice();
        }
        return DEFAULT_HOME_URLS.slice();
    }

    /**
     * 保存主页面 URL 列表
     * @param {string[]} urls
     */
    function saveHomeUrls(urls) {
        const cleaned = (urls || [])
            .map(u => (u || '').trim())
            .filter(u => u.length > 0);
        GM_setValue(STORAGE_KEYS.homeUrls, cleaned);
    }

    /**
     * 随机获取一个主页面 URL
     * @returns {string}
     */
    function getRandomHomeUrl() {
        const urls = getHomeUrls();
        if (urls.length === 0) return DEFAULT_HOME_URLS[0];
        return urls[Math.floor(Math.random() * urls.length)];
    }

    /**
     * 获取当前选中的主页面 URL（持久化的"激活项"）
     * 若未设置或已不在列表中，回退到列表第一项。
     * @returns {string}
     */
    function getSelectedHomeUrl() {
        const saved = GM_getValue(STORAGE_KEYS.selectedHomeUrl, null);
        const urls = getHomeUrls();
        if (saved && urls.includes(saved)) return saved;
        return urls[0] || DEFAULT_HOME_URLS[0];
    }

    /**
     * 保存当前选中的主页面 URL
     * @param {string} url
     */
    function saveSelectedHomeUrl(url) {
        if (typeof url !== 'string' || !url) return;
        GM_setValue(STORAGE_KEYS.selectedHomeUrl, url);
    }

    /**
     * 获取用于跳转的目标主页面 URL（运行时使用：当前选中项）
     * @returns {string}
     */
    function getActiveHomeUrl() {
        return getSelectedHomeUrl();
    }

    /**
     * 判断当前页面是否为已配置的主页面 URL 之一
     * @returns {boolean}
     */
    function isOnHomeUrl() {
        const current = window.location.pathname + window.location.search;
        return getHomeUrls().some(u => {
            try {
                const parsed = new URL(u);
                return (parsed.pathname + parsed.search) === current;
            } catch (e) {
                return false;
            }
        });
    }

    /**
     * 获取运行模式
     * @returns {string}
     */
    function getMode() {
        const m = GM_getValue(STORAGE_KEYS.mode, DEFAULT_MODE);
        return (m === MODES.every || m === MODES.single) ? m : DEFAULT_MODE;
    }

    /**
     * 保存运行模式
     * @param {string} mode
     */
    function saveMode(mode) {
        if (mode !== MODES.single && mode !== MODES.every) return;
        GM_setValue(STORAGE_KEYS.mode, mode);
    }

    /**
     * 获取实际使用的配置（基础配置 × 速度比例）
     * 注意：waitingTime 可能是数字或 {min,max} 区间，调用方应使用 sampleWaitingTime() 取样
     * @returns {Object} 计算后的配置对象
     */
    function getConfig() {
        if (!baseConfig) {
            baseConfig = getBaseConfig();
        }
        const ratio = getSpeedRatio();
        const wt = baseConfig.waitingTime;
        let waitingTime;
        if (wt && typeof wt === 'object' && 'min' in wt && 'max' in wt) {
            waitingTime = {
                min: Math.round(Number(wt.min) / ratio),
                max: Math.round(Number(wt.max) / ratio)
            };
        } else {
            waitingTime = Math.round(Number(wt) / ratio);
        }
        return {
            scrollInterval: Math.round(baseConfig.scrollInterval / ratio),
            scrollStep: Math.round(baseConfig.scrollStep * ratio),
            waitForElement: Math.round(baseConfig.waitForElement / ratio),
            waitingTime: waitingTime
        };
    }

    /**
     * 采样一次等待时间（毫秒）。若配置为区间则随机取一值，否则为固定值。
     * @returns {number}
     */
    function sampleWaitingTime() {
        const wt = getConfig().waitingTime;
        if (wt && typeof wt === 'object') {
            const min = Math.min(wt.min, wt.max);
            const max = Math.max(wt.min, wt.max);
            return Math.round(min + Math.random() * (max - min));
        }
        return Number(wt) || 0;
    }

    // 初始化基础配置
    baseConfig = getBaseConfig();

    // ==================== 开关状态管理 ====================

    /**
     * 获取助手开关状态
     * @returns {boolean} 是否启用
     */
    function getSwitchState() {
        return GM_getValue(STORAGE_KEYS.enabled, false);
    }

    /**
     * 切换助手开关状态
     */
    function toggleSwitch() {
        const currentState = getSwitchState();
        const newState = !currentState;
        GM_setValue(STORAGE_KEYS.enabled, newState);

        if (newState) {
            // 启用时跳转到当前选中的主页面
            window.location.href = getActiveHomeUrl();
        }
        console.log(`Linuxdo助手已${newState ? '启用' : '禁用'}`);
    }

    // ==================== UI 组件创建 ====================

    /**
     * 创建SVG图标元素
     * @param {string} iconHref - 图标引用（如 '#play' 或 '#pause'）
     * @returns {SVGElement} SVG元素
     */
    function createSVGIcon(iconHref) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'fa d-icon d-icon-rocket svg-icon prefix-icon svg-string');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        
        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', iconHref);
        svg.appendChild(use);
        
        return svg;
    }

    /**
     * 创建控制开关按钮
     * @returns {HTMLElement} 开关按钮的 li 元素
     */
    function createSwitchButton() {
        const iconLi = document.createElement('li');
        iconLi.className = 'header-dropdown-toggle';
        
        const iconLink = document.createElement('a');
        iconLink.href = '#';
        iconLink.className = 'btn no-text icon btn-flat';
        iconLink.tabIndex = 0;
        
        const isEnabled = getSwitchState();
        iconLink.title = isEnabled ? '停止Linuxdo助手' : '启动Linuxdo助手';
        
        const svg = createSVGIcon(isEnabled ? '#pause' : '#play');
        iconLink.appendChild(svg);
        iconLi.appendChild(iconLink);

        // 点击事件处理
        iconLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            toggleSwitch();
            
            // 更新按钮状态
            const newState = getSwitchState();
            const use = svg.querySelector('use');
            use.setAttribute('href', newState ? '#pause' : '#play');
            iconLink.title = newState ? '停止Linuxdo助手' : '启动Linuxdo助手';
            iconLink.classList.toggle('active', newState);
            
            // 更新悬浮滑块显示状态
            updateFloatingSliderVisibility();
        });

        return iconLi;
    }

    /**
     * 查找聊天按钮元素
     * @returns {Promise<HTMLElement|null>} 聊天按钮元素或null
     */
    async function findChatButton() {
        try {
            // 尝试等待聊天按钮出现
            const chatButton = await Promise.race([
                waitForElement(SELECTORS.chatButton),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('timeout')), ELEMENT_WAIT_TIMEOUT)
                )
            ]).catch(() => null);
            
            if (chatButton) {
                return chatButton;
            }
        } catch (e) {
            // 等待失败，继续尝试直接查找
        }
        
        // 直接查找聊天按钮
        return document.querySelector(SELECTORS.chatButton) || 
               document.querySelector(SELECTORS.chatLink)?.closest('li');
    }

    /**
     * 查找备用插入位置
     * @returns {HTMLElement|null} 备用位置元素或null
     */
    function findFallbackInsertPosition() {
        return document.querySelector(SELECTORS.headerButtons) || 
               document.querySelector(SELECTORS.headerIcons) ||
               document.querySelector(SELECTORS.headerDropdown)?.parentElement;
    }

    /**
     * 将开关按钮插入到页面中
     * @param {HTMLElement} buttonElement - 开关按钮元素
     */
    function insertSwitchButton(buttonElement) {
        // 优先插入到聊天按钮旁边
        const chatButton = document.querySelector(SELECTORS.chatButton);
        if (chatButton?.parentNode) {
            chatButton.parentNode.insertBefore(buttonElement, chatButton.nextSibling);
            return;
        }

        // 备用方案：插入到其他header按钮位置
        const fallbackPosition = findFallbackInsertPosition();
        if (fallbackPosition?.parentNode) {
            fallbackPosition.parentNode.insertBefore(buttonElement, fallbackPosition.nextSibling);
            return;
        }

        // 最后方案：插入到header中
        const header = document.querySelector(SELECTORS.header) || document.querySelector('header');
        if (header) {
            const headerList = header.querySelector('ul') || header.querySelector('nav');
            if (headerList) {
                headerList.appendChild(buttonElement);
            } else {
                header.insertBefore(buttonElement, header.firstChild);
            }
        } else {
            console.log("【错误】未找到按钮插入位置！");
        }
    }

    /**
     * 创建并插入开关图标到页面
     */
    async function createSwitchIcon() {
        const switchButton = createSwitchButton();
        await findChatButton(); // 等待聊天按钮加载
        insertSwitchButton(switchButton);
    }

    /**
     * 创建悬浮速度滑块
     * @returns {HTMLElement} 滑块容器元素
     */
    function createFloatingSpeedSlider() {
        // 如果已存在，先移除
        const existingSlider = document.getElementById('linuxdo-speed-slider');
        if (existingSlider) {
            existingSlider.remove();
        }

        // 创建容器
        const container = document.createElement('div');
        container.id = 'linuxdo-speed-slider';
        container.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: white;
            border-radius: 8px;
            padding: 16px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 9999;
            min-width: 200px;
        `;

        // 顶部行：标签 + ⚙ 设置按钮
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;';

        const label = document.createElement('div');
        label.textContent = '阅读速度';
        label.style.cssText = 'font-size: 14px; color: #333; font-weight: 500;';
        topRow.appendChild(label);

        const settingsBtn = document.createElement('button');
        settingsBtn.type = 'button';
        settingsBtn.textContent = '⚙';
        settingsBtn.title = '配置助手';
        settingsBtn.style.cssText = `
            background: transparent;
            border: none;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 2px 6px;
            color: #555;
        `;
        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            openSettingsModal();
        });
        topRow.appendChild(settingsBtn);

        container.appendChild(topRow);

        // 创建滑块容器
        const sliderWrapper = document.createElement('div');
        sliderWrapper.style.cssText = 'display: flex; align-items: center; gap: 12px;';

        // 创建滑块
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = SPEED_SLIDER_CONFIG.min;
        slider.max = SPEED_SLIDER_CONFIG.max;
        slider.step = SPEED_SLIDER_CONFIG.step;
        slider.value = getSpeedRatio();
        slider.style.cssText = `
            flex: 1;
            height: 6px;
            border-radius: 3px;
            background: #ddd;
            outline: none;
            cursor: pointer;
        `;

        // 创建数值显示
        const valueDisplay = document.createElement('span');
        valueDisplay.textContent = getSpeedRatio().toFixed(1) + 'x';
        valueDisplay.style.cssText = 'min-width: 45px; text-align: right; font-size: 14px; color: #666; font-weight: 500;';

        // 滑块值变化事件
        slider.addEventListener('input', () => {
            const ratio = parseFloat(slider.value);
            valueDisplay.textContent = ratio.toFixed(1) + 'x';
            saveSpeedRatio(ratio);
            
            // 如果正在滚动，立即应用新速度
            restartScrolling();
        });

        // 组装元素
        sliderWrapper.appendChild(slider);
        sliderWrapper.appendChild(valueDisplay);
        container.appendChild(sliderWrapper);
        document.body.appendChild(container);

        return container;
    }

    /**
     * 更新悬浮面板的显示状态（当前始终可见，保留函数以兼容调用点）
     */
    function updateFloatingSliderVisibility() {
        // 面板始终可见，便于随时调整配置
    }

    // ==================== 配置弹窗 ====================

    /**
     * 打开配置弹窗（主页面 URL 列表 + 运行模式）
     */
    function openSettingsModal() {
        // 已存在则不再创建
        if (document.getElementById('linuxdo-settings-modal')) return;

        // 遮罩层
        const overlay = document.createElement('div');
        overlay.id = 'linuxdo-settings-modal';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.45);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        // 弹窗主体
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
            width: 520px;
            max-width: 92vw;
            max-height: 86vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-size: 14px;
            color: #222;
        `;

        // 头部
        const header = document.createElement('div');
        header.style.cssText = 'padding: 14px 18px; border-bottom: 1px solid #eee; display: flex; align-items: center; justify-content: space-between;';
        const title = document.createElement('div');
        title.textContent = 'Linuxdo 助手配置';
        title.style.cssText = 'font-size: 16px; font-weight: 600;';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background: transparent; border: none; font-size: 22px; cursor: pointer; color: #888; line-height: 1;';
        closeBtn.addEventListener('click', () => overlay.remove());
        header.appendChild(title);
        header.appendChild(closeBtn);

        // 内容区
        const body = document.createElement('div');
        body.style.cssText = 'padding: 16px 18px; overflow-y: auto; flex: 1;';

        // ---- 运行模式区 ----
        const modeSection = document.createElement('div');
        modeSection.style.cssText = 'margin-bottom: 18px;';

        const modeTitle = document.createElement('div');
        modeTitle.textContent = '运行模式';
        modeTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
        modeSection.appendChild(modeTitle);

        const currentMode = getMode();
        const makeRadio = (value, labelText, desc) => {
            const wrapper = document.createElement('label');
            wrapper.style.cssText = 'display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; cursor: pointer;';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'linuxdo-mode';
            input.value = value;
            input.checked = currentMode === value;
            input.style.cssText = 'margin-top: 4px;';
            const textBox = document.createElement('div');
            const t = document.createElement('div');
            t.textContent = labelText;
            t.style.cssText = 'font-size: 14px;';
            const d = document.createElement('div');
            d.textContent = desc;
            d.style.cssText = 'font-size: 12px; color: #777;';
            textBox.appendChild(t);
            textBox.appendChild(d);
            wrapper.appendChild(input);
            wrapper.appendChild(textBox);
            return wrapper;
        };

        modeSection.appendChild(makeRadio(
            MODES.single,
            '单次进入主页面',
            '进入主页后沿着帖子页内的相关链接继续访问（当前默认行为）'
        ));
        modeSection.appendChild(makeRadio(
            MODES.every,
            '每次进入主页面',
            '每读完一个帖子都回到主页 URL，再从未访问列表中随机挑选'
        ));

        body.appendChild(modeSection);

        // ---- 滚动参数区 ----
        const paramSection = document.createElement('div');
        paramSection.style.cssText = 'margin-bottom: 18px;';

        const paramTitle = document.createElement('div');
        paramTitle.textContent = '滚动参数';
        paramTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
        paramSection.appendChild(paramTitle);

        const paramHint = document.createElement('div');
        paramHint.textContent = '以下为基础值，实际使用时会再乘以右下角速度比例。';
        paramHint.style.cssText = 'font-size: 12px; color: #777; margin-bottom: 10px;';
        paramSection.appendChild(paramHint);

        const currentBase = getBaseConfig();

        /** 创建一行 "标签 + 数字输入框" */
        const makeNumberRow = (labelText, value, min, step) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 8px;';
            const lab = document.createElement('div');
            lab.textContent = labelText;
            lab.style.cssText = 'flex: 1; font-size: 13px; color: #333;';
            const input = document.createElement('input');
            input.type = 'number';
            input.min = String(min);
            input.step = String(step);
            input.value = String(value);
            input.style.cssText = 'width: 120px; padding: 6px 8px; border: 1px solid #d0d0d0; border-radius: 4px; font-size: 13px;';
            row.appendChild(lab);
            row.appendChild(input);
            return { row, input };
        };

        const scrollIntervalRow = makeNumberRow('滚动间隔 (ms)', currentBase.scrollInterval, 1, 10);
        const scrollStepRow = makeNumberRow('每次滚动像素 (px)', currentBase.scrollStep, 1, 10);
        const waitForElementRow = makeNumberRow('元素等待超时 (ms)', currentBase.waitForElement, 1, 100);
        paramSection.appendChild(scrollIntervalRow.row);
        paramSection.appendChild(scrollStepRow.row);
        paramSection.appendChild(waitForElementRow.row);

        // 看完评论等待时间：固定 / 随机区间
        const waitWrapper = document.createElement('div');
        waitWrapper.style.cssText = 'margin-top: 4px; padding: 10px; border: 1px solid #eee; border-radius: 6px;';

        const waitLabel = document.createElement('div');
        waitLabel.textContent = '看完评论等待时间';
        waitLabel.style.cssText = 'font-size: 13px; color: #333; margin-bottom: 8px;';
        waitWrapper.appendChild(waitLabel);

        const wt = currentBase.waitingTime;
        const isRange = wt && typeof wt === 'object' && 'min' in wt && 'max' in wt;

        // 模式单选
        const waitModeRow = document.createElement('div');
        waitModeRow.style.cssText = 'display: flex; gap: 14px; margin-bottom: 8px;';

        const fixedLabel = document.createElement('label');
        fixedLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px;';
        const fixedRadio = document.createElement('input');
        fixedRadio.type = 'radio';
        fixedRadio.name = 'linuxdo-wait-mode';
        fixedRadio.value = 'fixed';
        fixedRadio.checked = !isRange;
        fixedLabel.appendChild(fixedRadio);
        fixedLabel.appendChild(document.createTextNode('固定时间'));

        const rangeLabel = document.createElement('label');
        rangeLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px;';
        const rangeRadio = document.createElement('input');
        rangeRadio.type = 'radio';
        rangeRadio.name = 'linuxdo-wait-mode';
        rangeRadio.value = 'range';
        rangeRadio.checked = isRange;
        rangeLabel.appendChild(rangeRadio);
        rangeLabel.appendChild(document.createTextNode('随机区间'));

        waitModeRow.appendChild(fixedLabel);
        waitModeRow.appendChild(rangeLabel);
        waitWrapper.appendChild(waitModeRow);

        // 固定值输入
        const fixedBox = document.createElement('div');
        fixedBox.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        const fixedInput = document.createElement('input');
        fixedInput.type = 'number';
        fixedInput.min = '0';
        fixedInput.step = '50';
        fixedInput.value = String(isRange ? 1000 : (Number(wt) || 1000));
        fixedInput.style.cssText = 'width: 140px; padding: 6px 8px; border: 1px solid #d0d0d0; border-radius: 4px; font-size: 13px;';
        const fixedSuffix = document.createElement('span');
        fixedSuffix.textContent = '毫秒';
        fixedSuffix.style.cssText = 'font-size: 12px; color: #777;';
        fixedBox.appendChild(fixedInput);
        fixedBox.appendChild(fixedSuffix);
        waitWrapper.appendChild(fixedBox);

        // 区间输入
        const rangeBox = document.createElement('div');
        rangeBox.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.min = '0';
        minInput.step = '50';
        minInput.value = String(isRange ? wt.min : 500);
        minInput.style.cssText = 'width: 110px; padding: 6px 8px; border: 1px solid #d0d0d0; border-radius: 4px; font-size: 13px;';
        const dash = document.createElement('span');
        dash.textContent = '—';
        dash.style.cssText = 'color: #666;';
        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.min = '0';
        maxInput.step = '50';
        maxInput.value = String(isRange ? wt.max : 2000);
        maxInput.style.cssText = 'width: 110px; padding: 6px 8px; border: 1px solid #d0d0d0; border-radius: 4px; font-size: 13px;';
        const rangeSuffix = document.createElement('span');
        rangeSuffix.textContent = '毫秒';
        rangeSuffix.style.cssText = 'font-size: 12px; color: #777;';
        rangeBox.appendChild(minInput);
        rangeBox.appendChild(dash);
        rangeBox.appendChild(maxInput);
        rangeBox.appendChild(rangeSuffix);
        waitWrapper.appendChild(rangeBox);

        // 切换显示
        const updateWaitVisibility = () => {
            const useRange = rangeRadio.checked;
            fixedBox.style.display = useRange ? 'none' : 'flex';
            rangeBox.style.display = useRange ? 'flex' : 'none';
        };
        fixedRadio.addEventListener('change', updateWaitVisibility);
        rangeRadio.addEventListener('change', updateWaitVisibility);
        updateWaitVisibility();

        paramSection.appendChild(waitWrapper);
        body.appendChild(paramSection);

        // ---- 主页面 URL 列表区（自定义下拉，每项内置 ✎ 编辑 / ✕ 删除；底部内置 + 新增） ----
        const urlSection = document.createElement('div');

        const urlTitle = document.createElement('div');
        urlTitle.textContent = '主页面 URL';
        urlTitle.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
        urlSection.appendChild(urlTitle);

        const urlHint = document.createElement('div');
        urlHint.textContent = '助手启用时会跳转到下拉框中"当前选中"的 URL。点击下拉框展开，可切换、编辑或删除已有项，底部「+ 新增」可添加新条目。';
        urlHint.style.cssText = 'font-size: 12px; color: #777; margin-bottom: 8px; line-height: 1.5;';
        urlSection.appendChild(urlHint);

        // 本地维护的 URL 列表状态
        let urlsState = getHomeUrls();
        // 从存储读取上次选中的 URL；若不在列表中则回退到首项
        let selectedUrl = (() => {
            const s = getSelectedHomeUrl();
            return urlsState.includes(s) ? s : (urlsState[0] || '');
        })();

        const isValidUrl = (u) => {
            if (!u) return false;
            try { new URL(u); return true; } catch { return false; }
        };

        // 下拉容器（相对定位，承载触发按钮 + 浮层面板）
        const dd = document.createElement('div');
        dd.style.cssText = 'position: relative;';

        // 触发按钮
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.style.cssText = 'width: 100%; padding: 7px 10px; border: 1px solid #d0d0d0; border-radius: 4px; background: #fff; font-size: 13px; text-align: left; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px;';
        const triggerText = document.createElement('span');
        triggerText.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;';
        const triggerArrow = document.createElement('span');
        triggerArrow.textContent = '▾';
        triggerArrow.style.cssText = 'color: #888; font-size: 12px;';
        trigger.appendChild(triggerText);
        trigger.appendChild(triggerArrow);
        dd.appendChild(trigger);

        // 浮层面板
        const panel = document.createElement('div');
        panel.style.cssText = 'position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: #fff; border: 1px solid #d0d0d0; border-radius: 4px; box-shadow: 0 6px 18px rgba(0,0,0,0.12); max-height: 260px; overflow-y: auto; z-index: 10001; display: none;';
        dd.appendChild(panel);

        urlSection.appendChild(dd);
        body.appendChild(urlSection);

        // —— 渲染逻辑 ——
        const updateTrigger = () => {
            triggerText.textContent = selectedUrl || '（列表为空，请新增）';
            triggerText.style.color = selectedUrl ? '#222' : '#999';
        };

        const closePanel = () => { panel.style.display = 'none'; };
        const openPanel = () => { panel.style.display = 'block'; renderPanel(); };
        const togglePanel = () => {
            if (panel.style.display === 'block') closePanel();
            else openPanel();
        };

        // 行样式
        const rowBaseStyle = 'display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid #f0f0f0; font-size: 13px;';
        const iconBtnStyle = 'background: transparent; border: none; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-size: 14px; line-height: 1;';

        // 创建一个普通项（展示 + 操作图标）
        const buildDisplayRow = (url) => {
            const row = document.createElement('div');
            row.style.cssText = rowBaseStyle + (url === selectedUrl ? ' background: #eef4ff;' : '');

            const text = document.createElement('span');
            text.textContent = url;
            text.title = url;
            text.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: #222;';
            text.addEventListener('click', () => {
                selectedUrl = url;
                updateTrigger();
                closePanel();
            });
            row.appendChild(text);

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.title = '编辑';
            editBtn.textContent = '✎';
            editBtn.style.cssText = iconBtnStyle + ' color: #1d6fdc;';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                row.replaceWith(buildEditRow(url));
            });
            row.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.title = '删除';
            delBtn.textContent = '✕';
            delBtn.style.cssText = iconBtnStyle + ' color: #c0392b;';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                urlsState = urlsState.filter(u => u !== url);
                if (selectedUrl === url) selectedUrl = urlsState[0] || '';
                updateTrigger();
                renderPanel();
            });
            row.appendChild(delBtn);

            return row;
        };

        // 创建一个编辑态项（输入 + ✓ + ✗）
        const buildEditRow = (originalUrl) => {
            const row = document.createElement('div');
            row.style.cssText = rowBaseStyle;

            const input = document.createElement('input');
            input.type = 'text';
            input.setAttribute('list', 'linuxdo-url-presets');
            input.value = originalUrl || '';
            input.placeholder = 'https://linux.do/...';
            input.style.cssText = 'flex: 1; padding: 4px 6px; border: 1px solid #d0d0d0; border-radius: 3px; font-size: 13px;';
            row.appendChild(input);

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.title = '确定';
            okBtn.textContent = '✓';
            okBtn.style.cssText = iconBtnStyle + ' color: #2e8b57;';
            const commit = () => {
                const v = input.value.trim();
                if (!isValidUrl(v)) { alert('请输入合法的 URL'); input.focus(); return; }
                if (originalUrl) {
                    // 编辑：替换
                    if (v !== originalUrl && urlsState.includes(v)) { alert('该 URL 已存在'); return; }
                    const idx = urlsState.indexOf(originalUrl);
                    if (idx >= 0) urlsState[idx] = v;
                    if (selectedUrl === originalUrl) selectedUrl = v;
                } else {
                    // 新增
                    if (urlsState.includes(v)) { alert('该 URL 已存在'); return; }
                    urlsState.push(v);
                    if (!selectedUrl) selectedUrl = v;
                }
                updateTrigger();
                renderPanel();
            };
            okBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { e.preventDefault(); renderPanel(); }
            });
            row.appendChild(okBtn);

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.title = '取消';
            cancelBtn.textContent = '✗';
            cancelBtn.style.cssText = iconBtnStyle + ' color: #888;';
            cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); renderPanel(); });
            row.appendChild(cancelBtn);

            // 自动聚焦
            setTimeout(() => input.focus(), 0);
            return row;
        };

        // 底部「+ 新增」行
        const buildAddRow = () => {
            const row = document.createElement('div');
            row.style.cssText = rowBaseStyle + ' color: #1d6fdc; cursor: pointer; font-weight: 500; border-bottom: none;';
            row.textContent = '+ 新增';
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                row.replaceWith(buildEditRow(''));
            });
            return row;
        };

        const renderPanel = () => {
            panel.innerHTML = '';
            // datalist 用于编辑/新增时的自动补全
            if (!document.getElementById('linuxdo-url-presets')) {
                const dl = document.createElement('datalist');
                dl.id = 'linuxdo-url-presets';
                HOME_URL_PRESETS.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p;
                    dl.appendChild(opt);
                });
                document.body.appendChild(dl);
            }
            if (urlsState.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = rowBaseStyle + ' color: #999; cursor: default;';
                empty.textContent = '（列表为空）';
                panel.appendChild(empty);
            } else {
                urlsState.forEach(u => panel.appendChild(buildDisplayRow(u)));
            }
            panel.appendChild(buildAddRow());
        };

        // 触发开/关
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePanel();
        });

        // 点击面板外部时关闭
        const outsideHandler = (e) => {
            if (!dd.contains(e.target)) closePanel();
        };
        document.addEventListener('click', outsideHandler);
        // 弹窗关闭时清理监听器
        overlay.addEventListener('remove', () => document.removeEventListener('click', outsideHandler));
        // 由于 overlay 没有 remove 事件，使用 MutationObserver 兜底
        const ddCleanupObs = new MutationObserver(() => {
            if (!document.body.contains(overlay)) {
                document.removeEventListener('click', outsideHandler);
                ddCleanupObs.disconnect();
            }
        });
        ddCleanupObs.observe(document.body, { childList: true });

        // 提供给保存/重置使用的刷新方法
        const refreshUrlDropdown = () => {
            if (!urlsState.includes(selectedUrl)) selectedUrl = urlsState[0] || '';
            updateTrigger();
            if (panel.style.display === 'block') renderPanel();
        };

        updateTrigger();

        // 底部按钮区
        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 12px 18px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 8px;';

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.textContent = '恢复默认';
        resetBtn.style.cssText = 'padding: 7px 14px; background: #fff; color: #555; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;';
        resetBtn.addEventListener('click', () => {
            urlsState = DEFAULT_HOME_URLS.slice();
            selectedUrl = urlsState[0] || '';
            refreshUrlDropdown();
            const singleRadio = modeSection.querySelector(`input[value="${MODES.single}"]`);
            if (singleRadio) singleRadio.checked = true;
            // 重置滚动参数
            scrollIntervalRow.input.value = String(DEFAULT_CONFIG.scrollInterval);
            scrollStepRow.input.value = String(DEFAULT_CONFIG.scrollStep);
            waitForElementRow.input.value = String(DEFAULT_CONFIG.waitForElement);
            const defaultWt = DEFAULT_CONFIG.waitingTime;
            const defaultIsRange = defaultWt && typeof defaultWt === 'object';
            fixedRadio.checked = !defaultIsRange;
            rangeRadio.checked = defaultIsRange;
            if (defaultIsRange) {
                fixedInput.value = '1000';
                minInput.value = String(defaultWt.min);
                maxInput.value = String(defaultWt.max);
            } else {
                fixedInput.value = String(defaultWt);
                minInput.value = '500';
                maxInput.value = '2000';
            }
            updateWaitVisibility();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = '取消';
        cancelBtn.style.cssText = 'padding: 7px 14px; background: #fff; color: #555; border: 1px solid #ccc; border-radius: 4px; cursor: pointer;';
        cancelBtn.addEventListener('click', () => overlay.remove());

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = '保存';
        saveBtn.style.cssText = 'padding: 7px 16px; background: #1d6fdc; color: #fff; border: 1px solid #1d6fdc; border-radius: 4px; cursor: pointer; font-weight: 500;';
        saveBtn.addEventListener('click', () => {
            // 收集 URL：使用本地维护的列表状态
            const urls = urlsState.slice();
            if (urls.length === 0) {
                alert('至少需要保留一个主页面 URL。');
                return;
            }
            // 校验为合法 URL
            for (const u of urls) {
                try { new URL(u); } catch (e) {
                    alert('URL 格式不合法：' + u);
                    return;
                }
            }
            // 滚动参数校验
            const parseNum = (el, name, allowZero) => {
                const n = Number(el.value);
                if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
                    alert(`${name} 需为${allowZero ? '非负' : '正'}数字`);
                    el.focus();
                    throw new Error('invalid');
                }
                return n;
            };
            let newBase;
            try {
                const si = parseNum(scrollIntervalRow.input, '滚动间隔', false);
                const ss = parseNum(scrollStepRow.input, '每次滚动像素', false);
                const wfe = parseNum(waitForElementRow.input, '元素等待超时', false);
                let waitingTime;
                if (rangeRadio.checked) {
                    const mn = parseNum(minInput, '等待时间下限', true);
                    const mx = parseNum(maxInput, '等待时间上限', true);
                    if (mn > mx) {
                        alert('等待时间下限不能大于上限');
                        return;
                    }
                    waitingTime = { min: mn, max: mx };
                } else {
                    waitingTime = parseNum(fixedInput, '看完评论等待时间', true);
                }
                newBase = {
                    scrollInterval: si,
                    scrollStep: ss,
                    waitForElement: wfe,
                    waitingTime: waitingTime
                };
            } catch (e) {
                return; // 校验失败已 alert
            }

            saveHomeUrls(urls);
            // 同步保存"当前选中"的 URL，使重新打开配置或重启浏览器后仍记住
            if (selectedUrl && urls.includes(selectedUrl)) {
                saveSelectedHomeUrl(selectedUrl);
            } else if (urls.length > 0) {
                saveSelectedHomeUrl(urls[0]);
            }

            const checked = modeSection.querySelector('input[name="linuxdo-mode"]:checked');
            saveMode(checked ? checked.value : DEFAULT_MODE);

            saveBaseConfig(newBase);
            // 立即应用滚动参数（如果正在运行）
            restartScrolling();

            overlay.remove();
            console.log('[Linuxdo助手] 配置已保存', { urls, mode: getMode(), base: newBase });
        });

        footer.appendChild(resetBtn);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);

        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        overlay.appendChild(modal);

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        document.body.appendChild(overlay);
    }

    // ==================== DOM 工具函数 ====================

    /**
     * 等待指定元素出现在页面中
     * @param {string} selector - CSS选择器
     * @returns {Promise<HTMLElement>} 找到的元素
     */
    function waitForElement(selector) {
        return new Promise((resolve, reject) => {
            // 先尝试直接查找
            const element = document.querySelector(selector);
            if (element) {
                resolve(element);
                return;
            }

            // 使用MutationObserver监听DOM变化
            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // 超时处理
            setTimeout(() => {
                observer.disconnect();
                console.log("【错误】未找到元素：", selector);
                reject(new Error('未找到：' + selector));
            }, getConfig().waitForElement);
        });
    }

    /**
     * 获取页面滚动容器（兼容不同浏览器/页面滚动实现）
     * @returns {HTMLElement|null} 滚动容器元素
     */
    function getScrollContainer() {
        return document.scrollingElement || document.documentElement || document.body;
    }

    /**
     * 获取页面中的原始链接列表
     * @returns {Array<Object>} 链接对象数组，包含index、href、text
     */
    function getRawLinks() {
        const linkElements = document.querySelectorAll(SELECTORS.rawLinks);
        return Array.from(linkElements)
            .map((element, index) => ({
                index: index + 1,
                href: element.href,
                text: element.textContent.trim()
            }))
            .filter(link => link.href);
    }

    // ==================== 核心功能 ====================

    /** 当前运行的滚动定时器引用 */
    let currentScrollInterval = null;
    
    /** 当前评论元素引用 */
    let currentCommentElement = null;

    /**
     * 加载并跳转到新页面
     * @param {Array<Object>} links - 可用链接列表
     */
    function loadPage(links) {
        if (!getSwitchState()) {
            return;
        }

        const visitedLinks = JSON.parse(
            localStorage.getItem(STORAGE_KEYS.visitedLinks) || '[]'
        );
        const unvisitedLinks = links.filter(
            link => !visitedLinks.includes(link.href)
        );

        // 「每次进入主页面」模式：当前不在主页时，执行浏览器后退返回上一个主页
        // 逻辑：首次从主页 -> 帖子是 push 了一条历史；后退即回到主页且复用已有列表。
        // 若 referrer 不是我们配置过的主页 URL（例如从其它站点直接进来），才回退到硬跳转。
        if (getMode() === MODES.every && !isOnHomeUrl()) {
            const ref = document.referrer;
            let refMatchesHome = false;
            if (ref) {
                try {
                    const refUrl = new URL(ref);
                    if (refUrl.origin === window.location.origin) {
                        const refPath = refUrl.pathname + refUrl.search;
                        refMatchesHome = getHomeUrls().some(u => {
                            try {
                                const p = new URL(u);
                                return (p.pathname + p.search) === refPath;
                            } catch (e) { return false; }
                        });
                    }
                } catch (e) { /* ignore */ }
            }
            if (refMatchesHome && window.history.length > 1) {
                console.log('[every 模式] 后退至主页面 (history.back)');
                window.history.back();
            } else {
                console.log('[every 模式] referrer 非主页，硬跳转到主页面');
                window.location.href = getActiveHomeUrl();
            }
            return;
        }

        // 如果没有未访问的链接，硬跳转到当前选中的主页面（强制重取列表，获取新的帖子）
        if (unvisitedLinks.length === 0) {
            console.log('[Linuxdo助手] 所有链接均已访问，重新打开主页面获取新列表');
            window.location.href = getActiveHomeUrl();
            return;
        }

        // 随机选择一个未访问的链接
        const randomIndex = Math.floor(Math.random() * unvisitedLinks.length);
        const selectedLink = unvisitedLinks[randomIndex];
        
        // 记录已访问
        visitedLinks.push(selectedLink.href);
        localStorage.setItem(STORAGE_KEYS.visitedLinks, JSON.stringify(visitedLinks));
        
        // 跳转
        window.location.href = selectedLink.href;
    }

    /**
     * 停止当前滚动
     */
    function stopScrolling() {
        if (currentScrollInterval) {
            clearInterval(currentScrollInterval);
            currentScrollInterval = null;
        }
        currentCommentElement = null;
    }

    /**
     * 滚动评论区域并自动跳转
     * @param {HTMLElement} commentElement - 评论容器元素
     */
    function scrollComment(commentElement) {
        // 停止之前的滚动
        stopScrolling();
        
        // 保存当前评论元素引用
        currentCommentElement = commentElement;
        
        // 记录开始等待链接的时间
        let linkWaitStartTime = null;
        // 本次等待周期采样得到的目标等待时长（毫秒）
        let currentWaitingTime = 0;
        
        // 获取最新配置
        const config = getConfig();
        
        const scrollInterval = setInterval(() => {
            // 每次滚动时重新获取配置，确保速度改变立即生效
            const currentConfig = getConfig();
            
            // 滚动：使用 window.scrollBy 并在 window 上派发 scroll 事件，
            // 这样 Discourse 的阅读追踪（screen-track）才能正确感知到滚动并上报 timings
            window.scrollBy({ top: currentConfig.scrollStep, left: 0, behavior: 'auto' });
            window.dispatchEvent(new Event('scroll'));

            // 检查是否有链接
            const links = getRawLinks();
            if (links.length > 0) {
                // 记录开始等待的时间，并采样一次本周期的等待时长
                if (linkWaitStartTime === null) {
                    linkWaitStartTime = Date.now();
                    currentWaitingTime = sampleWaitingTime();
                }
                
                // 计算已等待时间（毫秒）
                const waitedTime = Date.now() - linkWaitStartTime;
                
                if (waitedTime >= currentWaitingTime) {
                    stopScrolling();
                    loadPage(links);
                }
            } else {
                // 没有链接时重置等待时间
                linkWaitStartTime = null;
                currentWaitingTime = 0;
            }
        }, config.scrollInterval);
        
        // 保存 interval 引用
        currentScrollInterval = scrollInterval;
    }
    
    /**
     * 重新启动滚动（用于速度改变时立即生效）
     */
    function restartScrolling() {
        if (currentCommentElement) {
            scrollComment(currentCommentElement);
        }
    }

    /**
     * 启动自动滚动功能
     */
    async function startAutoScroll() {
        try {
            // 等待进入桌面端视图（避免移动端/未初始化完成时误触发）
            await waitForElement(SELECTORS.commentList);

            const scrollContainer = getScrollContainer();
            if (!scrollContainer) {
                throw new Error('未找到滚动容器元素');
            }

            console.log('找到滚动容器元素:', scrollContainer);
            scrollComment(scrollContainer);
        } catch (error) {
            console.error('启动自动滚动失败:', error);
        }
    }

    // ==================== 主程序入口 ====================

    /**
     * 主初始化函数
     */
    async function main() {
        // 创建控制开关按钮
        await createSwitchIcon();
        
        // 创建悬浮速度滑块
        createFloatingSpeedSlider();
        
        // 如果助手未启用，不执行后续操作
        if (!getSwitchState()) {
            return;
        }

        // 启动自动滚动
        startAutoScroll();
    }

    // bfcache 恢复处理：history.back() 命中浏览器前进/后退缓存时，
    // 不会重新执行脚本，需要手动重启自动滚动。
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            console.log('[Linuxdo助手] 页面从 bfcache 恢复');
            if (getSwitchState()) {
                // 先停止可能残留的旧 interval（保险），再启动
                stopScrolling();
                startAutoScroll();
            }
        }
    });

    // 页面加载完成后执行
    if (document.readyState === 'complete') {
        main();
    } else {
        window.addEventListener('load', main);
    }
})();



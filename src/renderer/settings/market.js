// LiteLoaderQQNT 插件市场界面：工具条 + 卡片网格 + 详情弹层
// 数据全部来自主进程的 market 接口：list / installed / install / uninstall

import { default_icon, normalizeVersion, compareVersion } from "./utils.js";

const type_names = {
    extension: "扩展",
    theme: "主题",
    framework: "框架"
};
// 类型筛选项，与 manifest.type 对应，all 表示不过滤
const type_filters = [
    { value: "all", label: "全部" },
    { value: "extension", label: "扩展" },
    { value: "theme", label: "主题" },
    { value: "framework", label: "框架" }
];
const sort_options = [
    { value: "default", label: "默认排序" },
    { value: "installed", label: "已安装优先" },
    { value: "updatable", label: "可更新优先" }
];
// 加载态骨架卡片数量
const skeleton_count = 6;


// 建元素的小工具，省掉满屏 createElement + className
function create(tag, class_name, text) {
    const element = document.createElement(tag);
    if (class_name) element.className = class_name;
    if (text != null) element.textContent = text;
    return element;
}


export function initMarket(view) {
    const section = view.querySelector(".market");
    if (!section) return;
    // 市场接口可能不存在（旧版主进程），此时降级成提示而不是抛错
    const market = LiteLoader.api?.plugin?.market;

    const state = {
        entries: [],
        cards: [],
        installed: new Map(),
        keyword: "",
        type: "all",
        sort: "default",
        loading: false,
        error: null,
        // 信息获取失败、已被隐藏的条目数
        failed: 0
    };

    // ---------- 工具条 ----------
    const root = create("div", "market-root");
    const toolbar = create("div", "market-toolbar");

    const search_row = create("div", "market-toolbar-row");
    const search_input = create("input", "market-search");
    search_input.type = "text";
    search_input.placeholder = "搜索插件名、描述、作者或 slug";
    const refresh_button = create("button", "market-refresh", "刷新");
    refresh_button.type = "button";
    search_row.append(search_input, refresh_button);

    const filter_row = create("div", "market-toolbar-row");
    const chips = create("div", "market-chips");
    const chip_elements = new Map();
    for (const filter of type_filters) {
        const chip = create("button", "market-chip", filter.label);
        chip.type = "button";
        chip.dataset.type = filter.value;
        chip.classList.toggle("is-active", filter.value === state.type);
        chip.addEventListener("click", () => selectType(filter.value));
        chip_elements.set(filter.value, chip);
        chips.append(chip);
    }
    const sort_select = create("select", "market-sort");
    for (const option of sort_options) {
        const node = create("option", null, option.label);
        node.value = option.value;
        sort_select.append(node);
    }
    filter_row.append(chips, sort_select);

    const status_line = create("div", "market-status", "正在加载…");
    const grid = create("div", "market-grid");

    toolbar.append(search_row, filter_row, status_line);
    root.append(toolbar, grid);
    section.append(root);

    // 当前打开的弹层关闭函数，保证同一时间只有一个弹层
    let closeModal = null;

    // ---------- 状态查询 ----------
    function isInstalled(slug) {
        return !!slug && state.installed.has(slug);
    }

    function isUpdatable(entry) {
        const manifest = entry.manifest;
        if (!manifest?.slug || !isInstalled(manifest.slug)) return false;
        return compareVersion(manifest.version, state.installed.get(manifest.slug)) > 0;
    }

    function isRecordInstalled(record) {
        return isInstalled(record.entry.manifest?.slug);
    }

    function isRecordUpdatable(record) {
        return isUpdatable(record.entry);
    }

    function platformText(manifest) {
        return manifest?.platform?.length ? manifest.platform.join(" / ") : "全平台";
    }

    function typeText(manifest) {
        return type_names[manifest?.type] ?? type_names.extension;
    }

    // 图标地址：远程绝对地址直接用，否则拼 raw.githubusercontent 的相对路径
    function iconSource(entry) {
        const icon_path = `${entry.manifest?.icon ?? ""}`.replace(/^\.\//, "");
        if (!icon_path) return default_icon;
        if (/^https?:\/\//i.test(icon_path)) return icon_path;
        return `https://raw.githubusercontent.com/${entry.repo}/${entry.branch ?? "main"}/${icon_path}`;
    }

    function openExternal(url) {
        if (url) LiteLoader.api?.openExternal?.(url);
    }

    // ---------- 卡片 ----------
    function createCard(entry) {
        const manifest = entry.manifest;

        const card = create("div", "market-card");
        const head = create("div", "market-card-head");
        const icon = create("img", "market-card-icon");
        icon.alt = "";
        icon.loading = "lazy";
        const title = create("div", "market-card-title");
        const name = create("div", "market-card-name");
        const meta = create("div", "market-card-meta");
        const badges = create("div", "market-card-badges");
        const desc = create("div", "market-card-desc");
        const foot = create("div", "market-card-foot");
        const author = create("div", "market-card-author");
        const actions = create("div", "market-card-actions");

        title.append(name, meta);
        head.append(icon, title, badges);
        foot.append(author, actions);
        card.append(head, desc, foot);

        const record = {
            entry,
            element: card,
            search: "",
            type: manifest.type ?? "extension"
        };

        card.dataset.slug = manifest.slug ?? entry.repo ?? "";
        card.title = "点击查看详情";
        icon.src = iconSource(entry);
        icon.addEventListener("error", () => icon.src = default_icon, { once: true });

        name.textContent = manifest.name ?? manifest.slug ?? entry.repo;
        name.title = name.textContent;
        meta.textContent = `${typeText(manifest)} · v${manifest.version ?? "未知版本"}`;
        desc.textContent = manifest.description ?? "暂无描述";
        desc.title = desc.textContent;

        const author_names = (manifest.authors ?? []).map((item) => item?.name).filter(Boolean);
        author.textContent = `by ${author_names.length ? author_names.join("、") : "未知作者"}`;
        author.title = author.textContent;

        const install_button = create("button", "market-btn primary install", "安装");
        const update_button = create("button", "market-btn primary update", "更新");
        const uninstall_button = create("button", "market-btn ghost uninstall", "卸载");
        const detail_button = create("button", "market-btn ghost detail", "详情");
        for (const button of [install_button, update_button, uninstall_button, detail_button]) {
            button.type = "button";
            // 卡片本身可点击，按钮必须阻止冒泡
            button.addEventListener("click", (event) => event.stopPropagation());
        }
        install_button.addEventListener("click", () => installPlugin(entry, install_button));
        update_button.addEventListener("click", () => installPlugin(entry, update_button));
        uninstall_button.addEventListener("click", () => uninstallPlugin(entry, uninstall_button));
        detail_button.addEventListener("click", () => openModal(record));
        actions.append(install_button, update_button, uninstall_button, detail_button);

        card.addEventListener("click", () => openModal(record));

        record.search = [
            manifest.name,
            manifest.description,
            manifest.slug,
            manifest.version,
            author_names.join(" ")
        ].filter(Boolean).join(" ").toLowerCase();

        return record;
    }

    // 已安装集合变化后同步卡片的徽标与按钮
    function refreshCard(record) {
        const { entry, element } = record;
        const installed = isRecordInstalled(record);
        const updatable = isRecordUpdatable(record);

        element.classList.toggle("is-installed", installed);
        element.classList.toggle("is-updatable", updatable);

        const badges = element.querySelector(".market-card-badges");
        badges.textContent = null;
        if (installed) badges.append(create("span", "market-badge", "已安装"));
        if (updatable) badges.append(create("span", "market-badge is-update", "可更新"));

        element.querySelector(".install").hidden = installed;
        element.querySelector(".update").hidden = !updatable;
        element.querySelector(".uninstall").hidden = !installed;
    }

    // ---------- 骨架与占位 ----------
    function createSkeleton() {
        const card = create("div", "market-card is-skeleton");
        const head = create("div", "market-card-head");
        const icon = create("div", "market-skeleton-icon");
        const title = create("div", "market-card-title");
        const name = create("div", "market-skeleton-line");
        const meta = create("div", "market-skeleton-line short");
        const desc = create("div", "market-skeleton-line");
        const desc_short = create("div", "market-skeleton-line short");
        const foot = create("div", "market-card-foot");
        const foot_line = create("div", "market-skeleton-line short");

        title.append(name, meta);
        head.append(icon, title);
        foot.append(foot_line);
        card.append(head, desc, desc_short, foot);
        return card;
    }

    function createEmpty(text, action) {
        const empty = create("div", "market-empty");
        empty.append(create("div", "market-empty-text", text));
        if (action) {
            const button = create("button", "market-btn ghost", action.label);
            button.type = "button";
            button.addEventListener("click", action.action);
            empty.append(button);
        }
        return empty;
    }

    // ---------- 过滤与渲染 ----------
    function visibleCards() {
        const matched = state.cards.filter((record) => {
            if (state.keyword && !record.search.includes(state.keyword)) return false;
            return state.type == "all" || record.type == state.type;
        });
        if (state.sort == "installed") {
            matched.sort((left, right) => Number(isRecordInstalled(right)) - Number(isRecordInstalled(left)));
        }
        else if (state.sort == "updatable") {
            matched.sort((left, right) => Number(isRecordUpdatable(right)) - Number(isRecordUpdatable(left)));
        }
        return matched;
    }

    function setStatus(total, installed, updatable, failed = 0) {
        status_line.textContent = `共 ${total} 个 · 已安装 ${installed} 个 · 可更新 ${updatable} 个`
            + (failed > 0 ? ` · ${failed} 个获取失败已隐藏` : "");
    }

    function render() {
        grid.textContent = null;

        if (state.loading) {
            status_line.textContent = "正在加载…";
            for (let index = 0; index < skeleton_count; index++) grid.append(createSkeleton());
            return;
        }

        if (state.error) {
            setStatus(0, 0, 0, 0);
            grid.append(createEmpty(state.error, { label: "重试", action: () => load(true) }));
            return;
        }

        if (!state.cards.length) {
            setStatus(0, 0, 0, state.failed);
            const message = state.failed > 0 ? "插件信息全部获取失败，请检查网络后重试" : "插件市场暂时没有可用的插件";
            grid.append(createEmpty(message, { label: "重试", action: () => load(true) }));
            return;
        }

        const visible = visibleCards();
        if (!visible.length) {
            setStatus(0, 0, 0);
            grid.append(createEmpty("没有匹配的插件", { label: "清空筛选", action: resetFilters }));
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const record of visible) {
            refreshCard(record);
            fragment.append(record.element);
        }
        grid.append(fragment);

        // 统计口径与网格一致：都基于当前过滤后的可见条目
        const installed_count = visible.filter(isRecordInstalled).length;
        const updatable_count = visible.filter(isRecordUpdatable).length;
        setStatus(visible.length, installed_count, updatable_count, state.failed);
    }

    // ---------- 详情弹层 ----------
    function openModal(record) {
        closeModal?.();

        const { entry } = record;
        const manifest = entry.manifest;
        if (!manifest) return;

        const mask = create("div", "market-modal-mask");
        const modal = create("div", "market-modal");

        const head = create("div", "market-modal-head");
        const icon = create("img", "market-modal-icon");
        icon.alt = "";
        icon.src = iconSource(entry);
        icon.addEventListener("error", () => icon.src = default_icon, { once: true });
        const heading = create("div", "market-modal-heading");
        const name = create("div", "market-modal-name", manifest.name ?? manifest.slug ?? entry.repo);
        const meta = create("div", "market-modal-meta", [
            typeText(manifest),
            `v${manifest.version ?? "未知版本"}`,
            platformText(manifest)
        ].join(" · "));
        heading.append(name, meta);
        const close_button = create("button", "market-modal-close", "关闭");
        close_button.type = "button";
        head.append(icon, heading, close_button);

        const desc = create("div", "market-modal-desc", manifest.description ?? "暂无描述");

        const links = create("div", "market-modal-links");
        const author_names = (manifest.authors ?? []).filter((item) => item?.name);
        if (author_names.length) {
            const line = create("div", "market-modal-line");
            line.append(create("span", "market-modal-label", "作者："));
            author_names.forEach((item, index) => {
                if (index > 0) line.append(create("span", "market-modal-sep", " · "));
                if (item.link) {
                    const link = create("button", "market-link", item.name);
                    link.type = "button";
                    link.addEventListener("click", () => openExternal(item.link));
                    line.append(link);
                }
                else {
                    line.append(create("span", null, item.name));
                }
            });
            links.append(line);
        }
        if (entry.repo) {
            const line = create("div", "market-modal-line");
            line.append(create("span", "market-modal-label", "仓库："));
            const repo_link = create("button", "market-link", entry.repo);
            repo_link.type = "button";
            repo_link.addEventListener("click", () => openExternal(`https://github.com/${entry.repo}`));
            line.append(repo_link);
            links.append(line);
        }

        const foot = create("div", "market-modal-foot");
        const actions = create("div", "market-modal-actions");
        const install_button = create("button", "market-btn primary", "安装");
        const update_button = create("button", "market-btn primary", "更新");
        const uninstall_button = create("button", "market-btn ghost", "卸载");
        for (const button of [install_button, update_button, uninstall_button]) button.type = "button";
        install_button.hidden = isRecordInstalled(record);
        update_button.hidden = !isRecordUpdatable(record);
        uninstall_button.hidden = !isRecordInstalled(record);
        install_button.addEventListener("click", async () => {
            if (await installPlugin(entry, install_button)) close();
        });
        update_button.addEventListener("click", async () => {
            if (await installPlugin(entry, update_button)) close();
        });
        uninstall_button.addEventListener("click", async () => {
            if (await uninstallPlugin(entry, uninstall_button)) close();
        });
        actions.append(install_button, update_button, uninstall_button);
        foot.append(actions);

        modal.append(head, desc, links, foot);
        mask.append(modal);

        function close() {
            document.removeEventListener("keydown", on_keydown);
            mask.remove();
            closeModal = null;
        }

        function on_keydown(event) {
            if (event.key === "Escape") close();
        }

        close_button.addEventListener("click", close);
        mask.addEventListener("click", (event) => {
            if (event.target === mask) close();
        });
        document.addEventListener("keydown", on_keydown);
        closeModal = close;

        document.body.append(mask);
    }

    // ---------- 安装 / 卸载 ----------
    async function installPlugin(entry, button) {
        const manifest = entry.manifest;
        if (!manifest?.slug) {
            alert("该插件缺少 slug，无法安装");
            return false;
        }
        const url = `https://github.com/${entry.repo}/archive/refs/heads/${entry.branch ?? "main"}.zip`;
        const origin_text = button.textContent;
        button.textContent = "安装中…";
        button.disabled = true;
        try {
            const result = await market.install(manifest.slug, url);
            if (!result?.success) {
                alert(result?.message ?? "安装插件失败");
                return false;
            }
            state.installed.set(manifest.slug, manifest.version ?? null);
            alert("已安装，重启 QQ 后生效");
            render();
            return true;
        }
        catch (error) {
            alert(`安装插件失败：${error?.message ?? error}`);
            return false;
        }
        finally {
            button.textContent = origin_text;
            button.disabled = false;
        }
    }

    async function uninstallPlugin(entry, button) {
        const manifest = entry.manifest;
        if (!manifest?.slug) return false;
        if (!confirm(`确定要卸载插件 ${manifest.name ?? manifest.slug} 吗？`)) return false;

        const origin_text = button?.textContent;
        if (button) {
            button.textContent = "卸载中…";
            button.disabled = true;
        }
        try {
            const result = await market.uninstall(manifest.slug, false);
            if (!result?.success) {
                alert(result?.message ?? "卸载插件失败");
                return false;
            }
            state.installed.delete(manifest.slug);
            render();
            return true;
        }
        catch (error) {
            alert(`卸载插件失败：${error?.message ?? error}`);
            return false;
        }
        finally {
            if (button) {
                button.textContent = origin_text;
                button.disabled = false;
            }
        }
    }

    // ---------- 加载 ----------
    async function load(refresh) {
        if (!market) {
            state.loading = false;
            state.cards = [];
            state.failed = 0;
            state.error = "当前 LiteLoaderQQNT 未提供插件市场接口，无法使用该功能";
            render();
            return;
        }

        state.loading = true;
        state.error = null;
        refresh_button.disabled = true;
        refresh_button.textContent = "刷新中…";
        render();

        try {
            const [list_result, installed_result] = await Promise.all([market.list(refresh), market.installed()]);
            if (!list_result?.success) {
                state.cards = [];
                state.failed = 0;
                state.error = `获取插件市场失败：${list_result?.message ?? "未知错误"}`;
            }
            else {
                state.entries = Array.isArray(list_result.data) ? list_result.data : [];
                state.installed = new Map(
                    (Array.isArray(installed_result) ? installed_result : [])
                        .filter((plugin) => plugin?.slug)
                        .map((plugin) => [plugin.slug, plugin.version ?? null])
                );
                // 信息获取失败的条目直接隐藏、不生成卡片，只保留计数用于状态行提示
                state.failed = state.entries.filter((entry) => !entry.manifest).length;
                state.cards = state.entries.filter((entry) => entry.manifest).map(createCard);
            }
        }
        catch (error) {
            state.cards = [];
            state.failed = 0;
            state.error = `获取插件市场失败：${error?.message ?? error}`;
        }
        finally {
            state.loading = false;
            refresh_button.disabled = false;
            refresh_button.textContent = "刷新";
            render();
        }
    }

    // ---------- 筛选交互 ----------
    function selectType(type) {
        state.type = type;
        for (const [value, chip] of chip_elements) chip.classList.toggle("is-active", value === type);
        render();
    }

    function resetFilters() {
        search_input.value = "";
        state.keyword = "";
        selectType("all");
    }

    search_input.addEventListener("input", () => {
        state.keyword = search_input.value.trim().toLowerCase();
        render();
    });
    sort_select.addEventListener("change", () => {
        state.sort = sort_select.value;
        render();
    });
    refresh_button.addEventListener("click", () => load(true));

    load(false);
}

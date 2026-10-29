"""桌面/390px 管理台工程验收；不执行任何真实 QQ、空间或模型调用。

由 lead 启动 background=False 的临时数据后端后运行：
QQAGENT_TEST_URL=http://127.0.0.1:<协调端口> \
QQAGENT_BROWSER_TEST_DATA=<系统临时目录中的独立数据目录> \
QQAGENT_BROWSER_TEST_ALLOW_MUTATION=1 uv run python scripts/browser_acceptance.py

必须使用新建的空数据库和对应初始密码。所有外部能力入口均由浏览器路由
拦截为明确测试夹具；配置、人格、记忆、备份、恢复使用真实临时 HTTP 后端。
本脚本不启动服务，不写 .runtime，不保存 Cookie、密码、二维码或网络原文。
"""

import asyncio
import json
import os
import sqlite3
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PAGES = ("overview", "connection", "models", "persona", "friends", "qzone", "memory", "system")
SENTINEL = "[BROWSER_TEST_INPUT]  \n\n"
UNTRUSTED = '<img src=x onerror="window.__injected=1"> & " 测试'
PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
EXTERNAL_PATHS = {
    "/api/check/qq", "/api/check/qzone", "/api/check/model", "/api/check/search",
    "/api/login/qq", "/api/login/qzone", "/api/components",
    "/api/friends/sync", "/api/qzone/apply", "/api/test-send",
}


def environment():
    """只在明确授权的系统临时数据目录中允许破坏性工程验收。"""
    if os.environ.get("QQAGENT_BROWSER_TEST_ALLOW_MUTATION") != "1":
        raise RuntimeError("必须显式设置 QQAGENT_BROWSER_TEST_ALLOW_MUTATION=1；此脚本会修改并恢复临时数据库。")
    raw_url = os.environ.get("QQAGENT_TEST_URL", "")
    parsed = urlsplit(raw_url)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or not parsed.port or parsed.port in {13800, 62360}
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password):
        raise RuntimeError("须显式指定已协调的回环临时服务 URL；禁止默认正式端口、DSH 地址或带路径/凭据的 URL。")
    raw_data = os.environ.get("QQAGENT_BROWSER_TEST_DATA")
    if not raw_data:
        raise RuntimeError("必须显式指定 QQAGENT_BROWSER_TEST_DATA；不读取任何 .runtime 默认目录。")
    data = Path(raw_data).resolve(strict=True)
    temp_root = Path(tempfile.gettempdir()).resolve()
    # macOS 的 /tmp 与 tempfile.gettempdir() 可不同，均仅接受真实系统临时根。
    temp_roots = (temp_root, Path("/tmp").resolve())
    if (not any(data.is_relative_to(root) and data != root for root in temp_roots)
            or data.is_relative_to(ROOT) or any(part.startswith(".runtime") for part in data.parts)):
        raise RuntimeError("验收数据必须位于独立系统临时子目录，不能是项目目录或 .runtime*。")
    password_path = data / "admin-password.txt"
    database = data / "state.sqlite3"
    if not password_path.is_file() or not database.is_file():
        raise RuntimeError("临时后端尚未初始化，缺少密码或数据库。")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        for table in ("secrets", "personas", "friends", "memories", "events", "ledger", "usage"):
            if connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]:
                raise RuntimeError("验收前要求新建空数据目录；检测到已有业务数据，拒绝运行。")
        meta = dict(connection.execute("SELECT k,v FROM meta"))
        config = json.loads(meta["config"])
        if config["policy"]["enabled"] or config["channel"]["enabled"] or config["qzone"]["enabled"]:
            raise RuntimeError("临时实例必须关闭所有真实渠道和正式社交。")
        if not json.loads(meta["stop_all"]) or json.loads(meta["social_running"]):
            raise RuntimeError("临时实例必须为停止发信且未启动业务。")
    return raw_url.rstrip("/"), data, password_path.read_text().strip()


class Boundary:
    """只允许同源请求，外部能力固定由夹具响应，不能自动透传。"""
    def __init__(self, origin):
        self.origin = origin
        self.overrides = {}
        self.once = {}
        self.calls = []
        self.external_calls = []
        self.blocked_origins = 0
        self.friend_rows = None
        self.friend_permissions = {}

    async def route(self, route):
        request = route.request
        url = urlsplit(request.url)
        if f"{url.scheme}://{url.netloc}" != self.origin:
            self.blocked_origins += 1
            await route.abort("blockedbyclient")
            return
        path, method = url.path, request.method
        if not path.startswith("/api/"):
            await route.continue_()
            return
        self.calls.append((method, path))
        key = (method, path)
        fixture = self.once.pop(key, None) or self.overrides.get(key)
        if fixture:
            status, body = fixture
            if isinstance(body, str):
                await route.fulfill(status=status, content_type="text/plain", body=body)
            else:
                await route.fulfill(status=status, json=body)
            return
        if path == "/api/friends" and self.friend_rows is not None:
            if method == "GET":
                await route.fulfill(json=self.friend_rows)
                return
            if method == "PUT":
                payload = request.post_data_json
                self.friend_permissions[payload["id"]] = payload["permissions"]
                await route.fulfill(json={"saved": True})
                return
        if path not in EXTERNAL_PATHS:
            await route.continue_()
            return
        self.external_calls.append((method, path))
        if path.startswith("/api/check/"):
            await route.fulfill(json={"online": False, "verified": True, "checked": time.time(), "reason": "[测试夹具] 连接不可用；未调用任何真实平台"})
        elif path.startswith("/api/login/"):
            await route.fulfill(json={"note": "[测试夹具] 组件尚未生成二维码；未调用真实登录"})
        elif path == "/api/components":
            await route.fulfill(status=400, json={"detail": "[测试夹具] 本地组件控制不可用"})
        elif path == "/api/friends/sync":
            await route.fulfill(json={"count": len(self.friend_rows or []), "source": "测试夹具"})
        elif path == "/api/qzone/apply":
            await route.fulfill(status=502, json={"detail": "[测试夹具] 桥接应用失败；凭据已保存"})
        elif path == "/api/test-send":
            await route.fulfill(json={"status": "unknown", "detail": "[测试夹具] 未执行真实发送；模拟未知结果"})
        else:
            raise AssertionError("未显式处理的外部能力入口")


async def idle(page):
    # 管理台 CSP 禁止页面内 eval；wait_for_function 会被 CSP 拒绝，改用 CDP 求值轮询。
    for _ in range(120):
        ready = await page.evaluate(
            "() => { const m=document.querySelector('#main'); return Boolean(m && !m.inert && !m.hasAttribute('aria-busy')); }")
        if ready:
            return
        await asyncio.sleep(0.05)
    raise AssertionError("页面加载未完成（#main 持续 inert 或 aria-busy）")


async def click(page, selector):
    await page.locator(selector).click()
    await idle(page)


async def click_first(page, selector):
    # 表格里同一行有多个按钮；`:first-of-type` 只命中每行第一个 button，不能用来选第二类操作。
    await page.locator(selector).first.click()
    await idle(page)


async def navigate(page, name):
    await page.locator(f'#nav [data-page="{name}"]').click()
    await expect(page.locator("#main")).to_have_attribute("data-page", name)
    await idle(page)


async def toast_has(page, text):
    await expect(page.locator("#toast")).to_contain_text(text)


async def assert_layout(page, name):
    assert await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), f"页面横向溢出：{name}"
    await expect(page.locator("#logout")).to_be_visible()
    assert await page.locator("#main h1").count() == 1
    assert await page.locator("#main [onerror], #main [onclick], #main script").count() == 0, "不可信字段成为可执行 DOM"
    assert not await page.evaluate("Boolean(window.__injected)"), "发生注入"


async def theme_state(page):
    return await page.evaluate(
        "() => { const button = document.getElementById('theme-toggle');"
        " return {theme: document.documentElement.dataset.theme || '',"
        " bg: getComputedStyle(document.body).backgroundColor,"
        " ariaLabel: button ? button.getAttribute('aria-label') : null,"
        " pressed: button ? button.getAttribute('aria-pressed') : null}; }")


async def assert_theme_toggle(page):
    """验证 theme.js：切换生效、背景色变化、localStorage 持久化、刷新保持且不破坏布局。"""
    button = page.locator("#theme-toggle")
    await expect(button).to_be_visible()
    before = await theme_state(page)
    assert before["theme"] in ("light", "dark"), "首屏未由 theme.js 写入 data-theme"
    expected = "dark" if before["theme"] == "light" else "light"
    await button.click()
    after = await theme_state(page)
    assert after["theme"] == expected, f"点击 #theme-toggle 后主题未切换：{before['theme']} -> {after['theme']}"
    assert after["bg"] != before["bg"], "主题切换后页面背景色未变化"
    assert after["pressed"] == ("true" if expected == "dark" else "false"), "主题切换后 aria-pressed 未更新"
    assert after["ariaLabel"] and after["ariaLabel"] != before["ariaLabel"], "主题切换后 aria-label 未更新"
    stored = await page.evaluate("() => localStorage.getItem('qqagent-theme')")
    assert stored == expected, "主题偏好未持久化到 localStorage 的 qqagent-theme"
    await assert_layout(page, "theme-toggle")
    await page.reload()
    await expect(page.locator("#shell")).to_be_visible()
    await idle(page)
    restored = await theme_state(page)
    assert restored["theme"] == expected, "刷新后 data-theme 未保持用户选择"
    assert restored["bg"] == after["bg"], "刷新后背景色与所选主题不一致"
    await assert_layout(page, "theme-toggle-refresh")
    # 恢复初始主题，避免后续页面与截图受主题影响。
    await button.click()
    assert (await theme_state(page))["theme"] == before["theme"], "未能恢复初始主题"


async def download_bytes(page, selector):
    async with page.expect_download() as event:
        await click(page, selector)
    download = await event.value
    local_path = await download.path()
    content = Path(local_path).read_bytes()
    await download.delete()
    return content


async def login(page, password, wrong=False):
    await expect(page.locator("#login")).to_be_visible()
    if wrong:
        await page.fill("#password", "[WRONG_TEST_PASSWORD]")
        await page.locator("#login-form button").click()
        await expect(page.locator("#login-error")).to_contain_text("不正确")
    await page.fill("#password", password)
    await page.locator("#login-form button").click()
    await expect(page.locator("#shell")).to_be_visible()
    await idle(page)


async def scenario(browser, origin, password, width, out):
    label = "desktop" if width == 1440 else "mobile"
    context = await browser.new_context(viewport={"width": width, "height": 1000 if width == 1440 else 844}, locale="zh-CN", timezone_id="Asia/Shanghai", service_workers="block", accept_downloads=True)
    boundary = Boundary(origin)
    await context.route("**/*", boundary.route)
    page = await context.new_page()
    errors = []
    page.on("pageerror", lambda _: errors.append("pageerror"))
    accept_dialogs = {"value": True}

    async def dialog_handler(dialog):
        if accept_dialogs["value"]:
            await dialog.accept()
        else:
            await dialog.dismiss()

    page.on("dialog", dialog_handler)
    checks = []
    try:
        await page.goto(origin)
        await login(page, password, wrong=True)
        await assert_theme_toggle(page)
        assert not errors, "主题切换引发页面级 JavaScript 异常"
        checks.append("主题切换/背景变化/localStorage 持久化/刷新保持/无横向溢出")
        for name in PAGES:
            await navigate(page, name)
            await assert_layout(page, name)
        checks.append("八页面与窄屏无横向溢出/退出按钮可见")

        await navigate(page, "overview")
        count = len(boundary.external_calls)
        await click(page, "#health")
        assert len(boundary.external_calls) == count, "普通刷新触发外部连接"
        await page.screenshot(path=str(out / f"{label}-overview.png"), full_page=True)
        await click(page, "#simulate")
        await expect(page.locator("#simulation-result")).to_contain_text("全部通过")
        await click(page, "#run")
        await click(page, "#halt")
        await click(page, "#pause")
        await click(page, "#pause")
        await click(page, "#stop")
        await click(page, "#stop")
        checks.append("纯状态刷新/模拟验收/启停和两道持久安全控制")

        await navigate(page, "connection")
        await page.fill("#owner-id", "10001")
        await page.fill("#qq-token", "[FAKE_BROWSER_QQ_TOKEN]")
        await click(page, "#save-qq")
        await expect(page.locator("#qq-token")).to_have_value("")
        await expect(page.locator("#qq-token-state")).to_contain_text("已配置")
        await click(page, '[data-clear-secret="qq_token"]')
        await expect(page.locator("#qq-token-state")).to_contain_text("未配置")
        for channel in ("qq", "qzone"):
            await click(page, "#check-" + channel)
            await expect(page.locator(f"#{channel}-check")).to_contain_text("未通过")
            await click(page, "#" + channel + "-login")
            await expect(page.locator(f"#{channel}-qr")).to_contain_text("测试夹具")
        boundary.once[("POST", "/api/login/qq")] = (200, {"image": "https://external.invalid/private-qr", "note": UNTRUSTED})
        await click(page, "#qq-login")
        await toast_has(page, "格式不安全")
        assert await page.locator("#qq-qr img").count() == 0
        boundary.once[("POST", "/api/login/qq")] = (200, {"image": PNG, "expires_at": time.time() + 0.7, "note": "[测试图片，非二维码]"})
        await click(page, "#qq-login")
        await expect(page.locator("#qq-qr")).to_contain_text("已过期", timeout=5000)
        await page.locator("details summary").click()
        for action in ("start", "restart", "stop"):
            await click(page, f'[data-component="napcat"][data-action="{action}"]')
            await toast_has(page, "组件控制不可用")
        await page.fill("#qzone-cookie", "[FAKE_BROWSER_COOKIE]")
        await page.fill("#qzone-token", "[FAKE_BROWSER_QZONE_TOKEN]")
        await click(page, "#save-qzone-secret")
        await toast_has(page, "凭据保存步骤已完成")
        await expect(page.locator("#qzone-cookie")).to_have_value("")
        for secret in ("qzone_cookie", "qzone_token"):
            await click(page, f'[data-clear-secret="{secret}"]')
        await page.fill("#test-text", "[FIXED_TEST_SENTINEL]")
        await click(page, "#test-send")
        await expect(page.locator("#test-send")).to_be_disabled()
        await expect(page.locator("#test-result")).to_contain_text("禁止本会话")
        await assert_layout(page, "connection-fixtures")
        checks.append("凭据保存/清除/部分失败；外部按钮均夹具；二维码安全与过期；未知发送不重试")

        await navigate(page, "models")
        await expect(page.locator("#stickers")).to_be_disabled()
        # 默认推理强度 low，建议目录来自后端；应用推荐参数后数值写回表单但尚未保存。
        await expect(page.locator("#model-effort")).to_have_value("low")
        assert await page.locator("#model-preset-list option").count() >= 4, "模型建议目录未加载"
        await page.fill("#model-name", "deepseek-v4.1-flash")
        await click(page, "#apply-preset")
        await expect(page.locator("#model-context")).to_have_value("128000")
        await expect(page.locator("#model-output")).to_have_value("8000")
        await expect(page.locator("#model-effort")).to_have_value("low")
        await page.fill("#model-name", "[UNSAVED_MODEL]")
        await page.select_option("#model-kind", "vision_model")
        # 第二轮复用同一合成库，vision 配置可能已存在；关键是未保存值不得带入。
        await expect(page.locator("#model-name")).not_to_have_value("[UNSAVED_MODEL]")
        await page.fill("#model-name", "[VISION_FIXTURE]")
        await click(page, "#save-model")
        await page.select_option("#model-kind", "model")
        await page.fill("#model-timeout", "")
        count = boundary.calls.count(("PUT", "/api/config"))
        await click(page, "#save-model")
        await toast_has(page, "须为")
        assert boundary.calls.count(("PUT", "/api/config")) == count
        await page.fill("#model-timeout", "30")
        await page.fill("#model-key", "[FAKE_BROWSER_MODEL_KEY]")
        boundary.once[("PUT", "/api/secrets")] = (422, {"detail": [{"loc": ["body", "value"], "type": "value_error", "input": "[SECRET_MUST_NOT_RENDER]"}]})
        await click(page, "#save-model")
        await toast_has(page, "配置已保存，但 API Key 保存失败")
        assert "SECRET_MUST_NOT_RENDER" not in await page.locator("body").inner_text()
        await click(page, "#save-model")
        await click(page, '[data-clear-secret="model_key"]')
        await click(page, "#test-model")
        await expect(page.locator("#model-result")).to_contain_text("未通过")
        await page.check("#vision")
        await click(page, "#save-tools")
        await page.uncheck("#vision")
        await click(page, "#save-tools")
        checks.append("模型切换保护/数值非空/凭据部分失败脱敏/未实现能力不可启用")

        # 联网搜索：配置、凭据保存与外部连通测试均由夹具拦截，真实调用为零。
        await page.check("#search-enabled")
        await page.fill("#search-url", "https://api.example.com/v1")
        await page.fill("#search-max", "5")
        await page.fill("#search-key", "[FAKE_SEARCH_KEY]")
        await click(page, "#save-search")
        await expect(page.locator("#search-key")).to_have_value("")
        await click(page, "#test-search")
        await expect(page.locator("#search-result")).to_contain_text("未通过")
        await click(page, '[data-clear-secret="search_key"]')
        checks.append("联网搜索配置/凭据保存/外部测试夹具")

        await navigate(page, "persona")
        # 第二轮已保存过人格；先清空，再验证空白原文不能启用。
        await page.fill("#persona-body", "")
        await expect(page.locator("#persona-body")).to_have_value("")
        await click(page, "#activate-new")
        await toast_has(page, "空白人格不能启用")
        await page.set_input_files("#persona-file", {"name": "invalid.txt", "mimeType": "text/plain", "buffer": b"\xff\xfe\xfa"})
        await toast_has(page, "UTF-8")
        await page.set_input_files("#persona-file", {"name": "persona.txt", "mimeType": "text/plain", "buffer": SENTINEL.encode()})
        await expect(page.locator("#persona-body")).to_have_value(SENTINEL)
        assert (await download_bytes(page, "#export-persona")).decode() == SENTINEL
        await click(page, "#draft")
        await click_first(page, "[data-view]")
        await expect(page.locator("#persona-body")).to_have_value(SENTINEL)
        await click(page, "#activate-new")
        await expect(page.locator("#main")).to_contain_text("生效版本")
        await click(page, "#disable-persona")
        await click_first(page, "[data-activate]")
        await page.check("#growth")
        await click(page, "#save-growth")
        checks.append("人格空白门禁/UTF-8导入/精确草稿导出/启用停用与历史恢复")

        await navigate(page, "friends")
        await expect(page.locator("#friend-table")).to_contain_text("尚无已同步好友")
        # 特意包含属性边界字符，证明它只能成为文本而非 HTML/选择器。
        unusual_id = '10002\" data-unsafe=\"x'
        boundary.friend_rows = [
            {"id": "10001", "name": UNTRUSTED, "permissions": "{}", "optout": "{}", "updated": time.time(), "last_interaction": time.time(), "cooldown_until": time.time() + 3600},
            {"id": unusual_id, "name": "[属性边界夹具]", "permissions": "{}", "optout": "{}", "updated": time.time()},
        ]
        await click(page, "#sync-friends")
        await expect(page.locator("#friend-table")).to_contain_text(UNTRUSTED)
        await page.locator('[data-friend="10001"][data-perm="reply"]').check()
        await page.fill("#friend-search", "不存在的好友")
        await expect(page.locator("#friend-table")).to_contain_text("没有匹配")
        await page.fill("#friend-search", "")
        await expect(page.locator('[data-friend="10001"][data-perm="reply"]')).to_be_checked()
        await click(page, '[data-savefriend="10001"]')
        assert boundary.friend_permissions["10001"]["reply"] is True
        await page.check("#default-read")
        await click(page, "#save-default")
        await page.uncheck("#default-read")
        await click(page, "#save-default")
        await assert_layout(page, "friends-untrusted")
        boundary.friend_rows = None
        checks.append("好友空状态/独立授权/搜索保留草稿/默认权限/冷却/字段注入")

        await navigate(page, "qzone")
        await expect(page.locator("#main")).to_contain_text("暂无已记录空间事件")
        await click(page, "#save-qzone")
        await click(page, "#qzone-probe")
        await expect(page.locator("#qzone-probe-result")).to_contain_text("未通过")
        checks.append("空间策略保存/空状态/只读检查失败")

        await navigate(page, "memory")
        await click(page, "#search-memory")
        await toast_has(page, "请填写好友 QQ")
        await page.fill("#memory-friend", "10001")
        await click(page, "#search-memory")
        await expect(page.locator("#memory-table")).to_contain_text("没有匹配记录")
        await page.locator("#memory-editor summary").click()
        await click(page, "#save-memory")
        await toast_has(page, "正文和来源不能为空")
        await page.fill("#memory-body", UNTRUSTED)
        await page.fill("#memory-source", "[FIXTURE_SOURCE]")
        await click(page, "#save-memory")
        await expect(page.locator("#memory-table")).to_contain_text(UNTRUSTED)
        await click(page, "[data-editmemory]")
        await expect(page.locator("#memory-id")).to_have_attribute("readonly", "")
        await page.fill("#memory-body", "[EDITED_MEMORY]")
        await click(page, "#save-memory")
        await click(page, "[data-editmemory]")
        await page.fill("#memory-friend", "20002")
        await page.locator("#memory-search").click()
        await expect(page.locator("#memory-body")).to_have_value("")
        await click(page, "#search-memory")
        await expect(page.locator("#memory-table")).not_to_contain_text("[EDITED_MEMORY]")
        await page.fill("#memory-friend", "10001")
        await click(page, "#search-memory")
        exported = json.loads(await download_bytes(page, "#export-memory"))
        assert exported and all(row["friend"] == "10001" for row in exported)
        await click(page, "[data-delete]")
        await expect(page.locator("#memory-table")).to_contain_text("没有匹配记录")
        await page.select_option("#memory-scope", "public")
        await expect(page.locator("#memory-friend")).to_be_disabled()
        await page.fill("#memory-body", "[PUBLIC_GROWTH_FIXTURE]")
        await page.fill("#memory-source", "[OWNER_SOURCE]")
        await click(page, "#save-memory")
        await expect(page.locator("#memory-table")).to_contain_text("[PUBLIC_GROWTH_FIXTURE]")
        public = json.loads(await download_bytes(page, "#export-memory"))
        assert public and all(row["friend"] == "" and row["kind"] == "growth" for row in public)
        await click(page, "[data-delete]")
        await click(page, "#new-memory")
        await click(page, "#load-activity")
        await page.fill("#log-result", "[NO_MATCH]")
        await click(page, "#load-activity")
        await expect(page.locator("#activity-table")).to_contain_text("暂无记录")
        await assert_layout(page, "memory-loaded")
        checks.append("好友隔离CRUD/范围切换清除/公开成长CRUD/导出/账本筛选")

        await navigate(page, "system")
        await page.fill("#policy-cost_daily", "0.25")
        await click(page, "#save-policy")
        await toast_has(page, "策略已保存")
        boundary.once[("PUT", "/api/config")] = (409, {"detail": "[测试夹具] 配置已变化，请刷新后重新编辑"})
        await page.fill("#policy-total_daily", "99")
        await click(page, "#save-policy")
        await toast_has(page, "配置已变化")
        await expect(page.locator("#policy-total_daily")).to_have_value("99")
        await click(page, "#save-policy")
        backup = await download_bytes(page, "#backup")
        assert json.loads(backup)
        diagnostics = json.loads(await download_bytes(page, "#diagnostics"))
        assert "privacy" in diagnostics
        await click(page, "#restore")
        await toast_has(page, "请先选择")
        await page.set_input_files("#restore-file", {"name": "invalid.json", "mimeType": "application/json", "buffer": b"not-json"})
        count = boundary.calls.count(("POST", "/api/backup/restore"))
        await click(page, "#restore")
        await toast_has(page, "未发送恢复请求")
        assert boundary.calls.count(("POST", "/api/backup/restore")) == count
        await page.set_input_files("#restore-file", {"name": "invalid-shape.json", "mimeType": "application/json", "buffer": b"{}"})
        await click(page, "#restore")
        await expect(page.locator("#toast.error")).to_be_visible()
        await expect(page.locator("#shell")).to_be_visible()
        await page.set_input_files("#restore-file", {"name": "backup.json", "mimeType": "application/json", "buffer": backup})
        await click(page, "#restore")
        await expect(page.locator("#login")).to_be_visible()
        await expect(page.locator("#main")).to_be_empty()
        await login(page, password)
        await navigate(page, "overview")
        await expect(page.locator("#stop")).to_contain_text("解除全部发信停止")
        checks.append("预算小数/配置冲突/备份诊断/无文件和畸形恢复/真实临时恢复后重新登录")

        boundary.once[("GET", "/api/config")] = (503, "[NON_JSON_TEST_FAILURE]")
        await page.locator('[data-page="models"]').click()
        await expect(page.locator("#retry-page")).to_be_visible()
        await expect(page.locator("#main")).to_contain_text("页面加载失败")
        await click(page, "#retry-page")
        await expect(page.locator("#main")).to_have_attribute("data-page", "models")
        await page.fill("#model-name", "[DIRTY_NAVIGATION_SENTINEL]")
        accept_dialogs["value"] = False
        await page.locator('[data-page="overview"]').click()
        await expect(page.locator("#model-name")).to_have_value("[DIRTY_NAVIGATION_SENTINEL]")
        accept_dialogs["value"] = True
        await navigate(page, "overview")
        boundary.once[("GET", "/api/status")] = (401, {"detail": "[测试夹具] 会话失效"})
        await click(page, "#health")
        await expect(page.locator("#login")).to_be_visible()
        await expect(page.locator("#main")).to_be_empty()
        await login(page, password)
        await click(page, "#logout")
        await expect(page.locator("#main")).to_be_empty()
        checks.append("非JSON失败/重试/未保存离页取消/401清除隐私DOM/退出")
        assert not errors, "浏览器发生页面级 JavaScript 异常"
        assert boundary.blocked_origins == 0, "页面尝试请求非同源地址"
        assert set(path for _, path in boundary.external_calls) == EXTERNAL_PATHS
        return {"viewport": width, "checks": checks, "page_errors": len(errors), "external_calls": "全部被测试夹具拦截，真实调用为零"}
    finally:
        await context.close()


async def main():
    origin, data, password = environment()
    out = data / "browser-output"
    out.mkdir(exist_ok=True)
    results = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            # 两种尺寸独立会话；第二轮复用第一轮留下的合成数据，不混入真实数据。
            for width in (1440, 390):
                results.append(await scenario(browser, origin, password, width, out))
        finally:
            await browser.close()
    report = {"mode": "真实临时HTTP后端 + 无头浏览器 + 外部能力边界夹具", "headless": True, "real_qq_qzone_model_acceptance": False, "results": results}
    (out / "browser-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

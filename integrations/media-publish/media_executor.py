"""MediaPublishPlatform compatible executor.

The Node workbench owns accounts, materials and task records. This small Flask
service only adapts the task payload to the original project's uploader core.
It deliberately does not duplicate the target project's web UI or database.
"""

import os
import sys
import asyncio
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

HERE = Path(__file__).resolve().parent
BACKEND = HERE / 'sau_backend'
sys.path.insert(0, str(BACKEND))

from newFileUpload.multiFileUploader import post_multiple_files_to_multiple_platforms
from newFileUpload.platform_configs import PLATFORM_CONFIGS
from utils.base_social_media import set_init_script
from playwright.async_api import async_playwright

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024
TOKEN = os.environ.get('XFC_MEDIA_EXECUTOR_TOKEN', '')
LOGIN_JOBS = {}
PLATFORM_ALIASES = {'wechat_channels': 'tencent'}


def authorized():
    if not TOKEN:
        return True
    return request.headers.get('Authorization', '') == f'Bearer {TOKEN}'


def platform_key(key):
    return PLATFORM_ALIASES.get(str(key), str(key))


def material_groups(materials):
    groups = {1: [], 2: []}
    for material in materials:
        file_path = str(material.get('absolute_path', ''))
        mime_type = str(material.get('mime_type', '')).lower()
        suffix = Path(file_path).suffix.lower()
        file_type = 1 if mime_type.startswith('image/') or suffix in {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'} else 2
        groups[file_type].append(file_path)
    return [(file_type, files) for file_type, files in groups.items() if files]


def merge_results(target, result):
    for platform, item in result.items():
        current = target.setdefault(platform, {'success': 0, 'total': 0})
        current['success'] += int(item.get('success', 0))
        current['total'] += int(item.get('total', 0))


def _log_path(platform):
    source_root = Path(os.environ.get('XFC_MEDIA_SOURCE_ROOT', HERE.parent.parent))
    return source_root / 'logs' / f'{platform}.log'


def _log_sizes(platforms):
    sizes = {}
    for platform in platforms:
        try:
            sizes[platform] = _log_path(platform).stat().st_size
        except OSError:
            sizes[platform] = 0
    return sizes


def _collect_errors(platforms, start_sizes):
    errors = {}
    for platform in platforms:
        log_path = _log_path(platform)
        try:
            with log_path.open('rb') as handle:
                start = start_sizes.get(platform, 0)
                handle.seek(start if log_path.stat().st_size >= start else 0)
                text = handle.read().decode('utf-8', errors='replace')
        except OSError:
            continue
        lines = [line.strip() for line in text.splitlines() if 'ERROR' in line]
        if lines:
            errors[platform] = lines[-1][-1000:]
    return errors


async def login_browser(job_id, platform, cookie_path):
    config = PLATFORM_CONFIGS.get(platform_key(platform))
    if not config:
        raise ValueError(f'不支持的平台: {platform}')
    configured_executable = os.environ.get('XFC_MEDIA_CHROME_PATH', '')
    executable = configured_executable if configured_executable and Path(configured_executable).is_file() else None
    browser = None
    context = None
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                headless=False,
                executable_path=executable,
                args=[
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--ignore-certificate-errors',
                    '--start-maximized',
                    '--disable-blink-features=AutomationControlled',
                ],
            )
            context = await browser.new_context()
            context = await set_init_script(context)
            page = await context.new_page()
            await page.goto(config['login_url'], wait_until='domcontentloaded', timeout=60000)
            deadline = time.time() + 300
            while time.time() < deadline:
                current_url = page.url.lower()
                if 'login' not in current_url:
                    Path(cookie_path).parent.mkdir(parents=True, exist_ok=True)
                    await context.storage_state(path=cookie_path)
                    LOGIN_JOBS[job_id].update({'status': 'success', 'cookie_path': cookie_path, 'message': '登录态已保存'})
                    return
                await asyncio.sleep(1.5)
            raise TimeoutError('等待登录超时（5分钟）')
    finally:
        if context is not None:
            try:
                await context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass


def begin_login(platform, cookie_path):
    job_id = f'login-{uuid.uuid4().hex[:12]}'
    LOGIN_JOBS[job_id] = {'id': job_id, 'status': 'running', 'platform': platform, 'message': '浏览器已打开，请完成登录'}

    def worker():
        try:
            asyncio.run(login_browser(job_id, platform, cookie_path))
        except Exception as exc:
            LOGIN_JOBS[job_id].update({'status': 'failed', 'message': str(exc)})

    threading.Thread(target=worker, daemon=True).start()
    return LOGIN_JOBS[job_id]


@app.get('/health')
def health():
    if not authorized():
        return jsonify({'ok': False, 'error': 'unauthorized'}), 401
    return jsonify({'ok': True, 'service': 'media-publish-executor', 'platforms': [
        'xiaohongshu', 'wechat_channels', 'douyin', 'kuaishou', 'tiktok',
        'instagram', 'facebook', 'bilibili', 'baijiahao',
    ]})


@app.post('/accounts/login')
def login_account():
    if not authorized():
        return jsonify({'ok': False, 'error': 'unauthorized'}), 401
    payload = request.get_json(silent=True) or {}
    platform = str(payload.get('platform', ''))
    cookie_path = str(payload.get('cookie_path', ''))
    allowed_root = Path(os.environ.get('XFC_MEDIA_COOKIE_DIR', HERE / 'cookiesFile')).resolve()
    target = Path(cookie_path).resolve()
    if not cookie_path or allowed_root not in target.parents:
        return jsonify({'ok': False, 'error': '登录态路径不合法'}), 400
    if platform_key(platform) not in PLATFORM_CONFIGS:
        return jsonify({'ok': False, 'error': f'不支持的平台: {platform}'}), 400
    return jsonify({'ok': True, 'job': begin_login(platform, str(target))['id']})


@app.get('/accounts/login/status/<job_id>')
def login_status(job_id):
    if not authorized():
        return jsonify({'ok': False, 'error': 'unauthorized'}), 401
    return jsonify(LOGIN_JOBS.get(job_id, {'status': 'missing', 'message': '登录任务不存在'}))


@app.post('/tasks')
def execute_task():
    if not authorized():
        return jsonify({'status': 'failed', 'error': 'unauthorized'}), 401
    payload = request.get_json(silent=True) or {}
    platforms = [str(value) for value in payload.get('platforms', [])]
    accounts = payload.get('accounts', [])
    materials = payload.get('materials', [])
    if not platforms or not accounts or not materials:
        return jsonify({'status': 'failed', 'error': 'platforms, accounts and materials are required'}), 400

    normalized_platforms = [platform_key(value) for value in platforms]
    account_files = {}
    for account in accounts:
        platform = platform_key(account.get('platform', ''))
        cookie_path = str(account.get('cookie_path', ''))
        if platform in normalized_platforms and cookie_path:
            account_files.setdefault(platform, []).append(cookie_path)
    missing = [platform for platform in normalized_platforms if not account_files.get(platform)]
    if missing:
        return jsonify({'status': 'failed', 'error': f'未配置这些平台的登录态: {", ".join(missing)}'}), 400

    files = [str(material.get('absolute_path', '')) for material in materials]
    missing_files = [file_path for file_path in files if not file_path or not Path(file_path).is_file()]
    if missing_files:
        return jsonify({'status': 'failed', 'error': '素材文件不存在或无法读取'}), 400

    try:
        result = {}
        log_sizes = _log_sizes(normalized_platforms)
        for file_type, group_files in material_groups(materials):
            merge_results(result, post_multiple_files_to_multiple_platforms(
                platforms=normalized_platforms,
                account_files=account_files,
                file_type=file_type,
                files=group_files,
                title=str(payload.get('title', '')),
                text=str(payload.get('content', '')),
                tags=payload.get('topics', []),
                thumbnail_path='',
                location='',
                enableTimer=False,
            ))
        errors = _collect_errors(normalized_platforms, log_sizes)
        for platform, item in result.items():
            if int(item.get('success', 0)) < int(item.get('total', 0)) and platform in errors:
                item['error'] = errors[platform]
        success = bool(result) and all(int(item.get('success', 0)) >= int(item.get('total', 0)) for item in result.values())
        error_messages = [f"{platform}: {item['error']}" for platform, item in result.items() if item.get('error')]
        return jsonify({
            'status': 'success' if success else 'failed',
            'results': result,
            'error': '; '.join(error_messages)[:2000] if error_messages else ('' if success else '平台发布失败，请查看执行器日志'),
        })
    except Exception as exc:
        return jsonify({'status': 'failed', 'error': str(exc)}), 500


if __name__ == '__main__':
    host = os.environ.get('XFC_MEDIA_EXECUTOR_HOST', '127.0.0.1')
    port = int(os.environ.get('XFC_MEDIA_EXECUTOR_PORT', '5409'))
    app.run(host=host, port=port, threaded=True)

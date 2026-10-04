from pathlib import Path
from sys import stdout
from loguru import logger

from conf import BASE_DIR

_configured_log_files = set()


def log_formatter(record: dict) -> str:
    """
    Formatter for log records.
    :param dict record: Log object containing log metadata & message.
    :returns: str
    """
    colors = {
        "TRACE": "#cfe2f3",
        "INFO": "#9cbfdd",
        "DEBUG": "#8598ea",
        "WARNING": "#dcad5a",
        "SUCCESS": "#3dd08d",
        "ERROR": "#ae2c2c"
    }
    color = colors.get(record["level"].name, "#b3cfe7")
    return f"<fg #70acde>{{time:YYYY-MM-DD HH:mm:ss}}</fg #70acde> | <fg {color}>{{level}}</fg {color}>: <light-white>{{message}}</light-white>\n"


def create_logger(log_name: str, file_path: str):
    """
    Create custom logger for different business modules.
    :param str log_name: name of log
    :param str file_path: Optional path to log file
    :returns: Configured logger
    """
    def filter_record(record):
        return record["extra"].get("business_name") == log_name

    log_file = Path(BASE_DIR / file_path).resolve()
    log_file.parent.mkdir(parents=True, exist_ok=True)
    # Uploaders are created once per account/file. Keep one sink per file so
    # retries do not duplicate every log line and obscure the real error.
    if log_file not in _configured_log_files:
        logger.add(log_file, filter=filter_record, level="INFO", rotation="10 MB", retention="10 days", backtrace=True, diagnose=True)
        _configured_log_files.add(log_file)
    return logger.bind(business_name=log_name)


# Remove all existing handlers
logger.remove()
# Add a standard console handler
logger.add(stdout, colorize=True, format=log_formatter)

douyin_logger = create_logger('douyin', 'logs/douyin.log')
tencent_logger = create_logger('tencent', 'logs/tencent.log')
xhs_logger = create_logger('xhs', 'logs/xhs.log')
tiktok_logger = create_logger('tiktok', 'logs/tiktok.log')
bilibili_logger = create_logger('bilibili', 'logs/bilibili.log')
kuaishou_logger = create_logger('kuaishou', 'logs/kuaishou.log')
baijiahao_logger = create_logger('baijiahao', 'logs/baijiahao.log')
xiaohongshu_logger = create_logger('xiaohongshu', 'logs/xiaohongshu.log')
instagram_logger = create_logger('instagram', 'logs/instagram.log')
facebook_logger = create_logger('facebook', 'logs/facebook.log')

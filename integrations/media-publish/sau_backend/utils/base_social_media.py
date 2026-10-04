from pathlib import Path
from typing import List

from conf import BASE_DIR

SOCIAL_MEDIA_DOUYIN = "douyin"
SOCIAL_MEDIA_TENCENT = "tencent"
SOCIAL_MEDIA_TIKTOK = "tiktok"
SOCIAL_MEDIA_BILIBILI = "bilibili"
SOCIAL_MEDIA_KUAISHOU = "kuaishou"


def get_supported_social_media() -> List[str]:
    return [SOCIAL_MEDIA_DOUYIN, SOCIAL_MEDIA_TENCENT, SOCIAL_MEDIA_TIKTOK, SOCIAL_MEDIA_KUAISHOU]


def get_cli_action() -> List[str]:
    return ["upload", "login", "watch"]


async def set_init_script(context):
    # The integrated executor keeps the source tree under integrations/media-publish;
    # BASE_DIR points to the host application's data root for media and cookies.
    stealth_js_path = Path(__file__).resolve().with_name("stealth.min.js")
    if not stealth_js_path.is_file():
        stealth_js_path = Path(BASE_DIR / "sau_backend/utils/stealth.min.js")
    await context.add_init_script(path=stealth_js_path)
    return context

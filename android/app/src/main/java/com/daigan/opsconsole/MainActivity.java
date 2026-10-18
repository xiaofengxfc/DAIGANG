package com.daigan.opsconsole;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 手机端外壳：一个 WebView，指向电脑上正在运行的服务。
 *
 * 为什么不把前端打进来：
 * 后端是 Node + node:sqlite + PowerShell + Python，跑不到 Android 上。
 * 把 dist 打进 APK 也只是个空壳，/api 会打到手机本地、登录也过不去。
 * 直接加载 http://<电脑IP>:8787，页面 origin 就是服务器本身，
 * Cookie 会话、CSP 的 'self'、相对路径 /api 全部天然成立。
 *
 * 界面全部用代码搭，不引 AndroidX：整个 App 只有一块 WebView 和一个
 * 连不上时的提示页，没有状态、没有列表，不值得为它背一个依赖库。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "daigan";
    private static final String KEY_URL = "server";
    private static final int REQUEST_FILE = 1001;
    private static final int CANVAS = 0xFFF5F5F7;
    private static final int INK = 0xFF1A1A1A;
    private static final int INK_2 = 0xFF666666;
    private static final int LINE = 0xFFDDDDDD;

    private SharedPreferences prefs;
    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;
    private View errorView;
    private TextView errorText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(CANVAS);
        setContentView(root);

        buildWebView();

        String saved = prefs.getString(KEY_URL, "");
        if (saved.isEmpty()) {
            askServer(null);
        } else {
            load(saved);
        }
    }

    /* ---------------- WebView ---------------- */

    private void buildWebView() {
        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(CANVAS);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        // 页面里已经写了 viewport-fit=cover，这里再按屏幕宽度缩放会把它压扁
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String target = uri.toString();
                // 站内的相对跳转继续留在 WebView；站外的交给系统浏览器
                if (target.startsWith(origin())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // 没有浏览器可打开就什么都不做，别把 App 崩掉
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideError();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError err) {
                // 只认主文档的失败。图片、图标加载不出来不算「连不上」，
                // 那种情况页面自己会画占位，不该抢屏。
                if (request.isForMainFrame()) {
                    showError("连不上这台电脑上的服务。\n确认电脑上的启动窗口还开着，并且手机和电脑连的是同一个 WiFi。");
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /**
             * 页面里的 window.confirm 在 WebView 里默认**什么都不做**：
             * 回调不回来，JS 就一直等着 —— 表现是点「删除」毫无反应。
             * 这两处确认框（删素材、删账号）必须由外壳画出来。
             */
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (d, w) -> result.confirm())
                        .setNegativeButton("取消", (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            /**
             * <input type="file"> 同理：不接管就永远不弹选择器。
             * 素材上传、登录态 JSON 导入、备份恢复都靠它。
             */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        root.addView(web);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (filePathCallback != null) {
            // createIntent 的结果既可能带 Uri，也可能带 ClipData（多选），
            // 只读 data.getData() 会漏掉多选的那几个文件。
            filePathCallback.onReceiveValue(
                    WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
        }
    }

    private void load(String base) {
        String url = normalize(base);
        prefs.edit().putString(KEY_URL, url).apply();
        hideError();
        web.loadUrl(url);
    }

    /** 用户可能只填了 IP，或者填了带结尾斜杠的地址，这里统一成 http://host:port */
    private static String normalize(String input) {
        String v = input.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    private String origin() {
        String v = prefs.getString(KEY_URL, "");
        return v.isEmpty() ? "http://127.0.0.1" : v;
    }

    /* ---------------- 连不上时的提示页 ---------------- */

    private void showError(String message) {
        if (errorView == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(CANVAS);
            int pad = dp(28);
            box.setPadding(pad, pad, pad, pad);

            TextView title = new TextView(this);
            title.setText("连不上");
            title.setTextColor(INK);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            box.addView(title);

            errorText = new TextView(this);
            errorText.setTextColor(INK_2);
            errorText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            errorText.setLineSpacing(dp(3), 1f);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            tp.topMargin = dp(10);
            box.addView(errorText, tp);

            Button retry = plainButton("重试");
            retry.setOnClickListener(v -> {
                String saved = prefs.getString(KEY_URL, "");
                if (saved.isEmpty()) askServer(null);
                else {
                    hideError();
                    web.loadUrl(saved);
                }
            });

            Button change = plainButton("改地址");
            change.setOnClickListener(v -> askServer(prefs.getString(KEY_URL, "")));

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rp.topMargin = dp(22);
            row.addView(retry);
            row.addView(change);
            box.addView(row, rp);

            errorView = box;
            root.addView(errorView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        errorText.setText(message);
        errorView.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        if (errorView != null) errorView.setVisibility(View.GONE);
    }

    private Button plainButton(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(INK);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(10);
        b.setLayoutParams(lp);
        return b;
    }

    /* ---------------- 首次启动 / 改地址 ---------------- */

    private void askServer(String current) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("192.168.1.10:8787");
        input.setText(current == null ? "" : current.replaceFirst("^https?://", ""));
        input.setSingleLine(true);
        int pad = dp(20);
        input.setPadding(pad, dp(6), pad, dp(6));

        new AlertDialog.Builder(this)
                .setTitle("电脑上的地址")
                .setMessage("电脑启动服务时，窗口里会打印一行「手机打开」的地址，把它填在这里。")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("连接", (d, w) -> load(input.getText().toString()))
                .setNegativeButton(current == null ? "退出" : "取消", (d, w) -> {
                    if (current == null) finish();
                })
                .show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /* ---------------- 返回键 ---------------- */

    @Override
    public void onBackPressed() {
        if (errorView != null && errorView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }
}

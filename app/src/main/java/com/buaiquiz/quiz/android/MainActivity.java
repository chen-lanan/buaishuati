package com.buaiquiz.quiz.android;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class MainActivity extends Activity {
    private static final int PICK_FILE_REQUEST = 4102;
    private static final String HOME_URL = "file:///android_asset/web/index.html";
    private static final String PREFS = "quiz-storage";

    private WebView webView;
    private boolean immersiveEnabled = true;
    private boolean darkSystemBars = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.TRANSPARENT);
        configureWebView(webView);
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        setContentView(webView);
        applySystemBars(true, isSystemDarkModeInternal());
        webView.loadUrl(HOME_URL);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
        disableForceDarkCompat(settings);

        view.removeJavascriptInterface("searchBoxJavaBridge_");
        view.removeJavascriptInterface("accessibility");
        view.removeJavascriptInterface("accessibilityTraversal");
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient());
    }

    private static void disableForceDarkCompat(WebSettings settings) {
        if (settings == null || Build.VERSION.SDK_INT < 29) return;
        try {
            int forceDarkOff = WebSettings.class.getField("FORCE_DARK_OFF").getInt(null);
            WebSettings.class.getMethod("setForceDark", Integer.TYPE).invoke(settings, forceDarkOff);
        } catch (Throwable ignored) {
        }
    }

    private static void disableContrastEnforcementCompat(Window window) {
        if (window == null || Build.VERSION.SDK_INT < 29) return;
        try {
            Window.class.getMethod("setStatusBarContrastEnforced", Boolean.TYPE).invoke(window, false);
        } catch (Throwable ignored) {
        }
        try {
            Window.class.getMethod("setNavigationBarContrastEnforced", Boolean.TYPE).invoke(window, false);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onBackPressed() {
        callJavascript("window.__androidBack&&window.__androidBack()");
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        callJavascript("window.__onNativeSystemThemeChanged&&window.__onNativeSystemThemeChanged()");
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILE_REQUEST) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            dispatchFileError("cancel");
            return;
        }
        try {
            JSONObject picked = copyPickedFile(data.getData());
            callJavascript("window.__onNativeFileChosen&&window.__onNativeFileChosen(" + picked.toString() + ")");
        } catch (Exception error) {
            dispatchFileError(error.getMessage() == null ? "文件读取失败" : error.getMessage());
        }
    }

    private JSONObject copyPickedFile(Uri uri) throws Exception {
        ContentResolver resolver = getContentResolver();
        String displayName = queryDisplayName(uri);
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = uri.getLastPathSegment();
        }
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = "import_" + System.currentTimeMillis();
        }
        displayName = displayName.replaceAll("[\\\\/:*?\"<>|]", "_");

        File directory = new File(getCacheDir(), "picked-files");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("无法创建文件缓存目录");
        }
        File target = new File(directory, UUID.randomUUID().toString() + "_" + displayName);
        try (InputStream input = new BufferedInputStream(resolver.openInputStream(uri));
             OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
            if (input == null) throw new IllegalStateException("无法打开所选文件");
            copy(input, output);
        }

        JSONObject result = new JSONObject();
        result.put("name", displayName);
        result.put("path", target.getAbsolutePath());
        result.put("size", target.length());
        return result;
    }

    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
        } finally {
            closeQuietly(cursor);
        }
        return null;
    }

    private String mimeForSupportedExtension(String extension) {
        String ext = extension == null ? "" : extension.trim().toLowerCase(Locale.US);
        switch (ext) {
            case "doc": return "application/msword";
            case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "docm": return "application/vnd.ms-word.document.macroEnabled.12";
            case "dotx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.template";
            case "dotm": return "application/vnd.ms-word.template.macroEnabled.12";
            case "xls": return "application/vnd.ms-excel";
            case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "xlsm": return "application/vnd.ms-excel.sheet.macroEnabled.12";
            case "xltx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.template";
            case "xltm": return "application/vnd.ms-excel.template.macroEnabled.12";
            case "pdf": return "application/pdf";
            case "rtf": return "application/rtf";
            case "odt": return "application/vnd.oasis.opendocument.text";
            case "ods": return "application/vnd.oasis.opendocument.spreadsheet";
            case "csv": return "text/csv";
            case "tsv": return "text/tab-separated-values";
            case "txt": return "text/plain";
            case "md":
            case "markdown": return "text/markdown";
            case "html":
            case "htm": return "text/html";
            case "json": return "application/json";
            case "qbank":
            case "buaiquiz": return "application/octet-stream";
            default:
                String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return detected == null || detected.trim().isEmpty() ? null : detected;
        }
    }

    private String[] supportedPickerMimeTypes() {
        java.util.LinkedHashSet<String> mimeTypes = new java.util.LinkedHashSet<>();
        try {
            SharedPreferences preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = preferences.getString("__picker_supported_extensions_v1", "");
            if (raw != null && !raw.trim().isEmpty()) {
                JSONArray array = new JSONArray(raw);
                for (int index = 0; index < array.length(); index += 1) {
                    String mime = mimeForSupportedExtension(array.optString(index, ""));
                    if (mime != null && !mime.isEmpty()) mimeTypes.add(mime);
                }
            }
        } catch (Exception ignored) {
        }
        // 首次进入导入页、旧数据尚未写入扩展名白名单时仍只展示题库文档，
        // 不退回 image/*、video/* 等“所有文件”。
        if (mimeTypes.isEmpty()) {
            String[] defaults = new String[]{
                    "application/msword",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/vnd.ms-excel",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "application/pdf", "application/rtf",
                    "application/vnd.oasis.opendocument.text",
                    "application/vnd.oasis.opendocument.spreadsheet",
                    "application/json", "application/octet-stream",
                    "text/plain", "text/csv", "text/tab-separated-values", "text/html", "text/markdown"
            };
            mimeTypes.addAll(Arrays.asList(defaults));
        }
        return mimeTypes.toArray(new String[0]);
    }

    private void launchFilePicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            // Android SAF 没有“按扩展名过滤”接口，只能按 MIME。业务层在每次调用
            // 选择器前写入当前 SUPPORTED_EXTENSIONS；原生层动态转换为 MIME 白名单。
            // 因而以后新增格式时，文件选择器也会跟着更新，而图片/视频不会再出现在列表中。
            intent.setType("*/*");
            String[] mimeTypes = supportedPickerMimeTypes();
            if (mimeTypes.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);
            startActivityForResult(intent, PICK_FILE_REQUEST);
        } catch (ActivityNotFoundException error) {
            dispatchFileError("当前系统没有可用的文件选择器");
        }
    }

    private void dispatchFileError(String message) {
        callJavascript("window.__onNativeFileError&&window.__onNativeFileError(" + JSONObject.quote(message) + ")");
    }

    private void callJavascript(final String script) {
        if (webView == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) webView.evaluateJavascript(script, null);
            }
        });
    }

    private boolean isSystemDarkModeInternal() {
        int mask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mask == Configuration.UI_MODE_NIGHT_YES;
    }

    private int getStatusBarHeightPx() {
        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        return resourceId > 0 ? getResources().getDimensionPixelSize(resourceId) : 0;
    }

    private void applySystemBars(boolean immersive, boolean darkAppearance) {
        immersiveEnabled = immersive;
        darkSystemBars = darkAppearance;
        Window window = getWindow();
        View decor = window.getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if (immersive) {
            flags |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
            flags |= View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        }
        if (!darkAppearance && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (!darkAppearance && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        decor.setSystemUiVisibility(flags);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(darkAppearance ? Color.rgb(28, 27, 31) : Color.rgb(255, 251, 254));
        disableContrastEnforcementCompat(window);
    }

    private static File file(String path) {
        if (path == null || path.trim().isEmpty()) throw new IllegalArgumentException("路径不能为空");
        return new File(path);
    }

    private static void ensureParent(File target) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IllegalStateException("无法创建目录：" + parent);
        }
    }

    private static byte[] readAllBytes(File target) throws Exception {
        try (InputStream input = new BufferedInputStream(new FileInputStream(target));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            copy(input, output);
            return output.toByteArray();
        }
    }

    private static void copy(InputStream input, OutputStream output) throws Exception {
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
        output.flush();
    }

    private static long directorySize(File target) {
        if (!target.exists()) return 0L;
        if (target.isFile()) return target.length();
        long total = 0L;
        File[] children = target.listFiles();
        if (children != null) for (File child : children) total += directorySize(child);
        return total;
    }

    private static boolean deleteRecursively(File target) {
        if (!target.exists()) return true;
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        return target.delete();
    }

    private static void closeQuietly(Closeable value) {
        try { if (value != null) value.close(); } catch (Exception ignored) {}
    }

    public final class AndroidBridge {
        @JavascriptInterface
        public String getUserDataPath() {
            return getFilesDir().getAbsolutePath();
        }

        @JavascriptInterface
        public int getStatusBarHeight() {
            return getStatusBarHeightPx();
        }

        @JavascriptInterface
        public boolean isSystemDarkMode() {
            return isSystemDarkModeInternal();
        }

        @JavascriptInterface
        public void setSystemBars(final boolean immersive, final boolean darkAppearance) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemBars(immersive, darkAppearance);
                }
            });
        }

        @JavascriptInterface
        public void setImmersive(final boolean immersive) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemBars(immersive, darkSystemBars);
                }
            });
        }

        @JavascriptInterface
        public void finishApp() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.finish();
                }
            });
        }

        @JavascriptInterface
        public String storageGet(String key) {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString(key, "");
        }

        @JavascriptInterface
        public void storageSet(String key, String value) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public void storageRemove(String key) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(key).apply();
        }

        @JavascriptInterface
        public void chooseFile() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.launchFilePicker();
                }
            });
        }

        @JavascriptInterface
        public boolean exists(String path) {
            return file(path).exists();
        }

        @JavascriptInterface
        public boolean mkdir(String path) {
            File target = file(path);
            return target.exists() || target.mkdirs();
        }

        @JavascriptInterface
        public String readText(String path) {
            try {
                return new String(readAllBytes(file(path)), StandardCharsets.UTF_8);
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public void writeText(String path, String text) {
            File target = file(path);
            ensureParent(target);
            try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                output.write((text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public String readBase64(String path) {
            try {
                return Base64.encodeToString(readAllBytes(file(path)), Base64.NO_WRAP);
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public void writeBase64(String path, String base64) {
            File target = file(path);
            ensureParent(target);
            try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                output.write(Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT));
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public void copyFile(String source, String target) {
            File from = file(source);
            File to = file(target);
            ensureParent(to);
            try (InputStream input = new BufferedInputStream(new FileInputStream(from));
                 OutputStream output = new BufferedOutputStream(new FileOutputStream(to))) {
                copy(input, output);
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public String stat(String path) {
            try {
                File target = file(path);
                JSONObject result = new JSONObject();
                result.put("directory", target.isDirectory());
                result.put("size", target.isDirectory() ? MainActivity.directorySize(target) : target.length());
                return result.toString();
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public String readdir(String path) {
            File[] files = file(path).listFiles();
            if (files == null) return "[]";
            Arrays.sort(files, new Comparator<File>() {
                @Override
                public int compare(File left, File right) {
                    return String.CASE_INSENSITIVE_ORDER.compare(left.getName(), right.getName());
                }
            });
            JSONArray names = new JSONArray();
            for (File item : files) names.put(item.getName());
            return names.toString();
        }

        @JavascriptInterface
        public boolean unlink(String path) {
            File target = file(path);
            return !target.exists() || target.delete();
        }

        @JavascriptInterface
        public boolean rmdir(String path) {
            return deleteRecursively(file(path));
        }

        @JavascriptInterface
        public long directorySize(String path) {
            return MainActivity.directorySize(file(path));
        }

        @JavascriptInterface
        public void unzip(String zipFilePath, String targetPath) {
            File zipFile = file(zipFilePath);
            File targetDirectory = file(targetPath);
            if (!targetDirectory.exists() && !targetDirectory.mkdirs()) {
                throw new RuntimeException("无法创建解压目录");
            }
            try {
                String root = targetDirectory.getCanonicalPath() + File.separator;
                try (ZipInputStream input = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)))) {
                    ZipEntry entry;
                    byte[] buffer = new byte[16 * 1024];
                    while ((entry = input.getNextEntry()) != null) {
                        File target = new File(targetDirectory, entry.getName()).getCanonicalFile();
                        if (!target.getPath().startsWith(root)) throw new SecurityException("压缩包路径异常");
                        if (entry.isDirectory()) {
                            if (!target.exists() && !target.mkdirs()) throw new IllegalStateException("无法创建目录");
                        } else {
                            ensureParent(target);
                            try (OutputStream output = new BufferedOutputStream(new FileOutputStream(target))) {
                                int count;
                                while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                            }
                        }
                        input.closeEntry();
                    }
                }
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        }

        @JavascriptInterface
        public void shareFile(String filePath) {
            final File target = file(filePath);
            if (!target.isFile()) throw new RuntimeException("文件不存在");
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Uri uri = ShareFileProvider.uriFor(MainActivity.this, target);
                        String extension = MimeTypeMap.getFileExtensionFromUrl(target.getName());
                        String mime = extension == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
                        if (mime == null) mime = "application/octet-stream";
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType(mime);
                        share.putExtra(Intent.EXTRA_STREAM, uri);
                        share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(share, "分享题库文件"));
                    } catch (Exception error) {
                        Toast.makeText(MainActivity.this, error.getMessage(), Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
                }
            });
        }
    }
}

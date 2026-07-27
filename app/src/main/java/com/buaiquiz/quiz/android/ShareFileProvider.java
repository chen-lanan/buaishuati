package com.buaiquiz.quiz.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Locale;

public final class ShareFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.shenhai.android.local.fileprovider";

    public static Uri uriFor(Context context, File file) throws Exception {
        File canonical = file.getCanonicalFile();
        ensureAllowed(context, canonical);
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath("file")
                .appendQueryParameter("path", canonical.getAbsolutePath())
                .build();
    }

    private static void ensureAllowed(Context context, File file) throws Exception {
        String path = file.getCanonicalPath();
        String files = context.getFilesDir().getCanonicalPath() + File.separator;
        String cache = context.getCacheDir().getCanonicalPath() + File.separator;
        if (!path.startsWith(files) && !path.startsWith(cache)) {
            throw new SecurityException("不允许分享应用目录之外的文件");
        }
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        String path = uri.getQueryParameter("path");
        if (path == null || path.trim().isEmpty()) throw new FileNotFoundException("缺少文件路径");
        try {
            File file = new File(path).getCanonicalFile();
            ensureAllowed(getContext(), file);
            if (!file.isFile()) throw new FileNotFoundException(path);
            return file;
        } catch (FileNotFoundException error) {
            throw error;
        } catch (Exception error) {
            throw new FileNotFoundException(error.getMessage());
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        try {
            String extension = MimeTypeMap.getFileExtensionFromUrl(resolve(uri).getName());
            String mime = extension == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
            return mime == null ? "application/octet-stream" : mime;
        } catch (Exception error) {
            return "application/octet-stream";
        }
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File file = resolve(uri);
            MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, 1);
            cursor.addRow(new Object[]{file.getName(), file.length()});
            return cursor;
        } catch (Exception error) {
            return new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, 0);
        }
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("只允许读取");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("只读 Provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}

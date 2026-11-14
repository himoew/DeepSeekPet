package com.bluefish.diary;

import android.content.Context;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 本子的文件层。一篇一个文件：diary/2026-11-11_210336.md
 * 删掉的不真删，挪进 diary/trash/，并在 diary/deleted.log 记一行。
 *
 * 放在 getExternalFilesDir（/sdcard/Android/data/com.bluefish.diary/files/diary/）：
 * 不需要任何存储权限；宿主 `adb shell` 能直接读（这台 MuMu 的 shell 带 ext_data_rw 组）。
 */
final class Store {
    static final String DIR = "diary";
    static final String TRASH = "trash";
    static final String LOG = "deleted.log";
    private static final String FMT_FILE = "yyyy-MM-dd_HHmmss";

    private Store() {}

    static File dir(Context c) {
        File d = new File(c.getExternalFilesDir(null), DIR);
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    static File trashDir(Context c) {
        File d = new File(dir(c), TRASH);
        if (!d.exists()) {
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
        }
        return d;
    }

    static final class Entry {
        final File file;
        final String name;
        final long at;
        final String head;
        final String body;

        Entry(File file, String name, long at, String head, String body) {
            this.file = file;
            this.name = name;
            this.at = at;
            this.head = head;
            this.body = body;
        }

        String dateShort() {
            return name.length() >= 10 ? name.substring(5, 10) : "";
        }

        String timeShort() {
            return name.length() >= 15 ? name.substring(11, 13) + ":" + name.substring(13, 15) : "";
        }

        /** 列表上那一行：11-11 21:03  那只猫趴在窗台上…… */
        String gist(int max) {
            String s = body.replace('\n', ' ').trim();
            if (s.length() > max) s = s.substring(0, max) + "……";
            return s;
        }
    }

    static String todayLine() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date())
                + " " + weekday();
    }

    static String weekday() {
        String[] w = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
        Calendar c = Calendar.getInstance();
        return w[c.get(Calendar.DAY_OF_WEEK) - 1];
    }

    static String todayKey() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date());
    }

    static String hhmm(long at) {
        return new SimpleDateFormat("HH:mm", Locale.CHINA).format(new Date(at));
    }

    static List<Entry> list(Context c) {
        List<Entry> out = new ArrayList<>();
        File[] fs = dir(c).listFiles();
        if (fs == null) return out;
        for (File f : fs) {
            String n = f.getName();
            if (!f.isFile() || !n.endsWith(".md") || n.length() < 15) continue;
            Entry e = load(f);
            if (e != null) out.add(e);
        }
        Collections.sort(out, new Comparator<Entry>() {
            @Override
            public int compare(Entry a, Entry b) {
                return b.name.compareTo(a.name);
            }
        });
        return out;
    }

    static Entry load(File f) {
        try {
            String raw = readText(f);
            String head = "";
            StringBuilder body = new StringBuilder();
            for (String line : raw.split("\n", -1)) {
                if (head.isEmpty() && line.startsWith("# ")) {
                    head = line.substring(2).trim();
                    continue;
                }
                if (body.length() > 0) body.append('\n');
                body.append(line);
            }
            String name = f.getName();
            long at = f.lastModified();
            try {
                at = new SimpleDateFormat(FMT_FILE, Locale.CHINA).parse(name.substring(0, 15)).getTime();
            } catch (Exception ignored) { }
            return new Entry(f, name, at, head, body.toString().trim());
        } catch (IOException e) {
            return null;
        }
    }

    /** 写一篇新的（永远新建文件，不覆盖）。返回文件名。 */
    static String write(Context c, String body, long at) throws IOException {
        String name = new SimpleDateFormat(FMT_FILE, Locale.CHINA).format(new Date(at)) + ".md";
        File f = new File(dir(c), name);
        int n = 2;
        while (f.exists()) {
            name = new SimpleDateFormat(FMT_FILE, Locale.CHINA).format(new Date(at)) + "-" + n + ".md";
            f = new File(dir(c), name);
            n += 1;
        }
        String head = "# " + new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date(at))
                + " " + weekday() + " " + hhmm(at);
        writeText(f, head + "\n" + body.trim() + "\n");
        return name;
    }

    /** 软删除：挪进 trash/，并记一行流水。 */
    static boolean delete(Context c, File f) {
        Entry e = load(f);
        File dest = new File(trashDir(c), f.getName());
        if (dest.exists()) dest = new File(trashDir(c), f.getName() + "." + System.currentTimeMillis());
        if (!f.renameTo(dest)) {
            // rename 失败（跨卷）就走复制
            try {
                writeText(dest, readText(f));
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            } catch (IOException ex) {
                return false;
            }
        }
        String gist = e == null ? "" : e.gist(40);
        int len = e == null ? 0 : e.body.length();
        appendLog(c, "{\"at\":" + System.currentTimeMillis() + ",\"file\":" + quote(dest.getName())
                + ",\"gist\":" + quote(gist) + ",\"len\":" + len + "}");
        return true;
    }

    private static void appendLog(Context c, String line) {
        try {
            FileOutputStream out = new FileOutputStream(new File(dir(c), LOG), true);
            OutputStreamWriter w = new OutputStreamWriter(out, StandardCharsets.UTF_8);
            w.write(line + "\n");
            w.close();
        } catch (IOException ignored) { }
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch == '\n') b.append("\\n");
            else b.append(ch);
        }
        return b.append('"').toString();
    }

    static String readText(File f) throws IOException {
        if (!f.exists()) return "";
        StringBuilder b = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8));
        char[] buf = new char[4096];
        int n;
        while ((n = r.read(buf)) > 0) b.append(buf, 0, n);
        r.close();
        return b.toString();
    }

    static void writeText(File f, String text) throws IOException {
        OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        w.write(text);
        w.close();
    }
}

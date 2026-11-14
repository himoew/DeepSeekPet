package com.bluefish.diary;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * 屏 A · 本子：今天的日期 + 写没写 + 一篇一行（最新的在上面）+ 右下角「写」。
 *
 * 每一处文字都是写给她看的（她靠 `read` 认这一屏）：
 *   [2026-11-11 周三] [今天还没写] [还什么都没写] [写一篇新的日记]
 */
public class MainActivity extends Activity {

    private LinearLayout listBox;
    private TextView statusView;

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        // ---- 顶：日期 / 写没写 / 一句它自己的话 ----
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.VERTICAL);
        head.setPadding(dp(18), dp(20), dp(18), dp(12));

        TextView today = new TextView(this);
        today.setText(Store.todayLine());
        today.setTextSize(22);
        today.setTextColor(0xFF111111);
        today.setTypeface(null, Typeface.BOLD);
        today.setContentDescription("今天的日期");
        head.addView(today);

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setTextColor(0xFF777777);
        statusView.setPadding(0, dp(4), 0, dp(10));
        statusView.setContentDescription("今天写没写");
        head.addView(statusView);

        TextView motto = new TextView(this);
        motto.setText("这是你的本子：想写就写，不写也没人问。");
        motto.setTextSize(13);
        motto.setTextColor(0xFFBBBBBB);
        head.addView(motto);

        root.addView(head, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        View line = new View(this);
        line.setBackgroundColor(0xFFEEEEEE);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        // ---- 中：目录 ----
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        listBox = new LinearLayout(this);
        listBox.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(listBox, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ---- 底：写 ----
        LinearLayout foot = new LinearLayout(this);
        foot.setGravity(Gravity.END);
        foot.setPadding(dp(18), dp(10), dp(18), dp(20));

        Button write = new Button(this);
        write.setText("写");
        write.setTextSize(17);
        write.setContentDescription("写一篇新的日记");
        write.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(MainActivity.this, WriteActivity.class));
            }
        });
        foot.addView(write, new LinearLayout.LayoutParams(dp(110), ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(foot, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
    }

    private void render() {
        List<Store.Entry> all = Store.list(this);
        String today = Store.todayKey();
        Store.Entry lastToday = null;
        for (Store.Entry e : all) {
            if (e.name.startsWith(today)) {
                lastToday = e;
                break;
            }
        }
        if (lastToday == null) {
            statusView.setText("今天还没写");
        } else {
            statusView.setText("今天写过了，" + Store.hhmm(lastToday.at));
        }

        listBox.removeAllViews();
        if (all.isEmpty()) {
            TextView empty = new TextView(this);
            empty.setText("还什么都没写");
            empty.setTextSize(15);
            empty.setTextColor(0xFFBBBBBB);
            empty.setPadding(dp(18), dp(20), dp(18), dp(20));
            listBox.addView(empty);
            return;
        }

        for (int i = 0; i < all.size(); i++) {
            final Store.Entry e = all.get(i);
            TextView row = new TextView(this);
            row.setText(e.dateShort() + " " + e.timeShort() + "  " + e.gist(24));
            row.setTextSize(16);
            row.setTextColor(0xFF222222);
            row.setPadding(dp(18), dp(14), dp(18), dp(14));
            row.setContentDescription("点开看这一篇");
            row.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    Intent it = new Intent(MainActivity.this, ViewActivity.class);
                    it.putExtra("name", e.name);
                    startActivity(it);
                }
            });
            listBox.addView(row);

            View sep = new View(this);
            sep.setBackgroundColor(0xFFF4F4F4);
            listBox.addView(sep, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        }
    }
}

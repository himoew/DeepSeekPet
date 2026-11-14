package com.bluefish.diary;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
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
import android.widget.Toast;

import java.io.File;

/**
 * 屏 C · 看一篇：右上角「删除」，点一下还要再确认一次（删了 / 算了）。
 * 删是软删：文件挪进 trash/，她这边（列表和正文）立刻看不见了。
 */
public class ViewActivity extends Activity {

    private Store.Entry entry;

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String name = getIntent() == null ? "" : getIntent().getStringExtra("name");
        File f = new File(Store.dir(this), name);
        entry = name.isEmpty() ? null : Store.load(f);
        if (entry == null) {
            Toast.makeText(this, "这一篇找不到了", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(true);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(18), dp(14), dp(10), dp(6));

        TextView date = new TextView(this);
        date.setText(entry.dateShort() + " " + entry.timeShort());
        date.setTextSize(16);
        date.setTextColor(0xFF777777);
        date.setContentDescription("这一篇的时间");
        head.addView(date, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button del = new Button(this);
        del.setText("删除");
        del.setTextSize(15);
        del.setContentDescription("删掉这一篇；会再问你一次");
        del.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                confirmDelete();
            }
        });
        head.addView(del, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(head, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        View line = new View(this);
        line.setBackgroundColor(0xFFEEEEEE);
        root.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        ScrollView scroll = new ScrollView(this);
        TextView body = new TextView(this);
        body.setText(entry.body);
        body.setTextSize(18);
        body.setTextColor(0xFF111111);
        body.setLineSpacing(dp(6), 1f);
        body.setPadding(dp(18), dp(16), dp(18), dp(24));
        body.setContentDescription("这一篇的正文");
        scroll.addView(body, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private void confirmDelete() {
        new AlertDialog.Builder(this)
                .setMessage("删掉这一篇？")
                .setPositiveButton("删了", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        if (Store.delete(ViewActivity.this, entry.file)) {
                            Toast.makeText(ViewActivity.this, "删了", Toast.LENGTH_SHORT).show();
                        } else {
                            Toast.makeText(ViewActivity.this, "没删掉", Toast.LENGTH_SHORT).show();
                        }
                        finish();
                    }
                })
                .setNegativeButton("算了", null)
                .show();
    }
}

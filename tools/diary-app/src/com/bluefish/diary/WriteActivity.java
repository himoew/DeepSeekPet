package com.bluefish.diary;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;

/**
 * 屏 B · 写：一整屏就是一个输入框 + 右上角「保存」。
 * 没有标题、没有模板、没有字数。返回也保存（不丢字）；空着就不落盘。
 */
public class WriteActivity extends Activity {

    private EditText draft;
    private boolean saved;

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        root.setFitsSystemWindows(true);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(18), dp(14), dp(10), dp(6));

        TextView date = new TextView(this);
        date.setText(Store.todayLine() + " " + Store.hhmm(System.currentTimeMillis()));
        date.setTextSize(16);
        date.setTextColor(0xFF777777);
        date.setContentDescription("这一篇的时间");
        head.addView(date, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button save = new Button(this);
        save.setText("保存");
        save.setTextSize(16);
        save.setContentDescription("写完点这里保存");
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                doSave();
            }
        });
        head.addView(save, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(head, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        draft = new EditText(this);
        draft.setTextSize(18);
        draft.setTextColor(0xFF111111);
        draft.setHint("想写什么就写什么，写多长都行");
        draft.setHintTextColor(0xFFCCCCCC);
        draft.setGravity(Gravity.TOP | Gravity.START);
        draft.setBackgroundColor(Color.WHITE);
        draft.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        draft.setSingleLine(false);
        draft.setPadding(dp(18), dp(8), dp(18), dp(18));
        draft.setContentDescription("在这里写今天的日记；想写多少写多少，也可以只写一句");
        root.addView(draft, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        draft.requestFocus();
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(draft.getWindowToken(), 0);
        } catch (Exception ignored) { }
    }

    @Override
    public void onBackPressed() {
        doSave();
    }

    private void doSave() {
        if (saved) {
            finish();
            return;
        }
        String body = draft.getText().toString().trim();
        if (body.isEmpty()) {
            finish();
            return;
        }
        try {
            String name = Store.write(this, body, System.currentTimeMillis());
            saved = true;
            Toast.makeText(this, "写好了", Toast.LENGTH_SHORT).show();
            setResult(RESULT_OK);
            finish();
        } catch (IOException e) {
            Toast.makeText(this, "没写进去：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}

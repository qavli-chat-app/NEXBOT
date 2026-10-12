package com.qavli.nexbot;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.graphics.Color;
import android.webkit.CookieManager;
import android.content.Intent;
import android.net.Uri;

public class MainActivity extends Activity {
  private WebView web;
  private static final String HOME = "https://nexbot-whatsapp-worker-production.up.railway.app/dashboard";
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    getWindow().setStatusBarColor(Color.rgb(7,17,31));
    getWindow().setNavigationBarColor(Color.rgb(7,17,31));
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(7,17,31));
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setSupportZoom(false);
    settings.setLoadsImagesAutomatically(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        Uri uri = Uri.parse(url);
        if ("https".equals(uri.getScheme()) && "nexbot-whatsapp-worker-production.up.railway.app".equals(uri.getHost())) return false;
        startActivity(new Intent(Intent.ACTION_VIEW, uri));
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient());
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    setContentView(web);
    if (state == null) web.loadUrl(HOME); else web.restoreState(state);
  }
  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
  @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
}

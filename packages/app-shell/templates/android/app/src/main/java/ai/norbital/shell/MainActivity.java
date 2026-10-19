package ai.norbital.shell;

import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

public class MainActivity extends BridgeActivity {
    /** Intent extra naming the workspace path a tapped notice opens. */
    static final String EXTRA_PATH = "ai.norbital.shell.path";
    /** Intent extra naming the notices stream the notice came from; its origin is the one the path opens on. */
    static final String EXTRA_SOURCE = "ai.norbital.shell.source";
    /** While the app is on screen the Bolt shell raises notices itself; the notices service stays quiet. */
    static volatile boolean visible = false;

    private Origins origins;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NorbitalShellPlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge == null) return;
        // Remove Capacitor's all-frame fallback and auxiliary Java interfaces. Modern plugin calls remain available.
        WebView webView = bridge.getWebView();
        webView.removeJavascriptInterface("androidBridge");
        webView.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        webView.removeJavascriptInterface("CapacitorHttpAndroidInterface");
        origins = Origins.from(bridge.getConfig().getPluginConfiguration("NorbitalShell"));
        if (origins == null ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            webView.stopLoading();
            webView.loadData("Update Android System WebView to use this app securely.", "text/plain", "UTF-8");
            return;
        }
        List<String> rules = origins.originRules();
        // Capacitor injects its bridge script on the start origin only; an unpinned app's workspaces are subdomains.
        if (rules.size() > 1)
            WebViewCompat.addDocumentStartJavaScript(webView, capacitorScript(), new HashSet<>(rules.subList(1, rules.size())));
        // Added after Capacitor's bridge script and before the first document commits, so `window.Capacitor` exists.
        WebViewCompat.addDocumentStartJavaScript(webView, runtime(), new HashSet<>(rules));
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url.getPath() != null && url.getPath().startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START)) return true;
                // Embedded documents keep their ordinary browser navigation and never receive the native bridge.
                if (!request.isForMainFrame()) return false;
                if (url.toString().equals(bridge.getErrorUrl())) return false;
                // Capacitor's host mask matches one subdomain label; a deeper workspace origin (staging's
                // `t-x.workspaces.<host>`) would open outside, so trusted documents stay here directly.
                if (origins.trusts(url.toString())) return false;
                if (Arrays.asList("https", "http", "tel", "mailto", "sms").contains(url.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (android.content.ActivityNotFoundException ignored) {
                        // Stay on the trusted document when nothing can handle the URL.
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!origins.trusts(url) && !url.equals(bridge.getErrorUrl())) {
                    view.stopLoading();
                    return;
                }
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                // The workspace serves its own recovery documents for HTTP failures; the offline page is for network failures.
                if (!request.isForMainFrame()) super.onReceivedHttpError(view, request, response);
            }
        });
        open(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
    }

    @Override
    public void onPause() {
        visible = false;
        super.onPause();
    }

    /** A tapped notice opens its workspace path in the WebView. */
    private void open(Intent intent) {
        if (intent == null || origins == null || bridge == null) return;
        String page = origins.page(intent.getStringExtra(EXTRA_SOURCE), intent.getStringExtra(EXTRA_PATH));
        intent.removeExtra(EXTRA_PATH);
        intent.removeExtra(EXTRA_SOURCE);
        if (page != null) bridge.getWebView().loadUrl(page);
    }

    /** Capacitor's own document-start script; it builds it privately and registers it for the start origin only. */
    // ponytail: reflection on Capacitor 8.5.2's private Bridge.getJSInjector; recheck when the pinned Capacitor moves.
    private String capacitorScript() {
        try {
            Method method = Bridge.class.getDeclaredMethod("getJSInjector");
            method.setAccessible(true);
            // JSInjector is package-private: name it only through reflection
            Object injector = method.invoke(bridge);
            if (injector == null) throw new IllegalStateException("Capacitor could not export its bridge script");
            Method script = injector.getClass().getDeclaredMethod("getScriptString");
            script.setAccessible(true);
            return (String) script.invoke(injector);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("Capacitor's bridge script is unavailable", error);
        }
    }

    /** The device runtime `norbital-app generate` writes into the app's assets. */
    private String runtime() {
        try (InputStream input = getAssets().open("norbital-shell.js")) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            for (int read; (read = input.read(buffer)) != -1; ) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (IOException error) {
            throw new IllegalStateException("norbital-shell.js is missing; run norbital-app generate", error);
        }
    }
}

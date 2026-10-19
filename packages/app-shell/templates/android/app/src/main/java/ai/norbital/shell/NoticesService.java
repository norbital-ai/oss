package ai.norbital.shell;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashSet;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Holds the member's notice stream (`text/event-stream`, `data: { id, title, body, path }`) while the app is in the
 * background or swiped away, and posts one notification per new notice. Stops on `stopNotices` or a refused session.
 */
public class NoticesService extends Service {
    private static final String PREFERENCES = "ai.norbital.shell.notices";
    private static final String SERVICE_CHANNEL = "norbital_notices_service";
    private static final String NOTICE_CHANNEL = "norbital_notices";
    private static final int SERVICE_NOTIFICATION = 0x4e4f;
    private static final long FIRST_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 60_000;
    private static final int REMEMBERED = 500;

    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private Thread worker;
    private volatile boolean running;
    private volatile HttpURLConnection connection;

    static void start(Context context, String url) {
        context.getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putString("url", url).apply();
        ContextCompat.startForegroundService(context, new Intent(context, NoticesService.class));
    }

    static void stop(Context context) {
        context.getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().remove("url").apply();
        context.stopService(new Intent(context, NoticesService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A sticky restart carries no intent; the stream address survives in preferences.
        String url = getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString("url", null);
        if (url == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        channels();
        Notification ongoing = new NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(getApplicationInfo().loadLabel(getPackageManager()))
            .setContentText("Receiving notices")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(opening(null, SERVICE_NOTIFICATION))
            .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(SERVICE_NOTIFICATION, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(SERVICE_NOTIFICATION, ongoing);
        if (worker == null) {
            running = true;
            worker = new Thread(() -> listen(url), "norbital-notices");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection open = connection;
        if (open != null) open.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(SERVICE_CHANNEL, "Notice connection", NotificationManager.IMPORTANCE_MIN));
        manager.createNotificationChannel(new NotificationChannel(NOTICE_CHANNEL, "Notices", NotificationManager.IMPORTANCE_DEFAULT));
    }

    private PendingIntent opening(String path, int request) {
        Intent intent = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) {
            intent.putExtra(MainActivity.EXTRA_PATH, path);
            intent.putExtra(MainActivity.EXTRA_SOURCE, getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString("url", null));
        }
        return PendingIntent.getActivity(this, request, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** One connection at a time; reconnects with capped exponential backoff, and stops when the session is refused. */
    private void listen(String url) {
        long backoff = FIRST_BACKOFF_MS;
        String lastId = null;
        while (running) {
            HttpURLConnection open = null;
            try {
                open = (HttpURLConnection) new URL(url).openConnection();
                connection = open;
                open.setInstanceFollowRedirects(false);
                open.setConnectTimeout(15_000);
                // The stream is expected to carry comments or events more often than this.
                open.setReadTimeout(120_000);
                open.setRequestProperty("Accept", "text/event-stream");
                // Capacitor installs the WebView's cookie store as the default CookieHandler, which already sends the
                // session; a second copy is refused as duplicate credentials. A sticky restart has no handler yet.
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && CookieHandler.getDefault() == null) open.setRequestProperty("Cookie", cookies);
                if (lastId != null) open.setRequestProperty("Last-Event-ID", lastId);
                int status = open.getResponseCode();
                if (status == 401 || status == 403) {
                    signedOut();
                    return;
                }
                if (status == 200) {
                    backoff = FIRST_BACKOFF_MS;
                    BufferedReader reader = new BufferedReader(new InputStreamReader(open.getInputStream(), StandardCharsets.UTF_8));
                    StringBuilder data = new StringBuilder();
                    for (String line; running && (line = reader.readLine()) != null; ) {
                        if (line.isEmpty()) {
                            if (data.length() > 0) post(data.toString());
                            data.setLength(0);
                        } else if (line.startsWith("data:")) {
                            if (data.length() > 0) data.append('\n');
                            data.append(line.substring(line.startsWith("data: ") ? 6 : 5));
                        } else if (line.startsWith("id:")) {
                            lastId = line.substring(3).trim();
                        }
                    }
                }
            } catch (IOException ignored) {
                // Network loss and server restarts reconnect below.
            } finally {
                if (open != null) open.disconnect();
                connection = null;
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException interrupted) {
                return;
            }
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        }
    }

    private void signedOut() {
        running = false;
        new Handler(Looper.getMainLooper()).post(() -> stop(this));
    }

    private boolean remember(String id) {
        if (!seen.add(id)) return false;
        if (seen.size() > REMEMBERED) {
            Iterator<String> oldest = seen.iterator();
            oldest.next();
            oldest.remove();
        }
        return true;
    }

    private void post(String data) {
        try {
            JSONObject notice = new JSONObject(data);
            String id = notice.optString("id", "");
            if (id.isEmpty() || !remember(id) || MainActivity.visible) return;
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
            String path = notice.isNull("path") ? null : notice.optString("path");
            Notification notification = new NotificationCompat.Builder(this, NOTICE_CHANNEL)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentTitle(notice.optString("title", ""))
                .setContentText(notice.isNull("body") ? "" : notice.optString("body"))
                .setAutoCancel(true)
                .setContentIntent(opening(path, id.hashCode()))
                .build();
            NotificationManagerCompat.from(this).notify(id, 0, notification);
        } catch (JSONException | SecurityException ignored) {
            // A malformed event or a permission revoked mid-stream drops that one notice.
        }
    }
}

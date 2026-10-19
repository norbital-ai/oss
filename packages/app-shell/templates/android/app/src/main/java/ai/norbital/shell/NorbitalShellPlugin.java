package ai.norbital.shell;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.CookieManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NorbitalShell",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NorbitalShellPlugin extends Plugin {
    // A foreground fix does not prove background authorization.
    @PluginMethod
    public void locationStatus(PluginCall call) {
        LocationManager manager = (LocationManager) getContext().getSystemService(android.content.Context.LOCATION_SERVICE);
        boolean enabled = manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        boolean foreground = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean background = Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        result.put("always", foreground && background);
        call.resolve(result);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    /** Holds a home origin's `/__bolt/notices` open in a foreground service with the WebView's session cookies. */
    @PluginMethod
    public void startNotices(PluginCall call) {
        Origins origins = Origins.from(getConfig());
        String url = call.getString("url");
        if (origins == null || url == null || !origins.isHome(url)) {
            call.reject("Notices must come from a workspace of this app.");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "noticesPermission");
            return;
        }
        start(call, url);
    }

    @PermissionCallback
    private void noticesPermission(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) start(call, call.getString("url"));
        else call.reject("Notifications are not allowed", "DENIED");
    }

    private void start(PluginCall call, String url) {
        // A service restarted after the process died reads cookies from disk.
        CookieManager.getInstance().flush();
        NoticesService.start(getContext(), url);
        call.resolve();
    }

    @PluginMethod
    public void stopNotices(PluginCall call) {
        NoticesService.stop(getContext());
        call.resolve();
    }
}

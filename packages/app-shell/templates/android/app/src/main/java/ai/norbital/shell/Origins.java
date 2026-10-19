package ai.norbital.shell;

import com.getcapacitor.Bridge;
import com.getcapacitor.PluginConfig;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The origins the app is home on and the extra hosts the WebView may stay on (`NorbitalShell` plugin configuration).
 * A pinned app is home on its workspace origin only; an unpinned app on the host origin and every subdomain of the
 * host's name, with the same scheme and port.
 */
final class Origins {
    private final URI home;
    private final boolean pinned;
    private final String[] hosts;

    private Origins(URI home, boolean pinned, String[] hosts) {
        this.home = home;
        this.pinned = pinned;
        this.hosts = hosts;
    }

    static Origins from(PluginConfig config) {
        String workspace = config.getString("workspace");
        String value = workspace != null ? workspace : config.getString("host");
        if (value == null) return null;
        try {
            URI home = URI.create(value);
            if (!("https".equals(home.getScheme()) || "http".equals(home.getScheme())) ||
                home.getHost() == null || home.getRawUserInfo() != null) return null;
            return new Origins(home, workspace != null, config.getArray("allowNavigation", new String[0]));
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    private static int port(URI url) {
        return url.getPort() >= 0 ? url.getPort() : "https".equals(url.getScheme()) ? 443 : 80;
    }

    /** An IP literal has no subdomains, and WebView origin rules refuse a wildcard on one. */
    private boolean subdomains() {
        return !pinned && !home.getHost().matches("[0-9.]+|\\[.*");
    }

    boolean isHome(URI url) {
        if (url.getHost() == null || !home.getScheme().equals(url.getScheme()) || port(home) != port(url)) return false;
        String host = url.getHost().toLowerCase(Locale.ROOT);
        String name = home.getHost().toLowerCase(Locale.ROOT);
        return host.equals(name) || (subdomains() && host.endsWith("." + name));
    }

    boolean isHome(String value) {
        try {
            return isHome(URI.create(value));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    /** A home origin, or an allowed HTTPS host on its default port. */
    boolean trusts(String value) {
        try {
            URI url = URI.create(value);
            String path = url.getRawPath();
            if (!("https".equals(url.getScheme()) || "http".equals(url.getScheme())) || url.getRawUserInfo() != null ||
                url.getHost() == null || path == null || path.startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START)) return false;
            if (isHome(url)) return true;
            if (!"https".equals(url.getScheme()) || url.getPort() >= 0) return false;
            String host = url.getHost().toLowerCase(Locale.ROOT);
            for (String allowed : hosts) {
                String rule = allowed.toLowerCase(Locale.ROOT);
                if (rule.startsWith("*.") ? host.endsWith(rule.substring(1)) : host.equals(rule)) return true;
            }
            return false;
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    /** The `scheme://host[:port]` rules (and `scheme://*.host[:port]` when unpinned) WebViewCompat matches against. */
    List<String> originRules() {
        String port = home.getPort() >= 0 ? ":" + home.getPort() : "";
        List<String> rules = new ArrayList<>();
        rules.add(home.getScheme() + "://" + home.getHost() + port);
        if (subdomains()) rules.add(home.getScheme() + "://*." + home.getHost() + port);
        return rules;
    }

    /** A notice's absolute path on the home origin of the notices stream (`source`) it came from, or null. */
    String page(String source, String path) {
        if (source == null || path == null || !path.startsWith("/") || path.startsWith("//")) return null;
        try {
            URI base = URI.create(source);
            if (!isHome(base)) return null;
            URI url = base.resolve(path);
            return isHome(url) ? url.toString() : null;
        } catch (IllegalArgumentException error) {
            return null;
        }
    }
}

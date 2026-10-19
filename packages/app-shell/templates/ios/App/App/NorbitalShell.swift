import UIKit
import Capacitor
import CoreLocation
import UserNotifications
import WebKit

/// The origins the app is home on and the extra hosts the WebView may stay on (`NorbitalShell` plugin configuration).
/// A pinned app is home on its workspace origin only; an unpinned app on the host origin and every subdomain of the
/// host's name, with the same scheme and port.
struct NorbitalOrigins {
    let home: URLComponents
    let pinned: Bool
    let hosts: [String]

    init?(config: PluginConfig) {
        let workspace = config.getString("workspace")
        guard let value = workspace ?? config.getString("host"),
              let home = URLComponents(string: value),
              ["https", "http"].contains(home.scheme ?? ""),
              home.host != nil, home.user == nil, home.password == nil else { return nil }
        self.home = home
        self.pinned = workspace != nil
        self.hosts = (config.getArray("allowNavigation") ?? []).compactMap { ($0 as? String)?.lowercased() }
    }

    private func port(_ url: URLComponents) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }

    func isHome(_ url: URLComponents) -> Bool {
        guard url.scheme == home.scheme, port(url) == port(home),
              let host = url.host?.lowercased(), let name = home.host?.lowercased() else { return false }
        return host == name || (!pinned && host.hasSuffix("." + name))
    }

    /// A home origin, or an allowed HTTPS host on its default port.
    func trusts(_ url: URL) -> Bool {
        guard let parsed = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parsed.user == nil, parsed.password == nil,
              !parsed.percentEncodedPath.hasPrefix(CapacitorBridge.httpInterceptorStartIdentifier) else { return false }
        if isHome(parsed) { return true }
        guard parsed.scheme == "https", parsed.port == nil, let host = parsed.host?.lowercased() else { return false }
        return hosts.contains { $0.hasPrefix("*.") ? host.hasSuffix(String($0.dropFirst(1))) : host == $0 }
    }

    /// Native bridge messages are accepted only from a home document whose security origin is its own.
    func trusts(_ origin: WKSecurityOrigin, document: URL) -> Bool {
        guard let components = URLComponents(url: document, resolvingAgainstBaseURL: false), isHome(components) else { return false }
        let sourcePort = origin.port == 0 ? (origin.protocol == "https" ? 443 : 80) : origin.port
        return origin.protocol == components.scheme && origin.host.lowercased() == components.host?.lowercased() && sourcePort == port(components)
    }

    /// A notice's absolute path on the home origin `current` is on (an unpinned app's open workspace), else on `home`.
    func page(_ path: String, current: URL?) -> URL? {
        let open = current.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }.flatMap { isHome($0) ? $0 : nil }
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let base = (open ?? home).url,
              let url = URL(string: path, relativeTo: base)?.absoluteURL,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false), isHome(components) else { return nil }
        return url
    }
}

/// Registers the shell plugin, admits bridge messages from home documents only, and injects the device runtime.
class NorbitalBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NorbitalShellPlugin())
        guard let native = bridge as? CapacitorBridge,
              let origins = NorbitalOrigins(config: native.config.getPluginConfig("NorbitalShell")) else {
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
            return
        }
        let controller = native.webViewDelegationHandler.contentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(NorbitalBridgeMessages(origins: origins, delegate: native.webViewDelegationHandler), name: "bridge")
        // After Capacitor's own scripts, so `window.Capacitor` exists; the runtime itself checks the document origin.
        if let file = Bundle.main.url(forResource: "norbital-shell", withExtension: "js"),
           let source = try? String(contentsOf: file, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }
}

private class NorbitalBridgeMessages: NSObject, WKScriptMessageHandler {
    let origins: NorbitalOrigins
    let delegate: WebViewDelegationHandler

    init(origins: NorbitalOrigins, delegate: WebViewDelegationHandler) {
        self.origins = origins
        self.delegate = delegate
        super.init()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let document = message.frameInfo.request.url,
              origins.trusts(message.frameInfo.securityOrigin, document: document) else { return }
        delegate.userContentController(controller, didReceive: message)
    }
}

@objc(NorbitalShellPlugin)
class NorbitalShellPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    let identifier = "NorbitalShellPlugin"
    let jsName = "NorbitalShell"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "locationStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushRegistration", returnType: CAPPluginReturnPromise)
    ]
    /// Calls waiting for APNs; touched on the main queue only.
    private var registering: [CAPPluginCall] = []

    override func load() {
        bridge?.notificationRouter.pushNotificationHandler = self
        NotificationCenter.default.addObserver(self, selector: #selector(registered(_:)), name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(failed(_:)), name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
    }

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true else { return nil }
        guard let url = navigationAction.request.url,
              let origins = NorbitalOrigins(config: getConfig()) else { return NSNumber(value: true) }
        if url == bridge?.config.errorPathURL { return NSNumber(value: false) }
        if origins.trusts(url) { return NSNumber(value: false) }
        if ["https", "http", "tel", "mailto", "sms"].contains(url.scheme ?? "") {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return NSNumber(value: true)
    }

    // A foreground fix does not prove Always authorization.
    @objc func locationStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let manager = CLLocationManager()
            call.resolve([
                "enabled": CLLocationManager.locationServicesEnabled(),
                "always": manager.authorizationStatus == .authorizedAlways
            ])
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings unavailable")
                return
            }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("Settings unavailable") }
            }
        }
    }

    @objc func pushRegistration(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    call.reject("Notifications are not allowed", "DENIED")
                    return
                }
                self.registering.append(call)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    @objc private func registered(_ notification: Notification) {
        guard let token = notification.object as? Data else { return }
        let config = getConfig()
        let registration: [String: Any] = [
            "kind": "apns",
            "token": token.map { String(format: "%02x", $0) }.joined(),
            "topic": Bundle.main.bundleIdentifier ?? "",
            "environment": config.getString("apsEnvironment") ?? "production",
            "teamId": config.getString("teamId") ?? ""
        ]
        DispatchQueue.main.async {
            let calls = self.registering
            self.registering = []
            calls.forEach { $0.resolve(registration) }
            self.notifyListeners("pushRegistration", data: registration)
        }
    }

    @objc private func failed(_ notification: Notification) {
        let message = (notification.object as? Error)?.localizedDescription ?? "APNs registration failed"
        DispatchQueue.main.async {
            let calls = self.registering
            self.registering = []
            calls.forEach { $0.reject(message) }
        }
    }

    // An open app raises notices from the Bolt shell's live lane; a push arriving in the foreground stays silent.
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions { [] }

    func didReceive(response: UNNotificationResponse) {
        guard let path = response.notification.request.content.userInfo["path"] as? String,
              let origins = NorbitalOrigins(config: getConfig()) else { return }
        DispatchQueue.main.async {
            guard let url = origins.page(path, current: self.bridge?.webView?.url) else { return }
            _ = self.bridge?.webView?.load(URLRequest(url: url))
        }
    }
}

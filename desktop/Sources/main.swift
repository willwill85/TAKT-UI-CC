import Cocoa
import WebKit
import SwiftTerm

class FlippedContainerView: NSView {
    override var isFlipped: Bool { true }
}

class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {
    var window: NSWindow!
    var rootView: FlippedContainerView!
    var webView: WKWebView!
    var nativeTerminalContainer: NSView!
    var nativeTabs: [String: LocalProcessTerminalView] = [:]
    var activeTabId: String?
    var engineMode: String = "native"
    // Where the TAKT-UI-CC checkout lives. Written into Info.plist (TAKTRepoPath) by scripts/build-app.sh;
    // can be overridden at runtime with the TAKT_REPO environment variable.
    let repoPath: String = {
        if let env = ProcessInfo.processInfo.environment["TAKT_REPO"], !env.isEmpty { return env }
        if let plist = Bundle.main.object(forInfoDictionaryKey: "TAKTRepoPath") as? String, !plist.isEmpty { return plist }
        return FileManager.default.currentDirectoryPath
    }()
    var workbenchURLString: String {
        let port = ProcessInfo.processInfo.environment["TAKT_PORT"] ?? "3080"
        return "http://127.0.0.1:\(port)"
    }
    var launcherScriptPath: String { repoPath + "/server/native-ssh-session.sh" }
    var startScriptPath: String { repoPath + "/scripts/start.sh" }
    var retryTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenus()

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width: CGFloat = min(1520, screenFrame.width * 0.94)
        let height: CGFloat = min(940, screenFrame.height * 0.93)
        let rect = NSRect(
            x: screenFrame.origin.x + (screenFrame.width - width) / 2,
            y: screenFrame.origin.y + (screenFrame.height - height) / 2,
            width: width,
            height: height
        )

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "TAKT-UI-CC"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 0.035, green: 0.039, blue: 0.051, alpha: 1.0)
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.delegate = self

        rootView = FlippedContainerView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        rootView.autoresizingMask = [.width, .height]
        window.contentView = rootView

        let userContent = WKUserContentController()
        let bootScript = WKUserScript(
            source: "window.__TAKT_NATIVE_TERM_AVAILABLE__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContent.addUserScript(bootScript)
        userContent.add(self, name: "taktNative")

        let config = WKWebViewConfiguration()
        config.userContentController = userContent
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        webView = WKWebView(frame: rootView.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        nativeTerminalContainer = NSView(frame: NSRect(x: 276, y: 68, width: 700, height: 600))
        nativeTerminalContainer.wantsLayer = true
        nativeTerminalContainer.layer?.backgroundColor = NSColor(srgbRed: 0.039, green: 0.043, blue: 0.059, alpha: 1.0).cgColor
        nativeTerminalContainer.isHidden = true

        rootView.addSubview(webView)
        rootView.addSubview(nativeTerminalContainer)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        loadWorkbenchURL()
        startBackgroundServicesAsync()
    }

    // MARK: - WKScriptMessageHandler (JS <-> Native AppKit SwiftTerm Bridge)
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "taktNative",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }

        switch action {
        case "updateRect":
            let x = CGFloat((body["x"] as? NSNumber)?.doubleValue ?? 0)
            let y = CGFloat((body["y"] as? NSNumber)?.doubleValue ?? 0)
            let w = CGFloat((body["width"] as? NSNumber)?.doubleValue ?? 0)
            let h = CGFloat((body["height"] as? NSNumber)?.doubleValue ?? 0)
            let visible = (body["visible"] as? Bool) ?? false

            if visible && engineMode == "native" && w > 20 && h > 20 {
                let targetFrame = NSRect(x: x, y: y, width: w, height: h)
                if nativeTerminalContainer.frame != targetFrame {
                    nativeTerminalContainer.frame = targetFrame
                }
                for (_, tv) in nativeTabs {
                    tv.frame = NSRect(x: 8, y: 6, width: max(20, w - 16), height: max(20, h - 12))
                }
                nativeTerminalContainer.isHidden = false
            } else {
                nativeTerminalContainer.isHidden = true
            }

        case "activateTab":
            guard let tabId = body["tabId"] as? String else { return }
            let cwd = (body["cwd"] as? String) ?? "/root/work"
            let sshHost = (body["sshHost"] as? String) ?? ""
            activeTabId = tabId
            let termView = getOrCreateNativeTerminal(tabId: tabId, cwd: cwd, sshHost: sshHost)
            for (id, tv) in nativeTabs {
                tv.isHidden = (id != tabId)
            }
            if engineMode == "native" && !nativeTerminalContainer.isHidden {
                window.makeFirstResponder(termView)
            }

        case "sendInput":
            let tabId = (body["tabId"] as? String) ?? activeTabId ?? ""
            let text = (body["text"] as? String) ?? ""
            if let tv = nativeTabs[tabId], !text.isEmpty {
                let bytes = Array(text.utf8)
                tv.send(source: tv, data: bytes[...])
                if engineMode == "native" {
                    window.makeFirstResponder(tv)
                }
            }

        case "closeTab":
            guard let tabId = body["tabId"] as? String else { return }
            if let tv = nativeTabs.removeValue(forKey: tabId) {
                tv.terminate()
                tv.removeFromSuperview()
            }
            if activeTabId == tabId {
                activeTabId = nil
                nativeTerminalContainer.isHidden = true
            }

        case "setEngine":
            if let mode = body["mode"] as? String {
                engineMode = mode
                if mode != "native" {
                    nativeTerminalContainer.isHidden = true
                } else if let aid = activeTabId, let tv = nativeTabs[aid] {
                    nativeTerminalContainer.isHidden = false
                    window.makeFirstResponder(tv)
                }
            }

        default:
            break
        }
    }

    func getOrCreateNativeTerminal(tabId: String, cwd: String, sshHost: String) -> LocalProcessTerminalView {
        if let existing = nativeTabs[tabId] {
            return existing
        }

        let bounds = nativeTerminalContainer.bounds
        let innerRect = NSRect(
            x: 8,
            y: 6,
            width: max(100, bounds.width - 16),
            height: max(80, bounds.height - 12)
        )

        let tv = LocalProcessTerminalView(frame: innerRect)
        tv.autoresizingMask = [.width, .height]

        // Codex Monochrome Graphite Dark Theme for Native AppKit Terminal (Zero Green)
        tv.nativeBackgroundColor = NSColor(srgbRed: 0.051, green: 0.051, blue: 0.051, alpha: 1.0) // #0d0d0d
        tv.nativeForegroundColor = NSColor(srgbRed: 0.925, green: 0.925, blue: 0.937, alpha: 1.0) // #ececef
        tv.caretColor = NSColor(srgbRed: 0.957, green: 0.957, blue: 0.961, alpha: 1.0)            // #f4f4f5 Codex Silver-White
        tv.caretTextColor = NSColor(srgbRed: 0.051, green: 0.051, blue: 0.051, alpha: 1.0)
        tv.selectedTextBackgroundColor = NSColor(srgbRed: 1.0, green: 1.0, blue: 1.0, alpha: 0.20)
        tv.font = NSFont(name: "JetBrains Mono", size: 13.0)
            ?? NSFont(name: "SF Mono", size: 13.0)
            ?? NSFont.monospacedSystemFont(ofSize: 13.0, weight: .regular)
        tv.optionAsMetaKey = true

        nativeTerminalContainer.addSubview(tv)
        nativeTabs[tabId] = tv

        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = "en_US.UTF-8"
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        let envArray = env.map { "\($0.key)=\($0.value)" }

        let targetHost = sshHost
        tv.startProcess(
            executable: "/bin/bash",
            args: [launcherScriptPath, tabId, cwd, targetHost],
            environment: envArray,
            execName: "bash"
        )

        return tv
    }

    func startBackgroundServicesAsync() {
        let script = startScriptPath
        DispatchQueue.global(qos: .utility).async {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            task.arguments = ["-c", "'\(script)' </dev/null >/tmp/takt-workbench-boot.log 2>&1 &"]
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
            task.environment = env
            try? task.run()
        }
    }

    @objc func loadWorkbenchURL() {
        guard let url = URL(string: workbenchURLString) else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.timeoutInterval = 3.0
        webView.load(req)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry()
    }

    func scheduleRetry() {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in
            self?.loadWorkbenchURL()
        }
    }

    @objc func reloadPage(_ sender: Any?) {
        loadWorkbenchURL()
    }

    @objc func openInBrowser(_ sender: Any?) {
        if let url = URL(string: workbenchURLString) {
            NSWorkspace.shared.open(url)
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func setupMenus() {
        let mainMenu = NSMenu()

        // App Menu
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 TAKT-UI-CC", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "刷新工作台界面", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        appMenu.addItem(withTitle: "在浏览器中打开", action: #selector(openInBrowser(_:)), keyEquivalent: "b")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "隐藏窗口", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出 TAKT-UI-CC", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Edit Menu
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // Window Menu
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

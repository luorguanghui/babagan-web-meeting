using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Babagan {
  internal static class Client {
    [STAThread] static int Main(string[] args) {
      Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
      if (args.Length == 2 && args[0] == "--smoke-test") {
        try {
          using (var helper = new DesktopHelper()) {
            Task.Run(() => helper.Start(AppDomain.CurrentDomain.BaseDirectory)).GetAwaiter().GetResult();
            if (!helper.Stop(true)) throw new IOException("本机组件在父进程管道关闭后未能正常退出。");
          }
          var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
          if (!Package.SupportedWebView(version)) throw new Exception("需要 WebView2 156 或更新版本。");
          File.WriteAllText(args[1], "{\"ready\":true,\"captureStarted\":false,\"version\":\"" + Package.Version + "\"}"); return 0;
        } catch (Exception error) { try { File.WriteAllText(args[1], Package.Json().Serialize(new { ready = false, error = error.GetType().Name, message = error.Message })); } catch {} return 1; }
      }
      string health = args.Length == 2 && args[0] == "--health-file" ? args[1] : null;
      try {
        bool first;
        using (var mutex = new Mutex(true, Package.MutexName, out first)) {
          if (!first) { using (var signal = EventWaitHandle.OpenExisting(Package.MutexName + ".open")) signal.Set(); if (health != null) File.WriteAllText(health, "ready"); return 0; }
          using (var form = new MeetingWindow(health)) Application.Run(form);
          mutex.ReleaseMutex(); return 0;
        }
      } catch { MessageBox.Show("无法启动 Babagan 客户端。请重新运行安装器修复，或使用普通网页。", "Babagan", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
  }
  internal sealed class MeetingWindow : Form {
    readonly WebView2 web = new WebView2(); readonly DesktopHelper helper = new DesktopHelper(); readonly CancellationTokenSource cancel = new CancellationTokenSource();
    readonly ClientUpdater updater; readonly string health; readonly Label status = new Label(); readonly EventWaitHandle open; readonly System.Windows.Forms.Timer poll;
    readonly Dictionary<CoreWebView2PermissionKind, CoreWebView2PermissionState> permissions = new Dictionary<CoreWebView2PermissionKind, CoreWebView2PermissionState>();
    bool joined, closing, initialized, resourcesDisposed; string updateState = "current";
    internal MeetingWindow(string healthFile) {
      health = healthFile; Text = "Babagan · 会议"; Width = 1240; Height = 840; MinimumSize = new Size(860, 620); StartPosition = FormStartPosition.CenterScreen;
      Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); BackColor = ColorTranslator.FromHtml("#fff7ed");
      Font = new Font("Microsoft YaHei UI", 9);
      web.Dock = DockStyle.Fill; status.Dock = DockStyle.Bottom; status.Height = 28; status.Padding = new Padding(12, 5, 0, 0); status.ForeColor = ColorTranslator.FromHtml("#68412b"); status.Text = "正在准备会议…";
      Controls.Add(web); Controls.Add(status);
      open = new EventWaitHandle(false, EventResetMode.AutoReset, Package.MutexName + ".open");
      updater = new ClientUpdater(Package.Root, AppDomain.CurrentDomain.BaseDirectory, () => joined || helper.CaptureActive, UpdateChanged);
      helper.ActivityChanged += () => Ui(async () => { updater.ActivityChanged(); if (!joined && !helper.CaptureActive && updateState == "available") await updater.Check(cancel.Token); });
      helper.Failed += () => Ui(() => { if (!closing) status.Text = "本机采集组件已退出；重新打开客户端可恢复高质量共享。"; });
      poll = new System.Windows.Forms.Timer { Interval = 500 };
      var nextCheck = DateTime.UtcNow.AddMinutes(30);
      poll.Tick += async (_, e) => {
        if (open.WaitOne(0)) { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); }
        if (initialized && DateTime.UtcNow >= nextCheck) { nextCheck = DateTime.UtcNow.AddMinutes(30); await updater.Check(cancel.Token); }
      };
      poll.Start(); Shown += async (_, e) => await Initialize();
      FormClosing += (_, e) => {
        if (closing) return;
        if ((joined || helper.CaptureActive) && MessageBox.Show("关闭客户端会离开会议并停止本机共享。是否继续？", "Babagan", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) { e.Cancel = true; return; }
        closing = true; cancel.Cancel(); poll.Stop();
        // Stop our own helper before permitting a pending update to activate.
        helper.Dispose(); joined = false; helper.CaptureActive = false; updater.TryActivate();
      };
    }
    void Ui(Action action) { if (closing || IsDisposed || !IsHandleCreated) return; try { BeginInvoke(action); } catch (InvalidOperationException) {} }
    async Task Initialize() {
      try {
        if (!Package.SupportedWebView(CoreWebView2Environment.GetAvailableBrowserVersionString())) throw new IOException("WebView2 运行时过旧。");
        var launch = await helper.Start(AppDomain.CurrentDomain.BaseDirectory);
        var options = new CoreWebView2EnvironmentOptions("--disable-features=MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop --enable-features=WebRtcAV1HWEncode --disable-background-timer-throttling --disable-renderer-backgrounding");
        var environment = await CoreWebView2Environment.CreateAsync(null, Package.Child(Package.Root, "webview-profile"), options);
        environment.NewBrowserVersionAvailable += (_, e) => Ui(() => status.Text = "浏览器组件已更新，下次打开客户端生效。");
        await web.EnsureCoreWebView2Async(environment);
        web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
        web.CoreWebView2.Settings.AreDevToolsEnabled = false;
        web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        web.CoreWebView2.Settings.IsPasswordAutosaveEnabled = false;
        web.CoreWebView2.Settings.IsGeneralAutofillEnabled = false;
        web.CoreWebView2.NavigationStarting += (_, e) => { if (!Package.TrustedUrl(e.Uri)) { e.Cancel = true; External(e.Uri); } };
        web.CoreWebView2.FrameNavigationStarting += (_, e) => { if (!Package.TrustedUrl(e.Uri) && e.Uri != "about:blank") e.Cancel = true; };
        web.CoreWebView2.NewWindowRequested += (_, e) => { e.Handled = true; if (Package.TrustedUrl(e.Uri)) web.CoreWebView2.Navigate(e.Uri); else External(e.Uri); };
        web.CoreWebView2.PermissionRequested += (_, e) => {
          if (!Package.TrustedUrl(e.Uri)) { e.State = CoreWebView2PermissionState.Deny; return; }
          string kind = e.PermissionKind.ToString();
          if (kind == "LocalNetworkAccess" || kind == "LoopbackNetwork") { e.State = CoreWebView2PermissionState.Allow; return; }
          if (e.PermissionKind != CoreWebView2PermissionKind.Microphone && e.PermissionKind != CoreWebView2PermissionKind.Camera) { e.State = CoreWebView2PermissionState.Default; return; }
          CoreWebView2PermissionState decision;
          if (!permissions.TryGetValue(e.PermissionKind, out decision)) {
            string name = e.PermissionKind == CoreWebView2PermissionKind.Microphone ? "麦克风" : "摄像头";
            decision = MessageBox.Show("允许 Babagan 在会议中使用" + name + "？", "设备权限", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny; permissions[e.PermissionKind] = decision;
          }
          e.State = decision;
        };
        web.CoreWebView2.WebMessageReceived += OnMessage;
        web.CoreWebView2.NavigationCompleted += (_, e) => { if (!closing) status.Text = e.IsSuccess ? "Babagan · Windows 客户端 " + Package.Version : "网页连接失败，请检查网络后重新打开客户端。"; };
        if (health != null) File.WriteAllText(health, "ready");
        initialized = true; web.CoreWebView2.Navigate(Package.ClientStartUrl(launch));
        updater.TryActivate(); await updater.Check(cancel.Token);
      } catch { status.Text = "客户端启动失败。请检查网络，或重新运行安装器修复。"; }
    }
    void External(string value) {
      Uri uri; if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || uri.Scheme != "https" || uri.UserInfo.Length != 0) return;
      try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); } catch {}
    }
    async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
      object id = null;
      try {
        if (!Package.TrustedUrl(e.Source) || !Package.TrustedUrl(web.CoreWebView2.Source)) return;
        if (e.WebMessageAsJson.Length > 8192) throw new InvalidDataException();
        var request = Package.Json().Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
        if (request == null || !request.ContainsKey("v") || Convert.ToInt32(request["v"]) != 1 || !request.ContainsKey("id")) throw new InvalidDataException();
        id = request["id"]; if (!(id is string) || ((string)id).Length > 128) throw new InvalidDataException();
        var method = Convert.ToString(request["method"]); object result;
        if (method == "client.info") result = new { protocol = 1, platform = "windows", appVersion = Package.Version, screenCapture = true, systemAudio = false, autoUpdate = true, updateState = updater.State };
        else if (method == "meeting.state") {
          var parameters = request.ContainsKey("params") ? request["params"] as Dictionary<string, object> : null;
          if (parameters == null || parameters.Count != 1 || !parameters.ContainsKey("joined") || !(parameters["joined"] is bool)) throw new InvalidDataException();
          joined = (bool)parameters["joined"]; updater.ActivityChanged(); if (!joined && !helper.CaptureActive && updateState == "available") await updater.Check(cancel.Token); result = new { joined = joined };
        } else if (method == "update.check") { await updater.Check(cancel.Token); result = updater.State; }
        else throw new InvalidDataException();
        Reply(new { v = 1, id = id, ok = true, result = result });
      } catch { if (id != null) Reply(new { v = 1, id = id, ok = false, error = new { code = "unsupported_request", message = "客户端不支持此请求。" } }); }
    }
    void Reply(object value) { if (!closing && initialized && Package.TrustedUrl(web.CoreWebView2.Source)) web.CoreWebView2.PostWebMessageAsJson(Package.Json().Serialize(value)); }
    void UpdateChanged(string state, string text) {
      updateState = state; if (closing || IsDisposed) return; status.Text = text;
      var current = updater.State;
      Reply(new { v = 1, @event = "update.state", state = current.state, message = current.message, phase = current.phase,
        downloadedBytes = current.downloadedBytes, totalBytes = current.totalBytes, updateRevision = current.updateRevision });
    }
    protected override void Dispose(bool disposing) {
      if (disposing && !resourcesDisposed) { resourcesDisposed = true; closing = true; cancel.Cancel(); helper.Dispose(); poll.Dispose(); open.Dispose(); web.Dispose(); cancel.Dispose(); }
      base.Dispose(disposing);
    }
  }
}

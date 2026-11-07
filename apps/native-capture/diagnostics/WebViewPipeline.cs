// Standalone diagnostics only. Its single navigation target is a local synthetic fixture.
// Capability configuration arrives on an owned stdin pipe, never in command arguments or logs.
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class TestConfiguration { public string url; public int seconds; public string output; public bool steps; public int bitrate; public bool largePan; public bool snapshots; }
internal static class WebViewPipeline {
  [STAThread] static int Main() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    try {
      var line = Console.ReadLine(); if (line == null || line.Length > 8192) throw new InvalidDataException();
      var config = new JavaScriptSerializer().Deserialize<TestConfiguration>(line);
      var uri = new Uri(config.url);
      if (uri.GetLeftPart(UriPartial.Authority) != "http://127.0.0.1:5188" || uri.AbsolutePath != "/apps/native-capture/diagnostics/browser-pipeline.html" || uri.UserInfo.Length != 0
        || !uri.Fragment.StartsWith("#nativeCapture=1.") || config.seconds < 10 || config.seconds > 600 || !Path.IsPathRooted(config.output)) throw new InvalidDataException();
      Directory.CreateDirectory(config.output);
      using (var form = new TestWindow(config)) { Application.Run(form); return form.Result; }
    } catch (Exception error) { Console.Error.WriteLine("Synthetic WebView2 harness failed: " + error.GetType().Name); return 1; }
  }
}
internal sealed class TestWindow : Form {
  readonly TestConfiguration config; readonly WebView2 web = new WebView2();
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 20000000, RecursionLimit = 80 };
  Form cover; bool finished, disposing; string browser; internal int Result = 1;
  internal TestWindow(TestConfiguration input) {
    config = input; Text = "Babagan WebView2 synthetic pipeline · TEST CONTENT ONLY"; ClientSize = new Size(1280, 760); StartPosition = FormStartPosition.CenterScreen;
    web.Dock = DockStyle.Fill; Controls.Add(web);
    Shown += async (_, e) => await Run();
    FormClosing += (_, e) => { if (!finished) e.Cancel = true; };
  }
  async Task<string> Evaluate(string script) { return await web.CoreWebView2.ExecuteScriptAsync(script); }
  async Task<bool> WaitFor(string predicate, int timeout) {
    var until = DateTime.UtcNow.AddMilliseconds(timeout);
    while (DateTime.UtcNow < until) { if (await Evaluate("Boolean(" + predicate + ")") == "true") return true; await Task.Delay(100); }
    return false;
  }
  async Task Save(int elapsed) {
    string serialized = await Evaluate("JSON.stringify({samples:window.samples||[],errors:window.diagnosticErrors||[],observerError:window.observerError||null,failure:window.failure||null,decodedFrameChecks:window.decodedFrameChecks,stopped:!!window.stopped})");
    var data = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(json.Deserialize<string>(serialized));
    data["browser"] = browser; data["runtime"] = "WebView2"; data["steps"] = config.steps; data["bitrate"] = config.bitrate; data["sampledSeconds"] = elapsed;
    data["input"] = config.largePan ? "Cached synthetic 4096x2304 chart; full-viewport fast pan/diagonal/scroll/cuts; no desktop capture" : "FFmpeg generated testsrc2 / color only; no desktop capture";
    data["largePan"] = config.largePan;
    if (config.largePan) data["motionCycleSeconds"] = 90;
    data["snapshots"] = config.snapshots;
    File.WriteAllText(Path.Combine(config.output, "samples.json"), json.Serialize(data), new UTF8Encoding(false));
    Console.WriteLine(json.Serialize(new { elapsed = elapsed, state = "sampled" })); Console.Out.Flush();
  }
  async Task Run() {
    Exception failure = null;
    try {
      var options = new CoreWebView2EnvironmentOptions("--disable-features=MediaFoundationUseSWBRCForH264Camera,MediaFoundationUseSWBRCForH264Desktop --enable-features=WebRtcAV1HWEncode --disable-background-timer-throttling --disable-renderer-backgrounding");
      var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(config.output, "owned-test-profile"), options);
      browser = environment.BrowserVersionString;
      await web.EnsureCoreWebView2Async(environment);
      web.CoreWebView2.Settings.AreHostObjectsAllowed = false;
      web.CoreWebView2.Settings.AreDevToolsEnabled = false;
      web.CoreWebView2.NavigationStarting += (_, e) => { Uri target; if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || target.GetLeftPart(UriPartial.Authority) != "http://127.0.0.1:5188" || target.AbsolutePath != "/apps/native-capture/diagnostics/browser-pipeline.html") e.Cancel = true; };
      web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
      web.CoreWebView2.PermissionRequested += (_, e) => e.State = e.PermissionKind == CoreWebView2PermissionKind.Autoplay ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
      await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.diagnosticErrors=[];addEventListener('error',e=>window.diagnosticErrors.push(String(e.message)));addEventListener('unhandledrejection',e=>window.diagnosticErrors.push(String(e.reason)));");
      web.CoreWebView2.Navigate(config.url);
      // The module initializes window.samples only after its production imports resolve.
      if (!await WaitFor("window.samples && document.querySelector('#start')?.onclick", 30000)) throw new TimeoutException("Fixture did not initialize");
      await Evaluate("document.querySelector('#start').click()");
      if (!await WaitFor("window.ready || window.failure", 30000) || await Evaluate("Boolean(window.failure)") == "true") throw new InvalidOperationException("Synthetic media did not start");
      for (int elapsed = 0; elapsed < config.seconds; elapsed += 10) {
        if (elapsed == 20) {
          await Evaluate("window.testPhase='background-test'");
          cover = new Form { Text = "Babagan owned background test", ClientSize = new Size(1000, 600), StartPosition = FormStartPosition.CenterScreen, BackColor = Color.FromArgb(255, 247, 237) };
          cover.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "Synthetic WebView2 media continues in the other owned test window.\nNo desktop, camera or microphone is being captured.", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 18) });
          cover.Show(); cover.Activate();
        }
        if (elapsed == 40) { await Evaluate("window.testPhase='window-minimized'"); if (cover != null) { cover.Close(); cover.Dispose(); cover = null; } WindowState = FormWindowState.Minimized; }
        if (elapsed == 60) { WindowState = FormWindowState.Normal; Activate(); await Evaluate("window.testPhase='foreground-restored'"); }
        await Task.Delay(Math.Min(10, config.seconds - elapsed) * 1000);
        await Save(Math.Min(elapsed + 10, config.seconds));
        if (config.snapshots && (elapsed == 10 || (config.largePan && (elapsed == 40 || elapsed == 70)))) {
          string encoded = json.Deserialize<string>(await Evaluate("(()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png').split(',')[1]})()"));
          File.WriteAllBytes(Path.Combine(config.output, "decoded-" + (elapsed + 10) + "s.png"), Convert.FromBase64String(encoded));
        }
      }
      await Evaluate("document.querySelector('#stop').click()");
      if (!await WaitFor("window.stopped", 10000)) throw new TimeoutException("Synthetic pipeline did not stop");
      await Save(config.seconds); Result = 0;
    } catch (Exception error) { failure = error; }
    if (failure != null) {
      try { if (web.CoreWebView2 != null) await Save(-1); } catch {}
      Console.Error.WriteLine("Synthetic WebView2 run failed: " + failure.GetType().Name);
    }
    finished = true; if (cover != null) { cover.Close(); cover.Dispose(); cover = null; } Close();
  }
  protected override void Dispose(bool value) { if (value && !disposing) { disposing = true; web.Dispose(); } base.Dispose(value); }
}

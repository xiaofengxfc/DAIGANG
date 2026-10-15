using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

// Visual direction contract
// THESIS: this is a night-shift operations console, not a generic settings dialog.
// OWN-WORLD: graphite surfaces, indigo action color, thin structure lines, quiet status lights.
// STORY: the operator sees backend state first, acts second, and can audit the latest log below.
// FIRST VIEWPORT: navigation rail on the left; status/action workspace on the right.
// FORM: Operate mode; compact desktop workbench with native WinForms controls and no decorative chrome.
namespace DaiganLauncher
{
    internal static class Program
    {
        internal static readonly string Root = NormalizeRoot(AppDomain.CurrentDomain.BaseDirectory);
        internal static readonly string StateDirectory = Path.Combine(Root, "launcher-data");
        internal static readonly string PidFile = Path.Combine(StateDirectory, "server.pid");
        internal static readonly string LogFile = Path.Combine(StateDirectory, "server.log");
        internal const string AutoStartName = "DaiganOpsConsole";
        private const string RunKeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

        private static string NormalizeRoot(string path)
        {
            string full = Path.GetFullPath(path ?? AppDomain.CurrentDomain.BaseDirectory);
            string root = Path.GetPathRoot(full);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)) return full;
            return full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        [STAThread]
        private static void Main(string[] args)
        {
            bool created;
            using (var mutex = new System.Threading.Mutex(true, "Local\\DaiganOpsConsoleLauncher", out created))
            {
                if (!created)
                {
                    MessageBox.Show("启动器已经在运行。", "代肝价格查询", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherForm(args));
            }
        }

        internal static string FindNodeExecutable()
        {
            var candidates = new List<string>();
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "node.exe",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(2000);
                    candidates.AddRange(output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));
                }
            }
            catch { }

            string explicitNode = Environment.GetEnvironmentVariable("XFC_NODE_PATH");
            if (!string.IsNullOrWhiteSpace(explicitNode)) candidates.Insert(0, explicitNode);

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string app = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string nvmHome = Environment.GetEnvironmentVariable("NVM_HOME");
            string nvmSymlink = Environment.GetEnvironmentVariable("NVM_SYMLINK");
            candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            candidates.Add(Path.Combine(pf86, "nodejs", "node.exe"));
            candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));
            if (!string.IsNullOrWhiteSpace(nvmSymlink)) candidates.Add(Path.Combine(nvmSymlink, "node.exe"));
            if (!string.IsNullOrWhiteSpace(nvmHome)) candidates.Add(Path.Combine(nvmHome, "node.exe"));
            candidates.Add(Path.Combine(user, "scoop", "shims", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "chocolatey", "bin", "node.exe"));

            AddVersionedNodeCandidates(candidates, nvmHome);
            AddVersionedNodeCandidates(candidates, Path.Combine(app, "nvm"));

            foreach (string raw in candidates)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                string path = raw.Trim().Trim('"');
                if (File.Exists(path) && string.Equals(Path.GetFileName(path), "node.exe", StringComparison.OrdinalIgnoreCase))
                    return Path.GetFullPath(path);
            }
            return null;
        }

        private static void AddVersionedNodeCandidates(List<string> candidates, string directory)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return;
            try
            {
                foreach (string child in Directory.GetDirectories(directory))
                    candidates.Add(Path.Combine(child, "node.exe"));
            }
            catch { }
        }

        internal static string ReadNodeVersion(string node)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = "-v",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(3000);
                    return output;
                }
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        internal static bool IsSupportedNodeVersion(string version)
        {
            Match match = Regex.Match(version ?? "", @"v?(\d+)\.(\d+)");
            if (!match.Success) return false;
            int major;
            int minor;
            if (!int.TryParse(match.Groups[1].Value, out major) || !int.TryParse(match.Groups[2].Value, out minor)) return false;
            return major > 22 || (major == 22 && minor >= 12);
        }

        internal static int? FindTrackedServerPid()
        {
            try
            {
                if (!File.Exists(PidFile)) return null;
                string[] parts = File.ReadAllText(PidFile).Trim().Split('|');
                if (parts.Length < 2) return null;
                int pid;
                long startFileTime;
                if (!int.TryParse(parts[0], out pid) || !long.TryParse(parts[1], out startFileTime)) return null;
                using (var process = Process.GetProcessById(pid))
                {
                    if (process.HasExited) return null;
                    long actual = process.StartTime.ToFileTime();
                    if (actual != startFileTime) return null;
                    if (!string.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase)) return null;
                    return pid;
                }
            }
            catch { return null; }
        }

        internal static void SavePid(Process process, string node)
        {
            Directory.CreateDirectory(StateDirectory);
            File.WriteAllText(PidFile, process.Id + "|" + process.StartTime.ToFileTime() + "|" + node, new UTF8Encoding(false));
        }

        internal static void RemovePid()
        {
            try { if (File.Exists(PidFile)) File.Delete(PidFile); } catch { }
        }

        internal static bool IsAutoStartEnabled()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunKeyPath))
                {
                    string command = Convert.ToString(key == null ? null : key.GetValue(AutoStartName)) ?? "";
                    string exe = Application.ExecutablePath;
                    return command.IndexOf(exe, StringComparison.OrdinalIgnoreCase) >= 0 &&
                        command.IndexOf("--autostart", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch { return false; }
        }

        internal static void SetAutoStart(bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(RunKeyPath))
            {
                if (key == null) throw new InvalidOperationException("无法访问当前用户的开机启动设置。");
                if (enabled)
                {
                    string exe = Path.GetFullPath(Application.ExecutablePath);
                    key.SetValue(AutoStartName, "\"" + exe + "\" --autostart", RegistryValueKind.String);
                }
                else key.DeleteValue(AutoStartName, false);
            }
        }

        internal static string QuoteArg(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            // Only backslashes immediately before quotes or the closing quote
            // need doubling. Doubling every slash breaks Windows paths with spaces.
            var quoted = new StringBuilder(value.Length + 2);
            quoted.Append('"');
            int slashes = 0;
            foreach (char ch in value)
            {
                if (ch == '\\') { slashes++; continue; }
                if (ch == '"')
                {
                    quoted.Append(new string('\\', slashes * 2 + 1));
                    quoted.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0) { quoted.Append(new string('\\', slashes)); slashes = 0; }
                quoted.Append(ch);
            }
            if (slashes > 0) quoted.Append(new string('\\', slashes * 2));
            quoted.Append('"');
            return quoted.ToString();
        }

        /**
         * 前端产物（public/dist/）是构建出来的，不进版本库。以前启动器直接拉 server.mjs，
         * 于是「刚克隆下来还没 build」的机器上后台能起来、接口全通，网页却是一片白——
         * 用户只会看到白屏，看不出是没构建。这里让启动器自己把这一步补上。
         */
        internal static string BundleDirectory()
        {
            return Path.Combine(Root, "public", "dist");
        }

        internal static bool BundleMissing()
        {
            return !File.Exists(Path.Combine(BundleDirectory(), "app.js"))
                || !File.Exists(Path.Combine(BundleDirectory(), "app.css"));
        }

        /** 源码比产物新 = 产物过期。第一次构建之后，改了 src/client 再启动就该重建。 */
        internal static bool BundleStale()
        {
            DateTime bundleTime;
            try
            {
                bundleTime = File.GetLastWriteTimeUtc(Path.Combine(BundleDirectory(), "app.js"));
                if (File.Exists(Path.Combine(BundleDirectory(), "app.css")))
                {
                    DateTime css = File.GetLastWriteTimeUtc(Path.Combine(BundleDirectory(), "app.css"));
                    if (css < bundleTime) bundleTime = css;
                }
            }
            catch { return true; }

            foreach (string file in SourceFilesNewerThan(bundleTime))
            {
                if (!string.IsNullOrEmpty(file)) return true;
            }
            return false;
        }

        private static IEnumerable<string> SourceFilesNewerThan(DateTime threshold)
        {
            var roots = new List<string> { Path.Combine(Root, "client"), Path.Combine(Root, "src"), Path.Combine(Root, "shared") };
            foreach (string root in roots)
            {
                if (!Directory.Exists(root)) continue;
                IEnumerable<string> files;
                try { files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories); }
                catch { continue; }
                foreach (string file in files)
                {
                    DateTime written;
                    try { written = File.GetLastWriteTimeUtc(file); }
                    catch { continue; }
                    if (written > threshold) yield return file;
                }
            }
            DateTime config;
            try { config = File.GetLastWriteTimeUtc(Path.Combine(Root, "vite.config.mjs")); }
            catch { config = DateTime.MinValue; }
            if (config > threshold) yield return "vite.config.mjs";
        }

        /** 只认真文件：PATH 上若只有个同名目录，Process.Start 会抛别的错，不如老实判定为找不到。 */
        private static bool FileExistsOnPath(string path)
        {
            try { return !string.IsNullOrWhiteSpace(path) && File.Exists(path.Trim()); }
            catch { return false; }
        }

        /** 装着 node.exe 的那个目录。拿不到就返回空串。 */
        internal static string NodeDirectory()
        {
            string node = FindNodeExecutable();
            try { return string.IsNullOrWhiteSpace(node) ? "" : Path.GetDirectoryName(node); }
            catch { return ""; }
        }

        /**
         * 跑 npm 时用的 PATH。
         *
         * npm.cmd 自己会去调 node。启动器可能是在「PATH 里没有 node」的环境里被拉起来的
         * （开机的 Run 项、从别处双击），但它仍然找到了 node.exe —— 那份 PATH 一定要
         * 传给子进程，否则 npm 会报 'node' is not recognized 而构建失败。
         */
        internal static string BuildPath()
        {
            string existing = Environment.GetEnvironmentVariable("PATH") ?? "";
            string nodeDir = NodeDirectory();
            if (string.IsNullOrWhiteSpace(nodeDir)) return existing;
            if (existing.Split(';').Any((part) => string.Equals(part.Trim().TrimEnd('\\'), nodeDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)))
                return existing;
            return nodeDir + ";" + existing;
        }

        /**
         * 找 npm。npm 是 npm.cmd，而且 .cmd 必须交给 cmd.exe 执行，并且要带上 /d /s /c
         * ——直接 Process.Start("npm.cmd") 在没配 PATHEXT 的环境里会失败。
         * 返回 null 表示这台机器上没找到 npm（那前端就构建不了，由调用方给出提示）。
         */
        internal static string FindNpmCommand()
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "npm.cmd",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(2000);
                    foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        if (FileExistsOnPath(line)) return line.Trim();
                    }
                }
            }
            catch { }

            // where.exe 没找到时，按 Node 的常见装法再猜一遍：npm.cmd 就躺在 node.exe 旁边。
            string nodeDir = NodeDirectory();
            if (!string.IsNullOrWhiteSpace(nodeDir))
            {
                string besideNode = Path.Combine(nodeDir, "npm.cmd");
                if (FileExistsOnPath(besideNode)) return besideNode;
            }
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            return new[]
            {
                Path.Combine(pf, "nodejs", "npm.cmd"),
                Path.Combine(pf86, "nodejs", "npm.cmd")
            }.FirstOrDefault(FileExistsOnPath);
        }

        internal static int? FindProjectServerPidFromWmi()
        {
            try
            {
                string server = Path.Combine(Root, "server.mjs");
                using (var searcher = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'"))
                using (var results = searcher.Get())
                {
                    foreach (ManagementObject item in results)
                    {
                        string command = Convert.ToString(item["CommandLine"]) ?? "";
                        string pidText = Convert.ToString(item["ProcessId"]);
                        int pid;
                        if (!int.TryParse(pidText, out pid)) continue;
                        string serverName = Path.GetFileName(server);
                        // Older launcher builds passed a relative script name, while newer
                        // builds pass the absolute path. Accept both forms here so an upgrade
                        // can still find and control the already-running backend.
                        if (command.IndexOf(server, StringComparison.OrdinalIgnoreCase) >= 0 ||
                            command.IndexOf(serverName, StringComparison.OrdinalIgnoreCase) >= 0)
                            return pid;
                    }
                }
            }
            catch { }
            return null;
        }

        internal static int? FindRunningServerPid()
        {
            return FindTrackedServerPid() ?? FindProjectServerPidFromWmi();
        }
    }

    internal sealed class LauncherForm : Form
    {
        private readonly TextBox _portBox = new TextBox();
        private readonly TextBox _hostBox = new TextBox();
        private readonly TextBox _extraBox = new TextBox();
        private readonly CheckBox _localBox = new CheckBox();
        private readonly CheckBox _autoStartBox = new CheckBox();
        private readonly Label _statusLabel = new Label();
        private readonly Label _nodeLabel = new Label();
        private readonly Label _rootLabel = new Label();
        private readonly Button _startButton = new Button();
        private readonly Button _stopButton = new Button();
        private readonly Button _restartButton = new Button();
        private readonly Button _openButton = new Button();
        private readonly Button _logButton = new Button();
        private readonly Button _dataButton = new Button();
        private readonly Button _buildButton = new Button();
        private readonly RichTextBox _logBox = new RichTextBox();
        private readonly Timer _timer = new Timer();
        private readonly List<string> _passThrough = new List<string>();
        private Process _serverProcess;
        private StreamWriter _logWriter;
        private readonly object _logLock = new object();
        private bool _startOnLoad;
        private bool _closing;
        private bool _loadingSettings;
        private bool _building;
        private DateTime _lastProcessProbeUtc = DateTime.MinValue;
        private int? _lastExternalPid;

        internal LauncherForm(string[] args)
        {
            ParseArguments(args ?? new string[0]);
            try { Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            BuildUi();
            LoadSettings();
            _timer.Interval = 1000;
            _timer.Tick += delegate { RefreshStatus(); };
            _timer.Start();
            Shown += delegate
            {
                if (_startOnLoad)
                {
                    BeginInvoke((Action)delegate
                    {
                        StartServer();
                        // Keep failures visible. A startup error hidden in a minimized window
                        // looks like a broken auto-start to the user.
                        if (HasArgument(args, "--autostart") && Program.FindRunningServerPid().HasValue)
                            WindowState = FormWindowState.Minimized;
                    });
                }
            };
            FormClosing += OnFormClosing;
        }

        private static bool HasArgument(string[] args, string value)
        {
            return args != null && args.Any(a => string.Equals(a, value, StringComparison.OrdinalIgnoreCase));
        }

        private void ParseArguments(string[] args)
        {
            string envPort = Environment.GetEnvironmentVariable("XFC_PORT");
            string envHost = Environment.GetEnvironmentVariable("XFC_HOST");
            _portBox.Text = string.IsNullOrWhiteSpace(envPort) ? "8787" : envPort;
            _hostBox.Text = envHost ?? "";
            _localBox.Checked = Environment.GetEnvironmentVariable("XFC_LOCAL") == "1";

            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i] ?? "";
                if (string.Equals(arg, "--autostart", StringComparison.OrdinalIgnoreCase) || string.Equals(arg, "--start", StringComparison.OrdinalIgnoreCase))
                {
                    _startOnLoad = true;
                }
                else if (string.Equals(arg, "--local", StringComparison.OrdinalIgnoreCase))
                {
                    _localBox.Checked = true;
                    _startOnLoad = true;
                }
                else if (arg.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
                {
                    _portBox.Text = arg.Substring(7);
                    _startOnLoad = true;
                }
                else if (string.Equals(arg, "--port", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    _portBox.Text = args[++i];
                    _startOnLoad = true;
                }
                else if (arg.StartsWith("--host=", StringComparison.OrdinalIgnoreCase))
                {
                    _hostBox.Text = arg.Substring(7);
                    _startOnLoad = true;
                }
                else if (string.Equals(arg, "--host", StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length)
                {
                    _hostBox.Text = args[++i];
                    _startOnLoad = true;
                }
                else if (!string.Equals(arg, "--help", StringComparison.OrdinalIgnoreCase))
                {
                    _passThrough.Add(arg);
                    _startOnLoad = true;
                }
            }
        }

        private void LoadSettings()
        {
            _loadingSettings = true;
            try
            {
                _autoStartBox.Checked = Program.IsAutoStartEnabled();
                if (_passThrough.Count > 0) _extraBox.Text = string.Join(" ", _passThrough.Select(Program.QuoteArg));
                _rootLabel.Text = "项目目录：" + Program.Root;
                _nodeLabel.Text = "Node：检测中…";
                string node = Program.FindNodeExecutable();
                string version = node == null ? "" : Program.ReadNodeVersion(node);
                _nodeLabel.Text = node == null ? "Node：未找到（请安装 Node.js 22.12+）" :
                    "Node：" + node + "  " + (string.IsNullOrWhiteSpace(version) ? "版本未知" : version) +
                    (Program.IsSupportedNodeVersion(version) ? "" : "  · 版本不受支持");
                RefreshStatus();
                RefreshLog();
            }
            finally { _loadingSettings = false; }
        }

        private void BuildUi()
        {
            Text = "代肝价格查询 · 启动控制台";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(900, 620);
            Size = new Size(1180, 780);
            BackColor = Color.FromArgb(11, 13, 16);
            ForeColor = Color.FromArgb(243, 245, 247);
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;

            var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Color.FromArgb(11, 13, 16), Margin = new Padding(0) };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 238));
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(shell);

            var rail = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 20, 24), Padding = new Padding(20, 22, 18, 20) };
            shell.Controls.Add(rail, 0, 0);
            var railGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 8, BackColor = Color.FromArgb(17, 20, 24), Margin = new Padding(0) };
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 60));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            railGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
            rail.Controls.Add(railGrid);

            var brandRow = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) };
            var brandMark = new Label { Text = "代", AutoSize = false, Size = new Size(38, 38), TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.FromArgb(184, 64, 42), ForeColor = Color.FromArgb(255, 246, 242), Font = new Font("Microsoft YaHei UI", 17F, FontStyle.Bold), Location = new Point(0, 0) };
            var brand = new Label { Text = "代肝价格查询", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold), Location = new Point(48, 1) };
            var brandSub = new Label { Text = "运营后台控制台", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(48, 27) };
            brandRow.Controls.Add(brandMark); brandRow.Controls.Add(brand); brandRow.Controls.Add(brandSub); railGrid.Controls.Add(brandRow, 0, 0);

            var navTitle = new Label { Text = "项目", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Font = new Font(Font, FontStyle.Bold), Anchor = AnchorStyles.Left | AnchorStyles.Bottom, Margin = new Padding(2, 0, 0, 5) };
            railGrid.Controls.Add(navTitle, 0, 1);
            var navItem = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(32, 38, 46), Margin = new Padding(0, 0, 0, 2) };
            var navDot = new Label { Text = "●", AutoSize = true, ForeColor = Color.FromArgb(139, 131, 255), Location = new Point(14, 12) };
            var navText = new Label { Text = "后台服务", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Location = new Point(39, 11) };
            navItem.Controls.Add(navDot); navItem.Controls.Add(navText); railGrid.Controls.Add(navItem, 0, 2);
            railGrid.Controls.Add(new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 20, 24) }, 0, 3);

            var safeTitle = new Label { Text = "数据安全", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Font = new Font(Font, FontStyle.Bold), Anchor = AnchorStyles.Left | AnchorStyles.Bottom, Margin = new Padding(2, 0, 0, 5) };
            railGrid.Controls.Add(safeTitle, 0, 4);
            var safeRow = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) };
            var safeDot = new Label { Text = "●", AutoSize = true, ForeColor = Color.FromArgb(63, 167, 126), Location = new Point(2, 5) };
            var safeText = new Label { Text = "本机数据模式", AutoSize = true, ForeColor = Color.FromArgb(167, 176, 188), Location = new Point(21, 5) };
            safeRow.Controls.Add(safeDot); safeRow.Controls.Add(safeText); railGrid.Controls.Add(safeRow, 0, 5);
            _rootLabel.AutoEllipsis = true; _rootLabel.Text = "项目目录：" + Program.Root; _rootLabel.ForeColor = Color.FromArgb(115, 126, 139); _rootLabel.Dock = DockStyle.Fill; _rootLabel.Margin = new Padding(2, 4, 0, 0);
            railGrid.Controls.Add(_rootLabel, 0, 6);
            var railHint = new Label { Text = "数据库与上传文件始终\n留在 data 目录，不会被启动器搬动。", AutoSize = false, Dock = DockStyle.Fill, ForeColor = Color.FromArgb(115, 126, 139), Margin = new Padding(2, 8, 0, 0) };
            railGrid.Controls.Add(railHint, 0, 7);

            var main = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(28, 22, 28, 22), BackColor = Color.FromArgb(11, 13, 16), Margin = new Padding(0) };
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 142));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 190));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.Controls.Add(main, 1, 0);

            var header = new Panel { Dock = DockStyle.Fill };
            var title = new Label { Text = "启动控制台", ForeColor = Color.FromArgb(243, 245, 247), Font = new Font("Microsoft YaHei UI", 20F, FontStyle.Bold), AutoSize = true, Location = new Point(0, 0) };
            var subtitle = new Label { Text = "管理本地后台的运行状态与启动参数", ForeColor = Color.FromArgb(167, 176, 188), AutoSize = true, Location = new Point(2, 38) };
            header.Controls.Add(title); header.Controls.Add(subtitle); main.Controls.Add(header, 0, 0);

            var statusCard = CreateCard();
            var statusGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, Padding = new Padding(0), BackColor = Color.FromArgb(17, 20, 24) };
            statusGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); statusGrid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            statusGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); statusGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 23));
            var statusInfo = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) };
            var statusTitle = new Label { Text = "后台状态", AutoSize = true, ForeColor = Color.FromArgb(167, 176, 188), Location = new Point(0, 0) };
            _statusLabel.Text = "状态：未启动"; _statusLabel.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold); _statusLabel.AutoSize = true; _statusLabel.ForeColor = Color.FromArgb(243, 245, 247); _statusLabel.Location = new Point(0, 25);
            statusInfo.Controls.Add(statusTitle); statusInfo.Controls.Add(_statusLabel); statusGrid.Controls.Add(statusInfo, 0, 0);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(18, 22, 0, 0), Anchor = AnchorStyles.Top | AnchorStyles.Right };
            ConfigureButton(_startButton, "启动", Color.FromArgb(92, 84, 199), StartServer);
            ConfigureButton(_stopButton, "停止", Color.FromArgb(38, 43, 52), StopServer);
            ConfigureButton(_restartButton, "重启", Color.FromArgb(38, 43, 52), RestartServer);
            ConfigureButton(_openButton, "打开后台", Color.FromArgb(63, 167, 126), OpenDashboard);
            actions.Controls.AddRange(new Control[] { _startButton, _stopButton, _restartButton, _openButton });
            statusGrid.Controls.Add(actions, 1, 0);
            var statusHint = new Label { Text = "启动器只负责控制进程，业务数据仍由项目原有服务管理。", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Anchor = AnchorStyles.Left | AnchorStyles.Bottom, Margin = new Padding(2, 0, 0, 0) };
            statusGrid.Controls.Add(statusHint, 0, 1); statusGrid.SetColumnSpan(statusHint, 2);
            statusCard.Controls.Add(statusGrid); main.Controls.Add(statusCard, 0, 1);

            var settings = CreateCard();
            var settingsGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(0), BackColor = Color.FromArgb(17, 20, 24) };
            settingsGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 27)); settingsGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 44)); settingsGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 34)); settingsGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var settingsHeader = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0) };
            var settingsTitle = new Label { Text = "启动配置", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 1, 10, 0) };
            var settingsHint = new Label { Text = "这些参数只在下一次启动或重启时生效", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Margin = new Padding(0, 2, 0, 0) };
            settingsHeader.Controls.Add(settingsTitle); settingsHeader.Controls.Add(settingsHint); settingsGrid.Controls.Add(settingsHeader, 0, 0);
            StyleTextBox(_portBox); StyleTextBox(_hostBox); StyleTextBox(_extraBox);
            var fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 2, Margin = new Padding(0) };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 48)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 36)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 58)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 64));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            fields.Controls.Add(MakeLabel("端口"), 0, 0); fields.Controls.Add(_portBox, 1, 0);
            fields.Controls.Add(MakeLabel("主机"), 2, 0); fields.Controls.Add(_hostBox, 3, 0);
            fields.Controls.Add(MakeLabel("参数"), 0, 1); fields.Controls.Add(_extraBox, 1, 1); fields.SetColumnSpan(_extraBox, 3); settingsGrid.Controls.Add(fields, 0, 1);
            var checks = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 2, 0, 0) };
            _localBox.Text = "仅本机访问（--local）"; _localBox.AutoSize = true; _localBox.ForeColor = Color.FromArgb(167, 176, 188); _localBox.BackColor = Color.FromArgb(17, 20, 24); _localBox.FlatStyle = FlatStyle.Flat; _localBox.Margin = new Padding(0, 2, 26, 0);
            _autoStartBox.Text = "开机自启动"; _autoStartBox.AutoSize = true; _autoStartBox.ForeColor = Color.FromArgb(167, 176, 188); _autoStartBox.BackColor = Color.FromArgb(17, 20, 24); _autoStartBox.FlatStyle = FlatStyle.Flat; _autoStartBox.Margin = new Padding(0, 2, 0, 0);
            checks.Controls.Add(_localBox); checks.Controls.Add(_autoStartBox); settingsGrid.Controls.Add(checks, 0, 2);
            _autoStartBox.CheckedChanged += delegate
            {
                if (_loadingSettings) return;
                try { Program.SetAutoStart(_autoStartBox.Checked); SetStatus(_autoStartBox.Checked ? "已启用开机自启动" : "已关闭开机自启动", Color.FromArgb(37, 99, 235)); }
                catch (Exception ex)
                {
                    _loadingSettings = true;
                    _autoStartBox.Checked = !_autoStartBox.Checked;
                    _loadingSettings = false;
                    MessageBox.Show("保存开机自启动设置失败：" + ex.Message, "设置失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            };
            _nodeLabel.AutoEllipsis = true; _nodeLabel.ForeColor = Color.FromArgb(115, 126, 139); _nodeLabel.Dock = DockStyle.Fill; _nodeLabel.Margin = new Padding(2, 4, 0, 0); settingsGrid.Controls.Add(_nodeLabel, 0, 3); settings.Controls.Add(settingsGrid); main.Controls.Add(settings, 0, 2);

            var logCard = CreateCard();
            var logGrid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(0), BackColor = Color.FromArgb(17, 20, 24) };
            logGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 28)); logGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            var logHeader = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0) };
            var logTitle = new Label { Text = "运行日志", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Location = new Point(0, 2) };
            var logHint = new Label { Text = "最近 180 行 · UTF-8", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(70, 3) };
            ConfigureButton(_logButton, "打开日志", Color.FromArgb(38, 43, 52), OpenLog); ConfigureButton(_dataButton, "数据目录", Color.FromArgb(38, 43, 52), OpenDataDirectory);
            ConfigureButton(_buildButton, "重建前端", Color.FromArgb(38, 43, 52), RebuildFrontend);
            _logButton.Width = 96; _dataButton.Width = 96; _buildButton.Width = 96;
            var logActions = new FlowLayoutPanel { Anchor = AnchorStyles.Top | AnchorStyles.Right, Dock = DockStyle.Right, AutoSize = true, FlowDirection = FlowDirection.RightToLeft, WrapContents = false, Margin = new Padding(0) };
            logActions.Controls.Add(_dataButton); logActions.Controls.Add(_logButton); logActions.Controls.Add(_buildButton);
            logHeader.Controls.Add(logTitle); logHeader.Controls.Add(logHint); logHeader.Controls.Add(logActions); logGrid.Controls.Add(logHeader, 0, 0);
            _logBox.Dock = DockStyle.Fill; _logBox.ReadOnly = true; _logBox.BackColor = Color.FromArgb(11, 13, 16); _logBox.ForeColor = Color.FromArgb(167, 176, 188); _logBox.BorderStyle = BorderStyle.None; _logBox.Font = new Font("Cascadia Mono", 9F); _logBox.DetectUrls = true; _logBox.Padding = new Padding(8);
            logGrid.Controls.Add(_logBox, 0, 1); logCard.Controls.Add(logGrid); main.Controls.Add(logCard, 0, 3);
        }

        private Panel CreateCard()
        {
            return new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 20, 24), Padding = new Padding(22), BorderStyle = BorderStyle.FixedSingle };
        }

        private void StyleTextBox(TextBox box)
        {
            box.Dock = DockStyle.Fill; box.Margin = new Padding(0, 3, 12, 3); box.BackColor = Color.FromArgb(32, 38, 46); box.ForeColor = Color.FromArgb(243, 245, 247); box.BorderStyle = BorderStyle.FixedSingle; box.Font = new Font("Microsoft YaHei UI", 9F);
        }

        private Label MakeLabel(string text)
        {
            return new Label { Text = text, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 0, 0), ForeColor = Color.FromArgb(167, 176, 188) };
        }

        private void ConfigureButton(Button button, string text, Color color, EventHandler handler)
        {
            button.Text = text; button.Width = 104; button.Height = 36; button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 0; button.FlatAppearance.MouseOverBackColor = ControlPaint.Light(color, 0.12f); button.FlatAppearance.MouseDownBackColor = ControlPaint.Light(color, 0.2f); button.BackColor = color; button.ForeColor = Color.White; button.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold); button.Margin = new Padding(0, 0, 8, 0); button.Cursor = Cursors.Hand; button.Click += handler;
            button.MouseEnter += delegate { if (button.Enabled) button.BackColor = ControlPaint.Light(color, 0.12f); };
            button.MouseLeave += delegate { button.BackColor = button.Enabled ? color : Color.FromArgb(32, 38, 46); };
        }

        private int GetPort()
        {
            int port;
            if (!int.TryParse(_portBox.Text.Trim(), out port) || port < 1 || port > 65535) throw new InvalidOperationException("端口必须是 1 到 65535 之间的数字。");
            return port;
        }

        private string BuildNodeArguments()
        {
            var parts = new List<string> { Program.QuoteArg(Path.Combine(Program.Root, "server.mjs")) };
            parts.Add("--port"); parts.Add(GetPort().ToString());
            if (_localBox.Checked) parts.Add("--local");
            if (!string.IsNullOrWhiteSpace(_hostBox.Text)) { parts.Add("--host"); parts.Add(Program.QuoteArg(_hostBox.Text.Trim())); }
            if (!string.IsNullOrWhiteSpace(_extraBox.Text)) parts.Add(_extraBox.Text.Trim());
            return string.Join(" ", parts);
        }

        private void StartServer(object sender, EventArgs e) { StartServer(); }

        /**
         * 开工前先把前端产物准备好。缺了/过期了就自己构建——用户不该为了「网页不白」
         * 去猜 npm run build 这件事。
         *
         * 失败也不拦着启动：后端接口本身是好的，硬拦下来用户连日志都看不到；
         * server.mjs 那边会明确报出前端没构建，网页上也会给一页说明。
         */
        private void EnsureFrontendBuilt()
        {
            if (!Program.BundleMissing() && !Program.BundleStale()) return;
            // RunNpmBuild 里要转消息泵，否则窗口会被判定成「未响应」；转起来之后
            // 用户可能又点一下「启动」。这里挡住重入，别把同一份产物构建两遍。
            if (_building) return;

            string reason = Program.BundleMissing() ? "前端还没构建" : "前端产物比源码旧";
            string npm = Program.FindNpmCommand();
            if (npm == null)
            {
                WriteLog("⚠ " + reason + "，但这台机器上没找到 npm，无法自动构建。");
                WriteLog("  请手动在 " + Program.Root + " 下执行：npm run setup");
                return;
            }

            WriteLog("===== " + reason + "，开始构建前端 =====");
            SetStatus("正在构建前端…", Color.FromArgb(37, 99, 235));
            _building = true;
            int code;
            string built;
            try
            {
                var output = new StringBuilder();
                code = RunNpmBuild(npm, output);
                built = output.ToString();
            }
            finally { _building = false; }

            foreach (string line in built.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
                WriteLog("  " + line);

            if (code == 0 && !Program.BundleMissing())
            {
                WriteLog("===== 前端构建完成 =====");
                return;
            }

            WriteLog("⚠ 前端构建失败（退出码 " + code + "），后台会照常启动。");
            WriteLog("  手动重试：在 " + Program.Root + " 下执行 npm run setup");
            MessageBox.Show(
                "前端构建失败（退出码 " + code + "）。\n\n" +
                "后台仍会启动，但网页可能显示「前端还没构建」的提示页。\n" +
                "常见原因：首次构建需要联网下载依赖，网络不通就会失败。\n\n" +
                "可以在 " + Program.Root + " 下手动执行：npm run setup",
                "前端构建失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        /**
         * 跑 npm run build。npm 是 .cmd，必须经 cmd.exe 执行，并加 /d /s /c。
         * 构建可能要几十秒到几分钟（首次要下依赖），这里给 10 分钟上限，
         * 同时把消息泵转起来，免得窗口被判定成「未响应」。
         */
        private int RunNpmBuild(string npmPath, StringBuilder output)
        {
            var psi = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                Arguments = "/d /s /c \"\"" + npmPath + "\" run build 2>&1\"",
                WorkingDirectory = Program.Root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            // npm.cmd 内部要调 node；启动器可能是从「PATH 里没有 node」的环境起来的，
            // 把 node 目录补进子进程的 PATH，否则会失败在 'node' is not recognized。
            psi.EnvironmentVariables["PATH"] = Program.BuildPath();

            using (var process = new Process { StartInfo = psi })
            {
                process.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) output.AppendLine(e.Data);
                };
                process.Start();
                process.BeginOutputReadLine();

                var deadline = DateTime.UtcNow.AddMinutes(10);
                while (!process.WaitForExit(120))
                {
                    Application.DoEvents();
                    if (DateTime.UtcNow > deadline)
                    {
                        try { process.Kill(); } catch { }
                        output.AppendLine("构建超时（超过 10 分钟），已中止。");
                        return -1;
                    }
                }
                // WaitForExit(int) 返回后异步的 stdout 可能还没读完，无参版本等它排空。
                process.WaitForExit();
                return process.ExitCode;
            }
        }

        /** 工具栏里的手动入口：日志卡在「重建前端」按钮上。 */
        private void RebuildFrontend(object sender, EventArgs e)
        {
            if (_building) return;
            string npm = Program.FindNpmCommand();
            if (npm == null)
            {
                MessageBox.Show("没有找到 npm。请先安装 Node.js 22.12 或更高版本。", "无法构建前端", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (Program.FindRunningServerPid().HasValue)
            {
                MessageBox.Show("后台正在运行。构建过程中页面会短暂不可用，构建完成后需要重启后台才会生效。", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }

            _building = true;
            _buildButton.Enabled = false;
            try
            {
                WriteLog("\r\n===== 手动重建前端 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
                SetStatus("正在构建前端…", Color.FromArgb(37, 99, 235));
                var output = new StringBuilder();
                int code = RunNpmBuild(npm, output);
                foreach (string line in output.ToString().Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
                    WriteLog("  " + line);
                if (code == 0 && !Program.BundleMissing())
                {
                    SetStatus("前端构建完成", Color.FromArgb(5, 150, 105));
                    MessageBox.Show("前端构建完成。如果后台正在运行，重启后台后新界面才会生效。", "完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    SetStatus("前端构建失败", Color.FromArgb(220, 38, 38));
                    MessageBox.Show("前端构建失败（退出码 " + code + "）。详情见下方日志。", "构建失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            finally
            {
                _building = false;
                _buildButton.Enabled = true;
                RefreshStatus();
            }
        }

        private void StartServer()
        {
            Process startedProcess = null;
            try
            {
                int? tracked = Program.FindRunningServerPid();
                if (tracked.HasValue) { SetStatus("后台已在运行 · PID " + tracked.Value, Color.FromArgb(5, 150, 105)); return; }
                Program.RemovePid();
                string node = Program.FindNodeExecutable();
                if (node == null) throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js 22.12 或更高版本后重试。");
                string nodeVersion = Program.ReadNodeVersion(node);
                if (!Program.IsSupportedNodeVersion(nodeVersion)) throw new InvalidOperationException("当前 Node.js 版本不受支持（需要 22.12 或更高版本，当前为 " + (string.IsNullOrWhiteSpace(nodeVersion) ? "未知" : nodeVersion) + "）。");
                if (!File.Exists(Path.Combine(Program.Root, "server.mjs"))) throw new InvalidOperationException("项目入口 server.mjs 不在 EXE 所在目录，无法启动。");
                GetPort();
                Directory.CreateDirectory(Program.StateDirectory);
                CloseLogWriter();
                _logWriter = new StreamWriter(new FileStream(Program.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
                WriteLog("\r\n===== 启动请求 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
                WriteLog("Node: " + node);
                WriteLog("Args: " + BuildNodeArguments());
                // 先补前端产物，再拉后台：白屏的根因就在这里，别等用户自己发现。
                EnsureFrontendBuilt();
                var psi = new ProcessStartInfo
                {
                    FileName = node,
                    Arguments = BuildNodeArguments(),
                    WorkingDirectory = Program.Root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };
                _serverProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
                startedProcess = _serverProcess;
                _serverProcess.OutputDataReceived += OnProcessOutput;
                _serverProcess.ErrorDataReceived += OnProcessOutput;
                _serverProcess.Exited += OnProcessExited;
                if (!_serverProcess.Start()) throw new InvalidOperationException("Node 启动失败。");
                _serverProcess.BeginOutputReadLine(); _serverProcess.BeginErrorReadLine();
                Program.SavePid(_serverProcess, node);
                SetStatus("启动中 · PID " + _serverProcess.Id, Color.FromArgb(37, 99, 235));
                RefreshButtons(true);
            }
            catch (Exception ex)
            {
                if (startedProcess != null)
                {
                    try
                    {
                        if (!startedProcess.HasExited) startedProcess.Kill();
                    }
                    catch { }
                    try { startedProcess.Dispose(); } catch { }
                    if (ReferenceEquals(_serverProcess, startedProcess)) _serverProcess = null;
                }
                Program.RemovePid();
                RefreshButtons(false);
                WriteLog("启动失败：" + ex.Message);
                SetStatus("启动失败", Color.FromArgb(220, 38, 38));
                MessageBox.Show(ex.Message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void StopServer(object sender, EventArgs e) { StopServer(); }

        private void StopServer()
        {
            try
            {
                int? pid = _serverProcess != null && !_serverProcess.HasExited ? (int?)_serverProcess.Id : Program.FindRunningServerPid();
                if (!pid.HasValue) { Program.RemovePid(); SetStatus("后台未运行", Color.FromArgb(100, 116, 139)); return; }
                WriteLog("正在停止后台 · PID " + pid.Value);
                using (var process = Process.GetProcessById(pid.Value))
                {
                    process.Kill();
                    process.WaitForExit(5000);
                }
                Program.RemovePid();
                if (_serverProcess != null) { _serverProcess.Dispose(); _serverProcess = null; }
                SetStatus("已停止", Color.FromArgb(100, 116, 139));
                RefreshButtons(false);
            }
            catch (Exception ex)
            {
                WriteLog("停止失败：" + ex.Message);
                SetStatus("停止失败", Color.FromArgb(220, 38, 38));
                MessageBox.Show("停止后台失败：" + ex.Message, "停止失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RestartServer(object sender, EventArgs e)
        {
            StopServer();
            BeginInvoke((Action)delegate { StartServer(); });
        }

        private void OpenDashboard(object sender, EventArgs e)
        {
            try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + GetPort()) { UseShellExecute = true }); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "无法打开浏览器", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private void OpenLog(object sender, EventArgs e)
        {
            try
            {
                Directory.CreateDirectory(Program.StateDirectory);
                if (!File.Exists(Program.LogFile)) File.WriteAllText(Program.LogFile, "", new UTF8Encoding(false));
                Process.Start(new ProcessStartInfo(Program.LogFile) { UseShellExecute = true });
            }
            catch (Exception ex) { MessageBox.Show(ex.Message, "无法打开日志", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private void OpenDataDirectory(object sender, EventArgs e)
        {
            try { Process.Start(new ProcessStartInfo("explorer.exe", Program.QuoteArg(Path.Combine(Program.Root, "data"))) { UseShellExecute = false }); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "无法打开数据目录", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }

        private void OnProcessOutput(object sender, DataReceivedEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Data)) WriteLog(e.Data);
        }

        private void OnProcessExited(object sender, EventArgs e)
        {
            var exited = sender as Process;
            try
            {
                if (exited != null && File.Exists(Program.PidFile))
                {
                    string first = File.ReadAllText(Program.PidFile).Trim().Split('|').FirstOrDefault();
                    if (first == exited.Id.ToString()) Program.RemovePid();
                }
            }
            catch { }
            try { BeginInvoke((Action)delegate { if (!_closing) { SetStatus("后台已退出，请查看日志", Color.FromArgb(220, 38, 38)); RefreshButtons(false); RefreshLog(); } }); } catch { }
        }

        private void WriteLog(string text)
        {
            try
            {
                Directory.CreateDirectory(Program.StateDirectory);
                lock (_logLock)
                {
                    if (_logWriter == null) _logWriter = new StreamWriter(new FileStream(Program.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
                    _logWriter.WriteLine("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + text);
                }
            }
            catch { }
            RefreshLogSafe();
        }

        private void RefreshLogSafe()
        {
            try
            {
                if (IsDisposed || !IsHandleCreated) return;
                if (InvokeRequired) BeginInvoke((Action)RefreshLog);
                else RefreshLog();
            }
            catch { }
        }

        private void CloseLogWriter()
        {
            lock (_logLock)
            {
                if (_logWriter != null) { _logWriter.Dispose(); _logWriter = null; }
            }
        }

        private void RefreshLog()
        {
            try
            {
                if (!File.Exists(Program.LogFile)) return;
                string text;
                using (var fs = new FileStream(Program.LogFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(fs, Encoding.UTF8, true)) text = reader.ReadToEnd();
                string[] lines = text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                string tail = string.Join(Environment.NewLine, lines.Skip(Math.Max(0, lines.Length - 180)));
                if (_logBox.Text != tail) { _logBox.Text = tail; _logBox.SelectionStart = _logBox.TextLength; _logBox.ScrollToCaret(); }
            }
            catch { }
        }

        private void RefreshStatus()
        {
            int? pid = FindStatusPid();
            if (pid.HasValue) { SetStatus("后台运行中 · PID " + pid.Value, Color.FromArgb(5, 150, 105)); RefreshButtons(true); }
            else { RefreshButtons(false); }
            RefreshLog();
        }

        private int? FindStatusPid()
        {
            if (_serverProcess != null && !_serverProcess.HasExited) return _serverProcess.Id;
            if ((DateTime.UtcNow - _lastProcessProbeUtc).TotalSeconds >= 3)
            {
                _lastProcessProbeUtc = DateTime.UtcNow;
                _lastExternalPid = Program.FindRunningServerPid();
            }
            return _lastExternalPid;
        }

        private void RefreshButtons(bool running)
        {
            _startButton.Enabled = !running; _stopButton.Enabled = running; _restartButton.Enabled = running; _openButton.Enabled = running;
        }

        private void SetStatus(string text, Color color)
        {
            _statusLabel.Text = "状态：" + text; _statusLabel.ForeColor = color;
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            _closing = true;
            _timer.Stop();
            int? pid = _serverProcess != null && !_serverProcess.HasExited ? (int?)_serverProcess.Id : Program.FindRunningServerPid();
            if (pid.HasValue)
            {
                DialogResult answer = MessageBox.Show("后台仍在运行。\n\n是：停止后台并退出\n否：只退出控制台，后台继续运行\n取消：返回控制台", "退出启动器", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) { _closing = false; e.Cancel = true; return; }
                if (answer == DialogResult.Yes) StopServer();
            }
            CloseLogWriter();
        }
    }
}

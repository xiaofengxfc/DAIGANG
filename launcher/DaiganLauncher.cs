using System;
using System.Collections.Generic;
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
        internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        internal static readonly string StateDirectory = Path.Combine(Root, "launcher-data");
        internal static readonly string PidFile = Path.Combine(StateDirectory, "server.pid");
        internal static readonly string LogFile = Path.Combine(StateDirectory, "server.log");
        internal const string AutoStartName = "DaiganOpsConsole";

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

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string app = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            candidates.Add(Path.Combine(pf86, "nodejs", "node.exe"));
            candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));
            candidates.Add(Path.Combine(app, "nvm", "node.exe"));
            candidates.Add(Path.Combine(user, "scoop", "shims", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "chocolatey", "bin", "node.exe"));

            foreach (string raw in candidates)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                string path = raw.Trim().Trim('"');
                if (File.Exists(path) && string.Equals(Path.GetFileName(path), "node.exe", StringComparison.OrdinalIgnoreCase))
                    return Path.GetFullPath(path);
            }
            return null;
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
                using (var key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
                    return key != null && key.GetValue(AutoStartName) != null;
            }
            catch { return false; }
        }

        internal static void SetAutoStart(bool enabled)
        {
            using (var key = Registry.CurrentUser.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run"))
            {
                if (enabled)
                {
                    string exe = Application.ExecutablePath.Replace("\"", "\\\"");
                    key.SetValue(AutoStartName, "\"" + exe + "\" --autostart");
                }
                else key.DeleteValue(AutoStartName, false);
            }
        }

        internal static string QuoteArg(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
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
                        if (command.IndexOf(server, StringComparison.OrdinalIgnoreCase) >= 0) return pid;
                    }
                }
            }
            catch { }
            return null;
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
        private readonly RichTextBox _logBox = new RichTextBox();
        private readonly Timer _timer = new Timer();
        private readonly List<string> _passThrough = new List<string>();
        private Process _serverProcess;
        private StreamWriter _logWriter;
        private readonly object _logLock = new object();
        private bool _startOnLoad;
        private bool _closing;

        internal LauncherForm(string[] args)
        {
            ParseArguments(args ?? new string[0]);
            BuildUi();
            LoadSettings();
            _timer.Interval = 1000;
            _timer.Tick += delegate { RefreshStatus(); };
            _timer.Start();
            Shown += delegate
            {
                if (_startOnLoad)
                {
                    BeginInvoke((Action)delegate { StartServer(); });
                    if (HasArgument(args, "--autostart")) WindowState = FormWindowState.Minimized;
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
            _autoStartBox.Checked = Program.IsAutoStartEnabled();
            if (_passThrough.Count > 0) _extraBox.Text = string.Join(" ", _passThrough.Select(Program.QuoteArg));
            _rootLabel.Text = "项目目录：" + Program.Root;
            _nodeLabel.Text = "Node：检测中…";
            string node = Program.FindNodeExecutable();
            _nodeLabel.Text = node == null ? "Node：未找到（请安装 Node.js 22.5+）" : "Node：" + node + "  " + Program.ReadNodeVersion(node);
            RefreshStatus();
            RefreshLog();
        }

        private void BuildUi()
        {
            Text = "代肝价格查询 · 启动控制台";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(980, 680);
            Size = new Size(1160, 760);
            BackColor = Color.FromArgb(11, 13, 16);
            ForeColor = Color.FromArgb(243, 245, 247);
            Font = new Font("Microsoft YaHei UI", 9F);
            AutoScaleMode = AutoScaleMode.Dpi;

            var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, BackColor = Color.FromArgb(11, 13, 16) };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 238));
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(shell);

            var rail = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 20, 24), Padding = new Padding(22, 24, 18, 22) };
            shell.Controls.Add(rail, 0, 0);
            var brandMark = new Label { Text = "D", AutoSize = false, Size = new Size(38, 38), TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.FromArgb(92, 84, 199), ForeColor = Color.White, Font = new Font("Segoe UI", 17F, FontStyle.Bold), Location = new Point(22, 24) };
            rail.Controls.Add(brandMark);
            var brand = new Label { Text = "代肝价格查询", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font("Microsoft YaHei UI", 12F, FontStyle.Bold), Location = new Point(70, 25) };
            rail.Controls.Add(brand);
            var brandSub = new Label { Text = "运营后台控制台", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(70, 49) };
            rail.Controls.Add(brandSub);
            var navTitle = new Label { Text = "项目", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Font = new Font(Font, FontStyle.Bold), Location = new Point(24, 108) };
            rail.Controls.Add(navTitle);
            var navItem = new Panel { Location = new Point(18, 135), Size = new Size(198, 42), BackColor = Color.FromArgb(32, 38, 46) };
            var navDot = new Label { Text = "●", AutoSize = true, ForeColor = Color.FromArgb(92, 84, 199), Location = new Point(14, 12) };
            var navText = new Label { Text = "后台服务", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Location = new Point(39, 11) };
            navItem.Controls.Add(navDot); navItem.Controls.Add(navText); rail.Controls.Add(navItem);
            var railRule = new Label { AutoSize = false, Height = 1, Width = 194, BackColor = Color.FromArgb(37, 43, 52), Location = new Point(22, 202) };
            rail.Controls.Add(railRule);
            var safeTitle = new Label { Text = "数据安全", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Font = new Font(Font, FontStyle.Bold), Location = new Point(24, 225) };
            rail.Controls.Add(safeTitle);
            var safeDot = new Label { Text = "●", AutoSize = true, ForeColor = Color.FromArgb(63, 167, 126), Location = new Point(24, 258) };
            var safeText = new Label { Text = "本机数据模式", AutoSize = true, ForeColor = Color.FromArgb(167, 176, 188), Location = new Point(43, 258) };
            rail.Controls.Add(safeDot); rail.Controls.Add(safeText);
            _rootLabel.AutoEllipsis = true; _rootLabel.Text = "项目目录：" + Program.Root; _rootLabel.ForeColor = Color.FromArgb(115, 126, 139); _rootLabel.Location = new Point(24, 286); _rootLabel.Size = new Size(190, 48);
            rail.Controls.Add(_rootLabel);
            var railHint = new Label { Text = "数据库与上传文件始终\n留在 data 目录，不会被启动器搬动。", AutoSize = false, Size = new Size(190, 46), ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(24, 620) };
            rail.Controls.Add(railHint);

            var main = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(30, 24, 30, 24), BackColor = Color.FromArgb(11, 13, 16) };
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 66));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 154));
            main.RowStyles.Add(new RowStyle(SizeType.Absolute, 194));
            main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            shell.Controls.Add(main, 1, 0);

            var header = new Panel { Dock = DockStyle.Fill };
            var title = new Label { Text = "启动控制台", ForeColor = Color.FromArgb(243, 245, 247), Font = new Font("Microsoft YaHei UI", 20F, FontStyle.Bold), AutoSize = true, Location = new Point(0, 0) };
            var subtitle = new Label { Text = "管理本地后台的运行状态与启动参数", ForeColor = Color.FromArgb(167, 176, 188), AutoSize = true, Location = new Point(2, 36) };
            header.Controls.Add(title); header.Controls.Add(subtitle); main.Controls.Add(header, 0, 0);

            var statusCard = CreateCard();
            var statusTitle = new Label { Text = "后台状态", AutoSize = true, ForeColor = Color.FromArgb(167, 176, 188), Location = new Point(22, 18) };
            _statusLabel.Text = "状态：未启动"; _statusLabel.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold); _statusLabel.AutoSize = true; _statusLabel.ForeColor = Color.FromArgb(243, 245, 247); _statusLabel.Location = new Point(22, 45);
            var statusHint = new Label { Text = "启动器只负责控制进程，业务数据仍由项目原有服务管理。", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(24, 86) };
            statusCard.Controls.Add(statusTitle); statusCard.Controls.Add(_statusLabel); statusCard.Controls.Add(statusHint);
            var actions = new FlowLayoutPanel { Location = new Point(500, 38), Size = new Size(550, 62), Anchor = AnchorStyles.Top | AnchorStyles.Right, FlowDirection = FlowDirection.LeftToRight, WrapContents = false };
            ConfigureButton(_startButton, "启动", Color.FromArgb(92, 84, 199), StartServer);
            ConfigureButton(_stopButton, "停止", Color.FromArgb(38, 43, 52), StopServer);
            ConfigureButton(_restartButton, "重启", Color.FromArgb(38, 43, 52), RestartServer);
            ConfigureButton(_openButton, "打开后台", Color.FromArgb(63, 167, 126), OpenDashboard);
            actions.Controls.AddRange(new Control[] { _startButton, _stopButton, _restartButton, _openButton });
            statusCard.Controls.Add(actions); main.Controls.Add(statusCard, 0, 1);
            statusCard.Resize += delegate { actions.Left = Math.Max(280, statusCard.ClientSize.Width - actions.Width - 22); };
            statusCard.PerformLayout();
            actions.Left = Math.Max(280, statusCard.ClientSize.Width - actions.Width - 22);

            var settings = CreateCard();
            var settingsTitle = new Label { Text = "启动配置", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Location = new Point(22, 16) };
            var settingsHint = new Label { Text = "这些参数只在下一次启动或重启时生效", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(106, 17) };
            settings.Controls.Add(settingsTitle); settings.Controls.Add(settingsHint);
            StyleTextBox(_portBox); StyleTextBox(_hostBox); StyleTextBox(_extraBox);
            var fields = new TableLayoutPanel { Location = new Point(22, 52), Size = new Size(1030, 122), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, ColumnCount = 4, RowCount = 3 };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 64)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 70));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 36)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
            fields.Controls.Add(MakeLabel("端口"), 0, 0); fields.Controls.Add(_portBox, 1, 0);
            fields.Controls.Add(MakeLabel("主机"), 2, 0); fields.Controls.Add(_hostBox, 3, 0);
            fields.Controls.Add(MakeLabel("参数"), 0, 1); fields.Controls.Add(_extraBox, 1, 1); fields.SetColumnSpan(_extraBox, 3);
            _localBox.Text = "仅本机访问（--local）"; _localBox.AutoSize = true; _localBox.ForeColor = Color.FromArgb(167, 176, 188); _localBox.BackColor = Color.FromArgb(17, 20, 24); _localBox.FlatStyle = FlatStyle.Flat;
            _autoStartBox.Text = "开机自启动"; _autoStartBox.AutoSize = true; _autoStartBox.ForeColor = Color.FromArgb(167, 176, 188); _autoStartBox.BackColor = Color.FromArgb(17, 20, 24); _autoStartBox.FlatStyle = FlatStyle.Flat;
            fields.Controls.Add(_localBox, 0, 2); fields.SetColumnSpan(_localBox, 2); fields.Controls.Add(_autoStartBox, 2, 2); fields.SetColumnSpan(_autoStartBox, 2);
            settings.Controls.Add(fields);
            _autoStartBox.CheckedChanged += delegate
            {
                try { Program.SetAutoStart(_autoStartBox.Checked); SetStatus(_autoStartBox.Checked ? "已启用开机自启动" : "已关闭开机自启动", Color.FromArgb(37, 99, 235)); }
                catch (Exception ex) { MessageBox.Show("保存开机自启动设置失败：" + ex.Message, "设置失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            };
            _nodeLabel.AutoEllipsis = true; _nodeLabel.ForeColor = Color.FromArgb(115, 126, 139); _nodeLabel.Location = new Point(22, 176); _nodeLabel.Size = new Size(1030, 18); _nodeLabel.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            settings.Controls.Add(_nodeLabel);
            main.Controls.Add(settings, 0, 2);

            var logCard = CreateCard();
            var logTitle = new Label { Text = "运行日志", AutoSize = true, ForeColor = Color.FromArgb(243, 245, 247), Font = new Font(Font, FontStyle.Bold), Location = new Point(22, 15) };
            var logHint = new Label { Text = "最近 180 行 · UTF-8", AutoSize = true, ForeColor = Color.FromArgb(115, 126, 139), Location = new Point(93, 16) };
            ConfigureButton(_logButton, "打开日志", Color.FromArgb(38, 43, 52), OpenLog); ConfigureButton(_dataButton, "数据目录", Color.FromArgb(38, 43, 52), OpenDataDirectory);
            _logButton.Width = 96; _dataButton.Width = 96;
            var logActions = new FlowLayoutPanel { Anchor = AnchorStyles.Top | AnchorStyles.Right, Location = new Point(830, 9), Size = new Size(220, 42), FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
            logActions.Controls.Add(_dataButton); logActions.Controls.Add(_logButton);
            logCard.Controls.Add(logTitle); logCard.Controls.Add(logHint); logCard.Controls.Add(logActions);
            _logBox.Location = new Point(22, 48); _logBox.Size = new Size(1030, 220); _logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right; _logBox.ReadOnly = true; _logBox.BackColor = Color.FromArgb(11, 13, 16); _logBox.ForeColor = Color.FromArgb(167, 176, 188); _logBox.BorderStyle = BorderStyle.None; _logBox.Font = new Font("Cascadia Mono", 9F); _logBox.DetectUrls = true; _logBox.Padding = new Padding(8);
            logCard.Controls.Add(_logBox); main.Controls.Add(logCard, 0, 3);
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
            var parts = new List<string> { Program.QuoteArg("server.mjs") };
            parts.Add("--port"); parts.Add(GetPort().ToString());
            if (_localBox.Checked) parts.Add("--local");
            if (!string.IsNullOrWhiteSpace(_hostBox.Text)) { parts.Add("--host"); parts.Add(Program.QuoteArg(_hostBox.Text.Trim())); }
            if (!string.IsNullOrWhiteSpace(_extraBox.Text)) parts.Add(_extraBox.Text.Trim());
            return string.Join(" ", parts);
        }

        private void StartServer(object sender, EventArgs e) { StartServer(); }

        private void StartServer()
        {
            try
            {
                int? tracked = Program.FindTrackedServerPid();
                if (tracked.HasValue) { SetStatus("后台已在运行 · PID " + tracked.Value, Color.FromArgb(5, 150, 105)); return; }
                Program.RemovePid();
                string node = Program.FindNodeExecutable();
                if (node == null) throw new InvalidOperationException("没有找到 Node.js。请安装 Node.js 22.5 或更高版本后重试。");
                if (!File.Exists(Path.Combine(Program.Root, "server.mjs"))) throw new InvalidOperationException("项目入口 server.mjs 不在 EXE 所在目录，无法启动。");
                GetPort();
                Directory.CreateDirectory(Program.StateDirectory);
                CloseLogWriter();
                _logWriter = new StreamWriter(new FileStream(Program.LogFile, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
                WriteLog("\r\n===== 启动请求 " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " =====");
                WriteLog("Node: " + node);
                WriteLog("Args: " + BuildNodeArguments());
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
                int? pid = _serverProcess != null && !_serverProcess.HasExited ? (int?)_serverProcess.Id : Program.FindTrackedServerPid();
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
            int? pid = _serverProcess != null && !_serverProcess.HasExited ? (int?)_serverProcess.Id : Program.FindTrackedServerPid();
            if (pid.HasValue) { SetStatus("后台运行中 · PID " + pid.Value, Color.FromArgb(5, 150, 105)); RefreshButtons(true); }
            else { RefreshButtons(false); }
            RefreshLog();
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
            int? pid = _serverProcess != null && !_serverProcess.HasExited ? (int?)_serverProcess.Id : Program.FindTrackedServerPid();
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

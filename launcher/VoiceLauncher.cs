using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace VoiceMessengerLauncher
{
    public class LauncherForm : Form
    {
        // Win32 API for smooth window dragging
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;

        // Configuration
        private const string NEON_URL = "https://ep-steep-snow-b5qfejq3.c-7.us-east-2.aws.neon.tech/sql";
        private const string NEON_CONN = "postgresql://neondb_owner:npg_a47wDOrGSTFc@ep-steep-snow-b5qfejq3.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require";

        // State
        private string localVersion = "1.0.0";
        private string targetVersion = "1.0.0";
        private string releaseNotes = "";
        private int autoLaunchSeconds = 3;
        private System.Windows.Forms.Timer autoLaunchTimer;
        private bool isUpdating = false;
        private bool updateSuccess = false;
        private float progressValue = 10f;

        // UI Controls
        private Label lblTitle;
        private Label lblSubtitle;
        private Label lblVersionBadge;
        private Label lblStatus;
        private Label lblDetails;
        private Panel cardChangelog;
        private Label lblChangelogTitle;
        private Label lblChangelogText;
        private Button btnAction;
        private Button btnClose;
        private Button btnMinimize;
        private System.Windows.Forms.Timer animTimer;
        private float pulseAlpha = 0f;
        private bool pulseDir = true;

        public LauncherForm()
        {
            InitializeComponent();
            LoadLocalVersion();
        }

        private void InitializeComponent()
        {
            this.Size = new Size(540, 390);
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(11, 15, 25); // #0b0f19
            this.DoubleBuffered = true;
            this.ShowIcon = true;

            // Try load icon
            string iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "icon.ico");
            if (!File.Exists(iconPath))
                iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "../../assets/icon.ico");
            if (File.Exists(iconPath))
            {
                try { this.Icon = new Icon(iconPath); } catch { }
            }

            // Window drag events
            this.MouseDown += (s, e) => {
                if (e.Button == MouseButtons.Left)
                {
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                }
            };

            // Window Controls (Close & Minimize)
            btnClose = new Button();
            btnClose.Text = "✕";
            btnClose.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            btnClose.ForeColor = Color.FromArgb(156, 163, 175);
            btnClose.BackColor = Color.Transparent;
            btnClose.FlatStyle = FlatStyle.Flat;
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.Size = new Size(36, 30);
            btnClose.Location = new Point(this.Width - 42, 6);
            btnClose.Cursor = Cursors.Hand;
            btnClose.Click += (s, e) => Application.Exit();
            btnClose.MouseEnter += (s, e) => { btnClose.BackColor = Color.FromArgb(239, 68, 68); btnClose.ForeColor = Color.White; };
            btnClose.MouseLeave += (s, e) => { btnClose.BackColor = Color.Transparent; btnClose.ForeColor = Color.FromArgb(156, 163, 175); };
            this.Controls.Add(btnClose);

            btnMinimize = new Button();
            btnMinimize.Text = "—";
            btnMinimize.Font = new Font("Segoe UI", 8f, FontStyle.Regular);
            btnMinimize.ForeColor = Color.FromArgb(156, 163, 175);
            btnMinimize.BackColor = Color.Transparent;
            btnMinimize.FlatStyle = FlatStyle.Flat;
            btnMinimize.FlatAppearance.BorderSize = 0;
            btnMinimize.Size = new Size(36, 30);
            btnMinimize.Location = new Point(this.Width - 80, 6);
            btnMinimize.Cursor = Cursors.Hand;
            btnMinimize.Click += (s, e) => this.WindowState = FormWindowState.Minimized;
            btnMinimize.MouseEnter += (s, e) => { btnMinimize.BackColor = Color.FromArgb(31, 41, 55); btnMinimize.ForeColor = Color.White; };
            btnMinimize.MouseLeave += (s, e) => { btnMinimize.BackColor = Color.Transparent; btnMinimize.ForeColor = Color.FromArgb(156, 163, 175); };
            this.Controls.Add(btnMinimize);

            // Title
            lblTitle = new Label();
            lblTitle.Text = "VOICE MESSENGER";
            lblTitle.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            lblTitle.ForeColor = Color.White;
            lblTitle.Location = new Point(80, 24);
            lblTitle.AutoSize = true;
            this.Controls.Add(lblTitle);

            // Version Badge
            lblVersionBadge = new Label();
            lblVersionBadge.Text = "v" + localVersion;
            lblVersionBadge.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            lblVersionBadge.ForeColor = Color.FromArgb(192, 132, 252);
            lblVersionBadge.BackColor = Color.FromArgb(46, 16, 101);
            lblVersionBadge.TextAlign = ContentAlignment.MiddleCenter;
            lblVersionBadge.Size = new Size(65, 22);
            lblVersionBadge.Location = new Point(310, 29);
            this.Controls.Add(lblVersionBadge);

            // Subtitle
            lblSubtitle = new Label();
            lblSubtitle.Text = "Умный лаунчер и автоматическое обновление";
            lblSubtitle.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblSubtitle.ForeColor = Color.FromArgb(156, 163, 175);
            lblSubtitle.Location = new Point(80, 54);
            lblSubtitle.AutoSize = true;
            this.Controls.Add(lblSubtitle);

            // Status Label
            lblStatus = new Label();
            lblStatus.Text = "⚡ Проверка обновлений в облачной базе Neon...";
            lblStatus.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            lblStatus.ForeColor = Color.FromArgb(224, 231, 255);
            lblStatus.Location = new Point(35, 96);
            lblStatus.Size = new Size(470, 25);
            this.Controls.Add(lblStatus);

            // Changelog card
            cardChangelog = new Panel();
            cardChangelog.BackColor = Color.FromArgb(17, 24, 39); // #111827
            cardChangelog.Location = new Point(35, 165);
            cardChangelog.Size = new Size(470, 120);
            this.Controls.Add(cardChangelog);

            lblChangelogTitle = new Label();
            lblChangelogTitle.Text = "ИНФОРМАЦИЯ О ВЕРСИИ:";
            lblChangelogTitle.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
            lblChangelogTitle.ForeColor = Color.FromArgb(147, 197, 253);
            lblChangelogTitle.Location = new Point(14, 10);
            lblChangelogTitle.AutoSize = true;
            cardChangelog.Controls.Add(lblChangelogTitle);

            lblChangelogText = new Label();
            lblChangelogText.Text = "Подключение к центральной базе данных Neon.tech...\nПроверка актуальности локальных файлов.";
            lblChangelogText.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblChangelogText.ForeColor = Color.FromArgb(209, 213, 219);
            lblChangelogText.Location = new Point(14, 35);
            lblChangelogText.Size = new Size(442, 75);
            cardChangelog.Controls.Add(lblChangelogText);

            // Action Button ("Запустить Voice Messenger")
            btnAction = new Button();
            btnAction.Text = "Запустить Voice Messenger";
            btnAction.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            btnAction.ForeColor = Color.White;
            btnAction.BackColor = Color.FromArgb(147, 51, 234); // #9333ea
            btnAction.FlatStyle = FlatStyle.Flat;
            btnAction.FlatAppearance.BorderSize = 0;
            btnAction.Size = new Size(470, 44);
            btnAction.Location = new Point(35, 305);
            btnAction.Cursor = Cursors.Hand;
            btnAction.Click += (s, e) => LaunchMessenger();
            btnAction.MouseEnter += (s, e) => btnAction.BackColor = Color.FromArgb(168, 85, 247);
            btnAction.MouseLeave += (s, e) => btnAction.BackColor = Color.FromArgb(147, 51, 234);
            this.Controls.Add(btnAction);

            // Animation timer for neon glow
            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 40;
            animTimer.Tick += (s, e) => {
                if (pulseDir)
                {
                    pulseAlpha += 0.05f;
                    if (pulseAlpha >= 1f) { pulseAlpha = 1f; pulseDir = false; }
                }
                else
                {
                    pulseAlpha -= 0.05f;
                    if (pulseAlpha <= 0.2f) { pulseAlpha = 0.2f; pulseDir = true; }
                }
                this.Invalidate();
            };
            animTimer.Start();

            // Auto-launch timer
            autoLaunchTimer = new System.Windows.Forms.Timer();
            autoLaunchTimer.Interval = 1000;
            autoLaunchTimer.Tick += AutoLaunchTimer_Tick;

            // Trigger Update check on background thread
            this.Shown += (s, e) => {
                ThreadPool.QueueUserWorkItem(CheckForUpdatesThread);
            };
        }

        private void Log(string msg)
        {
            try
            {
                string logFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.log");
                File.AppendAllText(logFile, DateTime.Now.ToString("HH:mm:ss.fff") + " " + msg + "\r\n");
            }
            catch { }
        }

        private void LoadLocalVersion()
        {
            try
            {
                string vFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "version.json");
                Log("Checking version file: " + vFile);
                if (File.Exists(vFile))
                {
                    string content = File.ReadAllText(vFile);
                    Log("version.json content: " + content);
                    var serializer = new JavaScriptSerializer();
                    var dict = serializer.Deserialize<Dictionary<string, object>>(content);
                    if (dict != null && dict.ContainsKey("version"))
                    {
                        localVersion = dict["version"].ToString();
                        lblVersionBadge.Text = "v" + localVersion;
                        Log("Loaded localVersion: " + localVersion);
                    }
                }
                else
                {
                    Log("version.json not found, using default: " + localVersion);
                }
            }
            catch (Exception ex)
            {
                Log("Error loading local version: " + ex.Message);
            }
        }

        private void SaveLocalVersion(string ver)
        {
            try
            {
                string vFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "version.json");
                File.WriteAllText(vFile, "{\"version\":\"" + ver + "\",\"updated_at\":" + DateTime.UtcNow.Ticks + "}");
                localVersion = ver;
            }
            catch { }
        }

        private void CheckForUpdatesThread(object state)
        {
            Thread.Sleep(400); // Small aesthetic pause
            SetProgress(25f);
            Log("CheckForUpdatesThread started. localVersion=" + localVersion);

            try
            {
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                var request = (HttpWebRequest)WebRequest.Create(NEON_URL);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Headers["Neon-Connection-String"] = NEON_CONN;
                request.Timeout = 10000;

                string query = "{\"query\":\"SELECT version, download_url, release_notes, timestamp FROM app_releases ORDER BY timestamp DESC LIMIT 1;\"}";
                byte[] queryBytes = Encoding.UTF8.GetBytes(query);
                request.ContentLength = queryBytes.Length;

                using (var stream = request.GetRequestStream())
                {
                    stream.Write(queryBytes, 0, queryBytes.Length);
                }

                SetProgress(50f);

                string responseText = "";
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    responseText = reader.ReadToEnd();
                }

                Log("Neon DB response: " + responseText);
                SetProgress(75f);

                var serializer = new JavaScriptSerializer();
                serializer.MaxJsonLength = int.MaxValue;
                var jsonResult = serializer.Deserialize<Dictionary<string, object>>(responseText);

                if (jsonResult != null && jsonResult.ContainsKey("rows"))
                {
                    var rows = (System.Collections.ArrayList)jsonResult["rows"];
                    if (rows != null && rows.Count > 0)
                    {
                        var latestRow = (Dictionary<string, object>)rows[0];
                        string remoteVer = latestRow.ContainsKey("version") ? (latestRow["version"] != null ? latestRow["version"].ToString() : "1.0.0") : "1.0.0";
                        string notes = latestRow.ContainsKey("release_notes") ? (latestRow["release_notes"] != null ? latestRow["release_notes"].ToString() : "") : "";
                        string payload = latestRow.ContainsKey("payload_base64") ? (latestRow["payload_base64"] != null ? latestRow["payload_base64"].ToString() : "") : "";
                        string downloadUrl = latestRow.ContainsKey("download_url") ? (latestRow["download_url"] != null ? latestRow["download_url"].ToString() : "") : "";

                        targetVersion = remoteVer;
                        releaseNotes = notes;

                        bool newer = IsNewer(remoteVer, localVersion);
                        Log("remoteVer=" + remoteVer + " localVer=" + localVersion + " isNewer=" + newer);

                        if (newer)
                        {
                            // Need to update!
                            this.Invoke(new Action(() => {
                                lblStatus.Text = "🚀 Доступно обновление: v" + remoteVer + "!";
                                lblStatus.ForeColor = Color.FromArgb(168, 85, 247);
                                lblChangelogTitle.Text = "ЧТО НОВОГО В ВЕРСИИ " + remoteVer + ":";
                                lblChangelogText.Text = string.IsNullOrEmpty(notes) ? "Улучшения стабильности и новые функции голосовой связи." : notes;
                            }));

                            ApplyUpdate(remoteVer, payload, downloadUrl);
                            return;
                        }
                    }
                }

                // If up to date:
                SetProgress(100f);
                this.Invoke(new Action(() => {
                    lblStatus.Text = "✅ Установлена последняя версия v" + localVersion;
                    lblStatus.ForeColor = Color.FromArgb(52, 211, 153);
                    lblChangelogTitle.Text = "СТАТУС СИСТЕМЫ:";
                    lblChangelogText.Text = "Все компоненты мессенджера актуальны.\nБаза данных Neon подключена.\nГотово к запуску!";
                    StartAutoLaunch();
                }));
            }
            catch (Exception ex)
            {
                Log("Update check error: " + ex.ToString());
                // Fallback if offline or network error
                SetProgress(100f);
                this.Invoke(new Action(() => {
                    lblStatus.Text = "⚠️ Автономный режим (без сети)";
                    lblStatus.ForeColor = Color.FromArgb(251, 191, 36);
                    lblChangelogTitle.Text = "ИНФОРМАЦИЯ:";
                    lblChangelogText.Text = "Не удалось связаться с облачной базой Neon.\nЗапуск локальной версии v" + localVersion + "...";
                    StartAutoLaunch();
                }));
            }
        }

        private void ApplyUpdate(string newVer, string payloadBase64, string downloadUrl)
        {
            try
            {
                isUpdating = true;
                this.Invoke(new Action(() => {
                    lblStatus.Text = "📥 Загрузка обновления v" + newVer + "...";
                    btnAction.Enabled = false;
                    btnAction.Text = "Установка обновления...";
                }));

                // Close VoiceMessenger.exe if currently running to release file lock
                try
                {
                    Process[] procs = Process.GetProcessesByName("VoiceMessenger");
                    foreach (var p in procs)
                    {
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                }
                catch { }

                // Find resources/app.asar
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string resourcesDir = Path.Combine(baseDir, "resources");
                if (!Directory.Exists(resourcesDir))
                {
                    Directory.CreateDirectory(resourcesDir);
                }
                string asarPath = Path.Combine(resourcesDir, "app.asar");
                string tempDownloadPath = asarPath + ".tmp";
                Log("ApplyUpdate starting for v" + newVer + ", downloadUrl=" + downloadUrl);
                if (!string.IsNullOrEmpty(payloadBase64))
                {
                    SetProgress(85f);
                    byte[] asarBytes = Convert.FromBase64String(payloadBase64);
                    File.WriteAllBytes(tempDownloadPath, asarBytes);
                }
                else if (!string.IsNullOrEmpty(downloadUrl))
                {
                    try
                    {
                        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls;
                    }
                    catch { }

                    using (var client = new WebClient())
                    {
                        client.Proxy = null;
                        client.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
                        client.DownloadProgressChanged += (s, ev) => {
                            SetProgress((float)ev.ProgressPercentage);
                        };
                        Log("Calling DownloadFile: " + downloadUrl);
                        client.DownloadFile(new Uri(downloadUrl), tempDownloadPath);
                        Log("DownloadFile finished. Exists=" + File.Exists(tempDownloadPath));
                    }
                }

                if (File.Exists(tempDownloadPath) && new FileInfo(tempDownloadPath).Length > 0)
                {
                    Log("Downloaded file size: " + new FileInfo(tempDownloadPath).Length);
                    // Backup old asar if exists
                    string backupPath = Path.Combine(resourcesDir, "app.asar.bak");
                    if (File.Exists(asarPath))
                    {
                        try { File.Copy(asarPath, backupPath, true); } catch { }
                    }

                    // Move/overwrite new asar
                    if (File.Exists(asarPath)) File.Delete(asarPath);
                    File.Move(tempDownloadPath, asarPath);
                    Log("Replaced " + asarPath + " successfully!");

                    // Save new local version
                    SaveLocalVersion(newVer);
                    Log("Saved new local version: " + newVer);

                    SetProgress(100f);
                    updateSuccess = true;

                    this.Invoke(new Action(() => {
                        localVersion = newVer;
                        lblVersionBadge.Text = "v" + newVer;
                        lblStatus.Text = "🎉 Обновление v" + newVer + " успешно установлено!";
                        lblStatus.ForeColor = Color.FromArgb(52, 211, 153);
                        btnAction.Enabled = true;
                        StartAutoLaunch();
                    }));
                }
                else
                {
                    throw new Exception("Пустой пакет обновления");
                }
            }
            catch (Exception ex)
            {
                Log("ApplyUpdate error: " + ex.ToString());
                this.Invoke(new Action(() => {
                    lblStatus.Text = "❌ Ошибка обновления: " + ex.Message;
                    lblStatus.ForeColor = Color.FromArgb(239, 68, 68);
                    btnAction.Enabled = true;
                    btnAction.Text = "Запустить установленную версию";
                }));
            }
            finally
            {
                isUpdating = false;
            }
        }

        private bool IsNewer(string remote, string local)
        {
            try
            {
                var rParts = remote.TrimStart('v').Split('.');
                var lParts = local.TrimStart('v').Split('.');
                for (int i = 0; i < Math.Max(rParts.Length, lParts.Length); i++)
                {
                    int r = i < rParts.Length ? int.Parse(rParts[i]) : 0;
                    int l = i < lParts.Length ? int.Parse(lParts[i]) : 0;
                    if (r > l) return true;
                    if (r < l) return false;
                }
            }
            catch { }
            return false;
        }

        private void SetProgress(float val)
        {
            progressValue = val;
            this.Invalidate();
        }

        private void StartAutoLaunch()
        {
            autoLaunchSeconds = 3;
            btnAction.Text = "Запустить Voice Messenger (" + autoLaunchSeconds + "с)";
            autoLaunchTimer.Start();
        }

        private void AutoLaunchTimer_Tick(object sender, EventArgs e)
        {
            autoLaunchSeconds--;
            if (autoLaunchSeconds <= 0)
            {
                autoLaunchTimer.Stop();
                LaunchMessenger();
            }
            else
            {
                btnAction.Text = "Запустить Voice Messenger (" + autoLaunchSeconds + "с)";
            }
        }

        private void LaunchMessenger()
        {
            autoLaunchTimer.Stop();
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string exePath = Path.Combine(baseDir, "VoiceMessenger.exe");

                // Check relative paths if running in dev folder
                if (!File.Exists(exePath))
                {
                    exePath = Path.Combine(baseDir, "../VoiceMessenger.exe");
                }
                if (!File.Exists(exePath))
                {
                    exePath = Path.Combine(baseDir, "release/win-unpacked/VoiceMessenger.exe");
                }

                Log("LaunchMessenger path: " + exePath + " Exists: " + File.Exists(exePath));

                if (File.Exists(exePath))
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = Path.GetFullPath(exePath);
                    psi.WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(exePath));
                    Process.Start(psi);
                    Application.Exit();
                }
                else
                {
                    MessageBox.Show("Исполняемый файл VoiceMessenger.exe не найден рядом с лаунчером!\nПуть: " + exePath, "Ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Не удалось запустить Voice Messenger: " + ex.Message, "Ошибка запуска", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            // 1. Draw glowing outer border
            Color borderColor = Color.FromArgb((int)(pulseAlpha * 120 + 80), 168, 85, 247);
            using (Pen borderPen = new Pen(borderColor, 1.5f))
            {
                g.DrawRectangle(borderPen, 1, 1, this.Width - 2, this.Height - 2);
            }

            // 2. Draw Top Accent Line
            using (LinearGradientBrush topBrush = new LinearGradientBrush(
                new Point(0, 0), new Point(this.Width, 0),
                Color.FromArgb(147, 51, 234), Color.FromArgb(236, 72, 153)))
            {
                g.FillRectangle(topBrush, 0, 0, this.Width, 3);
            }

            // 3. Draw App Icon Graphic
            int iconX = 26;
            int iconY = 16;
            int iconSize = 48;
            if (this.Icon != null)
            {
                g.DrawIcon(this.Icon, new Rectangle(iconX, iconY, iconSize, iconSize));
            }

            // 4. Draw Progress Bar
            int barX = 35;
            int barY = 135;
            int barW = 470;
            int barH = 8;

            // Bar background track
            using (GraphicsPath trackPath = GetRoundedRect(new Rectangle(barX, barY, barW, barH), 4))
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(31, 41, 55)))
            {
                g.FillPath(trackBrush, trackPath);
            }

            // Bar fill
            int fillW = (int)((progressValue / 100f) * barW);
            if (fillW > 4)
            {
                using (GraphicsPath fillPath = GetRoundedRect(new Rectangle(barX, barY, fillW, barH), 4))
                using (LinearGradientBrush fillBrush = new LinearGradientBrush(
                    new Point(barX, barY), new Point(barX + barW, barY),
                    Color.FromArgb(168, 85, 247), Color.FromArgb(236, 72, 153)))
                {
                    g.FillPath(fillBrush, fillPath);
                }
            }
        }

        private GraphicsPath GetRoundedRect(Rectangle rect, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int d = radius * 2;
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        [STAThread]
        public static void Main()
        {
            try
            {
                File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " Main starting...\r\n");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new LauncherForm());
            }
            catch (Exception ex)
            {
                File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log"), ex.ToString());
                MessageBox.Show(ex.ToString(), "Launcher Crash", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}

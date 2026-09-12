using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace CodexUsageMonitor;

internal sealed class MainForm : Form
{
    private const int MaxNotifiedResetEvents = 256;
    private const string NotificationTitle = "Codexリセットを確認";
    private const string NotificationBody = "MonitorがCodex利用上限のリセットを確認しました。";
    private const string ObservatoryHistoryUrl = "https://codex.gussuriworks.com/history";
    private readonly Label _statusValue = CreateValueLabel();
    private readonly Label _usedValue = CreateValueLabel();
    private readonly Label _remainingValue = CreateValueLabel();
    private readonly Label _resetValue = CreateValueLabel();
    private readonly Label _bankedResetValue = CreateValueLabel();
    private readonly Label _lastSuccessValue = CreateValueLabel();
    private readonly Label _webhookValue = CreateValueLabel();
    private readonly Button _toggleButton = new();
    private readonly NotifyIcon _notificationIcon;
    private readonly object _notificationStateLock = new();
    private readonly string _notificationStatePath = GetNotificationStatePath();
    private readonly List<string> _notifiedResetEventKeys;
    private Process? _monitorProcess;
    private string? _repositoryRoot;
    private bool _stopping;
    private bool _errorState;

    public MainForm()
    {
        _notifiedResetEventKeys = LoadNotifiedResetEventKeys(_notificationStatePath);
        _notificationIcon = new NotifyIcon
        {
            Icon = SystemIcons.Information,
            Text = "Codex Usage Monitor",
            Visible = true,
        };
        _notificationIcon.BalloonTipClicked += (_, _) => OpenObservatoryHistory();

        Text = "Codex Usage Monitor";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = false;
        MinimizeBox = true;
        ClientSize = new Size(430, 400);
        MinimumSize = new Size(430, 400);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowOnly;
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.White;

        var title = new Label
        {
            Text = "Codex Usage Monitor",
            AutoSize = true,
            Font = new Font(Font, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 18),
        };

        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 2,
            RowCount = 9,
            Padding = new Padding(24, 22, 24, 20),
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 42));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 58));
        for (var row = 0; row < table.RowCount; row++)
        {
            table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        table.Controls.Add(title, 0, 0);
        table.SetColumnSpan(title, 2);
        AddRow(table, 1, "状態", _statusValue);
        AddRow(table, 2, "週間使用率", _usedValue);
        AddRow(table, 3, "週間残量", _remainingValue);
        AddRow(table, 4, "次回通常リセット", _resetValue);
        AddRow(table, 5, "BANKEDリセット", _bankedResetValue);
        AddRow(table, 6, "最終確認", _lastSuccessValue);
        AddRow(table, 7, "送信", _webhookValue);

        _toggleButton.Text = "監視停止";
        _toggleButton.AutoSize = true;
        _toggleButton.Anchor = AnchorStyles.Right;
        _toggleButton.Click += (_, _) => ToggleMonitor();
        table.Controls.Add(_toggleButton, 1, 8);

        Controls.Add(table);
        _statusValue.Text = "○ 起動中";
        _usedValue.Text = "--";
        _remainingValue.Text = "--";
        _resetValue.Text = "--";
        _bankedResetValue.Text = "--";
        _lastSuccessValue.Text = "--";
        _webhookValue.Text = "未送信";

        Shown += (_, _) => StartMonitor();
        FormClosing += (_, _) =>
        {
            try
            {
                StopMonitor();
            }
            finally
            {
                _notificationIcon.Visible = false;
                _notificationIcon.Dispose();
            }
        };
    }

    private static Label CreateValueLabel()
    {
        return new Label
        {
            AutoSize = true,
            Font = new Font(SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 10),
        };
    }

    private static void AddRow(TableLayoutPanel table, int row, string label, Label value)
    {
        table.Controls.Add(new Label
        {
            Text = label,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 10),
        }, 0, row);
        table.Controls.Add(value, 1, row);
    }

    private void ToggleMonitor()
    {
        if (IsMonitorRunning())
        {
            StopMonitor();
        }
        else
        {
            StartMonitor();
        }
    }

    private bool IsMonitorRunning()
    {
        return _monitorProcess is { HasExited: false };
    }

    private void StartMonitor()
    {
        if (IsMonitorRunning()) return;

        _stopping = false;
        _errorState = false;
        _repositoryRoot = FindRepositoryRoot();
        if (_repositoryRoot is null)
        {
            SetError("監視用ファイルが見つかりません");
            return;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
                WorkingDirectory = _repositoryRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add("/d");
            startInfo.ArgumentList.Add("/s");
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add("corepack pnpm run monitor:codex-usage:host");

            var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, args) => HandleOutput(args.Data);
            process.ErrorDataReceived += (_, _) => { };
            process.Exited += (_, _) => HandleProcessExited();
            if (!process.Start())
            {
                process.Dispose();
                SetError("監視を開始できません");
                return;
            }

            _monitorProcess = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            SetStatus("○ 起動中");
            _toggleButton.Text = "監視停止";
        }
        catch
        {
            SetError("監視を開始できません");
        }
    }

    private void StopMonitor()
    {
        var process = _monitorProcess;
        if (process is null) return;

        _stopping = true;
        try
        {
            if (!process.HasExited)
            {
                process.StandardInput.WriteLine("stop");
                process.StandardInput.Flush();
                if (!process.WaitForExit(5_000) && !process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(2_000);
                }
            }
        }
        catch
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
            }
            catch { }
        }
        finally
        {
            process.Dispose();
            _monitorProcess = null;
            SetStatus("○ 停止中");
            _toggleButton.Text = "監視開始";
            _stopping = false;
        }
    }

    private void HandleOutput(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement.Clone();
            if (!root.TryGetProperty("event", out var eventValue)) return;
            var eventName = eventValue.GetString();
            var at = root.TryGetProperty("at", out var atValue) ? atValue.GetString() : null;
            RunOnUiThread(() => HandleMonitorEvent(eventName, root, at));
        }
        catch (JsonException)
        {
            // pnpm/node startup text is intentionally ignored; the host emits JSON events.
        }
    }

    private void HandleMonitorEvent(string? eventName, JsonElement root, string? at)
    {
        switch (eventName)
        {
            case "starting":
                SetStatus("○ 起動中");
                break;
            case "app_server_started":
                SetStatus("● 監視中");
                break;
            case "snapshot_sent":
                SetStatus("● 監視中");
                _webhookValue.Text = "正常";
                _lastSuccessValue.Text = FormatLocalClock(at);
                UpdateSnapshotValues(root);
                break;
            case "snapshot_observed":
                SetStatus("● 監視中");
                _lastSuccessValue.Text = FormatLocalClock(ReadString(root, "observedAt") ?? at);
                UpdateSnapshotValues(root);
                break;
            case "reset_confirmed":
                NotifyResetConfirmed(root);
                break;
            case "snapshot_failed":
                SetStatus("△ 一時取得不能");
                _webhookValue.Text = "再試行中";
                break;
            case "session_restart":
                var reason = ReadString(root, "reason");
                if (reason == "codex_cli_not_found")
                {
                    SetError("Codexが見つかりません");
                }
                else
                {
                    SetStatus("△ 再接続中");
                    _webhookValue.Text = "再試行中";
                }
                break;
            case "error":
                SetError(ReadSafeErrorText(ReadString(root, "reason")));
                break;
            case "stopped":
                SetStatus("○ 停止中");
                _toggleButton.Text = "監視開始";
                break;
        }
    }

    private void NotifyResetConfirmed(JsonElement root)
    {
        var eventKey = ReadString(root, "resetEventKey");
        if (!IsSafeResetEventKey(eventKey) || !TryRecordResetNotification(eventKey!)) return;

        try
        {
            _notificationIcon.ShowBalloonTip(
                5_000,
                NotificationTitle,
                NotificationBody,
                ToolTipIcon.Info);
        }
        catch
        {
            // Notification failures must not stop the monitor or GUI.
        }
    }

    private bool TryRecordResetNotification(string eventKey)
    {
        lock (_notificationStateLock)
        {
            if (_notifiedResetEventKeys.Contains(eventKey, StringComparer.Ordinal)) return false;

            var next = new List<string>(_notifiedResetEventKeys) { eventKey };
            if (next.Count > MaxNotifiedResetEvents)
            {
                next.RemoveRange(0, next.Count - MaxNotifiedResetEvents);
            }

            if (!TryPersistNotifiedResetEventKeys(next)) return false;
            _notifiedResetEventKeys.Clear();
            _notifiedResetEventKeys.AddRange(next);
            return true;
        }
    }

    private bool TryPersistNotifiedResetEventKeys(IReadOnlyList<string> eventKeys)
    {
        var directory = Path.GetDirectoryName(_notificationStatePath);
        if (string.IsNullOrWhiteSpace(directory)) return false;

        var temporaryPath = $"{_notificationStatePath}.{Environment.ProcessId}.tmp";
        try
        {
            Directory.CreateDirectory(directory);
            File.WriteAllText(temporaryPath, JsonSerializer.Serialize(eventKeys));
            File.Move(temporaryPath, _notificationStatePath, true);
            return true;
        }
        catch
        {
            try { File.Delete(temporaryPath); } catch { }
            return false;
        }
    }

    private static List<string> LoadNotifiedResetEventKeys(string path)
    {
        try
        {
            if (!File.Exists(path)) return [];
            var stored = JsonSerializer.Deserialize<List<string>>(File.ReadAllText(path)) ?? [];
            return stored
                .Where(IsSafeResetEventKey)
                .Distinct(StringComparer.Ordinal)
                .TakeLast(MaxNotifiedResetEvents)
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    private static string GetNotificationStatePath()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(localAppData)) localAppData = AppContext.BaseDirectory;
        return Path.Combine(localAppData, "CodexUsageMonitor", "notified-reset-events.json");
    }

    private static bool IsSafeResetEventKey(string? eventKey)
    {
        return !string.IsNullOrWhiteSpace(eventKey) &&
            eventKey.Length <= 200 &&
            eventKey.All(character => char.IsLetterOrDigit(character) || character is ':' or '-' or '.' or '_');
    }

    private static void OpenObservatoryHistory()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = ObservatoryHistoryUrl,
                UseShellExecute = true,
            });
        }
        catch
        {
            // A browser launch failure must not affect monitoring.
        }
    }

    private void HandleProcessExited()
    {
        RunOnUiThread(() =>
        {
            if (_stopping) return;
            _monitorProcess = null;
            if (!_errorState) SetError("監視プロセスが終了しました");
            _toggleButton.Text = "監視開始";
        });
    }

    private void SetStatus(string text)
    {
        _statusValue.Text = text;
        _errorState = false;
    }

    private void SetError(string text)
    {
        _errorState = true;
        _statusValue.Text = $"× {text}";
        _webhookValue.Text = "未送信";
        _toggleButton.Text = "監視開始";
    }

    private static string ReadSafeErrorText(string? reason)
    {
        return reason switch
        {
            "monitor_secret_missing" => "監視用設定がありません",
            "codex_cli_not_found" => "Codexが見つかりません",
            "invalid_webhook_url" or "webhook_requires_https" => "監視用設定を確認してください",
            _ => "監視エラー",
        };
    }

    private static string? ReadString(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private void UpdateSnapshotValues(JsonElement root)
    {
        if (root.TryGetProperty("usedPercent", out var usedValue) && usedValue.TryGetDouble(out var used))
        {
            _usedValue.Text = FormatPercent(used);
            _remainingValue.Text = FormatPercent(Math.Max(0, 100 - used));
        }
        if (root.TryGetProperty("resetsAt", out var resetValue) && resetValue.TryGetInt64(out var resetsAt))
        {
            _resetValue.Text = FormatTokyoTime(resetsAt);
        }

        _bankedResetValue.Text = FormatBankedResetCount(root);
    }

    private static string FormatBankedResetCount(JsonElement root)
    {
        const long maxAvailableCount = 1_000;
        var source = ReadString(root, "bankedResetCountSource");
        if (!root.TryGetProperty("bankedResetDisplayCount", out var countValue) ||
            countValue.ValueKind != JsonValueKind.Number ||
            !countValue.TryGetInt64(out var count) ||
            count < 0 ||
            count > maxAvailableCount)
        {
            return "--";
        }
        if (string.IsNullOrEmpty(source))
        {
            return $"{count}回";
        }
        return source switch
        {
            "explicit" => $"{count}回",
            "last_known" => $"{count}回（前回確認）",
            _ => "--",
        };
    }

    private static string FormatPercent(double value)
    {
        return $"{value.ToString("0.##", CultureInfo.InvariantCulture)}%";
    }

    private static string FormatLocalClock(string? value)
    {
        if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date))
        {
            return "--";
        }
        return date.ToLocalTime().ToString("HH:mm:ss", CultureInfo.InvariantCulture);
    }

    private static string FormatTokyoTime(long unixSeconds)
    {
        try
        {
            var date = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
            var zone = TimeZoneInfo.FindSystemTimeZoneById("Tokyo Standard Time");
            return TimeZoneInfo.ConvertTime(date, zone).ToString("yyyy/MM/dd HH:mm", CultureInfo.InvariantCulture);
        }
        catch
        {
            return "--";
        }
    }

    private static string? FindRepositoryRoot()
    {
        var configured = Environment.GetEnvironmentVariable("CODEX_USAGE_MONITOR_REPO");
        if (IsRepositoryRoot(configured)) return Path.GetFullPath(configured!);

        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 8 && current is not null; depth++)
        {
            if (IsRepositoryRoot(current.FullName)) return current.FullName;
            current = current.Parent;
        }
        return null;
    }

    private static bool IsRepositoryRoot(string? path)
    {
        return !string.IsNullOrWhiteSpace(path) && File.Exists(Path.Combine(path, "package.json"));
    }

    private void RunOnUiThread(Action action)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try
        {
            BeginInvoke(action);
        }
        catch (InvalidOperationException) { }
    }
}

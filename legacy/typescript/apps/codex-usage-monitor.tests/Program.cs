using System.Reflection;
using System.Windows.Forms;

namespace CodexUsageMonitorLayoutSmoke;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        Application.SetHighDpiMode(HighDpiMode.DpiUnaware);

        foreach (var scale in new[] { 1.4f, 1.5f })
        {
            if (!CheckStatusLayout(scale)) return 1;
        }

        Console.WriteLine("PASS monitor controls remain visible at 140% and 150% scale");
        return 0;
    }

    private static bool CheckStatusLayout(float scale)
    {
        var formType = Assembly.Load("CodexUsageMonitor").GetType("CodexUsageMonitor.MainForm")
            ?? throw new InvalidOperationException("MainForm was not found.");
        using var form = (Form)Activator.CreateInstance(formType)!;

        if (form.FormBorderStyle != FormBorderStyle.Sizable ||
            form.AutoSizeMode != AutoSizeMode.GrowOnly ||
            form.MinimumSize.Height < 400)
        {
            Console.Error.WriteLine($"form sizing policy is not resizable/grow-only at {scale:P0}");
            return false;
        }

        var status = GetField<Label>(form, "_statusValue");
        var toggle = GetField<Button>(form, "_toggleButton");
        var table = (TableLayoutPanel)form.Controls[0];
        table.Scale(new SizeF(scale, scale));
        status.MaximumSize = new Size(120, 0);
        var statuses = new[]
        {
            "○ 起動中",
            "△ 一時取得不能",
            "× 監視プロセスが終了しました",
            "× 監視用ファイルが見つかりません",
        };
        foreach (var statusText in statuses)
        {
            status.Text = statusText;
            form.PerformLayout();
            table.PerformLayout();

            var buttonVisible = toggle.Enabled &&
                toggle.Left >= 0 &&
                toggle.Top >= 0 &&
                toggle.Right <= form.ClientSize.Width &&
                toggle.Bottom <= form.ClientSize.Height;
            if (!buttonVisible)
            {
                Console.Error.WriteLine($"{statusText}: button={toggle.Bounds}, client={form.ClientSize}, table={table.Bounds} at {scale:P0}");
                return false;
            }

            if (statusText.StartsWith("×", StringComparison.Ordinal) && status.Height <= 21)
            {
                Console.Error.WriteLine($"{statusText}: wrapped status was not measured at {scale:P0}");
                return false;
            }
        }

        return true;
    }

    private static T GetField<T>(Form form, string name)
    {
        return (T)(form.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)?.GetValue(form)
            ?? throw new InvalidOperationException($"Field {name} was not found."));
    }
}

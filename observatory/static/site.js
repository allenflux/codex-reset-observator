"use strict";

// Progressive enhancement only: every page, forecast and history record is
// rendered by Python. Browser code handles time zones, charts and refreshes.
(() => {
  const locale = {ja: "ja-JP", en: "en-US", zh: "zh-CN"}[document.body.dataset.locale] || "ja-JP";
  const chartPreferences = {range: "all", timezone: "local"};
  let chartCleanup = [];

  function localizeDates(root = document) {
    const formatter = new Intl.DateTimeFormat(locale, {year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short"});
    root.querySelectorAll("time[data-local-time]").forEach(element => {
      const date = new Date(element.dateTime);
      if (Number.isFinite(date.getTime())) {
        element.textContent = formatter.format(date);
        element.title = date.toISOString();
      }
    });
  }

  function column(label, count, height, suffix) {
    const element = document.createElement("div");
    element.className = "chart-column";
    element.title = `${label} · ${count} ${suffix}`;
    const number = document.createElement("span");
    number.className = "bar-count";
    number.textContent = count || "";
    const track = document.createElement("span");
    track.className = "bar-track";
    const bar = document.createElement("span");
    bar.className = "chart-bar";
    bar.style.height = `${height}%`;
    track.append(bar);
    const axis = document.createElement("span");
    axis.className = "bar-label";
    axis.textContent = label;
    element.append(number, track, axis);
    return element;
  }

  function initializeHeatmaps() {
    chartCleanup.forEach(cleanup => cleanup());
    chartCleanup = [];
    document.querySelectorAll("[data-heatmap]").forEach(panel => {
      const dataNode = panel.querySelector("[data-heatmap-data]");
      if (!dataNode) return;
      let data;
      try { data = JSON.parse(dataNode.textContent); } catch { return; }
      const times = [...new Set(data.events.map(value => new Date(value).getTime()).filter(Number.isFinite))].sort((left, right) => left - right);
      const range = panel.querySelector("[data-heatmap-range]");
      const timezone = panel.querySelector("[data-heatmap-timezone]");
      range.value = chartPreferences.range;
      timezone.value = chartPreferences.timezone;
      const mobile = window.matchMedia("(max-width: 540px)");

      function renderChart() {
        chartPreferences.range = range.value;
        chartPreferences.timezone = timezone.value;
        const zone = timezone.value === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone.value;
        const now = Date.parse(data.now) || Date.now();
        const start = range.value === "month" ? now - 30 * 86400000 : -Infinity;
        const eligible = times.filter(time => time >= start && time <= now);
        const block = mobile.matches ? 2 : 1;
        const bins = new Array(24 / block).fill(0);
        const hourFormat = new Intl.DateTimeFormat("en-US", {timeZone: zone, hour: "2-digit", hourCycle: "h23"});
        eligible.forEach(time => bins[Math.floor(Number(hourFormat.format(time)) / block)]++);
        const chart = panel.querySelector(".time-histogram");
        chart.style.gridTemplateColumns = `repeat(${bins.length}, minmax(0, 1fr))`;
        chart.setAttribute("aria-label", `${panel.querySelector("h2").textContent} (${zone})`);
        const max = Math.max(...bins, 1);
        chart.replaceChildren(...bins.map((count, index) => column(String(index * block).padStart(2, "0"), count, count / max * 100, data.labels.records)));
        chart.classList.toggle("two-hour-bins", block === 2);
        panel.querySelector("[data-heatmap-count]").textContent = eligible.length;
        panel.querySelector("[data-chart-zone]").textContent = zone;
        const table = panel.querySelector("[data-heatmap-table]");
        table.replaceChildren(...bins.map((count, index) => {
          const row = document.createElement("tr");
          const hour = document.createElement("th");
          hour.scope = "row";
          hour.textContent = `${String(index * block).padStart(2, "0")}:00`;
          const cell = document.createElement("td");
          cell.textContent = count;
          row.append(hour, cell);
          return row;
        }));
        table.closest("table").querySelector("caption").textContent = `${panel.querySelector("h2").textContent} (${zone})`;

        // A last-30-day interval is included when its endpoint is in range;
        // the preceding reset may be outside the range.
        const intervals = times.slice(1).flatMap((time, index) => time >= start && time <= now ? [(time - times[index]) / 86400000] : []);
        const intervalBins = new Array(11).fill(0);
        intervals.forEach(days => intervalBins[Math.min(10, Math.floor(days))]++);
        const intervalMax = Math.max(...intervalBins, 1);
        panel.querySelector(".interval-histogram").replaceChildren(...intervalBins.map((count, index) => column(index === 10 ? "10+" : `${index}–${index + 1}`, count, count / intervalMax * 100, data.labels.records)));
        const stats = panel.querySelector("[data-interval-stats]");
        panel.querySelector("[data-interval-empty]").hidden = intervals.length > 0;
        if (!intervals.length) { stats.replaceChildren(); return; }
        const sorted = intervals.slice().sort((left, right) => left - right);
        const midpoint = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
        const summary = {median, average: sorted.reduce((total, item) => total + item, 0) / sorted.length, shortest: sorted[0], longest: sorted[sorted.length - 1]};
        stats.replaceChildren(...Object.entries(summary).map(([key, value]) => {
          const pair = document.createElement("div");
          const label = document.createElement("dt");
          label.textContent = data.labels[key];
          const result = document.createElement("dd");
          result.textContent = `${value.toLocaleString(locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})} ${data.labels.days}`;
          pair.append(label, result);
          return pair;
        }));
      }
      range.addEventListener("change", renderChart);
      timezone.addEventListener("change", renderChart);
      const onResize = () => { if (panel.isConnected) renderChart(); };
      mobile.addEventListener("change", onResize);
      chartCleanup.push(() => mobile.removeEventListener("change", onResize));
      renderChart();
    });
  }

  function initializeHistorySearch() {
    const search = document.getElementById("history-search");
    const filter = document.getElementById("history-kind");
    if (!search || !filter) return;
    function applyFilter() {
      const query = search.value.trim().toLocaleLowerCase(locale);
      const items = [...document.querySelectorAll("[data-record-kind]")];
      let count = 0;
      items.forEach(item => {
        const visible = (filter.value === "all" || item.dataset.recordKind === filter.value) && item.textContent.toLocaleLowerCase(locale).includes(query);
        item.hidden = !visible;
        if (visible) count++;
      });
      document.getElementById("history-no-matches").hidden = count > 0;
    }
    search.addEventListener("input", applyFilter);
    filter.addEventListener("change", applyFilter);
  }

  function initializeRefresh() {
    const button = document.getElementById("refresh");
    if (!button) return;
    let refreshing = false;
    let lastAttempt = 0;
    async function refresh(manual = false) {
      if (refreshing || (!manual && (document.hidden || Date.now() - lastAttempt < 45000))) return;
      refreshing = true;
      lastAttempt = Date.now();
      button.disabled = true;
      button.textContent = button.dataset.loadingLabel;
      const message = document.getElementById("refresh-status");
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(`/api/current?locale=${encodeURIComponent(document.body.dataset.locale)}`, {signal: controller.signal, headers: {Accept: "application/json"}, cache: "no-store"});
        if (!response.ok) throw new Error("Snapshot refresh failed");
        const snapshot = await response.json();
        if (snapshot.schemaVersion !== "public-v1" || !snapshot.viewModel || typeof snapshot.viewModel !== "object") throw new Error("Unsupported snapshot");
        // The same Python templates own all rendering, including newly added
        // history rows and source URL validation. Never use raw source HTML.
        const page = await fetch(window.location.pathname, {signal: controller.signal, headers: {Accept: "text/html"}, cache: "no-store"});
        if (!page.ok) throw new Error("Page refresh failed");
        const parsed = new DOMParser().parseFromString(await page.text(), "text/html");
        const content = parsed.getElementById("radar-content");
        const meta = parsed.querySelector(".snapshot-meta");
        const warning = parsed.getElementById("data-warning");
        if (!content || !meta || !warning) throw new Error("Incomplete refresh");
        document.getElementById("radar-content").replaceWith(content);
        document.querySelector(".snapshot-meta").replaceWith(meta);
        document.getElementById("data-warning").replaceWith(warning);
        message.hidden = true;
        localizeDates();
        initializeHeatmaps();
      } catch {
        message.textContent = message.dataset.failure;
        message.hidden = false;
      } finally {
        window.clearTimeout(timeout);
        refreshing = false;
        button.disabled = false;
        button.textContent = `↻ ${button.dataset.label}`;
      }
    }
    button.addEventListener("click", () => refresh(true));
    window.setInterval(() => refresh(), 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    window.addEventListener("online", () => refresh());
  }

  localizeDates();
  initializeHeatmaps();
  initializeHistorySearch();
  initializeRefresh();
})();

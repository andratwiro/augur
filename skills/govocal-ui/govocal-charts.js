/* GoVocal dashboard charts — a thin, data-driven wrapper over ApexCharts that
 * themes every chart from the canonical --gv-chart-* tokens and ships sensible
 * interactivity (hover tooltips, legend toggle, no toolbar clutter).
 *
 * Why a wrapper: the dashboard charts must be real, interactive, re-feedable
 * components — pass data in, get a themed chart out — not static SVG. Colours,
 * font and grid all resolve from CSS custom properties at render time, so a
 * theme change (or ?theme=) flows through without touching this file.
 *
 * Requires ApexCharts (vendored at ./vendor/apexcharts.min.js) loaded first.
 *
 * API:
 *   GVChart.line(el,  { categories, series, height, colors, area, curve })
 *   GVChart.combo(el, { categories, bars, line, height, colors })   // bar + line
 *   GVChart.bar(el,   { categories, series, height, colors, horizontal, stacked,
 *                       grouped, dataLabels, percent, max })
 *   GVChart.donut(el, { labels, series, colors, height, total })
 *   GVChart.pie(el,   { labels, series, colors, height })
 *   GVChart.create(el, apexOptions)   // escape hatch: full ApexCharts options, themed
 * Every call returns the live ApexCharts instance (also stored on el.__gv) so you
 * can later chart.updateSeries(...) / chart.updateOptions(...) with new data.
 */
(function (global) {
  "use strict";

  function tok(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function palette() {
    return {
      navy: tok("--gv-chart-navy", "#073F80"),
      blue: tok("--gv-chart-blue", "#2F478A"),
      blueLight: tok("--gv-chart-blue-light", "#4D85C6"),
      line: tok("--gv-chart-line", "#7FBBCA"),
      teal: tok("--gv-chart-teal", "#01A1B1"),
      tealLight: tok("--gv-chart-teal-light", "#40B8C5"),
      pos: tok("--gv-chart-pos", "#04884C"),
      neg: tok("--gv-chart-neg", "#E52516"),
      axis: tok("--gv-chart-axis", "#596B7A"),
      grid: tok("--gv-chart-grid", "#EBEDEF"),
      text: tok("--gv-text-primary", "#333333"),
      font: tok("--gv-font-family", "'Public Sans', sans-serif") || "'Public Sans', sans-serif"
    };
  }

  // Recursive merge (objects only; arrays/scalars replace).
  function merge(target, src) {
    if (!src) return target;
    Object.keys(src).forEach(function (k) {
      var sv = src[k];
      if (sv === undefined) return;                 // never clobber a themed default with undefined
      if (sv && typeof sv === "object" && !Array.isArray(sv)) {
        target[k] = merge(target[k] && typeof target[k] === "object" ? target[k] : {}, sv);
      } else {
        target[k] = sv;
      }
    });
    return target;
  }

  // Shared theme applied to every chart.
  function baseTheme(p, height) {
    return {
      chart: {
        fontFamily: p.font,
        height: height || 300,
        toolbar: { show: false },
        zoom: { enabled: false },
        animations: { enabled: true, speed: 320, easing: "easeinout" },
        parentHeightOffset: 0
      },
      grid: {
        borderColor: p.grid,
        strokeDashArray: 0,
        xaxis: { lines: { show: false } },
        yaxis: { lines: { show: true } },
        padding: { top: 0, right: 4, bottom: 0, left: 4 }
      },
      dataLabels: { enabled: false },
      xaxis: {
        axisBorder: { show: false },
        axisTicks: { show: false },
        labels: { style: { colors: p.axis, fontSize: "13px", fontFamily: p.font } },
        crosshairs: { show: false }
      },
      yaxis: {
        labels: { style: { colors: p.axis, fontSize: "12px", fontFamily: p.font } }
      },
      legend: {
        position: "bottom",
        horizontalAlign: "center",
        fontSize: "13px",
        fontFamily: p.font,
        labels: { colors: p.axis },
        markers: { width: 9, height: 9, radius: 12 },
        itemMargin: { horizontal: 8, vertical: 2 }
      },
      tooltip: {
        style: { fontSize: "13px", fontFamily: p.font },
        marker: { show: true }
      },
      states: { hover: { filter: { type: "lighten", value: 0.08 } } }
    };
  }

  function mount(el, type, p, height, options) {
    var cfg = merge(baseTheme(p, height), { chart: { type: type } });
    merge(cfg, options || {});
    if (el.__gv) { try { el.__gv.destroy(); } catch (e) {} }
    var chart = new global.ApexCharts(el, cfg);
    chart.render();
    el.__gv = chart;
    return chart;
  }

  var GVChart = {
    palette: palette,

    create: function (el, options) {
      var p = palette();
      var type = (options && options.chart && options.chart.type) || "line";
      var height = options && options.chart && options.chart.height;
      return mount(el, type, p, height, options);
    },

    line: function (el, o) {
      o = o || {};
      var p = palette();
      var series = o.series || [];
      return mount(el, o.area ? "area" : "line", p, o.height || 150, {
        series: series,
        colors: o.colors || [p.line, p.blue, p.neg],
        stroke: { curve: o.curve || "straight", width: o.width || 2 },
        markers: { size: o.markers != null ? o.markers : 3, strokeWidth: 0, hover: { size: (o.markers != null ? o.markers : 3) + 2 } },
        fill: o.area ? { type: "gradient", gradient: { opacityFrom: 0.25, opacityTo: 0.02 } } : { type: "solid" },
        xaxis: { categories: o.categories || [], tickAmount: o.tickAmount },
        legend: { show: o.legend !== false && series.length > 1 }
      });
    },

    combo: function (el, o) {
      o = o || {};
      var p = palette();
      var bars = o.bars || { name: "This month", data: [] };
      var ln = o.line || { name: "Total", data: [] };
      return mount(el, "line", p, o.height || 150, {
        series: [
          { name: bars.name, type: "column", data: bars.data },
          { name: ln.name, type: "line", data: ln.data }
        ],
        colors: o.colors || [p.blue, p.line],
        stroke: { width: [0, 2], curve: "straight" },
        markers: { size: [0, 3], hover: { size: 5 } },
        plotOptions: { bar: { columnWidth: o.columnWidth || "45%", borderRadius: 0 } },
        xaxis: { categories: o.categories || [] },
        yaxis: o.dualAxis ? [{}, { opposite: true }] : { labels: { show: true } },
        legend: { show: o.legend !== false }
      });
    },

    bar: function (el, o) {
      o = o || {};
      var p = palette();
      var series = o.series || [];
      var pctFmt = function (v) { return v == null ? "" : v + "%"; };
      return mount(el, "bar", p, o.height || 220, {
        series: series,
        colors: o.colors || [p.navy, p.tealLight, p.blueLight, p.teal],
        plotOptions: {
          bar: {
            horizontal: !!o.horizontal,
            columnWidth: o.columnWidth || "60%",
            barHeight: o.barHeight || "65%",
            borderRadius: o.borderRadius || 0,
            dataLabels: { position: o.horizontal ? "top" : "top" },
            grouped: o.grouped !== false
          }
        },
        dataLabels: o.dataLabels ? {
          enabled: true,
          formatter: o.percent ? pctFmt : undefined,
          offsetY: o.horizontal ? 0 : -18,
          offsetX: o.horizontal ? 16 : 0,
          style: { fontSize: "11px", fontFamily: p.font, colors: [p.axis], fontWeight: 400 }
        } : { enabled: false },
        stacked: !!o.stacked,
        chart: { stacked: !!o.stacked, stackType: o.stackType },
        xaxis: {
          categories: o.categories || [],
          max: o.horizontal ? o.max : undefined,
          labels: o.percent && o.horizontal ? { formatter: pctFmt } : undefined
        },
        yaxis: {
          max: !o.horizontal ? o.max : undefined,
          labels: o.percent && !o.horizontal ? { formatter: pctFmt } : { style: { colors: p.axis } }
        },
        legend: { show: o.legend != null ? o.legend : series.length > 1 }
      });
    },

    donut: function (el, o) {
      o = o || {};
      var p = palette();
      return mount(el, "donut", p, o.height || 200, {
        series: o.series || [],
        labels: o.labels || [],
        colors: o.colors || [p.tealLight, p.grid],
        stroke: { colors: ["#fff"], width: 2 },
        plotOptions: {
          pie: {
            donut: {
              size: o.size || "68%",
              labels: o.total ? {
                show: true,
                total: { show: true, label: o.totalLabel || "", formatter: function () { return o.total; },
                  color: p.axis, fontFamily: p.font }
              } : { show: false }
            }
          }
        },
        legend: { show: o.legend !== false, position: o.legendPos || "right" }
      });
    },

    pie: function (el, o) {
      o = o || {};
      var p = palette();
      return mount(el, "pie", p, o.height || 200, {
        series: o.series || [],
        labels: o.labels || [],
        colors: o.colors || [p.blue, p.blueLight, p.line, p.teal],
        stroke: { colors: ["#fff"], width: 2 },
        legend: { show: o.legend !== false, position: o.legendPos || "right" }
      });
    }
  };

  global.GVChart = GVChart;
})(window);

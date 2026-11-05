import { useEffect, useRef } from "react";
import type {
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  SeriesMarker,
  Time,
} from "lightweight-charts";
import { LineStyle, LineType } from "lightweight-charts";
import { closedBars, deskSignal } from "../../lib/desk-signal.ts";
import {
  sma,
  ema,
  rsi,
  macd,
  bollingerBands,
  atr,
  stochastic,
  vwap,
  INDICATOR_REGISTRY,
  type IndicatorType,
} from "../../lib/indicators.ts";
import { toIndicatorCandles } from "./utils.ts";
import { CHART_COLORS, TF_INTERVAL_MS } from "./constants.ts";
import type { Timeframe } from "./constants.ts";

const DESK_EMA_COLORS = ["#26a69a", "#42a5f5", "#ffa726", "#ef5350"];

export function useIndicators(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: CandlestickData<Time>[],
  activeIndicators: IndicatorType[],
  isDark: boolean,
  volumeData: HistogramData<Time>[] = [],
  timeframe?: Timeframe,
): void {
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<"Line"> | ISeriesApi<"Histogram">>>(
    new Map(),
  );
  const colors = isDark ? CHART_COLORS.dark : CHART_COLORS.light;

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || chartData.length === 0) return;

    const chart = chartRef.current;
    const indCandles = toIndicatorCandles(chartData, volumeData);

    // Remove old indicator series
    for (const [_key, series] of indicatorSeriesRef.current) {
      try {
        chart.removeSeries(series);
      } catch {
        /* already removed */
      }
    }
    indicatorSeriesRef.current.clear();

    for (const type of activeIndicators) {
      const config = INDICATOR_REGISTRY.find((r) => r.type === type);
      if (!config) continue;

      switch (type) {
        case "SMA": {
          const data = sma(indCandles, config.defaultParams.period!);
          const s = chart.addLineSeries({
            color: config.color,
            lineWidth: 1,
            priceScaleId: "right",
          });
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("SMA", s);
          break;
        }
        case "EMA": {
          const data = ema(indCandles, config.defaultParams.period!);
          const s = chart.addLineSeries({
            color: config.color,
            lineWidth: 1,
            priceScaleId: "right",
          });
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("EMA", s);
          break;
        }
        case "RSI": {
          const data = rsi(indCandles, config.defaultParams.period);
          const s = chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "rsi" });
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("RSI", s);
          const refHigh = chart.addLineSeries({
            color: "#555",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceScaleId: "rsi",
          });
          refHigh.setData(data.map((p) => ({ time: p.time as Time, value: 70 })));
          indicatorSeriesRef.current.set("RSI-70", refHigh);
          const refLow = chart.addLineSeries({
            color: "#555",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceScaleId: "rsi",
          });
          refLow.setData(data.map((p) => ({ time: p.time as Time, value: 30 })));
          indicatorSeriesRef.current.set("RSI-30", refLow);
          break;
        }
        case "MACD": {
          const data = macd(
            indCandles,
            config.defaultParams.fast,
            config.defaultParams.slow,
            config.defaultParams.signal,
          );
          const mLine = chart.addLineSeries({
            color: "#2196f3",
            lineWidth: 1,
            priceScaleId: "macd",
          });
          mLine.setData(data.macd.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("MACD-line", mLine);
          const sLine = chart.addLineSeries({
            color: "#ff9800",
            lineWidth: 1,
            priceScaleId: "macd",
          });
          sLine.setData(data.signal.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("MACD-signal", sLine);
          const histo = chart.addHistogramSeries({ priceScaleId: "macd" });
          histo.setData(
            data.histogram.map((p) => ({
              time: p.time as Time,
              value: p.value,
              color: p.value >= 0 ? colors.up + "99" : colors.down + "99",
            })),
          );
          indicatorSeriesRef.current.set("MACD-hist", histo);
          break;
        }
        case "BOLL": {
          const data = bollingerBands(
            indCandles,
            config.defaultParams.period,
            config.defaultParams.stdDev,
          );
          const upper = chart.addLineSeries({
            color: config.color + "80",
            lineWidth: 1,
            priceScaleId: "right",
          });
          upper.setData(data.upper.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("BOLL-upper", upper);
          const mid = chart.addLineSeries({
            color: config.color,
            lineWidth: 1,
            priceScaleId: "right",
          });
          mid.setData(data.middle.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("BOLL-mid", mid);
          const lower = chart.addLineSeries({
            color: config.color + "80",
            lineWidth: 1,
            priceScaleId: "right",
          });
          lower.setData(data.lower.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("BOLL-lower", lower);
          break;
        }
        case "ATR": {
          const data = atr(indCandles, config.defaultParams.period);
          const s = chart.addLineSeries({ color: config.color, lineWidth: 1, priceScaleId: "atr" });
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("ATR", s);
          break;
        }
        case "STOCH": {
          const data = stochastic(
            indCandles,
            config.defaultParams.kPeriod,
            config.defaultParams.dPeriod,
          );
          const kLine = chart.addLineSeries({
            color: "#ab47bc",
            lineWidth: 1,
            priceScaleId: "stoch",
          });
          kLine.setData(data.k.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("STOCH-K", kLine);
          const dLine = chart.addLineSeries({
            color: "#ff7043",
            lineWidth: 1,
            priceScaleId: "stoch",
          });
          dLine.setData(data.d.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("STOCH-D", dLine);
          break;
        }
        case "VWAP": {
          const data = vwap(indCandles);
          const s = chart.addLineSeries({
            color: config.color,
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            priceScaleId: "right",
          });
          s.setData(data.map((p) => ({ time: p.time as Time, value: p.value })));
          indicatorSeriesRef.current.set("VWAP", s);
          break;
        }
        case "DESK": {
          // Same code as the backend scanner, on closed bars only.
          // shortcut: uses the default rules, not opencharts.config.ts; read them from the backend if users customise.
          // shortcut: the chart doesn't know stock from crypto, so a stock day bar shows from midnight, not 16:00; pass the symbol's session in if that matters.
          const barMs = timeframe ? TF_INTERVAL_MS[timeframe] : 0;
          const bars = deskSignal(barMs ? closedBars(indCandles, barMs / 1000) : indCandles);
          const emaLines = DESK_EMA_COLORS.map((color, k) => {
            const line = chart.addLineSeries({
              color,
              lineWidth: 1,
              priceScaleId: "right",
              lastValueVisible: false,
              priceLineVisible: false,
            });
            line.setData(
              bars.flatMap((b) =>
                b.emas[k] == null ? [] : [{ time: b.time as Time, value: b.emas[k]! }],
              ),
            );
            indicatorSeriesRef.current.set(`DESK-ema${k}`, line);
            return line;
          });
          for (const [key, pick, color] of [
            ["DESK-swingHigh", (b: (typeof bars)[number]) => b.swingHigh, colors.down],
            ["DESK-swingLow", (b: (typeof bars)[number]) => b.swingLow, colors.up],
          ] as const) {
            const zone = chart.addLineSeries({
              color: color + "99",
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              lineType: LineType.WithSteps,
              priceScaleId: "right",
              lastValueVisible: false,
              priceLineVisible: false,
            });
            zone.setData(
              bars.flatMap((b) =>
                pick(b) == null ? [] : [{ time: b.time as Time, value: pick(b)! }],
              ),
            );
            indicatorSeriesRef.current.set(key, zone);
          }
          // Markers ride on the fastest EMA line so they never clash with the
          // candle series' own markers (replay trade events).
          const markers: SeriesMarker<Time>[] = [];
          for (const b of bars) {
            if (b.signal === "BUY") {
              markers.push({
                time: b.time as Time,
                position: "belowBar",
                color: colors.up,
                shape: "arrowUp",
                text: "BUY",
              });
            } else if (b.signal === "SELL") {
              markers.push({
                time: b.time as Time,
                position: "aboveBar",
                color: colors.down,
                shape: "arrowDown",
                text: "SELL",
              });
            }
          }
          emaLines[0]!.setMarkers(markers);
          break;
        }
      }
    }
    // chartRef/candleSeriesRef are stable refs; colors derived from isDark dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndicators, chartData, volumeData, isDark, timeframe]);
}

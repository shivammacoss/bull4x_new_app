import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Modal,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  FlatList,
  Animated,
  PanResponder,
  Keyboard,
  Platform,
  KeyboardAvoidingView,
  Alert,
  Linking,
  Image,
  Share,
  AppState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons, MaterialCommunityIcons, Feather } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { API_URL, API_BASE_URL, WS_URL } from '../config';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import socketService from '../services/socketService';
import { getJsonAuthHeaders } from '../utils/authHeaders';
import { authedFetch } from '../utils/authedFetch';
import {
  extractInstrumentRows,
  extractPriceRows,
  rowsToPriceDict,
  normalizeInstrumentCategory,
} from '../utils/marketData';
import Mt5QuoteRow from '../components/Mt5QuoteRow';

const Tab = createBottomTabNavigator();
const { width, height } = Dimensions.get('window');

// ─── Chart data-source helpers (kept available for future use) ───────────
const CHART_CRYPTO_SET = new Set([
  'BTCUSD','ETHUSD','LTCUSD','XRPUSD','BNBUSD','SOLUSD','ADAUSD',
  'DOGEUSD','DOTUSD','MATICUSD','AVAXUSD','LINKUSD','TRXUSD','SHIBUSD',
]);

const YAHOO_INDEX_MAP = {
  US30: '^DJI', DJI: '^DJI', DJ30: '^DJI',
  US500: '^GSPC', SPX500: '^GSPC', SP500: '^GSPC',
  NAS100: '^NDX', US100: '^NDX', NDX: '^NDX',
  UK100: '^FTSE', FTSE100: '^FTSE',
  GER40: '^GDAXI', DE30: '^GDAXI', DE40: '^GDAXI',
  JPN225: '^N225', JP225: '^N225',
  HK50: '^HSI',
  AUS200: '^AXJO',
};

// eslint-disable-next-line no-unused-vars
function getChartDataSource(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (CHART_CRYPTO_SET.has(sym)) {
    const base = sym.replace(/USD$/, '');
    return { provider: 'binance', remote: `${base}USDT` };
  }
  if (YAHOO_INDEX_MAP[sym]) {
    return { provider: 'yahoo', remote: YAHOO_INDEX_MAP[sym] };
  }
  // Forex / metals / generic — Yahoo uses the `=X` suffix for FX & spot metals.
  if (/^[A-Z]{6}$/.test(sym)) {
    return { provider: 'yahoo', remote: `${sym}=X` };
  }
  // Stocks (e.g. AAPL, TSLA) — pass through as-is.
  return { provider: 'yahoo', remote: sym };
}

// Bootstrap script for the in-WebView chart (TradingView Charting Library).
// Hosts the chart that web uses, with custom datafeed, broker_factory, and
// the same entry/SL/TP horizontal_line overlay logic as
// intrendfx/frontend/trader/src/components/charts/ChartPositionOverlay.tsx.
//
// Loaded with baseUrl = https://intrendfx.com/, so /charting_library/ resolves
// to the production server where the library is already hosted.
const CHART_BOOTSTRAP_JS = String.raw`
(function () {
  function postMsg(payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (e) {}
  }

  var cfg = window.INTRENDFX_CONFIG || {};
  var SYMBOL    = String(cfg.symbol    || 'EURUSD').toUpperCase();
  var INTERVAL  = String(cfg.interval  || '5');
  var THEME     = (cfg.isDark ? 'Dark' : 'Light');
  var BG        = cfg.isDark ? '#0d0d0d' : '#ffffff';
  var TXT       = cfg.isDark ? '#aaaaaa' : '#555555';
  var DECIMALS  = Number(cfg.decimals  || 5);
  var TOKEN     = String(cfg.token || '');
  var API_BASE  = String(cfg.apiUrl  || 'https://api.intrendfx.com/api/v1').replace(/\/+$/, '');
  var WS_URL    = String(cfg.wsUrl   || 'wss://api.intrendfx.com');
  var INSTRUMENTS = Array.isArray(cfg.instruments) ? cfg.instruments : [];
  var ACCOUNT   = cfg.account || null;

  var statusEl = document.getElementById('status');
  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.style.display = text ? 'flex' : 'none';
  }

  if (!window.TradingView || !window.TradingView.widget) {
    setStatus('Charting library failed to load. Check your connection.');
    postMsg({ type: 'error', message: 'TradingView library missing' });
    return;
  }

  function authHeaders(extra) {
    var h = { 'Accept': 'application/json' };
    if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  // ── Symbol catalogue helpers (mirrors web's lookup against the trading store)
  function findInstrument(sym) {
    var u = String(sym || '').toUpperCase();
    for (var i = 0; i < INSTRUMENTS.length; i++) {
      if (String(INSTRUMENTS[i].symbol || '').toUpperCase() === u) return INSTRUMENTS[i];
    }
    return null;
  }
  function segmentToType(seg) {
    var s = String(seg || '').toLowerCase();
    if (s === 'crypto')      return 'crypto';
    if (s === 'index' || s === 'indices') return 'index';
    if (s === 'commodity' || s === 'commodities' || s === 'metal' || s === 'metals') return 'commodity';
    if (s === 'stock' || s === 'stocks' || s === 'equity') return 'stock';
    return 'forex';
  }
  var BINANCE_MAP = {
    BTCUSD:'BTCUSDT', ETHUSD:'ETHUSDT', LTCUSD:'LTCUSDT', XRPUSD:'XRPUSDT',
    SOLUSD:'SOLUSDT', BNBUSD:'BNBUSDT', DOGEUSD:'DOGEUSDT', ADAUSD:'ADAUSDT',
    TRXUSD:'TRXUSDT', LINKUSD:'LINKUSDT', DOTUSD:'DOTUSDT', AVAXUSD:'AVAXUSDT',
    XAUUSD:'PAXGUSDT',
    EURUSD:'EURUSDT',
  };
  function isBinanceSym(s) { return !!BINANCE_MAP[String(s || '').toUpperCase()]; }
  function toBinance(s) { return BINANCE_MAP[String(s || '').toUpperCase()]; }

  function resolutionToBinance(res) {
    var map = {'1':'1m','5':'5m','15':'15m','30':'30m','60':'1h','240':'4h','D':'1d','1D':'1d'};
    return map[String(res)] || '5m';
  }
  function resolutionToSec(res) {
    var map = {'1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'1D':86400};
    return map[String(res)] || 300;
  }

  // ── DATAFEED ─────────────────────────────────────────────────────────
  var SUPPORTED_RESOLUTIONS = ['1','5','15','30','60','240','1D'];
  var liveSubs = {};   // listenerGuid -> { sym, res, onTick, lastBar }

  var datafeed = {
    onReady: function (cb) {
      setTimeout(function () {
        cb({
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          exchanges: [
            { value: '', name: 'All', desc: 'All exchanges' },
            { value: 'inTrendFX', name: 'inTrendFX', desc: 'inTrendFX' },
          ],
          symbols_types: [
            { name: 'All', value: '' },
            { name: 'Forex', value: 'forex' },
            { name: 'Crypto', value: 'crypto' },
            { name: 'Index', value: 'index' },
            { name: 'Commodity', value: 'commodity' },
            { name: 'Stock', value: 'stock' },
          ],
          supports_marks: false,
          supports_timescale_marks: false,
          supports_search: true,
          supports_group_request: false,
        });
      }, 0);
    },

    searchSymbols: function (userInput, exchange, symbolType, onResult) {
      var q = String(userInput || '').toUpperCase();
      var out = [];
      for (var i = 0; i < INSTRUMENTS.length && out.length < 30; i++) {
        var inst = INSTRUMENTS[i];
        var sym = String(inst.symbol || '').toUpperCase();
        var typ = segmentToType(inst.segment || inst.category);
        if (symbolType && typ !== symbolType) continue;
        if (q && sym.indexOf(q) === -1) continue;
        out.push({
          symbol: sym, full_name: 'inTrendFX:' + sym, ticker: sym,
          description: inst.display_name || inst.name || sym,
          exchange: 'inTrendFX', type: typ,
        });
      }
      onResult(out);
    },

    resolveSymbol: function (symbolName, onResolve, onError) {
      var sym = String(symbolName || '').toUpperCase().replace(/^INTRENDFX:/, '');
      var inst = findInstrument(sym);
      var digits = inst && (inst.digits || inst.precision);
      if (!digits) digits = (sym.indexOf('JPY') >= 0) ? 3 : (isBinanceSym(sym) ? 2 : DECIMALS);
      var pricescale = Math.pow(10, digits);
      var typ = segmentToType(inst && (inst.segment || inst.category));
      setTimeout(function () {
        onResolve({
          ticker: sym, name: sym,
          description: (inst && (inst.display_name || inst.name)) || sym,
          type: typ,
          session: '24x7', timezone: 'Etc/UTC',
          exchange: 'inTrendFX', listed_exchange: 'inTrendFX',
          format: 'price',
          pricescale: pricescale, minmov: 1,
          has_intraday: true, has_daily: true, has_weekly_and_monthly: false,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 2,
          data_status: 'streaming',
        });
      }, 0);
    },

    getBars: function (symbolInfo, resolution, periodParams, onResult, onError) {
      var sym = symbolInfo.ticker || symbolInfo.name;
      var from = periodParams.from, to = periodParams.to;

      function done(bars) {
        if (!bars || !bars.length) onResult([], { noData: true });
        else onResult(bars, { noData: false });
      }

      // Crypto -> Binance (real OHLC)
      if (isBinanceSym(sym)) {
        var iv = resolutionToBinance(resolution);
        var url = 'https://api.binance.com/api/v3/klines?symbol=' + encodeURIComponent(toBinance(sym))
                + '&interval=' + iv + '&startTime=' + (from*1000) + '&endTime=' + (to*1000) + '&limit=1000';
        fetch(url).then(function (r) { return r.json(); }).then(function (rows) {
          if (!Array.isArray(rows)) throw new Error('binance bad response');
          var bars = rows.map(function (k) {
            return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
          });
          done(bars);
        }).catch(function (e) {
          fetchBackend(sym, resolution, from, to, done, onError);
        });
        return;
      }

      // Backend (forex/metals/indices/stocks)
      fetchBackend(sym, resolution, from, to, done, onError);
    },

    subscribeBars: function (symbolInfo, resolution, onTick, listenerGuid) {
      liveSubs[listenerGuid] = {
        sym: (symbolInfo.ticker || symbolInfo.name).toUpperCase(),
        res: String(resolution),
        onTick: onTick,
        lastBar: null,
      };
    },

    unsubscribeBars: function (listenerGuid) {
      delete liveSubs[listenerGuid];
    },
  };

  function fetchBackendOnce(sym, resolution, from, to) {
    var url = API_BASE + '/instruments/' + encodeURIComponent(sym) + '/bars'
            + '?resolution=' + encodeURIComponent(resolution)
            + '&from=' + from + '&to=' + to;
    return fetch(url, { headers: authHeaders() }).then(function (r) {
      if (!r.ok) throw new Error('bars HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      var raw = (data && Array.isArray(data.bars)) ? data.bars : (Array.isArray(data) ? data : []);
      return raw.map(function (b) {
        var t = Number(b.time || b.t || 0);
        if (t < 1e12) t *= 1000;
        return { time: t, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +(b.volume || 0) };
      }).filter(function (b) { return isFinite(b.open) && b.time > 0; });
    });
  }

  function fetchBackend(sym, resolution, from, to, done, onError) {
    var isIntraday = String(resolution) !== 'D' && String(resolution) !== '1D';
    var daySec = 86400;
    // Daily fallback reaches back ~10 years so the chart never looks truncated.
    var dailyFromCap = Math.floor(Date.now() / 1000) - daySec * 365 * 10;

    fetchBackendOnce(sym, resolution, from, to).then(function (bars) {
      if (!isIntraday) { done(bars); return; }
      // Backend often only stores daily history. Fall back to daily whenever
      // the intraday response is sparse OR doesn't cover the requested window,
      // so old candles still show instead of leaving the chart mostly empty.
      var oldestSec = bars.length ? Math.floor(bars[0].time / 1000) : to;
      var span = Math.max(1, to - from);
      var coverageGap = oldestSec - from;
      var sparse = bars.length < 20 || coverageGap > span * 0.25;
      if (!sparse) { done(bars); return; }
      var dailyFrom = Math.min(from, dailyFromCap);
      fetchBackendOnce(sym, 'D', dailyFrom, to).then(function (dailyBars) {
        done(dailyBars.length > bars.length ? dailyBars : bars);
      }).catch(function () { done(bars); });
    }).catch(function () {
      // Backend failed entirely — try daily as a last resort.
      var dailyFrom = Math.min(from, dailyFromCap);
      fetchBackendOnce(sym, 'D', dailyFrom, to).then(function (dailyBars) {
        done(dailyBars);
      }).catch(function () { done([]); });
    });
  }

  // ── PRICE FEED (WebSocket) ──────────────────────────────────────────
  var lastPrice = {};   // symbol -> { bid, ask, ts }
  function applyTickToSubs(sym, mid, vol) {
    var nowMs = Date.now();
    var keys = Object.keys(liveSubs);
    for (var i = 0; i < keys.length; i++) {
      var s = liveSubs[keys[i]];
      if (s.sym !== sym) continue;
      var barSec = resolutionToSec(s.res);
      var bucket = Math.floor(nowMs / 1000 / barSec) * barSec * 1000;
      if (!s.lastBar || bucket > s.lastBar.time) {
        s.lastBar = { time: bucket, open: mid, high: mid, low: mid, close: mid, volume: vol || 0 };
      } else {
        s.lastBar.high  = Math.max(s.lastBar.high, mid);
        s.lastBar.low   = Math.min(s.lastBar.low,  mid);
        s.lastBar.close = mid;
        s.lastBar.volume = (s.lastBar.volume || 0) + (vol || 0);
      }
      try { s.onTick(s.lastBar); } catch (e) {}
    }
  }

  var ws = null, wsRetry = 0;
  function connectWS() {
    try {
      ws = new WebSocket(WS_URL.replace(/\/+$/, '') + '/ws/prices');
    } catch (e) { return; }
    ws.onopen = function () { wsRetry = 0; postMsg({ type: 'wsopen' }); };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        // Server format may vary; common shapes: {symbol, bid, ask} or {s, b, a} or {prices:[...]}
        var list = Array.isArray(msg) ? msg : (msg.prices || (msg.symbol ? [msg] : []));
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          var sym = String(p.symbol || p.s || '').toUpperCase();
          if (!sym) continue;
          var bid = +p.bid || +p.b || 0;
          var ask = +p.ask || +p.a || 0;
          var mid = (bid && ask) ? (bid + ask) / 2 : (bid || ask);
          if (!isFinite(mid) || mid <= 0) continue;
          lastPrice[sym] = { bid: bid, ask: ask, ts: Date.now() };
          applyTickToSubs(sym, mid, +p.volume || 0);
        }
      } catch (e) {}
    };
    ws.onclose = function () {
      wsRetry++;
      var delay = Math.min(15000, 1000 * Math.pow(1.5, wsRetry));
      setTimeout(connectWS, delay);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  if (WS_URL) connectWS();

  // Allow the RN side to push ticks too (fallback if WS is gated by network).
  window.INTRENDFX_API = window.INTRENDFX_API || {};
  window.INTRENDFX_API.setLiveTick = function (symbol, bid, ask) {
    var sym = String(symbol || '').toUpperCase();
    var b = +bid, a = +ask;
    var mid = (b && a) ? (b + a) / 2 : (b || a);
    if (!sym || !isFinite(mid) || mid <= 0) return;
    lastPrice[sym] = { bid: b, ask: a, ts: Date.now() };
    applyTickToSubs(sym, mid, 0);
  };

  // ── BROKER (positions / orders + native SL/TP via positionUpdate) ───
  var _host = null;
  var _positions = [];   // pushed from RN
  var _orders    = [];

  window.INTRENDFX_API.setPositions = function (list, orders) {
    _positions = Array.isArray(list) ? list : [];
    _orders    = Array.isArray(orders) ? orders : _orders;
    pushPositionUpdates();
    syncOverlay();
  };

  function brokerFactory(host) {
    _host = host;
    setInterval(pushPositionUpdates, 3000);

    return {
      connectionStatus: function () { return 1; /* Connected */ },
      isTradable: function () { return Promise.resolve(true); },
      chartContextMenuActions: function () { return Promise.resolve([]); },
      accountManagerInfo: function () {
        return {
          accountTitle: 'Trading Account',
          summary: [
            { text: 'Balance', wValue: host.factory.createWatchedValue(0), formatter: 'fixed', isDefault: true },
            { text: 'Equity',  wValue: host.factory.createWatchedValue(0), formatter: 'fixed', isDefault: true },
          ],
          orderColumns: [], positionColumns: [], pages: [],
          contextMenuActions: function () { return Promise.resolve([]); },
        };
      },
      accountsMetainfo: function () {
        var acc = ACCOUNT || { id: 'default', currency: 'USD', name: 'Account' };
        return [{ id: String(acc.id || 'default'), name: String(acc.name || acc.account_number || 'Account') + ' (' + (acc.currency || 'USD') + ')', currency: acc.currency || 'USD' }];
      },
      currentAccount: function () { return String((ACCOUNT && (ACCOUNT.id || ACCOUNT._id)) || 'default'); },
      setCurrentAccount: function () {},
      orders: function () {
        return Promise.resolve(_orders.map(function (o) {
          return {
            id: String(o.id || o._id),
            symbol: String(o.symbol || '').toUpperCase(),
            type: o.orderType === 'limit' ? 1 : (o.orderType === 'stop' ? 2 : 3),
            side: (o.side || '').toLowerCase() === 'sell' ? -1 : 1,
            qty: Number(o.lots || o.quantity || 0),
            limitPrice: Number(o.price || 0),
            stopPrice: Number(o.stop_price || o.stopPrice || 0),
            stopLoss: Number(o.stop_loss || o.stopLoss || 0) || undefined,
            takeProfit: Number(o.take_profit || o.takeProfit || 0) || undefined,
            status: 6, // Working
          };
        }));
      },
      positions: function () { return Promise.resolve(positionsForHost()); },
      executions: function () { return Promise.resolve([]); },
      placeOrder: function (order) {
        var body = {
          account_id: (ACCOUNT && (ACCOUNT.id || ACCOUNT._id)) || null,
          symbol: order.symbol,
          side: (order.side === -1 || String(order.side).toLowerCase() === 'sell') ? 'sell' : 'buy',
          order_type: order.type === 1 ? 'limit' : (order.type === 2 ? 'stop' : 'market'),
          lots: Number(order.qty || 0.01),
        };
        if (order.limitPrice) body.price = Number(order.limitPrice);
        if (order.stopPrice)  body.stop_price = Number(order.stopPrice);
        if (order.stopLoss)   body.stop_loss = Number(order.stopLoss);
        if (order.takeProfit) body.take_profit = Number(order.takeProfit);
        return fetch(API_BASE + '/orders/', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.detail || d.message || 'order failed');
          postMsg({ type: 'orderPlaced', data: d });
          return { orderId: String(d.id || d.order_id || '') };
        }); });
      },
      modifyOrder: function (order) {
        var body = {};
        if (order.limitPrice) body.price = Number(order.limitPrice);
        if (order.stopPrice)  body.stop_price = Number(order.stopPrice);
        if (order.qty != null) body.lots = Number(order.qty);
        return fetch(API_BASE + '/orders/' + encodeURIComponent(order.id), {
          method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        }).then(function (r) { return r.ok ? Promise.resolve() : r.json().then(function (d) { throw new Error(d.detail || d.message || 'modify failed'); }); });
      },
      cancelOrder: function (id) {
        return fetch(API_BASE + '/orders/' + encodeURIComponent(id), {
          method: 'DELETE', headers: authHeaders(),
        }).then(function () { postMsg({ type: 'orderCancelled', id: id }); });
      },
      editPositionBrackets: function (positionId, modifiedBrackets) {
        var body = {};
        if (modifiedBrackets.stopLoss   != null) body.stop_loss   = Number(modifiedBrackets.stopLoss);
        if (modifiedBrackets.takeProfit != null) body.take_profit = Number(modifiedBrackets.takeProfit);
        return fetch(API_BASE + '/positions/' + encodeURIComponent(positionId), {
          method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d.detail || d.message || 'bracket failed'); });
          postMsg({ type: 'bracketUpdated', positionId: positionId, brackets: body });
        });
      },
      closePosition: function (positionId) {
        return fetch(API_BASE + '/positions/' + encodeURIComponent(positionId) + '/close', {
          method: 'POST', headers: authHeaders(),
        }).then(function () { postMsg({ type: 'positionClosed', positionId: positionId }); });
      },
      brokerConfig: function () {
        return Promise.resolve({
          configFlags: {
            supportOrderBrackets: true, supportPositionBrackets: true, supportEditBrackets: true,
            supportPLUpdate: true, supportClosePosition: true, supportReversePosition: false,
            supportNativeReversePosition: false, supportMarketOrders: true,
            supportLimitOrders: true, supportStopOrders: true, supportStopLimitOrders: false,
            supportModifyOrder: true, supportCancelOrder: true, supportEditAmount: true,
            showQuantityInsteadOfAmount: true, supportLevel2Data: false,
          },
          durations: [],
        });
      },
      quantityFormatter: function () {
        return { format: function (q) { return Number(q).toFixed(2); }, parse: function (s) { return parseFloat(s) || 0.01; } };
      },
    };
  }

  function positionsForHost() {
    return _positions.map(function (p) {
      var sym = String(p.symbol || '').toUpperCase();
      var lp = lastPrice[sym] || {};
      var side = String(p.side || '').toLowerCase();
      var last = side === 'buy' ? (lp.bid || p.openPrice) : (lp.ask || p.openPrice);
      var qty  = Number(p.lots || p.quantity || 0);
      var avg  = Number(p.openPrice || p.open_price || 0);
      var pl   = (side === 'buy' ? (last - avg) : (avg - last)) * qty;
      return {
        id: String(p.id || p._id),
        symbol: sym,
        side: side === 'sell' ? -1 : 1,
        qty: qty,
        avgPrice: avg,
        last: last,
        unrealizedPl: pl,
        stopLoss: p.stopLoss != null ? Number(p.stopLoss) : undefined,
        takeProfit: p.takeProfit != null ? Number(p.takeProfit) : undefined,
      };
    });
  }
  function pushPositionUpdates() {
    if (!_host) return;
    var arr = positionsForHost();
    for (var i = 0; i < arr.length; i++) {
      try { _host.positionUpdate(arr[i]); } catch (e) {}
    }
  }

  // ── POSITION OVERLAY (entry/SL/TP horizontal_line, mirrors web) ──────
  var COLORS = { buy: '#2962FF', sell: '#FF6D00', sl: '#EF5350', tp: '#26A69A' };
  var LS = { solid: 0, dashed: 2 };
  var SHAPE_BASE = { lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top' };
  var shapesById = {};   // posId -> { entryId, slId, tpId, lastEntry, lastSL, lastTP, lastLots, lastSide }
  var creating = {};
  var widgetRef = null, chartReady = false;

  function getActiveChart() {
    if (!widgetRef || !chartReady) return null;
    try { return widgetRef.activeChart(); } catch (e) { return null; }
  }
  function nowSec() { return Math.floor(Date.now() / 1000); }

  function syncOverlay() {
    var chart = getActiveChart();
    if (!chart || typeof chart.createShape !== 'function') return;
    var symU = SYMBOL.toUpperCase();
    var matching = _positions.filter(function (p) { return String(p.symbol || '').toUpperCase() === symU; });
    var ids = {};
    matching.forEach(function (p) { ids[p.id] = true; });

    Object.keys(shapesById).forEach(function (pid) {
      if (!ids[pid]) {
        var s = shapesById[pid];
        if (s.entryId) try { chart.removeEntity(s.entryId); } catch (e) {}
        if (s.slId)    try { chart.removeEntity(s.slId);    } catch (e) {}
        if (s.tpId)    try { chart.removeEntity(s.tpId);    } catch (e) {}
        delete shapesById[pid];
      }
    });

    matching.forEach(function (p) {
      var existing = shapesById[p.id];
      if (!existing) {
        if (creating[p.id]) return;
        creating[p.id] = true;
        createShapeSet(chart, p).then(function (set) {
          if (set) shapesById[p.id] = set;
        }).catch(function () {}).then(function () { delete creating[p.id]; });
      } else {
        updateShapeSet(chart, existing, p);
      }
    });
  }

  function createShapeSet(chart, p) {
    var t = nowSec();
    var entryColor = (String(p.side).toLowerCase() === 'buy') ? COLORS.buy : COLORS.sell;
    var lots = Number(p.lots || 0).toFixed(2);
    var entryTitle = String(p.side || '').toUpperCase() + ' ' + lots;

    return chart.createShape({ time: t, price: Number(p.openPrice) }, {
      shape: 'horizontal_line', text: entryTitle,
      lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
      overrides: {
        linecolor: entryColor, linestyle: LS.solid, linewidth: 2,
        showLabel: true, textcolor: entryColor,
        horzLabelsAlign: 'right', vertLabelsAlign: 'top',
        fontsize: 11, bold: true,
      },
    }).then(function (entryId) {
      var slPromise = (p.stopLoss && p.stopLoss > 0) ? chart.createShape(
        { time: t, price: Number(p.stopLoss) },
        { shape: 'horizontal_line', text: 'SL', lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
          overrides: { linecolor: COLORS.sl, linestyle: LS.dashed, linewidth: 1, showLabel: true, textcolor: COLORS.sl, horzLabelsAlign: 'right', vertLabelsAlign: 'top', fontsize: 11, bold: true } }
      ).catch(function () { return null; }) : Promise.resolve(null);

      var tpPromise = (p.takeProfit && p.takeProfit > 0) ? chart.createShape(
        { time: t, price: Number(p.takeProfit) },
        { shape: 'horizontal_line', text: 'TP', lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
          overrides: { linecolor: COLORS.tp, linestyle: LS.dashed, linewidth: 1, showLabel: true, textcolor: COLORS.tp, horzLabelsAlign: 'right', vertLabelsAlign: 'top', fontsize: 11, bold: true } }
      ).catch(function () { return null; }) : Promise.resolve(null);

      return Promise.all([slPromise, tpPromise]).then(function (ids) {
        return {
          entryId: entryId, slId: ids[0] || null, tpId: ids[1] || null,
          lastEntry: Number(p.openPrice), lastSL: p.stopLoss, lastTP: p.takeProfit,
          lastLots: Number(p.lots || 0), lastSide: p.side,
        };
      });
    });
  }

  function updateShapeSet(chart, set, p) {
    var t = nowSec();
    var entryPrice = Number(p.openPrice);
    if (entryPrice !== set.lastEntry) {
      try { var api = chart.getShapeById(set.entryId); api && api.setPoints && api.setPoints([{ time: t, price: entryPrice }]); } catch (e) {}
      set.lastEntry = entryPrice;
    }

    var slNow = (p.stopLoss && p.stopLoss > 0) ? Number(p.stopLoss) : null;
    if (slNow != null && set.slId) {
      if (slNow !== set.lastSL) {
        try { var a = chart.getShapeById(set.slId); a && a.setPoints && a.setPoints([{ time: t, price: slNow }]); } catch (e) {}
        set.lastSL = slNow;
      }
    } else if (slNow != null && !set.slId) {
      chart.createShape({ time: t, price: slNow }, {
        shape: 'horizontal_line', text: 'SL', lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
        overrides: { linecolor: COLORS.sl, linestyle: LS.dashed, linewidth: 1, showLabel: true, textcolor: COLORS.sl, horzLabelsAlign: 'right', vertLabelsAlign: 'top', fontsize: 11, bold: true },
      }).then(function (id) { set.slId = id; set.lastSL = slNow; }).catch(function () {});
    } else if (slNow == null && set.slId) {
      try { chart.removeEntity(set.slId); } catch (e) {}
      set.slId = null; set.lastSL = null;
    }

    var tpNow = (p.takeProfit && p.takeProfit > 0) ? Number(p.takeProfit) : null;
    if (tpNow != null && set.tpId) {
      if (tpNow !== set.lastTP) {
        try { var a2 = chart.getShapeById(set.tpId); a2 && a2.setPoints && a2.setPoints([{ time: t, price: tpNow }]); } catch (e) {}
        set.lastTP = tpNow;
      }
    } else if (tpNow != null && !set.tpId) {
      chart.createShape({ time: t, price: tpNow }, {
        shape: 'horizontal_line', text: 'TP', lock: true, disableSelection: true, disableSave: true, disableUndo: true, zOrder: 'top',
        overrides: { linecolor: COLORS.tp, linestyle: LS.dashed, linewidth: 1, showLabel: true, textcolor: COLORS.tp, horzLabelsAlign: 'right', vertLabelsAlign: 'top', fontsize: 11, bold: true },
      }).then(function (id) { set.tpId = id; set.lastTP = tpNow; }).catch(function () {});
    } else if (tpNow == null && set.tpId) {
      try { chart.removeEntity(set.tpId); } catch (e) {}
      set.tpId = null; set.lastTP = null;
    }
  }

  // ── INITIALISE WIDGET ────────────────────────────────────────────────
  setStatus('Loading chart…');
  try {
    widgetRef = new TradingView.widget({
      container: 'tv_chart',
      locale: 'en',
      library_path: '/charting_library/',
      datafeed: datafeed,
      symbol: SYMBOL,
      interval: INTERVAL,
      timezone: 'Etc/UTC',
      theme: THEME,
      fullscreen: false,
      autosize: true,
      debug: false,
      broker_factory: brokerFactory,
      disabled_features: [
        'use_localstorage_for_settings',
        'header_compare',
        'header_symbol_search',
        'display_market_status',
        'popup_hints',
      ],
      enabled_features: [
        'study_templates',
        'side_toolbar_in_fullscreen_mode',
        'trading_notifications',
        'show_trading_notifications_history',
        'pinch_scale',
        'horz_touch_drag_scroll',
        'vert_touch_drag_scroll',
      ],
      overrides: {
        'mainSeriesProperties.style': 1,
        'mainSeriesProperties.candleStyle.upColor': '#26a69a',
        'mainSeriesProperties.candleStyle.downColor': '#ef5350',
        'mainSeriesProperties.candleStyle.borderUpColor': '#26a69a',
        'mainSeriesProperties.candleStyle.borderDownColor': '#ef5350',
        'mainSeriesProperties.candleStyle.wickUpColor': '#26a69a',
        'mainSeriesProperties.candleStyle.wickDownColor': '#ef5350',
        'paneProperties.background': BG,
        'paneProperties.backgroundType': 'solid',
        'scalesProperties.textColor': TXT,
        'scalesProperties.backgroundColor': BG,
      },
      loading_screen: { backgroundColor: BG, foregroundColor: '#2962FF' },
    });

    widgetRef.onChartReady(function () {
      chartReady = true;
      setStatus('');
      postMsg({ type: 'ready', symbol: SYMBOL });
      // Apply any positions that arrived before the chart was ready.
      try { syncOverlay(); } catch (e) {}
      // Light-theme: inject CSS into the TradingView iframe so the resolution /
      // settings dropdowns don't show black-bar selected highlights.
      if (!cfg.isDark) { try { injectLightThemeCSS(); } catch (e) {} }
    });

    function injectLightThemeCSS() {
      var css = ''
        + ':root,body{'
        + '--tv-color-popup-element-background-active:#F1F5F9 !important;'
        + '--tv-color-popup-element-background-hover:#F1F5F9 !important;'
        + '--tv-color-popup-element-text-active:#0F172A !important;'
        + '--tv-color-popup-element-text:#0F172A !important;'
        + '--tv-color-popup-element-text-hover:#0F172A !important;'
        + '--tv-color-popup-element-divider-background:#E5E7EB !important;'
        + '--tv-color-popup-background:#FFFFFF !important;'
        + '--tv-color-popup-element-secondary-text:#64748B !important;'
        + '--tv-color-platform-background:#F1F5F9 !important;'
        + '--tv-color-toolbar-button-background-hover:#F1F5F9 !important;'
        + '--tv-color-toolbar-button-background-active:#F1F5F9 !important;'
        + '--tv-color-toolbar-button-background-active-hover:#E2E8F0 !important;'
        + '--tv-color-toolbar-button-text:#0F172A !important;'
        + '--tv-color-toolbar-button-text-hover:#0F172A !important;'
        + '--tv-color-toolbar-button-text-active:#1a73e8 !important;'
        + '--tv-color-toolbar-button-text-active-hover:#1a73e8 !important;'
        + '}'
        // High-specificity overrides for hashed TradingView popup item classes —
        // covers cases where the library doesn't read from the CSS variables above.
        + '[class*="item-"][class*="hovered"],'
        + '[class*="item-"][class*="hover"]:hover,'
        + '[class*="menuItem-"][class*="hover"]:hover{'
        + 'background-color:#F1F5F9 !important;color:#0F172A !important;}'
        + '[class*="item-"][class*="active"],'
        + '[class*="item-"][class*="checked"],'
        + '[class*="menuItem-"][class*="active"],'
        + '[class*="menuItem-"][class*="checked"]{'
        + 'background-color:#E2E8F0 !important;color:#0F172A !important;}'
        + '[class*="popup-"],[class*="menuWrap-"],[class*="dropdownContent-"]{'
        + 'background-color:#FFFFFF !important;color:#0F172A !important;}';

      function applyTo(doc) {
        if (!doc || !doc.head) return;
        if (doc.getElementById('intrendfx-tv-light-css')) return;
        var s = doc.createElement('style');
        s.id = 'intrendfx-tv-light-css';
        s.textContent = css;
        doc.head.appendChild(s);
      }

      // Apply to top document AND every iframe (TradingView renders the chart
      // in a nested iframe; popups can also live in a separate iframe).
      applyTo(document);
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        try {
          if (f.contentDocument) applyTo(f.contentDocument);
          f.addEventListener('load', function (ev) {
            try { applyTo(ev.target.contentDocument); } catch (_) {}
          });
        } catch (_) { /* cross-origin, skip */ }
      }
      // Watch for new iframes added later (popup menus often spawn one).
      try {
        var mo = new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var added = muts[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (n && n.tagName === 'IFRAME') {
                try { if (n.contentDocument) applyTo(n.contentDocument); } catch (_) {}
                n.addEventListener('load', function (ev) {
                  try { applyTo(ev.target.contentDocument); } catch (_) {}
                });
              }
            }
          }
        });
        mo.observe(document.body, { childList: true, subtree: true });
      } catch (_) {}
    }
  } catch (e) {
    setStatus('Could not initialise the chart.');
    postMsg({ type: 'error', message: String(e && e.message || e) });
  }

  // ── PUBLIC API for the React-Native side ─────────────────────────────
  window.INTRENDFX_API.setSymbol = function (sym) {
    SYMBOL = String(sym || '').toUpperCase();
    if (widgetRef && chartReady) {
      try { widgetRef.activeChart().setSymbol(SYMBOL); } catch (e) {}
    }
    syncOverlay();
  };
  window.INTRENDFX_API.setInterval = function (i) {
    INTERVAL = String(i || '5');
    if (widgetRef && chartReady) {
      try { widgetRef.activeChart().setResolution(INTERVAL); } catch (e) {}
    }
  };
  window.INTRENDFX_API.setToken = function (t) { TOKEN = String(t || ''); };
  window.INTRENDFX_API.setAccount = function (a) { ACCOUNT = a || null; };
  window.INTRENDFX_API.refresh = function () { try { syncOverlay(); } catch (e) {} };

  // Listen for posted messages too (alt path).
  function onMessage(event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    try {
      var msg = JSON.parse(data);
      if (msg && msg.type === 'positions') window.INTRENDFX_API.setPositions(msg.list, msg.orders);
      else if (msg && msg.type === 'tick') window.INTRENDFX_API.setLiveTick(msg.symbol, msg.bid, msg.ask);
      else if (msg && msg.type === 'symbol') window.INTRENDFX_API.setSymbol(msg.symbol);
      else if (msg && msg.type === 'token') window.INTRENDFX_API.setToken(msg.token);
    } catch (e) {}
  }
  document.addEventListener('message', onMessage);
  window.addEventListener('message', onMessage);
})();
`;

// iOS 26 Style Toast Notification Component
const ToastContext = React.createContext();

const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  
  const showToast = (message, type = 'info', duration = 3000) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
  };
  
  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <View style={toastStyles.container} pointerEvents="none">
        {toasts.map((toast, index) => (
          <ToastItem key={toast.id} toast={toast} index={index} />
        ))}
      </View>
    </ToastContext.Provider>
  );
};

const ToastItem = ({ toast, index }) => {
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  
  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();
    
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -100, duration: 300, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    }, 2500);
    
    return () => clearTimeout(timer);
  }, []);
  
  const getToastStyle = () => {
    switch (toast.type) {
      case 'success': return { backgroundColor: 'rgba(34, 197, 94, 0.95)', icon: 'checkmark-circle' };
      case 'error': return { backgroundColor: 'rgba(239, 68, 68, 0.95)', icon: 'close-circle' };
      case 'warning': return { backgroundColor: 'rgba(251, 191, 36, 0.95)', icon: 'warning' };
      default: return { backgroundColor: 'rgba(37, 99, 235, 0.95)', icon: 'information-circle' };
    }
  };
  
  const style = getToastStyle();
  
  return (
    <Animated.View style={[
      toastStyles.toast,
      { backgroundColor: style.backgroundColor, transform: [{ translateY }], opacity, marginTop: index * 60 }
    ]}>
      <View style={toastStyles.toastContent}>
        <Ionicons name={style.icon} size={22} color="#fff" />
        <Text style={toastStyles.toastText}>{toast.message}</Text>
      </View>
    </Animated.View>
  );
};

const toastStyles = StyleSheet.create({
  container: { position: 'absolute', top: 60, left: 16, right: 16, zIndex: 9999 },
  toast: { 
    borderRadius: 16, 
    paddingVertical: 14, 
    paddingHorizontal: 18, 
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  toastContent: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toastText: { color: '#fff', fontSize: 15, fontWeight: '600', flex: 1 },
});

const useToast = () => React.useContext(ToastContext);

// Default instruments - fallback only, will be replaced by API data
const defaultInstruments = [
  // Minimal fallback - actual instruments fetched from backend API
  { symbol: 'EURUSD', name: 'EUR/USD', bid: 0, ask: 0, spread: 0, category: 'Forex', starred: true },
  { symbol: 'GBPUSD', name: 'GBP/USD', bid: 0, ask: 0, spread: 0, category: 'Forex', starred: true },
  { symbol: 'XAUUSD', name: 'Gold', bid: 0, ask: 0, spread: 0, category: 'Metals', starred: true },
  { symbol: 'BTCUSD', name: 'Bitcoin', bid: 0, ask: 0, spread: 0, category: 'Crypto', starred: true },
];

// Shared context for trading data
const TradingContext = React.createContext();

/** Align with web: one main (live) trading account — exclude demo from picker and API list. */
function normalizeTradingAccountRow(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const id = raw.id || raw._id;
  const accNum = String(raw.account_number ?? raw.accountNumber ?? '').trim();
  return {
    ...raw,
    id,
    _id: id,
    account_number: accNum || raw.account_number,
    accountNumber: accNum,
    accountId: accNum || String(id ?? ''),
    balance: Number(raw.balance ?? 0),
    equity: Number(raw.equity ?? raw.balance ?? 0),
    credit: Number(raw.credit ?? 0),
    is_demo: raw.is_demo === true,
    isDemo: raw.is_demo === true || raw.isDemo === true,
  };
}

function isDemoTradingAccount(a) {
  return !!(a?.is_demo || a?.isDemo || a?.accountTypeId?.isDemo);
}

const TradingProvider = ({ children, navigation, route }) => {
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [challengeAccounts, setChallengeAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [selectedChallengeAccount, setSelectedChallengeAccount] = useState(null);
  const [isChallengeMode, setIsChallengeMode] = useState(false);
  const [openTrades, setOpenTrades] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [instruments, setInstruments] = useState(defaultInstruments);
  const [livePrices, setLivePrices] = useState({});
  const [adminSpreads, setAdminSpreads] = useState({});
  const [loading, setLoading] = useState(true);
  const [accountSummary, setAccountSummary] = useState({
    balance: 0, equity: 0, credit: 0, freeMargin: 0, usedMargin: 0, floatingPnl: 0
  });
  const [marketWatchNews, setMarketWatchNews] = useState([]);
  const [loadingNews, setLoadingNews] = useState(true);
  const [currentMainTab, setCurrentMainTab] = useState('Home'); // Track current tab for notifications

  useEffect(() => {
    loadUser();
    fetchInstrumentsFromAPI();

    // Refresh data when app comes back to foreground
    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'active' && user) {
        fetchAccounts(user.id || user._id);
      }
    });

    return () => {
      sub?.remove();
    };
  }, []);

  useEffect(() => {
    console.log('[TrustEdge] User state changed:', !!user);
    if (user) {
      console.log('[TrustEdge] User loaded, fetching accounts for user ID:', user.id || user._id);
      fetchAccounts(user.id || user._id);
      fetchChallengeAccounts(user.id || user._id);
    } else {
      console.log('[TrustEdge] No user - not fetching accounts');
    }
  }, [user]);

  // Fetch instruments from backend API (TrustEdge)
  const fetchInstrumentsFromAPI = async () => {
    try {
      const headers = await getJsonAuthHeaders();
      const urls = [`${API_URL}/instruments/`, `${API_URL}/instruments`];
      let data = null;
      let ok = false;
      for (const url of urls) {
        console.log('[Mobile] Fetching instruments from:', url);
        const res = await fetch(url, { headers });
        data = await res.json().catch(() => null);
        console.log('[Mobile] Instruments response status:', res.status);
        if (res.ok) {
          ok = true;
          break;
        }
      }
      const rows = extractInstrumentRows(data);
      if (ok && rows.length > 0) {
        const starredSymbols = ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD'];
        const mappedInstruments = rows.map((inst) => {
          const sym = String(inst.symbol || inst.pair || inst.name || '').trim().toUpperCase();
          if (!sym) return null;
          const category = normalizeInstrumentCategory(inst.segment || inst.category, sym);
          return {
            symbol: sym,
            name: inst.display_name || inst.name || sym,
            bid: 0,
            ask: 0,
            spread: 0,
            category,
            starred: starredSymbols.includes(sym),
            digits: inst.digits,
            pip_size: inst.pip_size,
          };
        }).filter(Boolean);
        setInstruments(mappedInstruments);
        console.log('[Mobile] Loaded', mappedInstruments.length, 'instruments from API');
      } else if (!ok) {
        console.warn('[Mobile] Instruments request failed; using default watchlist until prices load');
      }
    } catch (e) {
      console.error('[Mobile] Error fetching instruments:', e);
    } finally {
      fetchAllPrices();
    }
  };

  // Fetch all current prices from TrustEdge
  const fetchAllPrices = async () => {
    try {
      const headers = await getJsonAuthHeaders();
      console.log('[Mobile] Fetching prices from:', `${API_URL}/instruments/prices/all`);
      const res = await fetch(`${API_URL}/instruments/prices/all`, { headers });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.warn('[Mobile] Prices HTTP', res.status, typeof data === 'string' ? data : JSON.stringify(data)?.slice(0, 200));
        return;
      }
      const rows = extractPriceRows(data);
      const pricesDict = rows.length ? rowsToPriceDict(rows) : {};
      console.log('[Mobile] Price rows:', rows.length, 'symbols:', Object.keys(pricesDict).length);

      if (Object.keys(pricesDict).length === 0) return;

      setLivePrices(pricesDict);

      setInstruments((prev) => {
        try {
          return prev.map((inst) => {
            if (!inst?.symbol) return inst;
            const price = pricesDict[inst.symbol];
            if (price && (price.bid > 0 || price.ask > 0)) {
              return {
                ...inst,
                bid: price.bid,
                ask: price.ask || price.bid,
                spread: price.spread ?? Math.abs((price.ask || price.bid) - price.bid),
              };
            }
            return inst;
          });
        } catch (e) {
          console.error('[Mobile] Error updating instruments:', e);
          return prev;
        }
      });
    } catch (e) {
      console.error('[Mobile] Error fetching prices:', e);
    }
  };

  // Handle selectedAccountId from navigation params (when coming from AccountsScreen)
  useEffect(() => {
    if (route?.params?.selectedAccountId && accounts.length > 0) {
      const account = accounts.find(a => (a.id || a._id) === route.params.selectedAccountId);
      if (account) {
        setSelectedAccount(account);
        setIsChallengeMode(false);
        setSelectedChallengeAccount(null);
        SecureStore.setItemAsync('selectedAccountId', account.id || account._id);
        SecureStore.deleteItemAsync('selectedChallengeAccountId');
        // Clear the param to prevent re-triggering
        navigation.setParams({ selectedAccountId: null });
      }
    }
  }, [route?.params?.selectedAccountId, accounts]);

  // Handle challengeAccountId from navigation params (when coming from AccountsScreen Challenge tab)
  useEffect(() => {
    if (route?.params?.challengeAccountId && challengeAccounts.length > 0) {
      const challengeAccount = challengeAccounts.find(a => a._id === route.params.challengeAccountId);
      console.log('DEBUG: Selecting challenge account from params:', route.params.challengeAccountId);
      if (challengeAccount) {
        setSelectedChallengeAccount(challengeAccount);
        setIsChallengeMode(true);
        // Save to SecureStore for persistence
        SecureStore.setItemAsync('selectedChallengeAccountId', challengeAccount._id);
        // Clear the param to prevent re-triggering
        navigation.setParams({ challengeAccountId: null });
      }
    }
  }, [route?.params?.challengeAccountId, challengeAccounts]);

  // Fetch challenge accounts - TrustEdge doesn't have a separate prop endpoint
  // Challenge accounts are regular accounts, skip this for now
  const fetchChallengeAccounts = async (userId) => {
    // TrustEdge doesn't have /prop/my-accounts endpoint
    // Challenge accounts are handled as regular accounts
    setChallengeAccounts([]);
  };
  
  // Refresh challenge account stats periodically
  const refreshChallengeAccountStats = async () => {
    // TrustEdge doesn't have prop accounts endpoint - skip
    return;
    if (!isChallengeMode || !selectedChallengeAccount || !user) return;
    try {
      const res = await fetch(`${API_URL}/prop/my-accounts/${user._id}`);
      const data = await res.json();
      if (data.success && data.accounts?.length > 0) {
        const updatedAccount = data.accounts.find(a => a._id === selectedChallengeAccount._id);
        if (updatedAccount) {
          // Log full account data to see available fields
          console.log('[ChallengeStats] Full account data:', JSON.stringify(updatedAccount, null, 2));
          setSelectedChallengeAccount(updatedAccount);
        }
      }
    } catch (e) {
      console.error('[ChallengeStats] Error refreshing:', e);
    }
  };

  // Save selected account ID whenever it changes (TrustEdge uses 'id' UUID, not '_id')
  useEffect(() => {
    const accountId = selectedAccount?.id || selectedAccount?._id;
    if (accountId) {
      SecureStore.setItemAsync('selectedAccountId', accountId);
    }
  }, [selectedAccount?.id, selectedAccount?._id]);

  useEffect(() => {
    // Fetch trades for the active account (regular or challenge)
    // Only fetch if user is authenticated and has an active account
    const hasActiveAccount = isChallengeMode ? selectedChallengeAccount : selectedAccount;
    if (user && hasActiveAccount) {
      console.log('[TrustEdge] User authenticated and account selected, fetching trading data');
      fetchOpenTrades();
      fetchPendingOrders();
      fetchTradeHistory();
      fetchAccountSummary();
      
      // Faster polling for real-time sync with web (every 2 seconds)
      const interval = setInterval(() => {
        if (user) { // Double-check user is still authenticated
          fetchOpenTrades();
          fetchPendingOrders();
          fetchAccountSummary();
        }
      }, 2000);
      
      // Refresh history less frequently (every 10 seconds)
      const historyInterval = setInterval(() => {
        if (user) { // Double-check user is still authenticated
          fetchTradeHistory();
        }
      }, 10000);
      
      // Refresh challenge account stats every 5 seconds (for DD, profit, balance)
      const challengeStatsInterval = setInterval(() => {
        if (isChallengeMode) {
          refreshChallengeAccountStats();
        }
      }, 5000);
      
      return () => {
        clearInterval(interval);
        clearInterval(historyInterval);
        clearInterval(challengeStatsInterval);
      };
    }
  }, [user, selectedAccount, isChallengeMode, selectedChallengeAccount]);

  // Refs to batch price updates and avoid "Maximum update depth exceeded"
  const livePricesRef = useRef({});
  const priceFlushTimer = useRef(null);

  // WebSocket connection for real-time prices
  useEffect(() => {
    // Connect to WebSocket
    socketService.connect();

    // Flush buffered prices into state at most once per 500ms
    const flushPrices = () => {
      const snapshot = livePricesRef.current;
      if (!snapshot || Object.keys(snapshot).length === 0) return;

      setLivePrices(snapshot);

      setInstruments(prev => {
        let changed = false;
        const next = prev.map(inst => {
          const key = inst.symbol;
          const price = snapshot[key] ?? snapshot[String(key || '').toUpperCase()];
          if (!price) return inst;
          const bid = Number(price.bid);
          const ask = Number(price.ask);
          if ((Number.isFinite(bid) && bid > 0) || (Number.isFinite(ask) && ask > 0)) {
            const bidN = Number.isFinite(bid) && bid > 0 ? bid : ask;
            const askN = Number.isFinite(ask) && ask > 0 ? ask : bidN;
            // Only create a new object when the price actually changed
            if (inst.bid === bidN && inst.ask === askN) return inst;
            changed = true;
            return {
              ...inst,
              bid: bidN,
              ask: askN,
              spread: price.spread != null && Number.isFinite(Number(price.spread))
                ? Number(price.spread)
                : Math.abs(askN - bidN),
            };
          }
          return inst;
        });
        return changed ? next : prev;
      });
    };

    // Subscribe to price updates via WebSocket - buffer into ref, flush throttled
    const unsubscribe = socketService.addPriceListener((prices) => {
      if (prices && Object.keys(prices).length > 0) {
        livePricesRef.current = { ...livePricesRef.current, ...prices };

        // Schedule a flush if one isn't already pending
        if (!priceFlushTimer.current) {
          priceFlushTimer.current = setTimeout(() => {
            priceFlushTimer.current = null;
            flushPrices();
          }, 500);
        }
      }
    });
    
    // Fetch admin spreads and news (these don't need WebSocket)
    fetchAdminSpreads();
    fetchMarketWatchNews();
    
    // Refresh news every 30 seconds
    const newsInterval = setInterval(fetchMarketWatchNews, 30000);
    
    // Check SL/TP every 2 seconds (like web app)
    const slTpInterval = setInterval(() => {
      checkSlTp();
    }, 2000);
    
    return () => {
      unsubscribe();
      if (priceFlushTimer.current) clearTimeout(priceFlushTimer.current);
      clearInterval(newsInterval);
      clearInterval(slTpInterval);
    };
  }, []);

  const fetchAdminSpreads = async () => {
    // TrustEdge doesn't have /charges/spreads endpoint - spreads are per-instrument
    setAdminSpreads({});
  };

  const fetchMarketWatchNews = async () => {
    // TrustEdge doesn't have /news/marketwatch endpoint
    setMarketWatchNews([]);
    setLoadingNews(false);
  };

  // Check SL/TP for all open trades
  // TrustEdge backend handles SL/TP server-side, no need to check from mobile
  const checkSlTp = async () => {
    try {
      // TrustEdge handles SL/TP server-side - just refresh open trades periodically
      if (!Array.isArray(openTrades) || openTrades.length === 0) return;
      return; // Skip - TrustEdge handles this
      const data = {};
      
      // Debug log
      if (data.closedCount > 0) {
        console.log(`[SL/TP] Response:`, JSON.stringify(data));
      }
      
      if (data.success && data.closedTrades && data.closedTrades.length > 0) {
        // Trades were closed by SL/TP - refresh trades
        console.log(`[SL/TP] ${data.closedTrades.length} trades closed - showing alerts`);
        fetchOpenTrades();
        fetchAccountSummary();
        
        // Get current selected account ID
        const currentAccountId = ctx.isChallengeMode 
          ? ctx.selectedChallengeAccount?._id 
          : ctx.selectedAccount?._id;
        
        // Show toast and alert only for trades belonging to the selected account
        data.closedTrades.forEach((closed) => {
          // Only show notification if trade belongs to currently selected account
          if (closed.tradingAccountId && closed.tradingAccountId !== currentAccountId) {
            console.log(`[Trade Close] Skipping notification - trade belongs to different account`);
            return;
          }
          
          const trigger = closed.trigger || closed.closedBy || closed.reason || 'Manual';
          const pnlValue = Number(closed.pnl || 0);
          const pnlText = pnlValue >= 0 ? `+$${pnlValue.toFixed(2)}` : `-$${Math.abs(pnlValue).toFixed(2)}`;
          console.log(`[Trade Close] Showing alert for ${closed.symbol} - ${trigger}`);
          
          // Determine alert title and message based on trigger type
          let alertTitle = '';
          let alertMessage = '';
          let toastType = closed.pnl >= 0 ? 'success' : 'warning';
          
          if (trigger === 'STOP_OUT') {
            alertTitle = '⚠️ Stop Out - Equity Zero';
            alertMessage = `All trades closed due to equity reaching zero.\n\n${closed.symbol}: ${pnlText}`;
            toastType = 'error';
          } else if (trigger === 'SL') {
            alertTitle = '🔴 Stop Loss Hit';
            alertMessage = `${closed.symbol} closed by Stop Loss.\n\nPnL: ${pnlText}`;
          } else if (trigger === 'TP') {
            alertTitle = '🟢 Take Profit Hit';
            alertMessage = `${closed.symbol} closed by Take Profit.\n\nPnL: ${pnlText}`;
          } else {
            alertTitle = `Trade Closed`;
            alertMessage = `${closed.symbol} closed. PnL: ${pnlText}`;
          }
          
          toast?.showToast(`${trigger}: ${closed.symbol} ${pnlText}`, toastType);
          Alert.alert(alertTitle, alertMessage);
        });
      }
    } catch (e) {
      console.log(`[SL/TP] Error:`, e.message);
    }
  };

  const loadUser = async () => {
    try {
      const userData = await SecureStore.getItemAsync('user');
      console.log('DEBUG: User data from SecureStore:', userData ? 'Found' : 'Not found');
      if (userData) {
        const parsedUser = JSON.parse(userData);
        console.log('DEBUG: Parsed user ID:', parsedUser?.id || parsedUser?._id);
        setUser(parsedUser);
      } else {
        console.log('DEBUG: No user data found in storage');
      }
    } catch (e) {
      console.error('Error loading user:', e);
    }
    setLoading(false);
  };

  const fetchAccounts = async (userId, forceSelectFirst = false) => {
    try {
      console.log('[TrustEdge] Fetching accounts from backend');
      const res = await authedFetch('/accounts');

      if (res.status === 401 || res.status === 403) {
        console.log('[TrustEdge] Token rejected even after silent re-login attempt');
        return;
      }

      const data = await res.json();
      console.log('[TrustEdge] Accounts response:', data);

      const rawList = data.items || data || [];
      const normalized = Array.isArray(rawList) ? rawList.map(normalizeTradingAccountRow) : [];
      // Show both demo and live in the picker (matches web)
      const accountsList = normalized;

      setAccounts(accountsList);
      
      if (accountsList.length > 0) {
        console.log('[TrustEdge] Accounts loaded (live-first):', accountsList.length);

        let accountToSelect = null;
        const savedAccountId = await SecureStore.getItemAsync('selectedAccountId');
        if (savedAccountId) {
          accountToSelect = accountsList.find(
            (a) => String(a.id || a._id) === String(savedAccountId)
          );
          if (accountToSelect) {
            console.log('[TrustEdge] Restoring saved account:', accountToSelect.account_number || accountToSelect.id);
          }
        }

        if (!accountToSelect) {
          accountToSelect = accountsList[0];
          console.log('[TrustEdge] Auto-selecting first account:', accountToSelect.account_number || accountToSelect.id);
        }

        setSelectedAccount(accountToSelect);
        const idToSave = accountToSelect.id || accountToSelect._id;
        if (idToSave) SecureStore.setItemAsync('selectedAccountId', idToSave);
      } else {
        console.log('[TrustEdge] No accounts available');
        setAccounts([]);
      }
    } catch (e) {
      console.error('Error fetching accounts:', e);
    }
  };

  const fetchOpenTrades = async () => {
    // Use challenge account if in challenge mode, otherwise regular account
    const accountId = isChallengeMode && selectedChallengeAccount 
      ? (selectedChallengeAccount.id || selectedChallengeAccount._id)
      : (selectedAccount?.id || selectedAccount?._id);
    if (!accountId) {
      console.log('[TrustEdge] No account ID for fetchOpenTrades');
      return;
    }
    try {
      console.log('[TrustEdge] Account ID for open trades:', accountId);
      const res = await authedFetch(`/positions/?account_id=${accountId}&status=open`);
      const data = await res.json();
      console.log('[TrustEdge] Open positions response:', data);
      // Map backend snake_case to camelCase expected by UI
      const rawList = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
      const mappedTrades = rawList.map(t => ({
        ...t,
        _id: t.id || t._id,
        side: (t.side || '').toUpperCase(),
        quantity: t.lots || t.quantity || 0,
        openPrice: t.open_price || t.openPrice || 0,
        currentPrice: t.current_price || t.currentPrice || 0,
        stopLoss: t.stop_loss || t.stopLoss || null,
        takeProfit: t.take_profit || t.takeProfit || null,
        sl: t.stop_loss || t.sl || null,
        tp: t.take_profit || t.tp || null,
        contractSize: t.contract_size || t.contractSize || 100000,
        marginUsed: t.margin_used || t.marginUsed || 0,
        commission: t.commission || 0,
        swap: t.swap || 0,
        profit: t.profit || 0,
      }));
      setOpenTrades(mappedTrades);
    } catch (e) {
      console.error('Error fetching open trades:', e);
    }
  };

  const fetchPendingOrders = async () => {
    // Use challenge account if in challenge mode, otherwise regular account
    const accountId = isChallengeMode && selectedChallengeAccount 
      ? (selectedChallengeAccount.id || selectedChallengeAccount._id)
      : (selectedAccount?.id || selectedAccount?._id);
    if (!accountId) {
      console.log('[TrustEdge] No account ID for fetchPendingOrders');
      return;
    }
    try {
      const res = await authedFetch(`/orders/?account_id=${accountId}&status=pending`);
      const data = await res.json();
      console.log('[TrustEdge] Pending orders response:', data);
      // Map backend snake_case to camelCase expected by UI
      const rawOrders = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
      const mappedOrders = rawOrders.map(o => ({
        ...o,
        _id: o.id || o._id,
        side: (o.side || '').toUpperCase(),
        quantity: o.lots || o.quantity || 0,
        orderType: o.order_type || o.orderType || 'limit',
        price: o.price || o.filled_price || 0,
        stopLoss: o.stop_loss || o.stopLoss || null,
        takeProfit: o.take_profit || o.takeProfit || null,
        sl: o.stop_loss || o.sl || null,
        tp: o.take_profit || o.tp || null,
      }));
      setPendingOrders(mappedOrders);
    } catch (e) {
      console.error('Error fetching pending orders:', e);
    }
  };

  const fetchTradeHistory = async () => {
    // Use challenge account if in challenge mode, otherwise regular account
    const accountId = isChallengeMode && selectedChallengeAccount 
      ? (selectedChallengeAccount.id || selectedChallengeAccount._id)
      : (selectedAccount?.id || selectedAccount?._id);
    if (!accountId) {
      console.log('[TrustEdge] No account ID for fetchTradeHistory');
      return;
    }
    try {
      // Use /portfolio/trades for proper trade history with close_price and profit
      const res = await authedFetch(`/portfolio/trades?account_id=${accountId}&per_page=200`);
      const data = await res.json();
      console.log('[TrustEdge] Trade history response:', data);
      
      // Backend returns { items: [...] } with snake_case fields
      // UI expects camelCase fields, so map them here
      const rawItems = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      const mappedHistory = rawItems.map(trade => ({
        _id: trade.id || trade._id,
        id: trade.id || trade._id,
        symbol: trade.symbol || '',
        side: (trade.side || '').toUpperCase(), // UI expects "BUY"/"SELL"
        quantity: trade.lots || trade.quantity || 0,
        lots: trade.lots || trade.quantity || 0,
        openPrice: trade.open_price || trade.openPrice || 0,
        open_price: trade.open_price || trade.openPrice || 0,
        closePrice: trade.close_price || trade.closePrice || 0,
        close_price: trade.close_price || trade.closePrice || 0,
        realizedPnl: trade.pnl || trade.profit || trade.realizedPnl || 0,
        pnl: trade.pnl || trade.profit || trade.realizedPnl || 0,
        profit: trade.pnl || trade.profit || 0,
        commission: trade.commission || 0,
        swap: trade.swap || 0,
        closedAt: trade.close_time || trade.closed_at || trade.closedAt || null,
        closed_at: trade.close_time || trade.closed_at || trade.closedAt || null,
        closedBy: trade.close_reason || trade.closedBy || 'manual',
        close_reason: trade.close_reason || trade.closedBy || 'manual',
        created_at: trade.opened_at || trade.created_at || null,
      }));
      
      setTradeHistory(mappedHistory);
    } catch (e) {
      console.error('Error fetching trade history:', e);
    }
  };

  const fetchAccountSummary = async () => {
    // For challenge accounts, use the account data directly
    if (isChallengeMode && selectedChallengeAccount) {
      setAccountSummary({
        balance: Number(selectedChallengeAccount.currentBalance || selectedChallengeAccount.balance || 0),
        equity: Number(selectedChallengeAccount.currentEquity || selectedChallengeAccount.currentBalance || 0),
        credit: Number(selectedChallengeAccount.credit || 0),
        usedMargin: 0,
        freeMargin: Number(selectedChallengeAccount.currentBalance || 0),
        floatingPnl: 0
      });
      return;
    }
    
    // For regular accounts, fetch from TrustEdge API
    const accountId = selectedAccount?.id || selectedAccount?._id;
    if (!accountId) {
      console.log('[TrustEdge] No account ID for fetchAccountSummary');
      return;
    }
    
    try {
      const res = await authedFetch(`/accounts/${accountId}/summary`);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.log('[TrustEdge] Account summary fetch failed:', res.status, errData?.detail || errData);
        return;
      }
      
      const data = await res.json();
      console.log('[TrustEdge] Account summary:', data);
      
      // Ensure all values are numbers to prevent toFixed crashes
      setAccountSummary({
        balance: Number(data.balance || 0),
        equity: Number(data.equity || 0),
        credit: Number(data.credit || 0),
        usedMargin: Number(data.margin_used || 0),
        freeMargin: Number(data.free_margin || 0),
        floatingPnl: Number(data.unrealized_pnl || 0)
      });
    } catch (e) {
      console.error('[TrustEdge] Error fetching account summary:', e);
      // Set safe defaults to prevent crashes
      setAccountSummary({
        balance: 0,
        equity: 0,
        credit: 0,
        usedMargin: 0,
        freeMargin: 0,
        floatingPnl: 0
      });
    }
  };

  const calculatePnl = (trade) => {
    if (!trade || !trade.symbol) return 0;
    const prices = livePrices[trade.symbol];
    if (!prices || !prices.bid) return 0;
    const side = (trade.side || '').toUpperCase();
    const currentPrice = side === 'BUY' ? prices.bid : prices.ask;
    if (!currentPrice) return 0;
    const openPrice = trade.openPrice || trade.open_price || 0;
    const quantity = trade.lots || trade.quantity || 0;
    const contractSize = trade.contract_size || trade.contractSize || 100000;
    const pnl = side === 'BUY'
      ? (currentPrice - openPrice) * quantity * contractSize
      : (openPrice - currentPrice) * quantity * contractSize;
    return pnl - (trade.commission || 0) - (trade.swap || 0);
  };

  // Use useMemo for real-time values to avoid infinite loops
  const realTimeValues = React.useMemo(() => {
    // Use challenge account balance when in challenge mode, fallback to accountSummary
    const activeAccount = isChallengeMode ? selectedChallengeAccount : selectedAccount;
    // Ensure all values are numbers to prevent toFixed crashes
    const balance = Number(accountSummary.balance || activeAccount?.balance || 0);
    const credit = Number(accountSummary.credit || activeAccount?.credit || 0);
    
    // Calculate today's realized PnL from closed trades
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const safeTradeHistory = Array.isArray(tradeHistory) ? tradeHistory : [];
    // tradeHistory contains only closed positions (fetched with status=closed)
    // Use closed_at if available, fallback to created_at for date filtering
    const todayClosedPnl = safeTradeHistory
      .filter(trade => {
        if (!trade) return false;
        const closedAt = new Date(trade.closed_at || trade.closedAt || trade.updated_at || trade.updatedAt || trade.created_at);
        return closedAt >= today;
      })
      .reduce((sum, trade) => sum + Number(trade.pnl || trade.profit || 0), 0);

    // Calculate real-time PnL from live prices
    let totalPnl = 0;
    let totalMargin = 0;

    const safeOpenTrades = Array.isArray(openTrades) ? openTrades : [];
    safeOpenTrades.forEach(trade => {
      if (!trade) return;
      totalPnl += calculatePnl(trade);
      totalMargin += Number(trade.marginUsed || trade.margin_used || 0);
    });

    const equity = Number(balance + credit + totalPnl);
    // Free Margin = Balance - Used Margin (not equity based)
    const freeMargin = Number(balance - totalMargin);
    
    // Calculate challenge-specific real-time values
    let realTimeDailyDD = 0;
    let realTimeOverallDD = 0;
    let realTimeProfit = 0;
    
    if (isChallengeMode && selectedChallengeAccount) {
      const initialBalance = Number(selectedChallengeAccount.initialBalance || selectedChallengeAccount.phaseStartBalance || 5000);
      const dayStartEquity = Number(selectedChallengeAccount.dayStartEquity || initialBalance);
      
      // Daily Drawdown = (dayStartEquity - currentEquity) / dayStartEquity * 100
      // Only count if equity dropped below day start
      const dailyLoss = Number(dayStartEquity - equity);
      realTimeDailyDD = dailyLoss > 0 ? Number((dailyLoss / dayStartEquity) * 100) : 0;
      
      // Overall Drawdown = (initialBalance - lowestEquity) / initialBalance * 100
      // Use current equity if it's lower than recorded lowest
      const lowestEquity = Math.min(Number(selectedChallengeAccount.lowestEquityOverall || initialBalance), Number(equity));
      const overallLoss = Number(initialBalance - lowestEquity);
      realTimeOverallDD = overallLoss > 0 ? Number((overallLoss / initialBalance) * 100) : 0;
      
      // Profit = (currentEquity - initialBalance) / initialBalance * 100
      realTimeProfit = Number(((Number(equity) - initialBalance) / initialBalance) * 100);
    }

    return {
      totalFloatingPnl: Math.round(totalPnl * 100) / 100,
      realTimeEquity: Math.round(equity * 100) / 100,
      realTimeFreeMargin: Math.round(freeMargin * 100) / 100,
      totalUsedMargin: Math.round(totalMargin * 100) / 100,
      todayPnl: Math.round((todayClosedPnl + totalPnl) * 100) / 100,
      realTimeDailyDD: Math.round(realTimeDailyDD * 100) / 100,
      realTimeOverallDD: Math.round(realTimeOverallDD * 100) / 100,
      realTimeProfit: Math.round(realTimeProfit * 100) / 100
    };
  }, [livePrices, openTrades, accountSummary, tradeHistory, isChallengeMode, selectedChallengeAccount, selectedAccount]);

  const { totalFloatingPnl, realTimeEquity, realTimeFreeMargin, totalUsedMargin, todayPnl, realTimeDailyDD, realTimeOverallDD, realTimeProfit } = realTimeValues;

  const logout = async () => {
    await SecureStore.deleteItemAsync('user');
    await SecureStore.deleteItemAsync('token');
    navigation.replace('Login');
  };

  const refreshAccounts = async () => {
    if (user) {
      await fetchAccounts(user.id);
      await fetchChallengeAccounts(user.id);
    }
  };

  // Get the active trading account ID (either regular or challenge)
  const getActiveTradingAccountId = () => {
    if (isChallengeMode && selectedChallengeAccount) {
      return selectedChallengeAccount.id;
    }
    return selectedAccount?.id;
  };

  // Get active account display info
  const getActiveAccountInfo = () => {
    if (isChallengeMode && selectedChallengeAccount) {
      return {
        accountId: selectedChallengeAccount.accountId,
        balance: selectedChallengeAccount.currentBalance || 0,
        equity: selectedChallengeAccount.currentEquity || 0,
        isChallenge: true,
        challengeName: selectedChallengeAccount.challengeId?.name || 'Challenge',
        status: selectedChallengeAccount.status
      };
    }
    return {
      accountId: selectedAccount?.accountId,
      balance: accountSummary?.balance || selectedAccount?.balance || 0,
      equity: realTimeEquity || accountSummary?.equity || 0,
      isChallenge: false
    };
  };

  return (
    <TradingContext.Provider value={{
      user, accounts, selectedAccount, setSelectedAccount,
      challengeAccounts, selectedChallengeAccount, setSelectedChallengeAccount,
      isChallengeMode, setIsChallengeMode,
      openTrades, pendingOrders, tradeHistory, instruments, livePrices, adminSpreads,
      loading, accountSummary, totalFloatingPnl, realTimeEquity, realTimeFreeMargin, todayPnl,
      realTimeDailyDD, realTimeOverallDD, realTimeProfit,
      fetchOpenTrades, fetchPendingOrders, fetchTradeHistory, fetchAccountSummary,
      refreshAccounts, calculatePnl, logout, setInstruments,
      marketWatchNews, loadingNews, fetchMarketWatchNews,
      getActiveTradingAccountId, getActiveAccountInfo,
      currentMainTab, setCurrentMainTab,
      navigation
    }}>
      {children}
    </TradingContext.Provider>
  );
};

/** Compact performance bars for copy-trader cards (no extra deps). */
const MiniSparkline = ({ seed, positive }) => {
  const s = typeof seed === 'string'
    ? seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
    : Number(seed) || 0;
  const bars = [];
  for (let i = 0; i < 14; i += 1) {
    bars.push(0.25 + 0.75 * Math.abs(Math.sin((s + i * 17) * 0.01)));
  }
  const max = Math.max(...bars, 0.001);
  const color = positive ? '#22c55e' : '#f97316';
  return (
    <View style={styles.sparklineRow}>
      {bars.map((v, i) => (
        <View
          key={i}
          style={[
            styles.sparklineBar,
            { height: Math.max(3, (v / max) * 26), backgroundColor: color },
          ]}
        />
      ))}
    </View>
  );
};

// HOME TAB — matches web mobile accounts view (top bar + tabs + accounts/transfer)
const HomeTab = ({ navigation }) => {
  const ctx = React.useContext(TradingContext);
  const { colors, isDark, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const parentNav = navigation.getParent();
  const [refreshing, setRefreshing] = useState(false);

  // Wallet balance + unread notification count (polled every 15s)
  const [walletBal, setWalletBal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);

  // Home tab state: 'accounts' or 'transfer'
  const [homeTab, setHomeTab] = useState('accounts');
  const [expandedAccountId, setExpandedAccountId] = useState(null);

  // Internal Transfer state
  const [transferFrom, setTransferFrom] = useState('wallet');
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  // Markets section (watchlist / gainers / losers)
  const [marketTab, setMarketTab] = useState('watchlist');
  const sessionOpenRef = useRef({});

  // Top-bar stock search
  const [searchQuery, setSearchQuery] = useState('');
  const searchResults = React.useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q) return [];
    const list = ctx.instruments || [];
    return list
      .filter((i) => {
        const sym = String(i.symbol || '').toUpperCase();
        const name = String(i.name || '').toUpperCase();
        return sym.includes(q) || name.includes(q);
      })
      .slice(0, 8);
  }, [searchQuery, ctx.instruments]);

  useEffect(() => {
    const lp = ctx.livePrices || {};
    Object.keys(lp).forEach((sym) => {
      if (sessionOpenRef.current[sym] != null) return;
      const row = lp[sym];
      const bid = row?.bid;
      const ask = row?.ask;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask || bid);
      if (mid > 0) sessionOpenRef.current[sym] = mid;
    });
  }, [ctx.livePrices]);

  const marketData = React.useMemo(() => {
    const instruments = ctx.instruments || [];
    const prices = ctx.livePrices || {};
    const withChanges = instruments
      .map((inst) => {
        if (!inst?.symbol) return null;
        const sym = inst.symbol;
        const p = prices[sym] || {};
        const bid = Number(p.bid ?? inst.bid ?? 0);
        const ask = Number(p.ask ?? inst.ask ?? 0);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask || bid || 0);
        if (!mid || mid <= 0) return null;
        let change = 0;
        const apiPct = p.change_percent ?? p.change_pct ?? p.pct_change ?? p.percent_change;
        if (apiPct != null && Number.isFinite(Number(apiPct))) {
          change = Number(apiPct);
        } else {
          const open = p.open ?? p.prev_close ?? p.day_open ?? sessionOpenRef.current[sym];
          if (open && Number(open) > 0) change = ((mid - Number(open)) / Number(open)) * 100;
        }
        return { ...inst, bid, ask, currentPrice: mid, change };
      })
      .filter(Boolean);

    if (marketTab === 'gainers') {
      return [...withChanges].filter((i) => i.change > 0).sort((a, b) => b.change - a.change).slice(0, 12);
    }
    if (marketTab === 'losers') {
      return [...withChanges].filter((i) => i.change < 0).sort((a, b) => a.change - b.change).slice(0, 12);
    }
    const watch = withChanges.filter((i) => i.starred);
    return (watch.length > 0 ? watch : withChanges).slice(0, 12);
  }, [ctx.instruments, ctx.livePrices, marketTab]);

  // Side drawer (tap logo to open, like web mobile "More" sidebar)
  const drawerWidth = Math.min(320, Dimensions.get('window').width * 0.82);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const drawerX = useRef(new Animated.Value(-drawerWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  const openDrawer = () => {
    setDrawerMounted(true);
    // next frame so the Modal is laid out before we animate
    requestAnimationFrame(() => {
      Animated.parallel([
        Animated.spring(drawerX, {
          toValue: 0,
          useNativeDriver: true,
          damping: 22,
          stiffness: 220,
          mass: 0.9,
          overshootClamping: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 220,
          useNativeDriver: true,
        }),
      ]).start();
    });
  };

  const closeDrawer = (cb) => {
    Animated.parallel([
      Animated.timing(drawerX, {
        toValue: -drawerWidth,
        duration: 240,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: 240,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) setDrawerMounted(false);
      if (cb) cb();
    });
  };

  const sideMenuItems = [
    { icon: 'grid-outline', label: 'Accounts', screen: 'Accounts' },
    { icon: 'card-outline', label: 'Deposit/Withdraw', screen: 'Wallet' },
    { icon: 'receipt-outline', label: 'Transactions', screen: 'TransactionHistory' },
    { icon: 'pie-chart-outline', label: 'Portfolio', screen: 'Portfolio' },
    { icon: 'bar-chart-outline', label: 'PAMM', screen: 'Pamm' },
    { icon: 'copy-outline', label: 'Copy Trading', screen: 'Social' },
    { icon: 'people-outline', label: 'Affiliates', screen: 'Business', params: { initialTab: 'ib' } },
    { icon: 'school-outline', label: 'inTrendFX Academy', screen: 'Academy' },
    { icon: 'newspaper-outline', label: 'Economic News', screen: 'EconomicCalendar' },
    { icon: 'calculator-outline', label: 'Risk Calculator', screen: 'RiskCalculator' },
    { icon: 'book-outline', label: 'Orders', screen: 'OrderBook' },
    { icon: 'person-outline', label: 'Profile', screen: 'Profile' },
    { icon: 'help-circle-outline', label: 'Support', screen: 'Support' },
  ];
  const openSideMenuItem = (item) => {
    closeDrawer(() => parentNav?.navigate(item.screen, item.params));
  };

  useEffect(() => {
    let mounted = true;

    const fetchAll = async () => {
      try {
        const token = await SecureStore.getItemAsync('token');
        if (!token || !mounted) return;
        const headers = { Authorization: `Bearer ${token}` };

        // Wallet + accounts + notifications in parallel
        const [wRes, aRes, nRes] = await Promise.all([
          fetch(`${API_URL}/wallet/summary`, { headers }),
          fetch(`${API_URL}/accounts`, { headers }),
          fetch(`${API_URL}/notifications?page=1&per_page=50`, { headers }),
        ]);

        if (!mounted) return;

        const wData = wRes.ok ? await wRes.json().catch(() => ({})) : {};
        const aData = aRes.ok ? await aRes.json().catch(() => ({})) : {};
        const nData = nRes.ok ? await nRes.json().catch(() => ({})) : {};

        console.log('[Wallet] summary response:', JSON.stringify(wData));

        // Try multiple field names from /wallet/summary
        let bal = wData.main_wallet_balance ?? wData.wallet_balance ?? wData.main_balance ?? wData.balance ?? wData.total;

        // If /wallet/summary didn't return balance, try /wallet/{userId}
        // API sometimes returns strings like "0" or "100.50" — coerce to Number
        if (bal == null || Number(bal) === 0 || Number.isNaN(Number(bal))) {
          try {
            const userData = await SecureStore.getItemAsync('user');
            if (userData) {
              const user = JSON.parse(userData);
              const userId = user._id || user.id;
              if (userId) {
                const wRes2 = await fetch(`${API_URL}/wallet/${userId}`, { headers });
                if (wRes2.ok) {
                  const wData2 = await wRes2.json().catch(() => ({}));
                  console.log('[Wallet] /wallet/:id response:', JSON.stringify(wData2));
                  const walletObj = wData2.wallet || wData2;
                  bal = walletObj.main_wallet_balance ?? walletObj.wallet_balance ?? walletObj.balance ?? bal;
                }
              }
            }
          } catch (_) {}
        }

        // Final fallback: derive from account totals
        if (bal == null || Number(bal) === 0 || Number.isNaN(Number(bal))) {
          const acctList = Array.isArray(aData.items) ? aData.items : (Array.isArray(aData) ? aData : []);
          const acctTotal = acctList.reduce((s, a) => s + Number(a?.balance || 0), 0);
          if (acctTotal > 0) bal = acctTotal;
        }
        if (mounted) setWalletBal(Math.max(0, Number(bal) || 0));

        const list = nData.items || nData.notifications || [];
        const count = Array.isArray(list)
          ? list.filter((n) => !(n.is_read || n.read)).length
          : 0;
        if (mounted) setUnreadCount(count);
      } catch (e) {
        console.error('[Wallet] fetchAll error:', e);
      }
    };

    fetchAll();
    const id = setInterval(fetchAll, 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Compute user initials for the avatar pill (cheap, inline)
  const u = ctx.user || {};
  const fn = (u.first_name || u.firstName || '').trim();
  const ln = (u.last_name || u.lastName || '').trim();
  const userInitials = (fn || ln)
    ? (((fn[0] || '') + (ln[0] || '')).toUpperCase() || '?')
    : ((u.email || '').trim().slice(0, 2).toUpperCase() || '?');

  const switchToAccount = async (account) => {
    if (!account) return;
    const aid = account.id || account._id;
    ctx.setSelectedAccount(account);
    try {
      await SecureStore.setItemAsync('selectedAccountId', aid);
    } catch (e) {}
    if (ctx.fetchAccountSummary) ctx.fetchAccountSummary();
    if (ctx.fetchOpenTrades) ctx.fetchOpenTrades();
  };

  // Refresh accounts when screen gains focus (e.g., after creating new account)
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (ctx.refreshAccounts) ctx.refreshAccounts();
    });
    return unsubscribe;
  }, [navigation, ctx.refreshAccounts]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      ctx.refreshAccounts && ctx.refreshAccounts(),
      ctx.fetchAccountSummary && ctx.fetchAccountSummary(),
    ]);
    setRefreshing(false);
  };

  // ── Live accounts + transfer helpers ──────────────────────────
  const liveAccounts = React.useMemo(
    () => (ctx.accounts || []).filter((a) => !isDemoTradingAccount(a)),
    [ctx.accounts]
  );

  const transferOptions = React.useMemo(() => {
    const opts = [
      { id: 'wallet', label: 'Main Wallet', sublabel: 'Wallet', balance: walletBal },
    ];
    for (const a of liveAccounts) {
      opts.push({
        id: a.id || a._id,
        label: `#${a.account_number || a.accountId || ''}`,
        sublabel: a.account_group?.name || a.accountTypeId?.name || 'Live',
        balance: Number(a.free_margin ?? a.balance ?? 0),
      });
    }
    return opts;
  }, [liveAccounts, walletBal]);

  useEffect(() => {
    if (!transferTo && transferOptions.length > 1) {
      setTransferTo(transferOptions[1].id);
    }
  }, [transferOptions, transferTo]);

  const transferFromBalance = React.useMemo(() => {
    const o = transferOptions.find((x) => x.id === transferFrom);
    return o ? o.balance : 0;
  }, [transferFrom, transferOptions]);

  const swapTransferDirection = () => {
    const prev = transferFrom;
    setTransferFrom(transferTo);
    setTransferTo(prev);
  };

  const submitTransfer = async () => {
    const amt = parseFloat(transferAmount);
    if (!amt || amt <= 0) { Alert.alert('Invalid amount', 'Enter a valid amount'); return; }
    if (transferFrom === transferTo) { Alert.alert('Invalid', 'Source and destination must differ'); return; }
    if (amt > transferFromBalance + 1e-9) { Alert.alert('Insufficient balance', 'Not enough funds to transfer'); return; }
    setTransferSubmitting(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      let path, body;
      if (transferFrom === 'wallet') {
        path = '/wallet/transfer-main-to-trading';
        body = { to_account_id: transferTo, amount: amt };
      } else if (transferTo === 'wallet') {
        path = '/wallet/transfer-trading-to-main';
        body = { from_account_id: transferFrom, amount: amt };
      } else {
        path = '/wallet/transfer-internal';
        body = { from_account_id: transferFrom, to_account_id: transferTo, amount: amt };
      }
      const res = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || data?.message || 'Transfer failed');
      Alert.alert('Success', `Transferred $${amt.toFixed(2)}`);
      setTransferAmount('');
      if (ctx.refreshAccounts) await ctx.refreshAccounts();
    } catch (e) {
      Alert.alert('Transfer failed', e?.message || 'Please try again');
    } finally {
      setTransferSubmitting(false);
    }
  };

  const accountDisplayLabel = (a) => {
    const n = String(a?.account_number || '');
    if (a?.is_demo) return 'Demo Account';
    if (n.startsWith('PM')) return 'PAMM Pool Account';
    if (n.startsWith('MM')) return 'MAM Pool Account';
    if (n.startsWith('CT')) return 'Copy Trade Pool Account';
    if (n.startsWith('CF')) return 'Copy Trade Account';
    if (n.startsWith('IF')) return 'Investment Account';
    return 'Live Account';
  };

  const fmtMoney = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (ctx.loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  const visibleAccounts = (ctx.accounts || []).filter((a) => a && (a.is_active !== false));

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgPrimary }}>
      {/* Top bar — Logo + Balance pill + Bell + Avatar (web mobile view) */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 14,
          paddingBottom: 12,
          backgroundColor: colors.bgPrimary,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* Logo — non-interactive */}
        <View style={{ padding: 4 }}>
          <Image
            source={require('../../assets/intrendfx-icon.png')}
            style={{ width: 48, height: 48, borderRadius: 10 }}
            resizeMode="contain"
          />
        </View>

        {/* Search bar (replaces wallet pill) */}
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            height: 38,
            borderRadius: 19,
            backgroundColor: colors.bgCard,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: 12,
            gap: 6,
          }}
        >
          <Ionicons name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search stocks"
            placeholderTextColor={colors.textMuted}
            style={{ flex: 1, color: colors.textPrimary, fontSize: 13, paddingVertical: 0 }}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Bell with badge */}
        <TouchableOpacity
          onPress={() => parentNav?.navigate('Notifications')}
          activeOpacity={0.75}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: colors.bgCard,
            borderWidth: 1,
            borderColor: colors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="notifications-outline" size={18} color={colors.textPrimary} />
          {unreadCount > 0 && (
            <View
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                minWidth: 18,
                height: 18,
                paddingHorizontal: 4,
                borderRadius: 9,
                backgroundColor: colors.error,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 2,
                borderColor: colors.bgPrimary,
              }}
            >
              <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>
                {unreadCount > 99 ? '99+' : unreadCount}
              </Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Avatar */}
        <TouchableOpacity
          onPress={() => parentNav?.navigate('Profile')}
          activeOpacity={0.75}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: colors.primary + '22',
            borderWidth: 1,
            borderColor: colors.primary + '55',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>{userInitials}</Text>
        </TouchableOpacity>
      </View>

      {/* Search results dropdown */}
      {searchQuery.trim().length > 0 && (
        <View
          style={{
            marginHorizontal: 14,
            marginTop: 6,
            borderRadius: 12,
            backgroundColor: colors.bgCard,
            borderWidth: 1,
            borderColor: colors.border,
            overflow: 'hidden',
            zIndex: 20,
          }}
        >
          {searchResults.length === 0 ? (
            <View style={{ padding: 14, alignItems: 'center' }}>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>No results</Text>
            </View>
          ) : (
            searchResults.map((item, idx) => (
              <TouchableOpacity
                key={item.symbol || idx}
                activeOpacity={0.7}
                onPress={() => {
                  setSearchQuery('');
                  navigation.navigate('Chart', { symbol: item.symbol });
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.textPrimary, fontSize: 14, fontWeight: '700' }}>{item.symbol}</Text>
                  {!!item.name && (
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      {item.name}
                    </Text>
                  )}
                </View>
                {!!item.category && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{item.category}</Text>
                )}
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      {/* Tabs: Accounts | Internal Transfer */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: colors.bgCard,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.border,
        }}
      >
        {[
          { id: 'accounts', label: 'Accounts' },
          { id: 'transfer', label: 'Internal Transfer' },
        ].map((t) => {
          const active = homeTab === t.id;
          return (
            <TouchableOpacity
              key={t.id}
              style={{ flex: 1, paddingVertical: 16, alignItems: 'center' }}
              onPress={() => setHomeTab(t.id)}
              activeOpacity={0.75}
            >
              <Text
                style={{
                  fontSize: 14,
                  color: active ? colors.primary : colors.textMuted,
                  fontWeight: active ? '800' : '600',
                }}
              >
                {t.label}
              </Text>
              {active && (
                <View
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    height: 3,
                    width: '40%',
                    backgroundColor: colors.primary,
                    borderTopLeftRadius: 3,
                    borderTopRightRadius: 3,
                  }}
                />
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {homeTab === 'accounts' && (
          <View
            style={{
              backgroundColor: colors.bgCard,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 18,
            }}
          >
            <Text style={{ fontSize: 20, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3 }}>
              Trading Accounts
            </Text>
            <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 4, marginBottom: 14 }}>
              Manage your trading accounts
            </Text>

            <TouchableOpacity
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 12,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: colors.primary,
                marginBottom: 14,
              }}
              onPress={() => parentNav?.navigate('Accounts', { action: 'open' })}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={18} color={colors.primary} />
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '800' }}>New Account</Text>
            </TouchableOpacity>

            {ctx.loading ? (
              <View style={{ alignItems: 'center', paddingVertical: 36, gap: 8 }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading accounts…</Text>
              </View>
            ) : visibleAccounts.length === 0 ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 12,
                  backgroundColor: colors.bgSecondary,
                  padding: 20,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center' }}>
                  You do not have a trading account yet. Open one to start.
                </Text>
              </View>
            ) : (
              visibleAccounts.map((row) => {
                const aid = row.id || row._id;
                const expanded = expandedAccountId === aid;
                const balance = Number(row.balance) || 0;
                const equity = Number(row.equity) || 0;
                const pnl = equity - balance;
                const pct = balance > 0 ? (equity / balance - 1) * 100 : 0;
                const pnlPos = pnl >= 0;
                const demo = isDemoTradingAccount(row);
                const idLabel = demo
                  ? `#D#${row.account_number || row.accountId || ''}`
                  : `#L#${row.account_number || row.accountId || ''}`;
                return (
                  <View
                    key={aid}
                    style={{
                      borderRadius: 14,
                      borderWidth: 1,
                      borderColor: expanded ? colors.primary + '80' : colors.border,
                      backgroundColor: colors.bgPrimary,
                      marginBottom: 10,
                      overflow: 'hidden',
                    }}
                  >
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => setExpandedAccountId(expanded ? null : aid)}
                      style={{ flexDirection: 'row', gap: 10, padding: 14, alignItems: 'flex-start' }}
                    >
                      <View
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 5,
                          marginTop: 8,
                          backgroundColor: demo ? '#38bdf8' : colors.primary,
                        }}
                      />
                      <View style={{ flex: 1 }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 8,
                            marginBottom: 10,
                          }}
                        >
                          <Text style={{ fontSize: 14, fontWeight: '800', color: colors.textPrimary }}>
                            {accountDisplayLabel(row)}
                          </Text>
                          <Text style={{ fontSize: 12, color: colors.textMuted, fontFamily: 'monospace' }}>
                            {idLabel}
                          </Text>
                        </View>

                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 }}>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.3, marginBottom: 2 }}>
                              Balance
                            </Text>
                            <Text style={{ fontSize: 15, fontWeight: '800', color: colors.textPrimary }}>
                              {fmtMoney(balance)}
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.3, marginBottom: 2 }}>
                              Equity
                            </Text>
                            <Text style={{ fontSize: 15, fontWeight: '800', color: colors.textPrimary }}>
                              {fmtMoney(equity)}
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.3, marginBottom: 2 }}>
                              P&amp;L
                            </Text>
                            <Text style={{ fontSize: 15, fontWeight: '800', color: pnlPos ? colors.primary : colors.error }}>
                              ~ {pnlPos ? '+' : ''}{fmtMoney(pnl)}
                            </Text>
                            <Text style={{ fontSize: 10, fontWeight: '700', marginTop: 1, color: pnlPos ? colors.primary + 'b0' : colors.error + 'b0' }}>
                              ({pnlPos ? '+' : ''}{pct.toFixed(2)}%)
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.3, marginBottom: 2 }}>
                              Leverage
                            </Text>
                            <Text style={{ fontSize: 15, fontWeight: '800', color: colors.textPrimary }}>
                              1:{String(row.leverage || '').replace(/^1:/, '') || '0'}
                            </Text>
                          </View>
                        </View>
                      </View>
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={20}
                        color={colors.textMuted}
                        style={{ marginTop: 4 }}
                      />
                    </TouchableOpacity>

                    {expanded && (
                      <View
                        style={{
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderTopColor: colors.border,
                          padding: 14,
                          gap: 14,
                        }}
                      >
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 }}>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, color: colors.textMuted, fontWeight: '600', marginBottom: 2 }}>
                              Free Margin
                            </Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>
                              {fmtMoney(row.free_margin)}
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, color: colors.textMuted, fontWeight: '600', marginBottom: 2 }}>
                              Margin Level
                            </Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>
                              {Number.isFinite(Number(row.margin_level)) && Number(row.margin_level) > 0
                                ? `${Number(row.margin_level).toFixed(2)}%`
                                : '0.00%'}
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, color: colors.textMuted, fontWeight: '600', marginBottom: 2 }}>
                              Currency
                            </Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>
                              {row.currency || 'USD'}
                            </Text>
                          </View>
                          <View style={{ width: '50%' }}>
                            <Text style={{ fontSize: 10, color: colors.textMuted, fontWeight: '600', marginBottom: 2 }}>
                              Type
                            </Text>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>
                              {row.account_group?.name || row.accountTypeId?.name || (demo ? 'Demo' : 'Live')}
                            </Text>
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          <TouchableOpacity
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 5,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              borderRadius: 8,
                              borderWidth: 1,
                              borderColor: colors.border,
                            }}
                            onPress={() =>
                              parentNav?.navigate('Portfolio', {
                                account_id: aid,
                                account_no: row.account_number,
                                tab: 'history',
                              })
                            }
                          >
                            <Ionicons name="book-outline" size={14} color={colors.textPrimary} />
                            <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>Journal</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 5,
                              paddingHorizontal: 14,
                              paddingVertical: 10,
                              borderRadius: 8,
                              backgroundColor: colors.primary,
                            }}
                            onPress={async () => {
                              await switchToAccount(row);
                              navigation.navigate('Chart');
                            }}
                          >
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>Trade</Text>
                            <Ionicons name="open-outline" size={13} color="#fff" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </View>
        )}

        {homeTab === 'accounts' && (
          <View style={{ marginTop: 16 }}>
            {/* Markets heading */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 }}>
              <Ionicons name="trending-up" size={22} color={colors.primary} />
              <Text style={{ fontSize: 20, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3 }}>
                Markets
              </Text>
            </View>

            {/* Pill tab row */}
            <View
              style={{
                flexDirection: 'row',
                backgroundColor: colors.bgCard,
                borderRadius: 14,
                padding: 6,
                marginBottom: 12,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              {[
                { id: 'watchlist', label: 'Watchlist', icon: null },
                { id: 'gainers', label: 'Gainers', icon: 'arrow-up', iconColor: colors.success },
                { id: 'losers', label: 'Losers', icon: 'arrow-down', iconColor: colors.error },
              ].map((t) => {
                const active = marketTab === t.id;
                return (
                  <TouchableOpacity
                    key={t.id}
                    activeOpacity={0.75}
                    onPress={() => setMarketTab(t.id)}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 10,
                      backgroundColor: active ? colors.primary : 'transparent',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 5,
                    }}
                  >
                    {t.icon && (
                      <Ionicons
                        name={t.icon}
                        size={14}
                        color={active ? '#fff' : t.iconColor}
                      />
                    )}
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: '800',
                        color: active ? '#fff' : colors.textPrimary,
                      }}
                    >
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Market list */}
            <View
              style={{
                backgroundColor: colors.bgCard,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                overflow: 'hidden',
              }}
            >
              {marketData.length === 0 ? (
                <View style={{ padding: 36, alignItems: 'center', gap: 6 }}>
                  <Ionicons
                    name={
                      marketTab === 'watchlist'
                        ? 'star-outline'
                        : marketTab === 'gainers'
                        ? 'trending-up'
                        : 'trending-down'
                    }
                    size={32}
                    color={colors.textMuted}
                  />
                  <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginTop: 4 }}>
                    {marketTab === 'watchlist'
                      ? 'No symbols in watchlist'
                      : `No ${marketTab} right now`}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                    Pull to refresh or check back shortly
                  </Text>
                </View>
              ) : (
                marketData.map((inst, idx) => {
                  const isPositive = inst.change >= 0;
                  const decimals = inst.category === 'Forex' ? 5 : 2;
                  return (
                    <TouchableOpacity
                      key={inst.symbol}
                      activeOpacity={0.75}
                      onPress={() => navigation.navigate('Chart', { symbol: inst.symbol })}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingVertical: 14,
                        paddingHorizontal: 16,
                        borderBottomWidth: idx < marketData.length - 1 ? StyleSheet.hairlineWidth : 0,
                        borderBottomColor: colors.border,
                      }}
                    >
                      <View style={{ flex: 1, marginRight: 12 }}>
                        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.2 }}>
                          {inst.symbol}
                        </Text>
                        <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }} numberOfLines={1}>
                          {inst.name || inst.category || ''}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        <Text style={{ fontSize: 16, fontWeight: '700', color: colors.textPrimary, fontVariant: ['tabular-nums'] }}>
                          {inst.ask ? Number(inst.ask).toFixed(decimals) : '…'}
                        </Text>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 3,
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                            borderRadius: 6,
                            backgroundColor: isPositive ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                          }}
                        >
                          <Ionicons
                            name={isPositive ? 'arrow-up' : 'arrow-down'}
                            size={11}
                            color={isPositive ? colors.success : colors.error}
                          />
                          <Text style={{ fontSize: 12, fontWeight: '800', color: isPositive ? colors.success : colors.error }}>
                            {Math.abs(Number(inst.change || 0)).toFixed(2)}%
                          </Text>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </View>
        )}

        {homeTab === 'transfer' && (
          <View
            style={{
              backgroundColor: colors.bgCard,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 18,
            }}
          >
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
              <View
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: colors.primary + '44',
                  backgroundColor: colors.primary + '18',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="swap-horizontal" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 20, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3 }}>
                  Internal Transfer
                </Text>
                <Text style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
                  Move funds between your main wallet and live trading accounts.
                </Text>
              </View>
            </View>

            {liveAccounts.length === 0 ? (
              <View
                style={{
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 12,
                  backgroundColor: colors.bgSecondary,
                  padding: 20,
                  alignItems: 'center',
                }}
              >
                <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center' }}>
                  No live trading accounts yet. Open one to transfer.
                </Text>
              </View>
            ) : (
              <>
                {/* FROM */}
                <Text style={{ fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.8, marginBottom: 8, marginTop: 4 }}>
                  FROM
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {transferOptions.map((o) => {
                    const active = transferFrom === o.id;
                    return (
                      <TouchableOpacity
                        key={o.id}
                        onPress={() => {
                          setTransferFrom(o.id);
                          if (transferTo === o.id) {
                            const alt = transferOptions.find((x) => x.id !== o.id);
                            if (alt) setTransferTo(alt.id);
                          }
                        }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: active ? colors.primary : colors.border,
                          backgroundColor: active ? colors.primary + '18' : colors.bgSecondary,
                        }}
                      >
                        <Ionicons
                          name={o.id === 'wallet' ? 'wallet' : 'briefcase'}
                          size={14}
                          color={active ? colors.primary : colors.textMuted}
                        />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? colors.primary : colors.textPrimary }}>
                          {o.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                {(() => {
                  const opt = transferOptions.find((x) => x.id === transferFrom);
                  if (!opt) return null;
                  const isWallet = opt.id === 'wallet';
                  return (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: 12,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: colors.primary + '55',
                        backgroundColor: colors.bgSecondary,
                        marginTop: 8,
                      }}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          backgroundColor: colors.primary + '18',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name={isWallet ? 'wallet' : 'briefcase'} size={18} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>{opt.label}</Text>
                        <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, marginTop: 2, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                          {opt.sublabel}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 15, fontWeight: '800', color: colors.primary }}>{fmtMoney(opt.balance)}</Text>
                    </View>
                  );
                })()}

                {/* SWAP */}
                <View style={{ alignItems: 'center', marginVertical: 10 }}>
                  <TouchableOpacity
                    onPress={swapTransferDirection}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      borderWidth: 1,
                      borderColor: colors.primary + '55',
                      backgroundColor: colors.bgSecondary,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="swap-vertical" size={18} color={colors.primary} />
                  </TouchableOpacity>
                </View>

                {/* TO */}
                <Text style={{ fontSize: 11, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.8, marginBottom: 8 }}>
                  TO
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {transferOptions.filter((o) => o.id !== transferFrom).map((o) => {
                    const active = transferTo === o.id;
                    return (
                      <TouchableOpacity
                        key={o.id}
                        onPress={() => setTransferTo(o.id)}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderColor: active ? colors.primary : colors.border,
                          backgroundColor: active ? colors.primary + '18' : colors.bgSecondary,
                        }}
                      >
                        <Ionicons
                          name={o.id === 'wallet' ? 'wallet' : 'briefcase'}
                          size={14}
                          color={active ? colors.primary : colors.textMuted}
                        />
                        <Text style={{ fontSize: 12, fontWeight: '700', color: active ? colors.primary : colors.textPrimary }}>
                          {o.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                {(() => {
                  const opt = transferOptions.find((x) => x.id === transferTo);
                  if (!opt) return null;
                  const isWallet = opt.id === 'wallet';
                  return (
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        padding: 12,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.bgSecondary,
                        marginTop: 8,
                      }}
                    >
                      <View
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 18,
                          backgroundColor: colors.primary + '18',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name={isWallet ? 'wallet' : 'briefcase'} size={18} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary }}>{opt.label}</Text>
                        <Text style={{ fontSize: 10, fontWeight: '600', color: colors.textMuted, marginTop: 2, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                          {opt.sublabel}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: colors.textPrimary }}>{fmtMoney(opt.balance)}</Text>
                    </View>
                  );
                })()}

                {/* AMOUNT */}
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                    paddingTop: 14,
                    marginTop: 14,
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>Amount</Text>
                  <TouchableOpacity
                    onPress={() => setTransferAmount(transferFromBalance > 0 ? transferFromBalance.toFixed(2) : '')}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>
                      Max: {fmtMoney(transferFromBalance)}
                    </Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  value={transferAmount}
                  onChangeText={setTransferAmount}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  style={{
                    borderWidth: 1,
                    borderColor: colors.border,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    fontSize: 16,
                    fontWeight: '700',
                    color: colors.textPrimary,
                    backgroundColor: colors.bgSecondary,
                  }}
                />

                <TouchableOpacity
                  onPress={submitTransfer}
                  disabled={
                    transferSubmitting ||
                    !transferAmount ||
                    transferFrom === transferTo ||
                    transferFromBalance <= 0
                  }
                  activeOpacity={0.85}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    paddingVertical: 14,
                    borderRadius: 12,
                    backgroundColor: colors.primary,
                    marginTop: 14,
                    opacity:
                      transferSubmitting ||
                      !transferAmount ||
                      transferFrom === transferTo ||
                      transferFromBalance <= 0
                        ? 0.5
                        : 1,
                  }}
                >
                  <Ionicons name="swap-horizontal" size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>
                    {transferSubmitting ? 'Transferring…' : 'Transfer'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* Side drawer — opens when user taps the logo (web mobile "More" sidebar) */}
      <Modal
        visible={drawerMounted}
        transparent
        animationType="none"
        statusBarTranslucent
        onRequestClose={() => closeDrawer()}
      >
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <Animated.View
            style={{
              width: drawerWidth,
              backgroundColor: colors.bgPrimary,
              paddingTop: insets.top + 10,
              transform: [{ translateX: drawerX }],
              shadowColor: '#000',
              shadowOffset: { width: 2, height: 0 },
              shadowOpacity: 0.25,
              shadowRadius: 12,
              elevation: 16,
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 18,
                paddingBottom: 16,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.border,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Image
                  source={require('../../assets/intrendfx-icon.png')}
                  style={{ width: 28, height: 28, borderRadius: 6 }}
                  resizeMode="contain"
                />
                <Text style={{ fontSize: 17, fontWeight: '800', letterSpacing: -0.3 }}>
                  <Text style={{ color: colors.textPrimary }}>inTrendFX</Text>
                  <Text style={{ color: colors.primary }}>FX</Text>
                </Text>
              </View>
              <TouchableOpacity onPress={() => closeDrawer()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6 }}>
              {sideMenuItems.map((item) => (
                <TouchableOpacity
                  key={item.screen + item.label}
                  onPress={() => openSideMenuItem(item)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 14,
                    paddingHorizontal: 18,
                    paddingVertical: 14,
                  }}
                >
                  <Ionicons name={item.icon} size={20} color={colors.primary} />
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.textPrimary }}>{item.label}</Text>
                </TouchableOpacity>
              ))}

              {/* Theme toggle */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 14,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                  marginTop: 6,
                }}
              >
                <Ionicons name={isDark ? 'moon' : 'sunny'} size={20} color={colors.primary} />
                <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary }}>
                  {isDark ? 'Dark Mode' : 'Light Mode'}
                </Text>
                <TouchableOpacity
                  onPress={() => toggleTheme && toggleTheme()}
                  style={{
                    width: 44,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor: isDark ? colors.primary : colors.border,
                    padding: 3,
                    alignItems: isDark ? 'flex-end' : 'flex-start',
                    justifyContent: 'center',
                  }}
                >
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' }} />
                </TouchableOpacity>
              </View>

              {/* Log Out */}
              <TouchableOpacity
                onPress={() => {
                  closeDrawer(() => { if (ctx.logout) ctx.logout(); });
                }}
                activeOpacity={0.7}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 14,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                }}
              >
                <Ionicons name="log-out-outline" size={20} color={colors.error} />
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.error }}>Log Out</Text>
              </TouchableOpacity>
            </ScrollView>

            {/* Help footer */}
            <View
              style={{
                padding: 16,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: colors.border,
                backgroundColor: colors.bgCard,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 }}>
                Need Help?
              </Text>
              <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 10 }}>
                Contact our 24/7 support team
              </Text>
              <TouchableOpacity
                onPress={() => openSideMenuItem({ screen: 'Support' })}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  paddingVertical: 10,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <Ionicons name="headset-outline" size={16} color={colors.textPrimary} />
                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textPrimary }}>Get Support</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>

          {/* Right overlay tap-out */}
          <Animated.View
            style={{
              flex: 1,
              backgroundColor: '#000',
              opacity: backdropOpacity.interpolate({ inputRange: [0, 1], outputRange: [0, 0.45] }),
            }}
          >
            <TouchableOpacity
              activeOpacity={1}
              onPress={() => closeDrawer()}
              style={{ flex: 1 }}
            />
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
};

// QUOTES TAB - Full Order Panel with all order types
const QuotesTab = ({ navigation }) => {
  const ctx = React.useContext(TradingContext);
  const { colors, isDark } = useTheme();
  const toast = useToast();
  const orderScrollRef = useRef(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('FAVOURITES');
  const [expandedSegment, setExpandedSegment] = useState(null);
  const categoryTabs = ['FAVOURITES', 'ALL', 'FOREX', 'CRYPTO', 'INDICES', 'METALS', 'COMMODITIES'];
  const categoryScrollRef = useRef(null);
  const [selectedInstrument, setSelectedInstrument] = useState(null);
  const [showOrderPanel, setShowOrderPanel] = useState(false);
  const [orderSide, setOrderSide] = useState('BUY');
  const [orderType, setOrderType] = useState('MARKET');
  const [pendingType, setPendingType] = useState('LIMIT');
  const [volume, setVolume] = useState(0.01);
  const [volumeText, setVolumeText] = useState('0.01');
  const [pendingPrice, setPendingPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [showQuickSlModal, setShowQuickSlModal] = useState(false);
  const [quickSlValue, setQuickSlValue] = useState('');
  const [pendingQuickTradeSide, setPendingQuickTradeSide] = useState(null);

  const [sessionStats, setSessionStats] = useState({});
  const prevBidRef = useRef({});
  const prevAskRef = useRef({});
  const [flashBid, setFlashBid] = useState({});
  const [flashAsk, setFlashAsk] = useState({});

  useEffect(() => {
    setSessionStats((prev) => {
      const next = { ...prev };
      for (const inst of ctx.instruments) {
        const s = inst.symbol;
        const lp = ctx.livePrices[s] || ctx.livePrices[String(s).toUpperCase()];
        const b = lp?.bid ?? inst.bid;
        if (b == null || !Number.isFinite(b) || b <= 0) continue;
        const cur = next[s];
        if (!cur) next[s] = { open: b, high: b, low: b };
        else next[s] = { ...cur, high: Math.max(cur.high, b), low: Math.min(cur.low, b) };
      }
      return next;
    });
  }, [ctx.livePrices, ctx.instruments]);

  useEffect(() => {
    const ub = {};
    const ua = {};
    for (const inst of ctx.instruments) {
      const s = inst.symbol;
      const lp = ctx.livePrices[s] || ctx.livePrices[String(s).toUpperCase()];
      const bid = lp?.bid ?? inst.bid;
      const ask = lp?.ask ?? inst.ask;
      if (bid != null && Number.isFinite(bid)) {
        const pb = prevBidRef.current[s];
        if (pb != null && bid !== pb) ub[s] = bid > pb ? 'up' : 'down';
        prevBidRef.current[s] = bid;
      }
      if (ask != null && Number.isFinite(ask)) {
        const pa = prevAskRef.current[s];
        if (pa != null && ask !== pa) ua[s] = ask > pa ? 'up' : 'down';
        prevAskRef.current[s] = ask;
      }
    }
    if (Object.keys(ub).length === 0 && Object.keys(ua).length === 0) return undefined;
    setFlashBid((f) => ({ ...f, ...ub }));
    setFlashAsk((f) => ({ ...f, ...ua }));
    const t = setTimeout(() => {
      setFlashBid((f) => {
        const n = { ...f };
        Object.keys(ub).forEach((k) => delete n[k]);
        return n;
      });
      setFlashAsk((f) => {
        const n = { ...f };
        Object.keys(ua).forEach((k) => delete n[k]);
        return n;
      });
    }, 220);
    return () => clearTimeout(t);
  }, [ctx.livePrices, ctx.instruments]);
  
  // Get leverage from account
  const getAccountLeverage = () => {
    if (ctx.isChallengeMode && ctx.selectedChallengeAccount) {
      return ctx.selectedChallengeAccount.leverage || '1:100';
    }
    return ctx.selectedAccount?.leverage || ctx.selectedAccount?.accountTypeId?.leverage || '1:100';
  };
  
  const segments = ['Forex', 'Metals', 'Commodities', 'Crypto', 'Indices', 'Stocks'];

  const openTradePanel = (instrument) => {
    setSelectedInstrument(instrument);
    setShowOrderPanel(true);
  };

  // Helper to get segment/category from symbol
  const getSymbolCategory = (symbol) => {
    if (['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'].includes(symbol)) return 'Metals';
    if (['USOIL', 'UKOIL', 'NGAS', 'COPPER', 'ALUMINUM', 'NICKEL'].includes(symbol)) return 'Commodities';
    const cryptoSymbols = ['BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD', 'DOGEUSD', 'TRXUSD', 'LINKUSD', 'MATICUSD', 'DOTUSD', 'SHIBUSD', 'LTCUSD', 'BCHUSD', 'AVAXUSD', 'XLMUSD', 'UNIUSD', 'ATOMUSD', 'ETCUSD', 'FILUSD', 'ICPUSD', 'VETUSD', 'NEARUSD', 'GRTUSD', 'AAVEUSD', 'MKRUSD', 'ALGOUSD', 'FTMUSD', 'SANDUSD', 'MANAUSD', 'AXSUSD', 'THETAUSD', 'XMRUSD', 'FLOWUSD', 'SNXUSD', 'EOSUSD', 'CHZUSD', 'ENJUSD', 'ZILUSD', 'BATUSD', 'CRVUSD', 'COMPUSD', 'SUSHIUSD', 'ZRXUSD', 'LRCUSD', 'ANKRUSD', 'GALAUSD', 'APEUSD', 'WAVESUSD', 'ZECUSD', 'PEPEUSD', 'ARBUSD', 'OPUSD', 'SUIUSD', 'APTUSD', 'INJUSD', 'LDOUSD', 'IMXUSD', 'RUNEUSD', 'KAVAUSD', 'KSMUSD', 'NEOUSD', 'QNTUSD', 'FETUSD', 'RNDRUSD', 'OCEANUSD', 'WLDUSD', 'SEIUSD', 'TIAUSD', 'BLURUSD', 'TONUSD', 'HBARUSD', '1INCHUSD', 'BONKUSD', 'FLOKIUSD', 'ORDIUSD'];
    if (cryptoSymbols.includes(symbol)) return 'Crypto';
    return 'Forex';
  };

  const executeTrade = async (overrideStopLoss = null, overrideSide = null) => {
    // Check if we have a valid account (either regular or challenge)
    const hasValidAccount = ctx.isChallengeMode 
      ? ctx.selectedChallengeAccount 
      : ctx.selectedAccount;
    
    if (!ctx.user) { toast?.showToast('Please login first', 'error'); return; }
    if (!hasValidAccount) { toast?.showToast('Please select a trading account first', 'error'); return; }
    if (!selectedInstrument) { toast?.showToast('Please select an instrument', 'error'); return; }
    if (isExecuting) return;
    
    // Use override values if provided, otherwise use state
    const effectiveStopLoss = overrideStopLoss || stopLoss;
    const effectiveSide = overrideSide || orderSide;
    
    // Client-side validation for challenge account SL mandatory rule
    if (ctx.isChallengeMode && ctx.selectedChallengeAccount) {
      const rules = ctx.selectedChallengeAccount.challengeId?.rules;
      if (rules?.stopLossMandatory && !effectiveStopLoss) {
        toast?.showToast('⚠️ Stop Loss is mandatory for this challenge', 'warning');
        return;
      }
    }
    
    const activeAccount = ctx.isChallengeMode ? ctx.selectedChallengeAccount : ctx.selectedAccount;
    console.log('DEBUG: Executing trade with account:', { 
      accountId: activeAccount?.accountId, 
      _id: activeAccount?._id,
      balance: activeAccount?.balance, 
      isChallengeMode: ctx.isChallengeMode
    });
    
    setIsExecuting(true);
    try {
      // Use prices from the selected instrument
      const bid = selectedInstrument.bid;
      const ask = selectedInstrument.ask;
      
      // Validate prices
      if (!bid || !ask || bid <= 0 || ask <= 0) {
        toast?.showToast('Market is closed or no price data available', 'error');
        setIsExecuting(false);
        return;
      }

      // Validate pending price for pending orders
      if (orderType === 'PENDING' && !pendingPrice) {
        toast?.showToast('Please enter a pending price', 'warning');
        setIsExecuting(false);
        return;
      }

      const segment = getSymbolCategory(selectedInstrument.symbol);
      
      // For pending orders, use entry price for bid/ask (matching web version)
      const finalBid = (orderType === 'PENDING' && pendingPrice) ? parseFloat(pendingPrice) : parseFloat(bid);
      const finalAsk = (orderType === 'PENDING' && pendingPrice) ? parseFloat(pendingPrice) : parseFloat(ask);
      
      // Build order data for TrustEdge backend
      // TrustEdge uses account.id (UUID) not _id
      const tradingAccountId = ctx.isChallengeMode && ctx.selectedChallengeAccount 
        ? (ctx.selectedChallengeAccount.id || ctx.selectedChallengeAccount._id)
        : (ctx.selectedAccount.id || ctx.selectedAccount._id);
      
      const orderData = {
        account_id: tradingAccountId,
        symbol: selectedInstrument.symbol,
        side: effectiveSide.toLowerCase(), // TrustEdge expects lowercase: "buy" or "sell"
        order_type: orderType === 'MARKET' ? 'market' : pendingType.toLowerCase(), // "market", "limit", or "stop"
        lots: parseFloat(volume) || 0.01,
      };
      
      // Add SL/TP if set (TrustEdge uses stop_loss and take_profit)
      if (effectiveStopLoss) orderData.stop_loss = parseFloat(effectiveStopLoss);
      if (takeProfit) orderData.take_profit = parseFloat(takeProfit);
      
      // Add price for limit/stop orders
      if (orderType === 'PENDING' && pendingPrice) {
        orderData.price = parseFloat(pendingPrice);
      }

      console.log('TrustEdge Trade order data:', JSON.stringify(orderData, null, 2));
      
      // Get token for authentication
      const token = await SecureStore.getItemAsync('token');
      
      const res = await fetch(`${API_URL}/orders/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(orderData)
      });
      const data = await res.json();
      console.log('TrustEdge Trade response:', res.status, JSON.stringify(data, null, 2));
      
      if (res.ok && data) {
        const isChallengeTradeMsg = data.isChallengeAccount ? ' (Challenge)' : '';
        toast?.showToast(`${effectiveSide} ${orderType === 'MARKET' ? 'Market' : pendingType} order placed!${isChallengeTradeMsg}`, 'success');
        setShowOrderPanel(false);
        setPendingPrice('');
        setStopLoss('');
        setTakeProfit('');
        ctx.fetchOpenTrades();
        ctx.fetchPendingOrders();
        ctx.fetchAccountSummary();
      } else {
        // TrustEdge backend uses 'detail' (FastAPI standard), fallback to 'message'
        const errMsg = data.detail || data.message || 'Failed to place order';
        console.error('Trade failed:', errMsg, data);
        if (data.code === 'DRAWDOWN_BREACH' || data.code === 'DAILY_DRAWDOWN_BREACH') {
          toast?.showToast(`⚠️ Challenge Failed: ${errMsg}`, 'error');
        } else if (data.code === 'MAX_LOTS_EXCEEDED' || data.code === 'MIN_LOTS_REQUIRED') {
          toast?.showToast(`⚠️ Lot Size Error: ${errMsg}`, 'warning');
        } else if (data.accountFailed) {
          toast?.showToast(`❌ Challenge Account Failed: ${data.failReason || errMsg}`, 'error');
        } else {
          toast?.showToast(errMsg, 'error');
        }
      }
    } catch (e) {
      console.error('Trade execution error:', e);
      toast?.showToast('Network error: ' + e.message, 'error');
    } finally {
      setIsExecuting(false);
    }
  };

  // Load saved favourites on mount
  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync('market_favourites');
        if (saved) {
          const favSymbols = JSON.parse(saved);
          ctx.setInstruments(prev => prev.map(i => ({
            ...i,
            starred: favSymbols.includes(i.symbol),
          })));
        }
      } catch (e) { /* ignore */ }
    })();
  }, []);

  const toggleStar = async (symbol) => {
    ctx.setInstruments(prev => {
      const updated = prev.map(i => 
        i.symbol === symbol ? { ...i, starred: !i.starred } : i
      );
      // Persist favourites
      const favSymbols = updated.filter(i => i.starred).map(i => i.symbol);
      SecureStore.setItemAsync('market_favourites', JSON.stringify(favSymbols)).catch(() => {});
      return updated;
    });
  };

  const getFilteredInstruments = () => {
    const term = searchTerm.toLowerCase().trim();
    let filtered = ctx.instruments;

    // Filter by category tab
    if (activeTab === 'FAVOURITES') {
      filtered = filtered.filter(i => i.starred);
    } else if (activeTab !== 'ALL') {
      filtered = filtered.filter(inst => {
        let instCategory = inst.category === 'Energy' ? 'Commodities' : inst.category;
        instCategory = normalizeInstrumentCategory(instCategory, inst.symbol);
        return instCategory.toUpperCase() === activeTab;
      });
    }

    // Filter by search
    if (term) {
      filtered = filtered.filter(inst =>
        inst.symbol.toLowerCase().includes(term) ||
        inst.name.toLowerCase().includes(term)
      );
    }

    return filtered;
  };

  const renderInstrumentItem = (item) => {
    if (!item?.symbol) return null;
    const sym = item.symbol;
    const liveTick = ctx.livePrices[sym] || ctx.livePrices[String(sym).toUpperCase()] || {};
    const bid = liveTick.bid ?? item.bid ?? 0;
    const ask = liveTick.ask ?? item.ask ?? 0;
    const spreadPipsText =
      ctx.adminSpreads[sym]?.spread > 0
        ? sym.includes('JPY')
          ? (ctx.adminSpreads[sym].spread * 100).toFixed(1)
          : bid > 100
            ? ctx.adminSpreads[sym].spread.toFixed(2)
            : (ctx.adminSpreads[sym].spread * 10000).toFixed(1)
        : bid && ask
          ? ((ask - bid) * (bid > 100 ? 1 : 10000)).toFixed(1)
          : '—';

    const accent = isDark ? '#50A5F1' : colors.primary;

    return (
      <Mt5QuoteRow
        key={sym}
        item={item}
        liveTick={liveTick}
        session={sessionStats[sym]}
        flashBid={flashBid[sym]}
        flashAsk={flashAsk[sym]}
        spreadPipsText={spreadPipsText}
        isDark={isDark}
        accentColor={accent}
        colors={colors}
        onPressRow={() => openTradePanel(item)}
        onToggleStar={() => toggleStar(sym)}
        onChart={() => navigation.navigate('Chart', { symbol: sym })}
      />
    );
  };

  const marketAccent = isDark ? '#50A5F1' : colors.primary;
  const searchBg = isDark ? 'rgba(255,255,255,0.06)' : colors.bgCard;
  const searchBorder = isDark ? 'rgba(255,255,255,0.1)' : colors.border;
  const searchIcon = isDark ? 'rgba(255,255,255,0.45)' : colors.textMuted;
  const tabInactiveText = isDark ? 'rgba(255,255,255,0.45)' : colors.textSecondary;

  const filteredInstruments = getFilteredInstruments();

  // Simplified instrument row matching screenshot style
  const renderMarketRow = (item) => {
    if (!item?.symbol) return null;
    const sym = item.symbol;
    const liveTick = ctx.livePrices[sym] || ctx.livePrices[String(sym).toUpperCase()] || {};
    const bid = liveTick.bid ?? item.bid ?? 0;

    // Category label
    let catLabel = item.category === 'Energy' ? 'Commodities' : item.category;
    catLabel = normalizeInstrumentCategory(catLabel, sym);
    const catDisplay = `${catLabel.toUpperCase()} – ${item.name || sym}`;

    // Pip change from session
    const sess = sessionStats[sym];
    const open = sess?.open;
    let pipChange = 0;
    let pipStr = '0 pip';
    let pipPositive = false;
    if (open != null && Number.isFinite(bid) && bid > 0 && open !== 0) {
      const digits = sym.includes('JPY') ? 3 : bid > 100 ? 2 : 5;
      const multiplier = sym.includes('JPY') ? 100 : bid > 100 ? 1 : 10000;
      pipChange = (bid - open) * multiplier;
      pipPositive = pipChange >= 0;
      pipStr = `${pipPositive ? '▲' : '▼'} ${Math.abs(pipChange).toFixed(1)} pip`;
    }

    const priceDigits = sym.includes('JPY') ? 3 : bid > 100 ? 2 : 5;

    return (
      <TouchableOpacity
        key={sym}
        style={[mktStyles.instrumentRow, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : colors.border }]}
        onPress={() => openTradePanel(item)}
        activeOpacity={0.7}
      >
        {/* Left: Symbol + Star + Category */}
        <View style={mktStyles.instrLeft}>
          <View style={mktStyles.instrSymbolRow}>
            <Text style={[mktStyles.instrSymbol, { color: colors.textPrimary }]}>{sym}</Text>
            <TouchableOpacity 
              onPress={(e) => { e?.stopPropagation?.(); toggleStar(sym); }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons 
                name={item.starred ? 'star' : 'star-outline'} 
                size={16} 
                color={item.starred ? '#f59e0b' : colors.textMuted} 
              />
            </TouchableOpacity>
          </View>
          <Text style={[mktStyles.instrCategory, { color: colors.textMuted }]} numberOfLines={1}>{catDisplay}</Text>
        </View>

        {/* Right: Price + Pip Change + Add */}
        <View style={mktStyles.instrRight}>
          <Text style={[mktStyles.instrPrice, { color: colors.textPrimary }]}>
            {bid > 0 ? bid.toFixed(priceDigits) : '—'}
          </Text>
          <Text style={[mktStyles.instrPip, { color: pipPositive ? '#22c55e' : '#ef4444' }]}>
            {pipStr}
          </Text>
        </View>
        <TouchableOpacity 
          onPress={() => navigation.navigate('Chart', { symbol: sym })}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          style={{ paddingLeft: 8 }}
        >
          <Ionicons name="trending-up" size={22} color={colors.textMuted} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Account Header */}
      <View style={[mktStyles.accountHeader, { backgroundColor: isDark ? '#0a0a0a' : colors.bgCard, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : colors.border }]}>
        <View style={mktStyles.accountHeaderContent}>
          <Text style={[mktStyles.accountLabel, { color: colors.textMuted }]}>ACCOUNT</Text>
          <TouchableOpacity onPress={() => setShowAccountPicker(true)} style={mktStyles.accountRow}>
            <Text style={[mktStyles.accountId, { color: colors.textPrimary }]}>
              {ctx.isChallengeMode
                ? (ctx.selectedChallengeAccount?.accountId || 'Select')
                : (ctx.selectedAccount?.accountId || ctx.selectedAccount?.accountNumber || 'Select')}
            </Text>
            <View style={[mktStyles.liveBadge, { backgroundColor: '#22c55e20' }]}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#22c55e', marginRight: 4 }} />
              <Text style={{ color: '#22c55e', fontSize: 11, fontWeight: '700' }}>LIVE</Text>
            </View>
            <View style={[mktStyles.centBadge, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#e8e8e8' }]}>
              <Text style={[mktStyles.centBadgeText, { color: colors.textPrimary }]}>Cent</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search Bar with Go button */}
      <View style={[mktStyles.searchRow, { backgroundColor: colors.bgPrimary }]}>
        <View style={[mktStyles.searchBox, { backgroundColor: searchBg, borderColor: searchBorder }]}>
          <Ionicons name="search" size={18} color={searchIcon} />
          <TextInput
            style={[mktStyles.searchInput, { color: colors.textPrimary }]}
            placeholder="Search symbols..."
            placeholderTextColor={colors.textMuted}
            value={searchTerm}
            onChangeText={setSearchTerm}
            returnKeyType="search"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          {searchTerm.length > 0 && (
            <TouchableOpacity onPress={() => setSearchTerm('')} style={{ padding: 4 }}>
              <Ionicons name="close-circle" size={18} color={searchIcon} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity 
          style={[mktStyles.goBtn, { backgroundColor: marketAccent }]}
          onPress={() => Keyboard.dismiss()}
        >
          <Text style={mktStyles.goBtnText}>Go</Text>
        </TouchableOpacity>
      </View>

      {/* Horizontal Category Tabs */}
      <ScrollView
        ref={categoryScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[mktStyles.categoryScroll, { backgroundColor: colors.bgPrimary }]}
        contentContainerStyle={mktStyles.categoryScrollContent}
      >
        {categoryTabs.map(tab => {
          const isActive = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={[mktStyles.categoryTab, isActive && { borderBottomColor: marketAccent, borderBottomWidth: 2 }]}
            >
              <Text style={[
                mktStyles.categoryTabText,
                { color: isActive ? marketAccent : tabInactiveText },
                isActive && { fontWeight: '700' },
              ]}>
                {tab === 'FAVOURITES' ? `★ ${tab}` : tab}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Instrument List */}
      <FlatList
        data={filteredInstruments}
        keyExtractor={item => item.symbol}
        renderItem={({ item }) => renderMarketRow(item)}
        style={{ flex: 1, backgroundColor: colors.bgPrimary }}
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyWatchlist}>
            <Ionicons name={activeTab === 'FAVOURITES' ? 'star-outline' : 'search-outline'} size={48} color={colors.textMuted} />
            <Text style={[styles.emptyWatchlistTitle, { color: colors.textPrimary }]}>
              {activeTab === 'FAVOURITES' ? 'No favourites yet' : 'No instruments found'}
            </Text>
            <Text style={[styles.emptyWatchlistText, { color: colors.textSecondary }]}>
              {activeTab === 'FAVOURITES' 
                ? 'Tap the ★ star icon on any instrument to add it to your favourites' 
                : 'Try a different search term or category'}
            </Text>
          </View>
        }
      />

      {/* Order Panel Slide Up - Full Order Types */}
      <Modal visible={showOrderPanel} animationType="slide" transparent>
        <KeyboardAvoidingView 
          style={styles.orderModalOverlay} 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <TouchableOpacity 
            style={styles.orderPanelBackdrop} 
            activeOpacity={1} 
            onPress={() => setShowOrderPanel(false)}
          />
          <ScrollView 
            ref={orderScrollRef}
            style={[styles.orderPanelScroll, { backgroundColor: colors.bgCard }]} 
            bounces={false}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.orderPanelContainer, { backgroundColor: colors.bgCard }]}>
              {/* Handle Bar */}
              <View style={[styles.orderPanelHandle, { backgroundColor: colors.border }]} />
              
              {/* Header */}
              <View style={styles.orderPanelHeaderRow}>
                <View>
                  <Text style={[styles.orderPanelSymbol, { color: colors.textPrimary }]}>{selectedInstrument?.symbol}</Text>
                  <Text style={[styles.orderPanelName, { color: colors.textMuted }]}>{selectedInstrument?.name}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <TouchableOpacity 
                    onPress={() => { setShowOrderPanel(false); navigation.navigate('Chart', { symbol: selectedInstrument?.symbol }); }}
                    style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#22c55e', justifyContent: 'center', alignItems: 'center' }}
                  >
                    <Ionicons name="trending-up" size={20} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setShowOrderPanel(false)} style={styles.orderCloseBtn}>
                    <Ionicons name="close" size={24} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Leverage Display (from account) */}
              <View style={[styles.leverageRow, { backgroundColor: colors.bgSecondary, borderColor: colors.border }]}>
                <Text style={[styles.leverageLabel, { color: colors.textMuted }]}>Leverage</Text>
                <Text style={[styles.leverageValue, { color: colors.textPrimary }]}>{getAccountLeverage()}</Text>
              </View>

              {/* One-Click Buy/Sell - Slim Buttons */}
              <View style={styles.quickTradeRow}>
                <TouchableOpacity 
                  style={[styles.quickSellBtn, isExecuting && styles.btnDisabled]}
                  onPress={() => { 
                    // Check if challenge mode with SL mandatory
                    if (ctx.isChallengeMode && ctx.selectedChallengeAccount?.challengeId?.rules?.stopLossMandatory) {
                      setPendingQuickTradeSide('SELL');
                      setQuickSlValue('');
                      setShowQuickSlModal(true);
                    } else {
                      setOrderSide('SELL');
                      setOrderType('MARKET');
                      executeTrade(null, 'SELL');
                    }
                  }}
                  disabled={isExecuting}
                >
                  <Text style={styles.quickBtnLabel}>SELL</Text>
                  <Text style={styles.quickBtnPrice}>
                    {selectedInstrument?.bid ? selectedInstrument.bid.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2) : '-'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.quickBuyBtn, isExecuting && styles.btnDisabled]}
                  onPress={() => { 
                    // Check if challenge mode with SL mandatory
                    if (ctx.isChallengeMode && ctx.selectedChallengeAccount?.challengeId?.rules?.stopLossMandatory) {
                      setPendingQuickTradeSide('BUY');
                      setQuickSlValue('');
                      setShowQuickSlModal(true);
                    } else {
                      setOrderSide('BUY');
                      setOrderType('MARKET');
                      executeTrade(null, 'BUY');
                    }
                  }}
                  disabled={isExecuting}
                >
                  <Text style={styles.quickBtnLabel}>BUY</Text>
                  <Text style={styles.quickBtnPrice}>
                    {selectedInstrument?.ask ? selectedInstrument.ask.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2) : '-'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Spread Info */}
              <View style={styles.spreadInfoRow}>
                <Text style={[styles.spreadInfoText, { color: colors.textMuted }]}>
                  Spread: {selectedInstrument?.bid ? 
                    ((selectedInstrument?.ask - selectedInstrument?.bid) * 
                    (selectedInstrument?.category === 'Forex' ? 10000 : 1)).toFixed(1) : '-'} pips
                </Text>
              </View>

              {/* SL Mandatory Warning for Challenge Accounts */}
              {ctx.isChallengeMode && ctx.selectedChallengeAccount?.challengeId?.rules?.stopLossMandatory && (
                <View style={styles.slMandatoryBanner}>
                  <Ionicons name="warning" size={16} color="#f59e0b" />
                  <Text style={styles.slMandatoryText}>Stop Loss is mandatory for this challenge account</Text>
                </View>
              )}

              {/* Order Type Toggle */}
              <View style={styles.orderTypeRow}>
                <TouchableOpacity 
                  style={[styles.orderTypeBtn, { backgroundColor: colors.bgSecondary }, orderType === 'MARKET' && styles.orderTypeBtnActive]}
                  onPress={() => setOrderType('MARKET')}
                >
                  <Text style={[styles.orderTypeBtnText, { color: colors.textMuted }, orderType === 'MARKET' && styles.orderTypeBtnTextActive]}>Market</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.orderTypeBtn, { backgroundColor: colors.bgSecondary }, orderType === 'PENDING' && styles.orderTypeBtnActive]}
                  onPress={() => setOrderType('PENDING')}
                >
                  <Text style={[styles.orderTypeBtnText, { color: colors.textMuted }, orderType === 'PENDING' && styles.orderTypeBtnTextActive]}>Pending</Text>
                </TouchableOpacity>
              </View>

              {/* Pending Order Types */}
              {orderType === 'PENDING' && (
                <View style={styles.pendingTypeRow}>
                  {['LIMIT', 'STOP'].map(type => (
                    <TouchableOpacity 
                      key={type}
                      style={[styles.pendingTypeBtn, { backgroundColor: colors.bgSecondary, borderColor: colors.border }, pendingType === type && styles.pendingTypeBtnActive]}
                      onPress={() => setPendingType(type)}
                    >
                      <Text style={[styles.pendingTypeText, { color: colors.textMuted }, pendingType === type && styles.pendingTypeTextActive]}>
                        {type === 'LIMIT' ? 'Limit' : 'Stop'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* Pending Price Input */}
              {orderType === 'PENDING' && (
                <View style={styles.inputSection}>
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>
                    {pendingType === 'LIMIT' ? 'Limit Price' : 'Stop Price'}
                  </Text>
                  <TextInput
                    style={[styles.priceInput, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                    value={pendingPrice}
                    onChangeText={setPendingPrice}
                    placeholder={ctx.livePrices[selectedInstrument?.symbol]?.bid?.toFixed(2) || '0.00'}
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                  />
                </View>
              )}

              {/* Volume Control */}
              <View style={styles.inputSection}>
                <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Volume (Lots)</Text>
                <View style={styles.volumeControlRow}>
                  <TouchableOpacity 
                    style={[styles.volumeControlBtn, { backgroundColor: colors.accent }]} 
                    onPress={() => {
                      const newVol = Math.max(0.01, volume - 0.01);
                      setVolume(newVol);
                      setVolumeText(newVol.toFixed(2));
                    }}
                  >
                    <Ionicons name="remove" size={18} color="#fff" />
                  </TouchableOpacity>
                  <TextInput
                    style={[styles.volumeInputField, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                    value={volumeText}
                    onChangeText={(text) => {
                      // Allow empty, numbers, and decimal point
                      if (text === '' || /^\d*\.?\d*$/.test(text)) {
                        setVolumeText(text);
                        // Update volume state in real-time for valid numbers
                        const val = parseFloat(text);
                        if (!isNaN(val) && val > 0) {
                          setVolume(val);
                        }
                      }
                    }}
                    onFocus={() => {
                      // Scroll to make input visible above keyboard
                      setTimeout(() => {
                        orderScrollRef.current?.scrollTo({ y: 200, animated: true });
                      }, 300);
                    }}
                    onBlur={() => {
                      const val = parseFloat(volumeText);
                      if (isNaN(val) || val <= 0) {
                        setVolumeText('0.01');
                        setVolume(0.01);
                      } else {
                        setVolume(val);
                        setVolumeText(val.toFixed(2));
                      }
                    }}
                    keyboardType="decimal-pad"
                    selectTextOnFocus={true}
                  />
                  <TouchableOpacity 
                    style={[styles.volumeControlBtn, { backgroundColor: colors.accent }]} 
                    onPress={() => {
                      const newVol = volume + 0.01;
                      setVolume(newVol);
                      setVolumeText(newVol.toFixed(2));
                    }}
                  >
                    <Ionicons name="add" size={18} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Stop Loss & Take Profit */}
              <View style={styles.slTpRow}>
                <View style={styles.slTpCol}>
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Stop Loss</Text>
                  <TextInput
                    style={[styles.slTpInputOrder, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                    value={stopLoss}
                    onChangeText={(text) => setStopLoss(text.replace(/[^0-9.]/g, ''))}
                    placeholder="Optional"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    selectionColor="#1a73e8"
                    onFocus={() => {
                      setTimeout(() => {
                        orderScrollRef.current?.scrollToEnd({ animated: true });
                      }, 300);
                    }}
                  />
                </View>
                <View style={styles.slTpCol}>
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Take Profit</Text>
                  <TextInput
                    style={[styles.slTpInputOrder, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                    value={takeProfit}
                    onChangeText={(text) => setTakeProfit(text.replace(/[^0-9.]/g, ''))}
                    placeholder="Optional"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                    selectionColor="#1a73e8"
                    onFocus={() => {
                      setTimeout(() => {
                        orderScrollRef.current?.scrollToEnd({ animated: true });
                      }, 300);
                    }}
                  />
                </View>
              </View>

              {/* Final Buy/Sell Buttons - Slim */}
              <View style={styles.finalTradeRow}>
                <TouchableOpacity 
                  style={[styles.finalSellBtn, isExecuting && styles.btnDisabled]}
                  onPress={() => executeTrade(null, 'SELL')}
                  disabled={isExecuting}
                >
                  <Text style={styles.finalBtnText}>
                    {isExecuting ? 'EXECUTING...' : orderType === 'PENDING' ? `SELL ${pendingType}` : 'SELL'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[styles.finalBuyBtn, isExecuting && styles.btnDisabled]}
                  onPress={() => executeTrade(null, 'BUY')}
                  disabled={isExecuting}
                >
                  <Text style={styles.finalBtnText}>
                    {isExecuting ? 'EXECUTING...' : orderType === 'PENDING' ? `BUY ${pendingType}` : 'BUY'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Account Picker Modal */}
      <Modal visible={showAccountPicker} animationType="slide" transparent onRequestClose={() => setShowAccountPicker(false)}>
        <View style={styles.accountPickerOverlay}>
          <TouchableOpacity style={styles.accountPickerBackdrop} onPress={() => setShowAccountPicker(false)} />
          <View style={[styles.accountPickerContent, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.accountPickerHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.accountPickerTitle, { color: colors.textPrimary }]}>Select Account</Text>
              <TouchableOpacity onPress={() => setShowAccountPicker(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.accountPickerList}>
              {/* Regular Accounts Section */}
              {ctx.accounts && ctx.accounts.length > 0 && (
                <>
                  <Text style={[styles.accountPickerSectionTitle, { color: colors.textMuted }]}>Trading Accounts</Text>
                  {ctx.accounts.map(account => (
                    <TouchableOpacity 
                      key={account._id}
                      style={[styles.accountPickerItem, { backgroundColor: colors.bgCard, borderBottomColor: colors.border }, !ctx.isChallengeMode && ctx.selectedAccount?._id === account._id && styles.accountPickerItemActive]}
                      onPress={() => { 
                        ctx.setIsChallengeMode(false);
                        ctx.setSelectedAccount(account); 
                        setShowAccountPicker(false); 
                      }}
                    >
                      <View style={styles.accountPickerItemLeft}>
                        <View style={[styles.accountPickerIcon, { backgroundColor: colors.bgSecondary }, !ctx.isChallengeMode && ctx.selectedAccount?._id === account._id && styles.accountPickerIconActive]}>
                          <Ionicons name="wallet" size={20} color={!ctx.isChallengeMode && ctx.selectedAccount?._id === account._id ? colors.accent : colors.textMuted} />
                        </View>
                        <View>
                          <Text style={[styles.accountPickerNumber, { color: colors.textPrimary }]}>{account.accountId || account.accountNumber}</Text>
                          <Text style={[styles.accountPickerType, { color: colors.textMuted }]}>{account.accountTypeId?.name || account.accountType || 'Standard'} • {account.leverage}</Text>
                        </View>
                      </View>
                      <View style={styles.accountPickerItemRight}>
                        <Text style={[styles.accountPickerBalance, { color: colors.textPrimary }]}>${(account.balance || 0).toFixed(2)}</Text>
                        {!ctx.isChallengeMode && (ctx.selectedAccount?.id === account.id || ctx.selectedAccount?._id === account._id) && (
                          <Ionicons name="checkmark-circle" size={20} color={colors.accent} />
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {/* Challenge Accounts Section */}
              {ctx.challengeAccounts && ctx.challengeAccounts.length > 0 && (
                <>
                  <Text style={[styles.accountPickerSectionTitle, { color: colors.textMuted, marginTop: 16 }]}>Challenge Accounts</Text>
                  {ctx.challengeAccounts.filter(acc => acc.status === 'ACTIVE').map(account => (
                    <TouchableOpacity 
                      key={account._id}
                      style={[styles.accountPickerItem, { backgroundColor: colors.bgCard, borderBottomColor: colors.border, borderLeftWidth: 3, borderLeftColor: '#1a73e8' }, ctx.isChallengeMode && ctx.selectedChallengeAccount?._id === account._id && styles.accountPickerItemActive]}
                      onPress={() => { 
                        ctx.setIsChallengeMode(true);
                        ctx.setSelectedChallengeAccount(account); 
                        setShowAccountPicker(false); 
                      }}
                    >
                      <View style={styles.accountPickerItemLeft}>
                        <View style={[styles.accountPickerIcon, { backgroundColor: '#1a73e820' }, ctx.isChallengeMode && ctx.selectedChallengeAccount?._id === account._id && { backgroundColor: '#1a73e840' }]}>
                          <Ionicons name="trophy" size={20} color="#1a73e8" />
                        </View>
                        <View>
                          <Text style={[styles.accountPickerNumber, { color: colors.textPrimary }]}>{account.accountId}</Text>
                          <Text style={[styles.accountPickerType, { color: colors.textMuted }]}>{account.challengeId?.name || 'Challenge'} • Step {account.currentStep || 1}</Text>
                        </View>
                      </View>
                      <View style={styles.accountPickerItemRight}>
                        <Text style={[styles.accountPickerBalance, { color: colors.textPrimary }]}>${(account.currentBalance || account.balance || 0).toFixed(2)}</Text>
                        {ctx.isChallengeMode && (ctx.selectedChallengeAccount?.id === account.id || ctx.selectedChallengeAccount?._id === account._id) && (
                          <Ionicons name="checkmark-circle" size={20} color="#1a73e8" />
                        )}
                      </View>
                    </TouchableOpacity>
                  ))}
                </>
              )}

              {/* No accounts message */}
              {(!ctx.accounts || ctx.accounts.length === 0) && (!ctx.challengeAccounts || ctx.challengeAccounts.length === 0) && (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Ionicons name="wallet-outline" size={48} color={colors.textMuted} />
                  <Text style={{ color: colors.textMuted, marginTop: 10 }}>No accounts available</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 5 }}>Please create an account first</Text>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Quick Stop Loss Modal for Challenge Accounts */}
      <Modal visible={showQuickSlModal} animationType="fade" transparent onRequestClose={() => setShowQuickSlModal(false)}>
        <View style={styles.quickSlModalOverlay}>
          <View style={[styles.quickSlModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={styles.quickSlModalHeader}>
              <Ionicons name="warning" size={24} color="#f59e0b" />
              <Text style={[styles.quickSlModalTitle, { color: colors.textPrimary }]}>Stop Loss Required</Text>
            </View>
            <Text style={[styles.quickSlModalSubtitle, { color: colors.textMuted }]}>
              Stop Loss is mandatory for challenge accounts. Please set a stop loss price before placing your trade.
            </Text>
            
            <View style={styles.quickSlInputContainer}>
              <Text style={[styles.quickSlInputLabel, { color: colors.textMuted }]}>Stop Loss Price</Text>
              <TextInput
                style={[styles.quickSlInput, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                value={quickSlValue}
                onChangeText={(text) => setQuickSlValue(text.replace(/[^0-9.]/g, ''))}
                placeholder={`e.g. ${pendingQuickTradeSide === 'BUY' 
                  ? (ctx.livePrices[selectedInstrument?.symbol]?.bid * 0.99)?.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2) 
                  : (ctx.livePrices[selectedInstrument?.symbol]?.ask * 1.01)?.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2)}`}
                placeholderTextColor={colors.textMuted}
                keyboardType="numbers-and-punctuation"
              />
              <Text style={[styles.quickSlHint, { color: colors.textMuted }]}>
                Current {pendingQuickTradeSide === 'BUY' ? 'Bid' : 'Ask'}: {pendingQuickTradeSide === 'BUY' 
                  ? ctx.livePrices[selectedInstrument?.symbol]?.bid?.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2) 
                  : ctx.livePrices[selectedInstrument?.symbol]?.ask?.toFixed(selectedInstrument?.category === 'Forex' ? 5 : 2)}
              </Text>
            </View>

            <View style={styles.quickSlModalButtons}>
              <TouchableOpacity 
                style={[styles.quickSlCancelBtn, { backgroundColor: colors.bgSecondary }]}
                onPress={() => {
                  setShowQuickSlModal(false);
                  setPendingQuickTradeSide(null);
                  setQuickSlValue('');
                }}
              >
                <Text style={[styles.quickSlCancelBtnText, { color: colors.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickSlConfirmBtn, { backgroundColor: pendingQuickTradeSide === 'BUY' ? '#22c55e' : '#ef4444' }]}
                onPress={() => {
                  if (!quickSlValue || isNaN(parseFloat(quickSlValue))) {
                    toast?.showToast('Please enter a valid stop loss price', 'warning');
                    return;
                  }
                  const slValue = quickSlValue;
                  const tradeSide = pendingQuickTradeSide;
                  setStopLoss(slValue);
                  setOrderSide(tradeSide);
                  setOrderType('MARKET');
                  setShowQuickSlModal(false);
                  setPendingQuickTradeSide(null);
                  setQuickSlValue('');
                  // Execute trade with SL and side passed directly (avoid async state issues)
                  setTimeout(() => executeTrade(slValue, tradeSide), 100);
                }}
              >
                <Text style={styles.quickSlConfirmBtnText}>
                  {pendingQuickTradeSide === 'BUY' ? 'BUY' : 'SELL'} with SL
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

// TRADE TAB - Account summary + Positions/Pending/History (like mobile web view)
const TradeTab = () => {
  const ctx = React.useContext(TradingContext);
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [tradeTab, setTradeTab] = useState('positions');
  const [refreshing, setRefreshing] = useState(false);
  const [showSlTpModal, setShowSlTpModal] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [closingTradeId, setClosingTradeId] = useState(null);
  const [showCloseAllModal, setShowCloseAllModal] = useState(false);
  const [closeAllType, setCloseAllType] = useState('all');
  const [isClosingAll, setIsClosingAll] = useState(false);
  const [showKillSwitch, setShowKillSwitch] = useState(false);
  const [isKillSwitchActive, setIsKillSwitchActive] = useState(false);
  const [showTradeDetails, setShowTradeDetails] = useState(false);
  const [detailTrade, setDetailTrade] = useState(null);
  const [showHistoryDetails, setShowHistoryDetails] = useState(false);
  const [historyDetailTrade, setHistoryDetailTrade] = useState(null);
  const [showPartialClose, setShowPartialClose] = useState(false);
  const [partialCloseTrade, setPartialCloseTrade] = useState(null);
  const [partialPercent, setPartialPercent] = useState(100);
  
  // History filter states
  const [historyFilter, setHistoryFilter] = useState('all');

  const totalUsedMargin = (Array.isArray(ctx.openTrades) ? ctx.openTrades : []).reduce((sum, trade) => sum + (trade.marginUsed || 0), 0);
  
  // Filter trade history based on selected filter
  const getFilteredHistory = () => {
    const now = new Date();
    return (Array.isArray(ctx.tradeHistory) ? ctx.tradeHistory : []).filter(trade => {
      const tradeDate = new Date(trade.closedAt);
      if (historyFilter === 'all') return true;
      if (historyFilter === 'today') {
        return tradeDate.toDateString() === now.toDateString();
      }
      if (historyFilter === 'week') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return tradeDate >= weekAgo;
      }
      if (historyFilter === 'month') {
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return tradeDate >= monthAgo;
      }
      if (historyFilter === 'year') {
        const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        return tradeDate >= yearAgo;
      }
      return true;
    });
  };

  // Calculate total P&L for filtered history
  const getHistoryTotalPnl = () => {
    return getFilteredHistory().reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  };

  // Calculate PnL for a trade
  const calculatePnl = (trade) => {
    const prices = ctx.livePrices[trade.symbol];
    if (!prices?.bid || !prices?.ask) return 0;
    const currentPrice = trade.side === 'BUY' ? prices.bid : prices.ask;
    return trade.side === 'BUY'
      ? (currentPrice - trade.openPrice) * trade.quantity * trade.contractSize
      : (trade.openPrice - currentPrice) * trade.quantity * trade.contractSize;
  };

  // Open partial close modal
  const openPartialCloseModal = (trade) => {
    setPartialCloseTrade(trade);
    setPartialPercent(100);
    setShowPartialClose(true);
  };

  // Close single trade (full or partial)
  const closeTrade = async (trade, closeLots = null) => {
    if (closingTradeId) return;
    const prices = ctx.livePrices[trade.symbol];
    if (!prices?.bid || !prices?.ask) {
      toast?.showToast('No price data available', 'error');
      return;
    }
    
    setClosingTradeId(trade.id || trade._id);
    try {
      const token = await SecureStore.getItemAsync('token');
      const positionId = trade.id || trade._id;
      const body = closeLots ? { lots: closeLots } : {};
      
      const res = await fetch(`${API_URL}/positions/${positionId}/close`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      console.log('[TrustEdge] Close position response:', data);
      
      if (res.ok) {
        const pnl = data.profit || 0;
        const label = closeLots ? `Partial close (${closeLots} lots)` : 'Closed';
        toast?.showToast(`${label}! P/L: $${pnl.toFixed(2)}`, pnl >= 0 ? 'success' : 'warning');
        ctx.fetchOpenTrades();
        ctx.fetchTradeHistory();
        ctx.fetchAccountSummary();
      } else {
        toast?.showToast(data.detail || data.message || 'Failed to close', 'error');
      }
    } catch (e) {
      console.error('Close trade error:', e);
      toast?.showToast('Failed to close trade', 'error');
    } finally {
      setClosingTradeId(null);
    }
  };

  // Confirm partial close from modal
  const confirmPartialClose = () => {
    if (!partialCloseTrade) return;
    const totalLots = partialCloseTrade.quantity || partialCloseTrade.lots || 0;
    const closeLots = partialPercent === 100 ? null : parseFloat((totalLots * partialPercent / 100).toFixed(2));
    setShowPartialClose(false);
    closeTrade(partialCloseTrade, closeLots);
  };

  // Close all trades (all, profit, or loss)
  const closeAllTrades = async (type) => {
    setCloseAllType(type);
    setShowCloseAllModal(true);
  };

  const confirmCloseAll = async () => {
    setIsClosingAll(true);
    const safeOpenTrades = Array.isArray(ctx.openTrades) ? ctx.openTrades : [];
    const tradesToClose = safeOpenTrades.filter(trade => {
      if (!trade) return false;
      const pnl = calculatePnl(trade);
      if (closeAllType === 'profit') return pnl > 0;
      if (closeAllType === 'loss') return pnl < 0;
      return true;
    });

    let closedCount = 0;
    const token = await SecureStore.getItemAsync('token');
    for (const trade of tradesToClose) {
      try {
        const positionId = trade.id || trade._id;
        const res = await fetch(`${API_URL}/positions/${positionId}/close`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });
        if (res.ok) closedCount++;
      } catch (e) {
        console.error('Close trade error:', e);
      }
    }

    setShowCloseAllModal(false);
    setIsClosingAll(false);
    toast?.showToast(`Closed ${closedCount} trade(s)`, 'success');
    ctx.fetchOpenTrades();
    ctx.fetchTradeHistory();
    ctx.fetchAccountSummary();
  };

  // Kill Switch - Close all trades and cancel all pending orders
  const executeKillSwitch = async () => {
    setIsKillSwitchActive(true);
    let closedTrades = 0;
    let cancelledOrders = 0;

    // Close all open trades via TrustEdge
    const token = await SecureStore.getItemAsync('token');
    const safeOpenTrades = Array.isArray(ctx.openTrades) ? ctx.openTrades : [];
    for (const trade of safeOpenTrades) {
      try {
        const positionId = trade.id || trade._id;
        const res = await fetch(`${API_URL}/positions/${positionId}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) closedTrades++;
      } catch (e) {
        console.error('Kill switch close error:', e);
      }
    }

    // Cancel all pending orders via TrustEdge
    const safePendingOrders = Array.isArray(ctx.pendingOrders) ? ctx.pendingOrders : [];
    for (const order of safePendingOrders) {
      try {
        const orderId = order.id || order._id;
        const res = await fetch(`${API_URL}/orders/${orderId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        if (res.ok) cancelledOrders++;
      } catch (e) {
        console.error('Kill switch cancel error:', e);
      }
    }

    setShowKillSwitch(false);
    setIsKillSwitchActive(false);
    toast?.showToast(`Kill Switch: Closed ${closedTrades} trades, cancelled ${cancelledOrders} orders`, 'warning');
    ctx.fetchOpenTrades();
    ctx.fetchPendingOrders();
    ctx.fetchTradeHistory();
    ctx.fetchAccountSummary();
  };

  const openSlTpModal = (trade) => {
    setSelectedTrade(trade);
    // Check both sl/stopLoss and tp/takeProfit fields for compatibility (like web app)
    setStopLoss((trade.sl || trade.stopLoss || trade.stop_loss)?.toString() || '');
    setTakeProfit((trade.tp || trade.takeProfit || trade.take_profit)?.toString() || '');
    setShowSlTpModal(true);
  };

  const updateSlTp = async () => {
    if (!selectedTrade) return;
    try {
      const slValue = stopLoss && stopLoss.trim() !== '' ? parseFloat(stopLoss) : null;
      const tpValue = takeProfit && takeProfit.trim() !== '' ? parseFloat(takeProfit) : null;
      
      const positionId = selectedTrade.id || selectedTrade._id;
      console.log('Updating SL/TP:', { positionId, stop_loss: slValue, take_profit: tpValue });
      
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/positions/${positionId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          stop_loss: slValue,
          take_profit: tpValue
        })
      });
      const data = await res.json();
      console.log('[TrustEdge] SL/TP update response:', data);

      if (res.ok) {
        toast?.showToast('SL/TP updated successfully', 'success');
        setShowSlTpModal(false);
        setSelectedTrade(null);
        ctx.fetchOpenTrades();
      } else {
        toast?.showToast(data.detail || data.message || 'Failed to update SL/TP', 'error');
      }
    } catch (e) {
      console.error('Update SL/TP error:', e);
      toast?.showToast('Network error', 'error');
    }
  };

  // Cancel pending order
  const [cancellingOrderId, setCancellingOrderId] = useState(null);
  const cancelPendingOrder = async (order) => {
    if (cancellingOrderId) return;
    const orderId = order.id || order._id;
    setCancellingOrderId(orderId);
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/orders/${orderId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        toast?.showToast('Order cancelled', 'success');
        ctx.fetchPendingOrders();
      } else {
        const errData = await res.json().catch(() => ({}));
        toast?.showToast(errData.detail || 'Failed to cancel order', 'error');
      }
    } catch (e) {
      toast?.showToast('Network error', 'error');
    } finally {
      setCancellingOrderId(null);
    }
  };

  const accountDisplay =
    ctx.isChallengeMode
      ? String(ctx.selectedChallengeAccount?.name || ctx.selectedChallengeAccount?.accountId || ctx.selectedChallengeAccount?.accountNumber || 'Challenge')
      : String(ctx.selectedAccount?.accountId || ctx.selectedAccount?.accountNumber || ctx.selectedAccount?.label || '—');

  const onTradeRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        ctx.fetchOpenTrades(),
        ctx.fetchPendingOrders(),
        ctx.fetchTradeHistory(),
        ctx.fetchAccountSummary(),
      ]);
    } finally {
      setRefreshing(false);
    }
  };

  const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const exportTradeCsv = async () => {
    let csv = '';
    if (tradeTab === 'positions') {
      csv = ['ACCOUNT', 'SYMBOL', 'SIDE', 'QTY', 'OPEN', 'CURRENT', 'FLOATING_PNL'].join(',') + '\n';
      (Array.isArray(ctx.openTrades) ? ctx.openTrades : []).forEach((t) => {
        const prices = ctx.livePrices[t.symbol];
        const cur = t.side === 'BUY' ? prices?.bid : prices?.ask;
        const pnl = ctx.calculatePnl(t);
        csv +=
          [
            escapeCsv(accountDisplay),
            escapeCsv(t.symbol),
            escapeCsv(t.side),
            escapeCsv(t.quantity),
            escapeCsv(t.openPrice != null ? Number(t.openPrice).toFixed(5) : ''),
            escapeCsv(cur != null ? Number(cur).toFixed(5) : ''),
            escapeCsv(pnl.toFixed(2)),
          ].join(',') + '\n';
      });
    } else if (tradeTab === 'pending') {
      csv = ['ACCOUNT', 'SYMBOL', 'TYPE', 'QTY', 'PRICE'].join(',') + '\n';
      (Array.isArray(ctx.pendingOrders) ? ctx.pendingOrders : []).forEach((o) => {
        csv +=
          [
            escapeCsv(accountDisplay),
            escapeCsv(o.symbol),
            escapeCsv(o.orderType),
            escapeCsv(o.quantity),
            escapeCsv(o.pendingPrice != null ? Number(o.pendingPrice).toFixed(5) : ''),
          ].join(',') + '\n';
      });
    } else {
      csv = ['ACCOUNT', 'SYMBOL', 'SIDE', 'QTY', 'OPEN', 'CLOSE', 'REALIZED_PNL', 'CLOSED_AT'].join(',') + '\n';
      getFilteredHistory().forEach((t) => {
        csv +=
          [
            escapeCsv(accountDisplay),
            escapeCsv(t.symbol),
            escapeCsv(t.side),
            escapeCsv(t.quantity),
            escapeCsv(t.openPrice != null ? Number(t.openPrice).toFixed(5) : ''),
            escapeCsv(t.closePrice != null ? Number(t.closePrice).toFixed(5) : ''),
            escapeCsv((t.realizedPnl ?? 0).toFixed(2)),
            escapeCsv(t.closedAt ? new Date(t.closedAt).toISOString() : ''),
          ].join(',') + '\n';
      });
    }
    try {
      await Share.share({ message: csv, title: 'trades-export.csv' });
    } catch (e) {
      if (e?.message !== 'User did not share') {
        toast?.showToast('Could not export', 'error');
      }
    }
  };

  const balanceVal = Number(
    ctx.accountSummary.balance ||
      (ctx.isChallengeMode ? ctx.selectedChallengeAccount?.balance : ctx.selectedAccount?.balance) ||
      0
  );
  const creditVal = Number(ctx.accountSummary.credit || 0);
  const floatPl = ctx.totalFloatingPnl ?? 0;
  const floatColor = floatPl >= 0 ? colors.accent : colors.lossColor;
  const todayPnlVal = Number(ctx.todayPnl ?? 0);
  const todayPnlColor = todayPnlVal >= 0 ? colors.profitColor : colors.lossColor;

  // Swipe-to-close: render right action
  const renderSwipeClose = (trade) => (progress, dragX) => {
    return (
      <TouchableOpacity
        style={{
          width: 80,
          backgroundColor: '#ef4444',
          justifyContent: 'center',
          alignItems: 'center',
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        }}
        onPress={() => openPartialCloseModal(trade)}
      >
        <Ionicons name="close-circle" size={24} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 }}>Close</Text>
      </TouchableOpacity>
    );
  };

  // Swipe-to-cancel for pending orders
  const renderSwipeCancel = (order) => (progress, dragX) => {
    return (
      <TouchableOpacity
        style={{
          width: 80,
          backgroundColor: '#ef4444',
          justifyContent: 'center',
          alignItems: 'center',
        }}
        onPress={() => cancelPendingOrder(order)}
      >
        <Ionicons name="close-circle" size={24} color="#fff" />
        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 }}>Cancel</Text>
      </TouchableOpacity>
    );
  };

  const equityColor = ctx.realTimeEquity >= balanceVal ? '#22c55e' : '#ef4444';
  const freeMarginColor = '#22c55e';

  return (
    <View style={[styles.tradeDashRoot, { backgroundColor: colors.bgPrimary }]}>
      {/* Account Stats - Compact vertical list */}
      <View style={{ paddingTop: 44, backgroundColor: colors.bgPrimary }}>
        {[
          { label: 'Balance', value: balanceVal.toFixed(2), color: colors.textPrimary },
          { label: 'Equity', value: ctx.realTimeEquity.toFixed(2), color: equityColor },
          { label: 'Credit', value: creditVal.toFixed(2), color: colors.textPrimary },
          { label: 'Used Margin', value: totalUsedMargin.toFixed(2), color: colors.textPrimary },
          { label: 'Free Margin', value: ctx.realTimeFreeMargin.toFixed(2), color: freeMarginColor },
          { label: 'Floating PL', value: `${floatPl >= 0 ? '' : ''}${floatPl.toFixed(2)}`, color: floatColor },
          { label: "Today's P&L", value: `${todayPnlVal >= 0 ? '' : ''}${todayPnlVal.toFixed(2)}`, color: todayPnlColor },
        ].map((item, idx) => (
          <View key={idx} style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 7,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
          }}>
            <Text style={{ color: colors.textMuted, fontSize: 14, fontWeight: '400' }}>{item.label}</Text>
            <Text style={{ color: item.color, fontSize: 14, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{item.value}</Text>
          </View>
        ))}
      </View>

      {/* Tabs: Positions | Pending | History */}
      <View style={{
        flexDirection: 'row',
        backgroundColor: colors.bgPrimary,
        borderBottomWidth: 1,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
      }}>
        {[
          { id: 'positions', title: 'Positions', count: ctx.openTrades?.length ?? 0 },
          { id: 'pending', title: 'Pending', count: ctx.pendingOrders?.length ?? 0 },
          { id: 'history', title: 'History' },
        ].map((tab) => {
          const isActive = tradeTab === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderBottomColor: isActive ? '#ef4444' : 'transparent',
              }}
              onPress={() => setTradeTab(tab.id)}
              activeOpacity={0.7}
            >
              <Text style={{
                fontSize: 13,
                fontWeight: isActive ? '700' : '500',
                color: isActive ? '#ef4444' : colors.textMuted,
              }}>
                {tab.title}{tab.count != null ? ` (${tab.count})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bgPrimary }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onTradeRefresh} tintColor={colors.primary} />}
      >
        {tradeTab === 'positions' && (
          ctx.openTrades.length === 0 ? (
            <View style={ordStyles.emptyWrap}>
              <Ionicons name="trending-up-outline" size={48} color={colors.textMuted} />
              <Text style={[ordStyles.emptyText, { color: colors.textMuted }]}>No open positions</Text>
            </View>
          ) : (
            <>
              {/* Close All / Close Profit / Close Loss buttons */}
              <View style={{
                flexDirection: 'row',
                paddingHorizontal: 10,
                paddingVertical: 8,
                gap: 6,
              }}>
                <TouchableOpacity
                  style={{
                    flex: 1,
                    paddingVertical: 7,
                    borderRadius: 5,
                    borderWidth: 1,
                    borderColor: '#ef4444',
                    alignItems: 'center',
                  }}
                  onPress={() => closeAllTrades('all')}
                >
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '700' }}>Close All ({ctx.openTrades.length})</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{
                    flex: 1,
                    paddingVertical: 7,
                    borderRadius: 5,
                    borderWidth: 1,
                    borderColor: '#ef4444',
                    alignItems: 'center',
                  }}
                  onPress={() => closeAllTrades('profit')}
                >
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '700' }}>Close Profit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{
                    flex: 1,
                    paddingVertical: 7,
                    borderRadius: 5,
                    borderWidth: 1,
                    borderColor: '#ef4444',
                    alignItems: 'center',
                  }}
                  onPress={() => closeAllTrades('loss')}
                >
                  <Text style={{ color: '#ef4444', fontSize: 12, fontWeight: '700' }}>Close Loss</Text>
                </TouchableOpacity>
              </View>

              {/* Position cards with swipe-to-close */}
              {ctx.openTrades.map((trade) => {
                const pnl = ctx.calculatePnl(trade);
                const prices = ctx.livePrices[trade.symbol];
                const currentPrice = trade.side === 'BUY' ? prices?.bid : prices?.ask;

                return (
                  <Swipeable
                    key={trade._id || trade.id}
                    renderRightActions={renderSwipeClose(trade)}
                    overshootRight={false}
                    friction={2}
                  >
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => { setDetailTrade(trade); setShowTradeDetails(true); }}
                      style={{
                        backgroundColor: colors.bgPrimary,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
                      }}
                    >
                      {/* Top row: Symbol + BUY/SELL badge + lots @ price */}
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                          <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '800', marginRight: 6 }}>{trade.symbol}</Text>
                          <View style={{
                            backgroundColor: trade.side === 'BUY' ? '#22c55e' : '#ef4444',
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                            borderRadius: 4,
                          }}>
                            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{trade.side}</Text>
                          </View>
                        </View>
                        {/* Edit SL/TP button */}
                        <TouchableOpacity
                          onPress={(e) => { e.stopPropagation(); openSlTpModal(trade); }}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 16,
                            backgroundColor: isDark ? 'rgba(239,68,68,0.15)' : '#fef2f2',
                            justifyContent: 'center',
                            alignItems: 'center',
                            marginRight: 10,
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Ionicons name="pencil" size={14} color="#ef4444" />
                        </TouchableOpacity>
                        {/* PnL */}
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{
                            color: pnl >= 0 ? '#22c55e' : '#ef4444',
                            fontSize: 15,
                            fontWeight: '800',
                          }}>
                            ${pnl >= 0 ? '' : ''}{pnl.toFixed(2)}
                          </Text>
                          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 1 }}>
                            {currentPrice?.toFixed(5) || '—'}
                          </Text>
                        </View>
                      </View>
                      {/* Bottom row: lots @ open price */}
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 3 }}>
                        {trade.quantity} lots @ {trade.openPrice?.toFixed(5)}
                      </Text>
                    </TouchableOpacity>
                  </Swipeable>
                );
              })}
            </>
          )
        )}

        {tradeTab === 'pending' && (
          ctx.pendingOrders.length === 0 ? (
            <View style={ordStyles.emptyWrap}>
              <Ionicons name="time-outline" size={48} color={colors.textMuted} />
              <Text style={[ordStyles.emptyText, { color: colors.textMuted }]}>No pending orders</Text>
            </View>
          ) : (
            ctx.pendingOrders.map((order) => (
              <Swipeable
                key={order._id || order.id}
                renderRightActions={renderSwipeCancel(order)}
                overshootRight={false}
                friction={2}
              >
                <View style={{
                  backgroundColor: colors.bgPrimary,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                      <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginRight: 8 }}>{order.symbol}</Text>
                      <View style={{
                        backgroundColor: '#eab308',
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 4,
                      }}>
                        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{order.orderType}</Text>
                      </View>
                    </View>
                    <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '700' }}>{order.pendingPrice?.toFixed(5)}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 13 }}>{order.quantity} lots</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>SL: {order.sl || order.stopLoss || '–'}  TP: {order.tp || order.takeProfit || '–'}</Text>
                  </View>
                </View>
              </Swipeable>
            ))
          )
        )}

        {tradeTab === 'history' && (
          <>
            <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
                {['all', 'today', 'week', 'month', 'year'].map(f => (
                  <TouchableOpacity
                    key={f}
                    style={{
                      paddingHorizontal: 16,
                      paddingVertical: 7,
                      borderRadius: 20,
                      backgroundColor: historyFilter === f ? '#ef4444' : (isDark ? 'rgba(255,255,255,0.06)' : colors.bgSecondary),
                    }}
                    onPress={() => setHistoryFilter(f)}
                  >
                    <Text style={{ color: historyFilter === f ? '#fff' : colors.textMuted, fontSize: 13, fontWeight: '600' }}>
                      {f === 'all' ? 'All' : f === 'today' ? 'Today' : f === 'week' ? 'Week' : f === 'month' ? 'Month' : 'Year'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 }}>
                <Text style={{ color: colors.textMuted, fontSize: 12 }}>{getFilteredHistory().length} trades</Text>
                <Text style={{ color: getHistoryTotalPnl() >= 0 ? '#22c55e' : '#ef4444', fontSize: 13, fontWeight: '700' }}>P&L: ${getHistoryTotalPnl().toFixed(2)}</Text>
              </View>
            </View>

            {getFilteredHistory().length === 0 ? (
              <View style={ordStyles.emptyWrap}>
                <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
                <Text style={[ordStyles.emptyText, { color: colors.textMuted }]}>No trade history</Text>
              </View>
            ) : (
              getFilteredHistory().map((trade) => (
                <TouchableOpacity
                  key={trade._id || trade.id}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
                  }}
                  onPress={() => { setHistoryDetailTrade(trade); setShowHistoryDetails(true); }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                      <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginRight: 8 }}>{trade.symbol}</Text>
                      <View style={{
                        backgroundColor: trade.side === 'BUY' ? '#22c55e' : '#ef4444',
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 4,
                      }}>
                        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>{trade.side}</Text>
                      </View>
                      {trade.closedBy === 'ADMIN' && (
                        <View style={{ backgroundColor: isDark ? '#1a73e820' : '#e3f2fd', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginLeft: 6 }}>
                          <Text style={{ color: '#1a73e8', fontSize: 10, fontWeight: '700' }}>Admin</Text>
                        </View>
                      )}
                    </View>
                    <Text style={{
                      color: (trade.realizedPnl || 0) >= 0 ? '#22c55e' : '#ef4444',
                      fontSize: 16,
                      fontWeight: '800',
                    }}>
                      {(trade.realizedPnl || 0) >= 0 ? '+' : ''}${(trade.realizedPnl || 0).toFixed(2)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 13 }}>{trade.quantity} lots | {trade.openPrice?.toFixed(5)} → {trade.closePrice?.toFixed(5)}</Text>
                  </View>
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 3 }}>{trade.closedAt ? new Date(trade.closedAt).toLocaleString() : ''}</Text>
                </TouchableOpacity>
              ))
            )}
          </>
        )}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/* SL/TP Modal */}
      <Modal visible={showSlTpModal} animationType="slide" transparent onRequestClose={() => setShowSlTpModal(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.slTpModalOverlay}
        >
          <TouchableOpacity
            style={styles.slTpModalBackdrop}
            activeOpacity={1}
            onPress={() => { Keyboard.dismiss(); setShowSlTpModal(false); }}
          />
          <View style={[styles.slTpModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.slTpModalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.slTpModalHeader}>
              <Text style={[styles.slTpModalTitle, { color: colors.textPrimary }]}>
                {selectedTrade?.symbol} - Set SL/TP
              </Text>
              <TouchableOpacity onPress={() => { setShowSlTpModal(false); Keyboard.dismiss(); }}>
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            <View style={styles.slTpInputGroup}>
              <Text style={[styles.slTpLabel, { color: colors.textMuted }]}>Stop Loss</Text>
              <TextInput
                style={[styles.slTpInput, { backgroundColor: isDark ? '#2a2a2a' : '#f5f5f5', borderColor: colors.border, color: colors.textPrimary }]}
                value={stopLoss}
                onChangeText={(text) => setStopLoss(text.replace(/[^0-9.]/g, ''))}
                placeholder="Enter stop loss price"
                placeholderTextColor={colors.textMuted}
                keyboardType="numbers-and-punctuation"
                returnKeyType="next"
                autoCorrect={false}
                autoCapitalize="none"
                selectionColor="#1a73e8"
                editable={true}
              />
            </View>

            <View style={styles.slTpInputGroup}>
              <Text style={[styles.slTpLabel, { color: colors.textMuted }]}>Take Profit</Text>
              <TextInput
                style={[styles.slTpInput, { backgroundColor: isDark ? '#2a2a2a' : '#f5f5f5', borderColor: colors.border, color: colors.textPrimary }]}
                value={takeProfit}
                onChangeText={(text) => setTakeProfit(text.replace(/[^0-9.]/g, ''))}
                placeholder="Enter take profit price"
                placeholderTextColor={colors.textMuted}
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                autoCorrect={false}
                autoCapitalize="none"
                selectionColor="#1a73e8"
                editable={true}
                onSubmitEditing={updateSlTp}
              />
            </View>

            <View style={styles.slTpCurrentInfo}>
              <Text style={[styles.slTpCurrentText, { color: colors.textMuted }]}>
                Open: {selectedTrade?.openPrice?.toFixed(5) || '-'}
              </Text>
              <Text style={[styles.slTpCurrentText, { color: colors.textMuted }]}>
                {selectedTrade?.side || '-'} | {selectedTrade?.quantity || 0} lots
              </Text>
            </View>

            <View style={styles.slTpButtonRow}>
              <TouchableOpacity
                style={[styles.slTpClearBtn, { backgroundColor: isDark ? '#2a2a2a' : '#f0f0f0' }]}
                onPress={() => { setStopLoss(''); setTakeProfit(''); }}
              >
                <Text style={[styles.slTpClearBtnText, { color: colors.textPrimary }]}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.slTpSaveBtn} onPress={updateSlTp}>
                <Text style={styles.slTpSaveBtnText}>Save Changes</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Partial Close Modal */}
      <Modal visible={showPartialClose} animationType="slide" transparent onRequestClose={() => setShowPartialClose(false)}>
        <View style={styles.slTpModalOverlay}>
          <TouchableOpacity style={styles.slTpModalBackdrop} activeOpacity={1} onPress={() => setShowPartialClose(false)} />
          <View style={[styles.slTpModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.slTpModalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.slTpModalHeader}>
              <Text style={[styles.slTpModalTitle, { color: colors.textPrimary }]}>Close Position</Text>
              <TouchableOpacity onPress={() => setShowPartialClose(false)}>
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>

            {partialCloseTrade && (
              <View style={{ paddingHorizontal: 4 }}>
                {/* Trade Info */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, padding: 12, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#f5f5f5' }}>
                  <View>
                    <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '700' }}>{partialCloseTrade.symbol}</Text>
                    <Text style={{ color: partialCloseTrade.side === 'BUY' ? '#2196f3' : '#ef4444', fontSize: 12, fontWeight: '600', marginTop: 2 }}>{partialCloseTrade.side} · {partialCloseTrade.quantity} lots</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: colors.textMuted, fontSize: 11 }}>Floating P&L</Text>
                    <Text style={{ color: calculatePnl(partialCloseTrade) >= 0 ? '#22c55e' : '#ef4444', fontSize: 16, fontWeight: '700' }}>
                      {calculatePnl(partialCloseTrade) >= 0 ? '+' : ''}${calculatePnl(partialCloseTrade).toFixed(2)}
                    </Text>
                  </View>
                </View>

                {/* Percentage Buttons */}
                <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: 10, letterSpacing: 0.5 }}>CLOSE AMOUNT</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                  {[25, 50, 75, 100].map(pct => {
                    const isActive = partialPercent === pct;
                    const totalLots = partialCloseTrade.quantity || 0;
                    const lotsForPct = parseFloat((totalLots * pct / 100).toFixed(2));
                    return (
                      <TouchableOpacity
                        key={pct}
                        onPress={() => setPartialPercent(pct)}
                        style={{
                          flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center',
                          backgroundColor: isActive ? (pct === 100 ? '#ef4444' : colors.primary) : (isDark ? 'rgba(255,255,255,0.06)' : '#f0f0f0'),
                          borderWidth: 1,
                          borderColor: isActive ? (pct === 100 ? '#ef4444' : colors.primary) : (isDark ? 'rgba(255,255,255,0.1)' : '#e0e0e0'),
                        }}
                      >
                        <Text style={{ color: isActive ? '#fff' : colors.textPrimary, fontSize: 15, fontWeight: '700' }}>{pct}%</Text>
                        <Text style={{ color: isActive ? 'rgba(255,255,255,0.7)' : colors.textMuted, fontSize: 10, marginTop: 2 }}>{lotsForPct} lots</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Summary */}
                <View style={{ padding: 12, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : '#f5f5f5', marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>Total Volume</Text>
                    <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>{partialCloseTrade.quantity} lots</Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>Close Volume</Text>
                    <Text style={{ color: partialPercent === 100 ? '#ef4444' : colors.primary, fontSize: 12, fontWeight: '700' }}>
                      {parseFloat(((partialCloseTrade.quantity || 0) * partialPercent / 100).toFixed(2))} lots
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>Remaining</Text>
                    <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>
                      {parseFloat(((partialCloseTrade.quantity || 0) * (100 - partialPercent) / 100).toFixed(2))} lots
                    </Text>
                  </View>
                </View>

                {/* Confirm Button */}
                <TouchableOpacity
                  onPress={confirmPartialClose}
                  disabled={closingTradeId != null}
                  style={{
                    paddingVertical: 16, borderRadius: 12, alignItems: 'center',
                    backgroundColor: partialPercent === 100 ? '#ef4444' : colors.primary,
                    opacity: closingTradeId ? 0.5 : 1,
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                    {closingTradeId ? 'Closing...' : partialPercent === 100 ? 'CLOSE FULL POSITION' : `CLOSE ${partialPercent}% (${parseFloat(((partialCloseTrade.quantity || 0) * partialPercent / 100).toFixed(2))} lots)`}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Trade Details Modal */}
      <Modal visible={showTradeDetails} animationType="slide" transparent onRequestClose={() => setShowTradeDetails(false)}>
        <View style={styles.slTpModalOverlay}>
          <TouchableOpacity style={styles.slTpModalBackdrop} activeOpacity={1} onPress={() => setShowTradeDetails(false)} />
          <View style={[styles.tradeDetailsContent, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.slTpModalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.slTpModalHeader}>
              <Text style={[styles.slTpModalTitle, { color: colors.textPrimary }]}>{detailTrade?.symbol} Trade Details</Text>
              <TouchableOpacity onPress={() => setShowTradeDetails(false)}>
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
            
            {detailTrade && (
              <ScrollView style={styles.tradeDetailsScroll}>
                {/* Trade ID & Status */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Trade Info</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Trade ID</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.tradeId}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Status</Text>
                    <Text style={[styles.detailValue, { color: '#22c55e' }]}>{detailTrade.status}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Side</Text>
                    <Text style={[styles.detailValue, { color: detailTrade.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>{detailTrade.side}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Order Type</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.orderType}</Text>
                  </View>
                </View>

                {/* Position Details */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Position</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Volume</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.quantity} lots</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Open Price</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.openPrice?.toFixed(5)}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Current Price</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>
                      {(detailTrade.side === 'BUY' ? ctx.livePrices[detailTrade.symbol]?.bid : ctx.livePrices[detailTrade.symbol]?.ask)?.toFixed(5) || '-'}
                    </Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Contract Size</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.contractSize?.toLocaleString()}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Leverage</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>1:{detailTrade.leverage}</Text>
                  </View>
                </View>

                {/* SL/TP */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Stop Loss / Take Profit</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Stop Loss</Text>
                    <Text style={[styles.detailValue, { color: (detailTrade.sl || detailTrade.stopLoss) ? '#1a73e8' : colors.textMuted }]}>
                      {detailTrade.sl || detailTrade.stopLoss || 'Not Set'}
                    </Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Take Profit</Text>
                    <Text style={[styles.detailValue, { color: (detailTrade.tp || detailTrade.takeProfit) ? '#22c55e' : colors.textMuted }]}>
                      {detailTrade.tp || detailTrade.takeProfit || 'Not Set'}
                    </Text>
                  </View>
                </View>

                {/* Charges */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Charges</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Margin Used</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${detailTrade.marginUsed?.toFixed(2)}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Spread</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{detailTrade.spread || 0} pips</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Commission</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${detailTrade.commission?.toFixed(2) || '0.00'}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Swap</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${detailTrade.swap?.toFixed(2) || '0.00'}</Text>
                  </View>
                </View>

                {/* P&L */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Profit & Loss</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Floating P&L</Text>
                    <Text style={[styles.detailValue, { color: ctx.calculatePnl(detailTrade) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 'bold' }]}>
                      ${ctx.calculatePnl(detailTrade).toFixed(2)}
                    </Text>
                  </View>
                </View>

                {/* Time */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Time</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Opened At</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{new Date(detailTrade.openedAt || detailTrade.createdAt).toLocaleString()}</Text>
                  </View>
                </View>

                {/* Action Buttons */}
                <View style={styles.detailActions}>
                  <TouchableOpacity
                    style={styles.detailEditBtn}
                    onPress={() => { setShowTradeDetails(false); openSlTpModal(detailTrade); }}
                  >
                    <Ionicons name="pencil" size={18} color="#ef4444" />
                    <Text style={[styles.detailEditText, { color: '#ef4444' }]}>Edit SL/TP</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.detailCloseBtn, { backgroundColor: '#ef4444' }]}
                    onPress={() => { setShowTradeDetails(false); openPartialCloseModal(detailTrade); }}
                  >
                    <Ionicons name="close-circle" size={18} color="#fff" />
                    <Text style={styles.detailCloseText}>Close Trade</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Close All Confirmation Modal */}
      <Modal visible={showCloseAllModal} animationType="fade" transparent onRequestClose={() => setShowCloseAllModal(false)}>
        <View style={styles.confirmModalOverlay}>
          <View style={styles.confirmModalContent}>
            <View style={[styles.confirmModalIcon, { backgroundColor: closeAllType === 'profit' ? '#1a73e820' : closeAllType === 'loss' ? '#1a73e820' : '#1a73e820' }]}>
              <Ionicons name={closeAllType === 'profit' ? 'trending-up' : closeAllType === 'loss' ? 'trending-down' : 'close-circle'} size={32} color={closeAllType === 'profit' ? '#1a73e8' : closeAllType === 'loss' ? '#1a73e8' : '#1a73e8'} />
            </View>
            <Text style={styles.confirmModalTitle}>
              {closeAllType === 'all' && 'Close All Trades?'}
              {closeAllType === 'profit' && 'Close Winning Trades?'}
              {closeAllType === 'loss' && 'Close Losing Trades?'}
            </Text>
            <Text style={styles.confirmModalMessage}>
              {closeAllType === 'all' && `This will close all ${ctx.openTrades.length} open trade(s)`}
              {closeAllType === 'profit' && 'This will close all trades currently in profit'}
              {closeAllType === 'loss' && 'This will close all trades currently in loss'}
            </Text>
            <View style={styles.confirmModalButtons}>
              <TouchableOpacity style={styles.confirmCancelBtn} onPress={() => setShowCloseAllModal(false)} disabled={isClosingAll}>
                <Text style={styles.confirmCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.confirmCloseBtn, { backgroundColor: closeAllType === 'profit' ? '#1a73e8' : closeAllType === 'loss' ? '#1a73e8' : '#1a73e8' }, isClosingAll && styles.btnDisabled]} 
                onPress={confirmCloseAll}
                disabled={isClosingAll}
              >
                <Text style={styles.confirmCloseText}>{isClosingAll ? 'Closing...' : 'Confirm'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* History Trade Details Modal */}
      <Modal visible={showHistoryDetails} animationType="slide" transparent onRequestClose={() => setShowHistoryDetails(false)}>
        <View style={styles.slTpModalOverlay}>
          <TouchableOpacity style={styles.slTpModalBackdrop} activeOpacity={1} onPress={() => setShowHistoryDetails(false)} />
          <View style={[styles.tradeDetailsContent, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.slTpModalHandle, { backgroundColor: colors.border }]} />
            <View style={styles.slTpModalHeader}>
              <Text style={[styles.slTpModalTitle, { color: colors.textPrimary }]}>{historyDetailTrade?.symbol} - Closed Trade</Text>
              <TouchableOpacity onPress={() => setShowHistoryDetails(false)}>
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
            
            {historyDetailTrade && (
              <ScrollView style={styles.tradeDetailsScroll}>
                {/* Trade Info */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Trade Info</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Trade ID</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.tradeId}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Status</Text>
                    <Text style={[styles.detailValue, { color: colors.textMuted }]}>{historyDetailTrade.status}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Side</Text>
                    <Text style={[styles.detailValue, { color: historyDetailTrade.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>{historyDetailTrade.side}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Order Type</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.orderType}</Text>
                  </View>
                  {/* Closed By - Show for all close types */}
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Closed By</Text>
                    <Text style={[styles.detailValue, { 
                      color: historyDetailTrade.closedBy === 'STOP_OUT' ? '#ef4444' : 
                             historyDetailTrade.closedBy === 'SL' ? '#ef4444' : 
                             historyDetailTrade.closedBy === 'TP' ? '#22c55e' : 
                             historyDetailTrade.closedBy === 'ADMIN' ? '#f59e0b' : colors.textMuted
                    }]}>
                      {historyDetailTrade.closedBy === 'STOP_OUT' ? '⚠️ Stop Out (Equity Zero)' :
                       historyDetailTrade.closedBy === 'SL' ? '🔴 Stop Loss Hit' :
                       historyDetailTrade.closedBy === 'TP' ? '🟢 Take Profit Hit' :
                       historyDetailTrade.closedBy === 'ADMIN' ? '👤 Admin Close' :
                       historyDetailTrade.closedBy === 'USER' ? '👤 Manual Close' :
                       historyDetailTrade.closedBy || 'Manual Close'}
                    </Text>
                  </View>
                </View>

                {/* Position Details */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Position</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Volume</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.quantity} lots</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Open Price</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.openPrice?.toFixed(5)}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Close Price</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.closePrice?.toFixed(5)}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Contract Size</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.contractSize?.toLocaleString()}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Leverage</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>1:{historyDetailTrade.leverage}</Text>
                  </View>
                </View>

                {/* SL/TP */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Stop Loss / Take Profit</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Stop Loss</Text>
                    <Text style={[styles.detailValue, { color: (historyDetailTrade.sl || historyDetailTrade.stopLoss) ? '#1a73e8' : colors.textMuted }]}>
                      {historyDetailTrade.sl || historyDetailTrade.stopLoss || 'Not Set'}
                    </Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Take Profit</Text>
                    <Text style={[styles.detailValue, { color: (historyDetailTrade.tp || historyDetailTrade.takeProfit) ? '#22c55e' : colors.textMuted }]}>
                      {historyDetailTrade.tp || historyDetailTrade.takeProfit || 'Not Set'}
                    </Text>
                  </View>
                </View>

                {/* Charges */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Charges</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Margin Used</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${historyDetailTrade.marginUsed?.toFixed(2) || '0.00'}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Spread</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{historyDetailTrade.spread || 0} pips</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Commission</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${historyDetailTrade.commission?.toFixed(2) || '0.00'}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Swap</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>${historyDetailTrade.swap?.toFixed(2) || '0.00'}</Text>
                  </View>
                </View>

                {/* P&L */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Realized Profit & Loss</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Realized P&L</Text>
                    <Text style={[styles.detailValue, { color: (historyDetailTrade.realizedPnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 'bold', fontSize: 18 }]}>
                      {(historyDetailTrade.realizedPnl || 0) >= 0 ? '+' : ''}${(historyDetailTrade.realizedPnl || 0).toFixed(2)}
                    </Text>
                  </View>
                </View>

                {/* Time */}
                <View style={[styles.detailSection, { backgroundColor: colors.bgSecondary }]}>
                  <Text style={[styles.detailSectionTitle, { color: '#ef4444' }]}>Time</Text>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Opened At</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{new Date(historyDetailTrade.openedAt || historyDetailTrade.createdAt).toLocaleString()}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Closed At</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{new Date(historyDetailTrade.closedAt).toLocaleString()}</Text>
                  </View>
                  <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
                    <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Duration</Text>
                    <Text style={[styles.detailValue, { color: colors.textPrimary }]}>
                      {(() => {
                        const openTime = new Date(historyDetailTrade.openedAt || historyDetailTrade.createdAt);
                        const closeTime = new Date(historyDetailTrade.closedAt);
                        const diffMs = closeTime - openTime;
                        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
                        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                        return diffHrs > 0 ? `${diffHrs}h ${diffMins}m` : `${diffMins}m`;
                      })()}
                    </Text>
                  </View>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

    </View>
  );
};

// HISTORY TAB
const HistoryTab = () => {
  const ctx = React.useContext(TradingContext);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await ctx.fetchTradeHistory();
    setRefreshing(false);
  };

  return (
    <FlatList
      style={styles.container}
      data={ctx.tradeHistory}
      keyExtractor={item => item._id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1a73e8" />}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Ionicons name="document-text-outline" size={48} color="#666" />
          <Text style={styles.emptyText}>No trade history</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.historyItemFull}>
          <View style={styles.historyHeader}>
            <View style={styles.historyLeft}>
              <Text style={styles.historySymbol}>{item.symbol}</Text>
              <View style={[styles.sideBadge, { backgroundColor: item.side === 'BUY' ? '#22c55e20' : '#ef444420' }]}>
                <Text style={[styles.sideText, { color: item.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>{item.side}</Text>
              </View>
              {item.closedBy === 'ADMIN' && (
                <View style={styles.adminBadge}>
                  <Text style={styles.adminBadgeText}>Admin Close</Text>
                </View>
              )}
            </View>
            <Text style={[styles.historyPnl, { color: (item.realizedPnl || 0) >= 0 ? '#22c55e' : '#ef4444' }]}>
              {(item.realizedPnl || 0) >= 0 ? '+' : ''}${(item.realizedPnl || 0).toFixed(2)}
            </Text>
          </View>
          <View style={styles.historyMeta}>
            <Text style={styles.historyMetaText}>{item.quantity} lots</Text>
            <Text style={styles.historyMetaText}>Open: {item.openPrice?.toFixed(5)}</Text>
            <Text style={styles.historyMetaText}>Close: {item.closePrice?.toFixed(5)}</Text>
          </View>
          <Text style={styles.historyDate}>{new Date(item.closedAt).toLocaleDateString()}</Text>
        </View>
      )}
    />
  );
};

/** Segments for Add Chart flow (match instrument `category` from API). */
const CHART_ADD_SYMBOL_SEGMENTS = ['Forex', 'Metals', 'Commodities', 'Crypto', 'Indices', 'Stocks'];

// CHART TAB - Full screen TradingView chart with multiple chart tabs
const ChartTab = ({ route }) => {
  const ctx = React.useContext(TradingContext);
  const { colors, isDark } = useTheme();
  const { showChartQuickTrade } = useSettings();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  
  // Get initial symbol from route params or default to XAUUSD (always uppercase for API / livePrices keys)
  const initialSymbol = String(route?.params?.symbol || 'XAUUSD').trim().toUpperCase();
  const [chartTabs, setChartTabs] = useState([{ symbol: initialSymbol, id: 1 }]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  /** Add Chart modal: pick segment first, then symbol */
  const [chartAddStep, setChartAddStep] = useState('segments');
  const [chartAddSegment, setChartAddSegment] = useState(null);
  
  // Handle symbol change from navigation params
  React.useEffect(() => {
    if (route?.params?.symbol) {
      const symbol = String(route.params.symbol).trim().toUpperCase();
      // Check if symbol already exists in tabs
      const existingTab = chartTabs.find(t => t.symbol === symbol);
      if (existingTab) {
        // Switch to existing tab
        setActiveTabId(existingTab.id);
      } else {
        // Add new tab with this symbol
        const newId = Math.max(...chartTabs.map(t => t.id)) + 1;
        setChartTabs(prev => [...prev, { symbol, id: newId }]);
        setActiveTabId(newId);
      }
    }
  }, [route?.params?.symbol]);
  const [showOrderPanel, setShowOrderPanel] = useState(false);
  const [orderSide, setOrderSide] = useState('BUY');
  const [volume, setVolume] = useState(0.01);
  const [volumeText, setVolumeText] = useState('0.01');
  const [isExecuting, setIsExecuting] = useState(false);
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [showChartSlModal, setShowChartSlModal] = useState(false);
  const [chartSlValue, setChartSlValue] = useState('');
  const [pendingChartTradeSide, setPendingChartTradeSide] = useState(null);
  
  // Get leverage from account
  const getAccountLeverage = () => {
    if (ctx.isChallengeMode && ctx.selectedChallengeAccount) {
      return ctx.selectedChallengeAccount.leverage || '1:100';
    }
    return ctx.selectedAccount?.leverage || ctx.selectedAccount?.accountTypeId?.leverage || '1:100';
  };

  const activeTab = chartTabs.find(t => t.id === activeTabId) || chartTabs[0];
  const activeSymbol = String(activeTab?.symbol || 'XAUUSD').trim().toUpperCase();

  const resetChartSymbolPicker = () => {
    setChartAddStep('segments');
    setChartAddSegment(null);
  };

  const addNewChartTab = (symbol) => {
    const sym = String(symbol || '').trim().toUpperCase();
    const newId = Math.max(...chartTabs.map(t => t.id)) + 1;
    setChartTabs([...chartTabs, { symbol: sym, id: newId }]);
    setActiveTabId(newId);
    setShowSymbolPicker(false);
    resetChartSymbolPicker();
  };

  const instrumentsInChartSegment = React.useMemo(() => {
    if (!chartAddSegment) return [];
    const list = ctx.instruments || [];
    return list
      .filter((i) => String(i.category || 'Forex') === chartAddSegment)
      .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
  }, [ctx.instruments, chartAddSegment]);

  const segmentSymbolCounts = React.useMemo(() => {
    const counts = {};
    CHART_ADD_SYMBOL_SEGMENTS.forEach((s) => { counts[s] = 0; });
    for (const inst of ctx.instruments || []) {
      const c = String(inst.category || 'Forex');
      if (counts[c] !== undefined) counts[c] += 1;
    }
    return counts;
  }, [ctx.instruments]);

  const removeChartTab = (id) => {
    if (chartTabs.length > 1) {
      const newTabs = chartTabs.filter(t => t.id !== id);
      setChartTabs(newTabs);
      if (activeTabId === id) {
        setActiveTabId(newTabs[0].id);
      }
    }
  };

  const currentInstrument =
    ctx.instruments.find((i) => String(i?.symbol || '').toUpperCase() === activeSymbol) || null;
  const liveTick = ctx.livePrices[activeSymbol] || ctx.livePrices[String(activeSymbol).toUpperCase()] || {};
  const bidNum = Number(liveTick.bid ?? currentInstrument?.bid ?? 0);
  const askNum = Number(liveTick.ask ?? currentInstrument?.ask ?? 0);
  const currentPrice = {
    bid: Number.isFinite(bidNum) && bidNum > 0 ? bidNum : 0,
    ask: Number.isFinite(askNum) && askNum > 0 ? askNum : 0,
  };
  const isForex = currentInstrument?.category === 'Forex';
  const decimals = isForex ? 5 : 2;

  const getSymbolForTradingView = (symbol) => {
    const symbolMap = {
      'EURUSD': 'OANDA:EURUSD', 'GBPUSD': 'OANDA:GBPUSD', 'USDJPY': 'OANDA:USDJPY',
      'USDCHF': 'OANDA:USDCHF', 'AUDUSD': 'OANDA:AUDUSD', 'NZDUSD': 'OANDA:NZDUSD',
      'USDCAD': 'OANDA:USDCAD', 'EURGBP': 'OANDA:EURGBP', 'EURJPY': 'OANDA:EURJPY',
      'GBPJPY': 'OANDA:GBPJPY', 'XAUUSD': 'OANDA:XAUUSD', 'XAGUSD': 'OANDA:XAGUSD',
      'BTCUSD': 'COINBASE:BTCUSD', 'ETHUSD': 'COINBASE:ETHUSD', 'LTCUSD': 'COINBASE:LTCUSD',
      'XRPUSD': 'BITSTAMP:XRPUSD', 'BNBUSD': 'BINANCE:BNBUSDT', 'SOLUSD': 'COINBASE:SOLUSD',
      'ADAUSD': 'COINBASE:ADAUSD', 'DOGEUSD': 'BINANCE:DOGEUSDT', 'DOTUSD': 'COINBASE:DOTUSD',
      'MATICUSD': 'COINBASE:MATICUSD', 'AVAXUSD': 'COINBASE:AVAXUSD', 'LINKUSD': 'COINBASE:LINKUSD',
    };
    return symbolMap[symbol] || `OANDA:${symbol}`;
  };

  const openOrderPanel = (side) => {
    setOrderSide(side);
    setShowOrderPanel(true);
  };

  // One-click trade execution - Fast execution (same endpoint as Quotes tab: /orders/)
  const executeOneClickTrade = async (side, slPrice = null) => {
    if (isExecuting) return;

    const hasValidAccount = ctx.isChallengeMode ? ctx.selectedChallengeAccount : ctx.selectedAccount;
    if (!ctx.user) {
      toast?.showToast('Please login first', 'error');
      return;
    }
    if (!hasValidAccount) {
      toast?.showToast('Please select a trading account first', 'error');
      return;
    }
    
    // Check if challenge mode with SL mandatory
    if (ctx.isChallengeMode && ctx.selectedChallengeAccount?.challengeId?.rules?.stopLossMandatory && !slPrice) {
      setPendingChartTradeSide(side);
      setChartSlValue('');
      setShowChartSlModal(true);
      return;
    }
    
    if (!currentPrice.bid || !currentPrice.ask || currentPrice.bid <= 0 || currentPrice.ask <= 0) {
      toast?.showToast('Market is closed or no price data available', 'error');
      return;
    }
    
    setIsExecuting(true);
    try {
      const price = side === 'BUY' ? currentPrice.ask : currentPrice.bid;
      
      const tradingAccountId = ctx.isChallengeMode && ctx.selectedChallengeAccount 
          ? (ctx.selectedChallengeAccount.id || ctx.selectedChallengeAccount._id)
          : (ctx.selectedAccount.id || ctx.selectedAccount._id);

      const orderData = {
        account_id: tradingAccountId,
        symbol: activeSymbol,
        side: side.toLowerCase(),
        order_type: 'market',
        lots: parseFloat(volume) || 0.01,
      };
      
      if (slPrice) orderData.stop_loss = parseFloat(slPrice);
      
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/orders/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(orderData)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data) {
        toast?.showToast(`${side} ${volume} ${activeSymbol} @ ${price.toFixed(decimals)}`, 'success');
        ctx.fetchOpenTrades();
        ctx.fetchPendingOrders?.();
        ctx.fetchAccountSummary();
      } else {
        toast?.showToast(data.detail || data.message || 'Failed to place order', 'error');
      }
    } catch (e) {
      toast?.showToast('Network error', 'error');
    } finally {
      setIsExecuting(false);
    }
  };

  const executeTrade = async () => {
    const hasValidAccount = ctx.isChallengeMode ? ctx.selectedChallengeAccount : ctx.selectedAccount;
    if (!ctx.user) {
      toast?.showToast('Please login first', 'error');
      return;
    }
    if (!hasValidAccount) {
      toast?.showToast('Please select a trading account first', 'error');
      return;
    }
    if (!currentPrice.bid || !currentPrice.ask || currentPrice.bid <= 0 || currentPrice.ask <= 0) {
      toast?.showToast('Market is closed or no price data available', 'error');
      return;
    }

    // Client-side validation for challenge account SL mandatory rule
    if (ctx.isChallengeMode && ctx.selectedChallengeAccount) {
      const rules = ctx.selectedChallengeAccount.challengeId?.rules;
      if (rules?.stopLossMandatory && !stopLoss) {
        Alert.alert('Stop Loss Required', 'Stop Loss is mandatory for this challenge. Please set SL before trading.');
        return;
      }
    }
    
    setIsExecuting(true);
    try {
      // Use challenge account ID if in challenge mode
      const tradingAccountId = ctx.isChallengeMode && ctx.selectedChallengeAccount 
        ? (ctx.selectedChallengeAccount.id || ctx.selectedChallengeAccount._id)
        : (ctx.selectedAccount?.id || ctx.selectedAccount?._id);
      
      const orderData = {
        account_id: tradingAccountId,
        symbol: activeSymbol,
        side: orderSide.toLowerCase(),
        order_type: 'market',
        lots: parseFloat(volume) || 0.01,
      };
      
      // Add SL/TP if set (TrustEdge uses stop_loss/take_profit)
      if (stopLoss) orderData.stop_loss = parseFloat(stopLoss);
      if (takeProfit) orderData.take_profit = parseFloat(takeProfit);
      
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/orders/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(orderData)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data) {
        toast?.showToast(`${orderSide} order placed!`, 'success');
        setShowOrderPanel(false);
        setStopLoss('');
        setTakeProfit('');
        ctx.fetchOpenTrades();
        ctx.fetchPendingOrders?.();
        ctx.fetchAccountSummary();
      } else {
        toast?.showToast(data.detail || data.message || 'Failed to place order', 'error');
      }
    } catch (e) {
      toast?.showToast('Network error', 'error');
    } finally {
      setIsExecuting(false);
    }
  };

  const chartTheme = isDark ? 'dark' : 'light';
  const chartBg = isDark ? '#121212' : '#ffffff';

  // ── Single chart: TradingView Charting Library (loaded from web's host).
  // Loaded with baseUrl https://intrendfx.com/ so /charting_library/* resolves
  // to the production server where the library is already hosted.
  const chartWebViewRef = useRef(null);
  const [chartJwt, setChartJwt] = useState('');

  // Pull JWT once for the chart (TradingView datafeed/broker calls use it).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await SecureStore.getItemAsync('token');
        if (!cancelled) setChartJwt(t || '');
      } catch (e) {}
    })();
    return () => { cancelled = true; };
  }, [ctx.user]);

  // Open positions on the active symbol — pushed into the chart so the overlay
  // can draw entry/SL/TP horizontal lines (mirrors web's ChartPositionOverlay).
  const positionsForChart = useMemo(() => {
    const sym = activeSymbol.toUpperCase();
    const open = Array.isArray(ctx.openTrades) ? ctx.openTrades : [];
    return open
      .filter((t) => String(t?.symbol || '').toUpperCase() === sym)
      .map((t) => ({
        id: String(t._id || t.id || `${t.symbol}-${t.openPrice}-${t.side}`),
        symbol: t.symbol,
        side: String(t.side || '').toLowerCase(),
        lots: Number(t.lots || t.quantity || 0),
        openPrice: Number(t.openPrice || t.open_price || 0),
        stopLoss: t.stopLoss != null ? Number(t.stopLoss) : (t.stop_loss != null ? Number(t.stop_loss) : null),
        takeProfit: t.takeProfit != null ? Number(t.takeProfit) : (t.take_profit != null ? Number(t.take_profit) : null),
      }))
      .filter((p) => Number.isFinite(p.openPrice) && p.openPrice > 0);
  }, [ctx.openTrades, activeSymbol]);

  // Pending orders for the broker_factory (same source the broker uses on web).
  const ordersForChart = useMemo(() => {
    const arr = Array.isArray(ctx.pendingOrders) ? ctx.pendingOrders : [];
    return arr.map((o) => ({
      id: String(o._id || o.id),
      symbol: o.symbol,
      side: String(o.side || '').toLowerCase(),
      orderType: o.orderType || o.order_type || 'limit',
      lots: Number(o.lots || o.quantity || 0),
      price: Number(o.price || 0),
      stop_price: Number(o.stop_price || o.stopPrice || 0),
      stop_loss: o.stopLoss || o.stop_loss || null,
      take_profit: o.takeProfit || o.take_profit || null,
    }));
  }, [ctx.pendingOrders]);

  const accountForChart = useMemo(() => {
    const acc = ctx.isChallengeMode ? ctx.selectedChallengeAccount : ctx.selectedAccount;
    if (!acc) return null;
    return {
      id: String(acc.id || acc._id || ''),
      _id: String(acc._id || acc.id || ''),
      account_number: acc.account_number || '',
      currency: acc.currency || 'USD',
      name: acc.account_number ? `${acc.account_number} (${acc.is_demo ? 'Demo' : 'Live'})` : 'Account',
      is_demo: !!acc.is_demo,
    };
  }, [ctx.selectedAccount, ctx.selectedChallengeAccount, ctx.isChallengeMode]);

  const chartHtml = useMemo(() => {
    const tvSym = getSymbolForTradingView(activeSymbol);
    return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>*{margin:0;padding:0;box-sizing:border-box;}html,body{height:100%;width:100%;background:${chartBg};overflow:hidden;}</style>
</head><body>
<div class="tradingview-widget-container" style="height:100%;width:100%">
  <div id="tradingview_chart" style="height:100%;width:100%"></div>
</div>
<script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
<script type="text/javascript">
new TradingView.widget({
  "autosize": true,
  "symbol": "${tvSym}",
  "interval": "5",
  "timezone": "Etc/UTC",
  "theme": "${chartTheme}",
  "style": "1",
  "locale": "en",
  "toolbar_bg": "${chartBg}",
  "enable_publishing": false,
  "hide_top_toolbar": false,
  "hide_legend": false,
  "hide_side_toolbar": false,
  "save_image": false,
  "container_id": "tradingview_chart",
  "backgroundColor": "${chartBg}",
  "withdateranges": true,
  "allow_symbol_change": false,
  "details": true,
  "hotlist": false,
  "calendar": false,
  "show_popup_button": true,
  "popup_width": "1000",
  "popup_height": "650",
  "studies": [],
  "studies_overrides": {},
  "overrides": {
    "mainSeriesProperties.showPriceLine": true,
    "mainSeriesProperties.highLowAvgPrice.highLowPriceLinesVisible": true,
    "scalesProperties.showSeriesLastValue": true,
    "scalesProperties.showStudyLastValue": true,
    "paneProperties.legendProperties.showLegend": true,
    "paneProperties.legendProperties.showSeriesTitle": true,
    "paneProperties.legendProperties.showSeriesOHLC": true,
    "paneProperties.legendProperties.showBarChange": true
  }
});
</script>
</body></html>`;
  }, [activeSymbol, isDark, chartBg, chartTheme]);

  // Push position + order updates into the chart WebView (no remount).
  useEffect(() => {
    if (!chartWebViewRef.current) return;
    const js = `window.INTRENDFX_API && window.INTRENDFX_API.setPositions(${JSON.stringify(positionsForChart)}, ${JSON.stringify(ordersForChart)}); true;`;
    try { chartWebViewRef.current.injectJavaScript(js); } catch (e) {}
  }, [positionsForChart, ordersForChart]);

  // Push live ticks (fallback in case the WebView's WS connection is gated).
  useEffect(() => {
    if (!chartWebViewRef.current) return;
    if (!currentPrice.bid && !currentPrice.ask) return;
    const js = `window.INTRENDFX_API && window.INTRENDFX_API.setLiveTick(${JSON.stringify(activeSymbol)}, ${currentPrice.bid || 0}, ${currentPrice.ask || 0}); true;`;
    try { chartWebViewRef.current.injectJavaScript(js); } catch (e) {}
  }, [activeSymbol, currentPrice.bid, currentPrice.ask]);

  // Push token / account changes without remounting.
  useEffect(() => {
    if (!chartWebViewRef.current || !chartJwt) return;
    const js = `window.INTRENDFX_API && window.INTRENDFX_API.setToken(${JSON.stringify(chartJwt)}); true;`;
    try { chartWebViewRef.current.injectJavaScript(js); } catch (e) {}
  }, [chartJwt]);

  // When chart signals it's ready, push positions+orders+token immediately.
  const handleChartMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event?.nativeEvent?.data || '{}');
      if (msg.type === 'ready' && chartWebViewRef.current) {
        const js = `
          window.INTRENDFX_API && window.INTRENDFX_API.setToken(${JSON.stringify(chartJwt)});
          window.INTRENDFX_API && window.INTRENDFX_API.setPositions(${JSON.stringify(positionsForChart)}, ${JSON.stringify(ordersForChart)});
          true;`;
        try { chartWebViewRef.current.injectJavaScript(js); } catch (e) {}
      } else if (msg.type === 'orderPlaced' || msg.type === 'positionClosed' || msg.type === 'bracketUpdated' || msg.type === 'orderCancelled') {
        ctx.fetchOpenTrades?.();
        ctx.fetchPendingOrders?.();
        ctx.fetchAccountSummary?.();
      } else if (msg.type === 'error') {
        console.warn('[Chart]', msg.message);
      }
    } catch (e) {}
  }, [positionsForChart, ordersForChart, chartJwt, ctx]);

  const [showNewsTab, setShowNewsTab] = useState(false);

  const tvSymbol = getSymbolForTradingView(activeSymbol);
  const encodedSymbol = encodeURIComponent(tvSymbol);
  const newsUrl = `https://www.tradingview.com/embed-widget/timeline/?locale=en&feedMode=symbol&symbol=${encodedSymbol}&colorTheme=${chartTheme}&isTransparent=true&displayMode=regular&width=100%25&height=100%25`;

  return (
    <View style={[styles.chartContainer, { backgroundColor: colors.bgPrimary }]}>
      {/* Status-bar spacer — keeps network/battery icons cleanly visible on a
          neutral background so the red/green trading bar (or chart tabs) below
          never overlaps the system status bar. */}
      <View style={{ height: insets.top, backgroundColor: colors.bgPrimary }} />

      {/* Quick Trade Bar at TOP - SELL | lot | BUY (toggle in More → "Chart Quick Trade") */}
      {showChartQuickTrade && (
      <View style={[styles.quickTradeBarTop, { paddingTop: 0, backgroundColor: colors.bgCard, borderBottomColor: colors.border, zIndex: 10, elevation: Platform.OS === 'android' ? 8 : 0 }]}>
        {/* SELL Button with Price */}
        <TouchableOpacity
          style={[styles.sellPriceBtn, isExecuting && styles.btnDisabled]}
          onPress={() => executeOneClickTrade('SELL')}
          disabled={isExecuting}
        >
          <Text style={styles.sellLabel}>sell</Text>
          <Text style={styles.sellPrice}>{currentPrice?.bid?.toFixed(decimals) || '-'}</Text>
        </TouchableOpacity>

        {/* Lot Size with +/- */}
        <View style={[styles.lotControlCenter, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity style={styles.lotMinusBtn} onPress={() => { const v = Math.max(0.01, volume - 0.01); setVolume(v); setVolumeText(v.toFixed(2)); }}>
            <Text style={styles.lotControlText}>−</Text>
          </TouchableOpacity>
          <TextInput
            style={[styles.lotCenterInput, { color: colors.textPrimary }]}
            value={volumeText}
            onChangeText={(text) => {
              if (text === '' || /^\d*\.?\d*$/.test(text)) {
                setVolumeText(text);
                const val = parseFloat(text);
                if (!isNaN(val) && val > 0) {
                  setVolume(val);
                }
              }
            }}
            onBlur={() => {
              const val = parseFloat(volumeText);
              if (isNaN(val) || val <= 0) {
                setVolumeText('0.01');
                setVolume(0.01);
              } else {
                setVolume(val);
                setVolumeText(val.toFixed(2));
              }
            }}
            keyboardType="decimal-pad"
            selectTextOnFocus
          />
          <TouchableOpacity style={styles.lotPlusBtn} onPress={() => { const v = volume + 0.01; setVolume(v); setVolumeText(v.toFixed(2)); }}>
            <Text style={styles.lotControlText}>+</Text>
          </TouchableOpacity>
        </View>

        {/* BUY Button with Price */}
        <TouchableOpacity
          style={[styles.buyPriceBtn, isExecuting && styles.btnDisabled]}
          onPress={() => executeOneClickTrade('BUY')}
          disabled={isExecuting}
        >
          <Text style={styles.buyLabel}>buy</Text>
          <Text style={styles.buyPrice}>{currentPrice?.ask?.toFixed(decimals) || '-'}</Text>
        </TouchableOpacity>
      </View>
      )}

      {/* Chart Tabs + NEWS tab — sits cleanly below the status-bar spacer. */}
      <View style={[styles.chartTabsBar, { paddingTop: 4, backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chartTabsScroll}>
          {chartTabs.map(tab => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.chartTab, { backgroundColor: !showNewsTab && activeTabId === tab.id ? (isDark ? '#333' : '#e2e8f0') : colors.bgCard, borderColor: !showNewsTab && activeTabId === tab.id ? colors.border : 'transparent', borderWidth: 1 }]}
              onPress={() => { setActiveTabId(tab.id); setShowNewsTab(false); }}
              onLongPress={() => removeChartTab(tab.id)}
            >
              <Text style={[styles.chartTabText, { color: !showNewsTab && activeTabId === tab.id ? colors.textPrimary : colors.textMuted, fontWeight: !showNewsTab && activeTabId === tab.id ? '700' : '500' }]}>
                {tab.symbol}
              </Text>
              {chartTabs.length > 1 && (
                <TouchableOpacity onPress={() => removeChartTab(tab.id)} style={{ marginLeft: 4 }}>
                  <Ionicons name="close" size={14} color={colors.textMuted} />
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          style={styles.addChartBtn}
          onPress={() => {
            resetChartSymbolPicker();
            setShowSymbolPicker(true);
          }}
        >
          <Ionicons name="add" size={20} color={colors.textMuted} />
        </TouchableOpacity>
        {/* NEWS tab */}
        <TouchableOpacity
          style={{
            paddingHorizontal: 14,
            paddingVertical: 8,
            backgroundColor: showNewsTab ? (isDark ? '#333' : '#e2e8f0') : colors.bgCard,
            borderRadius: 6,
            marginRight: 8,
            borderWidth: 1,
            borderColor: showNewsTab ? colors.border : 'transparent',
          }}
          onPress={() => setShowNewsTab(!showNewsTab)}
        >
          <Text style={{ color: showNewsTab ? colors.textPrimary : colors.textMuted, fontSize: 13, fontWeight: showNewsTab ? '700' : '500' }}>NEWS</Text>
        </TouchableOpacity>
      </View>

      {/* Chart or News Content */}
      {showNewsTab ? (
        <View style={{ flex: 1, backgroundColor: chartBg }}>
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : colors.border,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600' }}>LIVE NEWS</Text>
              <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700' }}>{activeSymbol}</Text>
            </View>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>TradingView</Text>
          </View>
          <WebView
            key={`news-${activeSymbol}-${isDark}`}
            source={{ uri: newsUrl }}
            style={{ flex: 1, backgroundColor: chartBg }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            scrollEnabled={true}
            originWhitelist={['*']}
            mixedContentMode="always"
            startInLoadingState={true}
            renderLoading={() => (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: chartBg }}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 10 }}>Loading news...</Text>
              </View>
            )}
          />
        </View>
      ) : (
        <View style={[styles.chartWrapper, { zIndex: 0 }]}>
          {/* Simple TradingView embed widget (tv.js) — public-data candles. */}
          <WebView
            ref={chartWebViewRef}
            key={`tv-${activeSymbol}-${isDark}`}
            source={{ html: chartHtml }}
            style={{ flex: 1, backgroundColor: chartBg }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            scrollEnabled={false}
            originWhitelist={['*']}
            mixedContentMode="always"
            allowsInlineMediaPlayback={true}
            androidLayerType="hardware"
          />
        </View>
      )}

      {/* Order Panel Slide Up */}
      <Modal visible={showOrderPanel} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.orderSlidePanel}>
            <View style={styles.orderPanelHandle} />
            <View style={styles.orderPanelHeader}>
              <Text style={styles.orderPanelTitle}>{activeSymbol}</Text>
              <TouchableOpacity onPress={() => setShowOrderPanel(false)}>
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Side Toggle */}
            <View style={styles.sideToggle}>
              <TouchableOpacity 
                style={[styles.sideBtn, orderSide === 'SELL' && styles.sideBtnSell]}
                onPress={() => setOrderSide('SELL')}
              >
                <Text style={styles.sideBtnText}>SELL</Text>
                <Text style={styles.sideBtnPrice}>{currentPrice?.bid?.toFixed(decimals) || '-'}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.sideBtn, orderSide === 'BUY' && styles.sideBtnBuy]}
                onPress={() => setOrderSide('BUY')}
              >
                <Text style={styles.sideBtnText}>BUY</Text>
                <Text style={styles.sideBtnPrice}>{currentPrice?.ask?.toFixed(decimals) || '-'}</Text>
              </TouchableOpacity>
            </View>

            {/* Volume */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Volume (Lots)</Text>
              <View style={styles.volumeInput}>
                <TouchableOpacity style={styles.volumeBtn} onPress={() => setVolume(Math.max(0.01, volume - 0.01))}>
                  <Ionicons name="remove" size={20} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.volumeValue}>{volume.toFixed(2)}</Text>
                <TouchableOpacity style={styles.volumeBtn} onPress={() => setVolume(volume + 0.01)}>
                  <Ionicons name="add" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* SL/TP for Challenge Accounts */}
            {ctx.isChallengeMode && ctx.selectedChallengeAccount && (
              <View style={styles.slTpRow}>
                <View style={styles.slTpInputGroup}>
                  <Text style={[styles.inputLabel, ctx.selectedChallengeAccount.challengeId?.rules?.stopLossMandatory && { color: '#f59e0b' }]}>
                    Stop Loss {ctx.selectedChallengeAccount.challengeId?.rules?.stopLossMandatory ? '*' : ''}
                  </Text>
                  <TextInput
                    style={[styles.slTpInput, { backgroundColor: '#333333', color: '#fff', borderColor: '#333' }]}
                    value={stopLoss}
                    onChangeText={(text) => setStopLoss(text.replace(/[^0-9.]/g, ''))}
                    placeholder="0.00"
                    placeholderTextColor="#666"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View style={styles.slTpInputGroup}>
                  <Text style={styles.inputLabel}>Take Profit</Text>
                  <TextInput
                    style={[styles.slTpInput, { backgroundColor: '#333333', color: '#fff', borderColor: '#333' }]}
                    value={takeProfit}
                    onChangeText={(text) => setTakeProfit(text.replace(/[^0-9.]/g, ''))}
                    placeholder="0.00"
                    placeholderTextColor="#666"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>
            )}

            {/* Execute Button */}
            <TouchableOpacity 
              style={[styles.executeBtn, { backgroundColor: orderSide === 'BUY' ? '#22c55e' : '#ef4444' }, isExecuting && { opacity: 0.6 }]}
              onPress={executeTrade}
              disabled={isExecuting}
            >
              {isExecuting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.executeBtnText}>
                  {orderSide} {volume.toFixed(2)} {activeSymbol}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Symbol Picker Modal - segment first, then symbols (themed) */}
      <Modal
        visible={showSymbolPicker}
        animationType="slide"
        transparent
        onRequestClose={() => {
          setShowSymbolPicker(false);
          resetChartSymbolPicker();
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.symbolPickerModal, { backgroundColor: colors.bgCard }]}>
            <View style={[styles.symbolPickerHeader, { borderBottomColor: colors.border }]}>
              <View style={styles.symbolPickerHeaderLeft}>
                {chartAddStep === 'symbols' ? (
                  <TouchableOpacity
                    onPress={() => {
                      setChartAddStep('segments');
                      setChartAddSegment(null);
                    }}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    style={styles.symbolPickerBackBtn}
                  >
                    <Ionicons name="chevron-back" size={24} color={colors.textPrimary} />
                  </TouchableOpacity>
                ) : null}
                <Text style={[styles.symbolPickerTitle, { color: colors.textPrimary }]}>
                  {chartAddStep === 'segments' ? 'Add Chart' : chartAddSegment || 'Symbols'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setShowSymbolPicker(false);
                  resetChartSymbolPicker();
                }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Ionicons name="close" size={24} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              {chartAddStep === 'segments'
                ? CHART_ADD_SYMBOL_SEGMENTS.map((seg) => (
                    <TouchableOpacity
                      key={seg}
                      style={[styles.chartAddSegmentRow, { borderBottomColor: colors.border }]}
                      onPress={() => {
                        setChartAddSegment(seg);
                        setChartAddStep('symbols');
                      }}
                    >
                      <Text style={[styles.chartAddSegmentLabel, { color: colors.textPrimary }]}>{seg}</Text>
                      <View style={styles.chartAddSegmentRight}>
                        <Text style={[styles.chartAddSegmentCount, { color: colors.textMuted, marginRight: 8 }]}>
                          {segmentSymbolCounts[seg] ?? 0}
                        </Text>
                        <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                      </View>
                    </TouchableOpacity>
                  ))
                : instrumentsInChartSegment.length === 0 ? (
                    <View style={styles.chartAddEmptyWrap}>
                      <Text style={[styles.chartAddEmptyText, { color: colors.textMuted }]}>
                        No symbols in this segment
                      </Text>
                    </View>
                  ) : (
                    instrumentsInChartSegment.map((inst) => {
                      const onChart = chartTabs.some((t) => t.symbol === inst.symbol);
                      return (
                        <TouchableOpacity
                          key={inst.symbol}
                          style={[
                            styles.symbolPickerItem,
                            { borderBottomColor: colors.border },
                            onChart && { backgroundColor: isDark ? `${colors.primary}18` : `${colors.primary}14` },
                          ]}
                          onPress={() => addNewChartTab(inst.symbol)}
                        >
                          <View>
                            <Text style={[styles.symbolPickerSymbol, { color: colors.textPrimary }]}>{inst.symbol}</Text>
                            <Text style={[styles.symbolPickerName, { color: colors.textMuted }]}>{inst.name}</Text>
                          </View>
                          {onChart ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                        </TouchableOpacity>
                      );
                    })
                  )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Chart SL Modal for Challenge Accounts */}
      <Modal visible={showChartSlModal} animationType="fade" transparent onRequestClose={() => setShowChartSlModal(false)}>
        <View style={styles.quickSlModalOverlay}>
          <View style={[styles.quickSlModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={styles.quickSlModalHeader}>
              <Ionicons name="warning" size={24} color="#f59e0b" />
              <Text style={[styles.quickSlModalTitle, { color: colors.textPrimary }]}>Stop Loss Required</Text>
            </View>
            <Text style={[styles.quickSlModalSubtitle, { color: colors.textMuted }]}>
              Stop Loss is mandatory for challenge accounts. Please set a stop loss price before placing your trade.
            </Text>
            
            <View style={styles.quickSlInputContainer}>
              <Text style={[styles.quickSlInputLabel, { color: colors.textMuted }]}>Stop Loss Price</Text>
              <TextInput
                style={[styles.quickSlInput, { backgroundColor: colors.bgSecondary, color: colors.textPrimary, borderColor: colors.border }]}
                value={chartSlValue}
                onChangeText={(text) => setChartSlValue(text.replace(/[^0-9.]/g, ''))}
                placeholder={`e.g. ${pendingChartTradeSide === 'BUY' 
                  ? (currentPrice?.bid * 0.99)?.toFixed(decimals) 
                  : (currentPrice?.ask * 1.01)?.toFixed(decimals)}`}
                placeholderTextColor={colors.textMuted}
                keyboardType="numbers-and-punctuation"
              />
              <Text style={[styles.quickSlHint, { color: colors.textMuted }]}>
                Current {pendingChartTradeSide === 'BUY' ? 'Bid' : 'Ask'}: {pendingChartTradeSide === 'BUY' 
                  ? currentPrice?.bid?.toFixed(decimals) 
                  : currentPrice?.ask?.toFixed(decimals)}
              </Text>
            </View>

            <View style={styles.quickSlModalButtons}>
              <TouchableOpacity 
                style={[styles.quickSlCancelBtn, { backgroundColor: colors.bgSecondary }]}
                onPress={() => {
                  setShowChartSlModal(false);
                  setPendingChartTradeSide(null);
                  setChartSlValue('');
                }}
              >
                <Text style={[styles.quickSlCancelBtnText, { color: colors.textPrimary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.quickSlConfirmBtn, { backgroundColor: pendingChartTradeSide === 'BUY' ? '#22c55e' : '#ef4444' }]}
                onPress={() => {
                  if (!chartSlValue || isNaN(parseFloat(chartSlValue))) {
                    toast?.showToast('Please enter a valid stop loss price', 'warning');
                    return;
                  }
                  setShowChartSlModal(false);
                  // Execute trade with SL
                  executeOneClickTrade(pendingChartTradeSide, chartSlValue);
                  setPendingChartTradeSide(null);
                  setChartSlValue('');
                }}
              >
                <Text style={styles.quickSlConfirmBtnText}>
                  {pendingChartTradeSide === 'BUY' ? 'BUY' : 'SELL'} with SL
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

// MORE TAB - Matching screenshot exactly
const MoreTab = ({ navigation }) => {
  const ctx = React.useContext(TradingContext);
  const { colors, isDark, toggleTheme } = useTheme();
  const { showChartQuickTrade, toggleChartQuickTrade } = useSettings();
  const parentNav = navigation.getParent();
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const handleCheckUpdate = async () => {
    if (checkingUpdate) return;
    if (__DEV__) {
      Alert.alert('Dev mode', 'OTA updates only work in release/preview builds.');
      return;
    }
    setCheckingUpdate(true);
    try {
      const res = await Updates.checkForUpdateAsync();
      if (res?.isAvailable) {
        await Updates.fetchUpdateAsync();
        Alert.alert(
          'Update available',
          'A new update has been downloaded. Restart now to apply?',
          [
            { text: 'Later', style: 'cancel' },
            { text: 'Restart', onPress: () => Updates.reloadAsync() },
          ]
        );
      } else {
        Alert.alert('Up to date', 'You are already on the latest version.');
      }
    } catch (e) {
      console.warn('OTA check failed:', e?.message || e);
      Alert.alert('Up to date', 'You are already on the latest version.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  const menuItems = [
    { icon: 'book-outline', label: 'Orders', screen: 'OrderBook', isTab: false, color: colors.primary },
    { icon: 'wallet-outline', label: 'Wallet', screen: 'Wallet', isTab: false, color: colors.primary },
    { icon: 'bar-chart-outline', label: 'PAMM / MAM', screen: 'Pamm', isTab: false, color: '#06b6d4' },
    { icon: 'calculator-outline', label: 'Risk Calculator', screen: 'RiskCalculator', isTab: false, color: '#f59e0b' },
    { icon: 'calendar-outline', label: 'Economic Calendar', screen: 'EconomicCalendar', isTab: false, color: '#ef4444' },
    { icon: 'school-outline', label: 'Academy', screen: 'Academy', isTab: false, color: '#2196f3' },
    { icon: 'receipt-outline', label: 'Transaction History', screen: 'TransactionHistory', isTab: false, color: '#a855f7' },
    { icon: 'people-circle-outline', label: 'Social', screen: 'Social', isTab: false, color: colors.primary },
    { icon: 'briefcase-outline', label: 'Business', screen: 'Business', params: { initialTab: 'ib' }, isTab: false, color: colors.primary },
    { icon: 'person-outline', label: 'Profile', screen: 'Profile', isTab: false, color: colors.primary },
    { icon: 'help-circle-outline', label: 'Support', screen: 'Support', isTab: false, color: colors.primary },
    { icon: 'document-text-outline', label: 'Instructions', screen: 'Instructions', isTab: false, color: colors.primary },
  ];

  const handleNavigate = (screen, isTab, params) => {
    if (isTab) {
      navigation.navigate(screen, params);
    } else if (parentNav) {
      parentNav.navigate(screen, params);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Header */}
      <View style={[styles.moreMenuHeader, { backgroundColor: colors.bgPrimary }]}>
        <Text style={[styles.moreMenuTitle, { color: colors.textPrimary }]}>More</Text>
      </View>

      {/* Menu Items */}
      <ScrollView style={styles.moreMenuList}>
        {menuItems.map((item, index) => (
          <TouchableOpacity key={index} style={[styles.moreMenuItem, { borderBottomColor: colors.border }]} onPress={() => handleNavigate(item.screen, item.isTab, item.params)}>
            <View style={[styles.moreMenuIcon, { backgroundColor: `${item.color}20` }]}>
              <Ionicons name={item.icon} size={20} color={item.color} />
            </View>
            <Text style={[styles.moreMenuItemText, { color: colors.textPrimary }]}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        ))}

        {/* Check for Updates */}
        <TouchableOpacity
          style={[styles.moreMenuItem, { borderBottomColor: colors.border }]}
          onPress={handleCheckUpdate}
          disabled={checkingUpdate}
          activeOpacity={0.7}
        >
          <View style={[styles.moreMenuIcon, { backgroundColor: `${colors.primary}20` }]}>
            <Ionicons name="cloud-download-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.moreMenuItemText, { color: colors.textPrimary }]}>Check for Updates</Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
              {checkingUpdate ? 'Checking…' : `App version ${(Updates.runtimeVersion || '1.0.0')}`}
            </Text>
          </View>
          {checkingUpdate ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          )}
        </TouchableOpacity>

        {/* Dark/Light Mode Toggle */}
        <View style={[styles.themeToggleItem, { borderBottomColor: colors.border }]}>
          <View style={[styles.moreMenuIcon, { backgroundColor: `${colors.primary}20` }]}>
            <Ionicons name={isDark ? 'moon' : 'sunny'} size={20} color={colors.primary} />
          </View>
          <Text style={[styles.moreMenuItemText, { color: colors.textPrimary }]}>Dark Mode</Text>
          <TouchableOpacity
            style={[styles.themeToggle, { backgroundColor: isDark ? colors.primary : colors.border }, isDark && styles.themeToggleActive]}
            onPress={toggleTheme}
          >
            <View style={[styles.themeToggleThumb, isDark && styles.themeToggleThumbActive]} />
          </TouchableOpacity>
        </View>

        {/* Chart Quick Trade (Buy/Sell bar) Toggle */}
        <View style={[styles.themeToggleItem, { borderBottomColor: colors.border }]}>
          <View style={[styles.moreMenuIcon, { backgroundColor: `${colors.primary}20` }]}>
            <Ionicons name="flash-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.moreMenuItemText, { color: colors.textPrimary }]}>Chart Quick Trade</Text>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
              Show one-click Buy/Sell bar above the chart
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.themeToggle, { backgroundColor: showChartQuickTrade ? colors.primary : colors.border }, showChartQuickTrade && styles.themeToggleActive]}
            onPress={toggleChartQuickTrade}
          >
            <View style={[styles.themeToggleThumb, showChartQuickTrade && styles.themeToggleThumbActive]} />
          </TouchableOpacity>
        </View>

        {/* Logout */}
        <TouchableOpacity style={[styles.moreMenuItem, { borderBottomColor: colors.border }]} onPress={ctx.logout}>
          <View style={[styles.moreMenuIcon, { backgroundColor: `${colors.primary}20` }]}>
            <Ionicons name="log-out-outline" size={20} color={colors.primary} />
          </View>
          <Text style={[styles.moreMenuItemText, { color: colors.primary }]}>Log Out</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

// Tab Navigator with theme support
const ThemedTabNavigator = () => {
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const ctx = React.useContext(TradingContext);

  const bottomPadding = Math.max(insets.bottom, 10);
  const tabActive = isDark ? '#50A5F1' : colors.primary;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.tabBarBg,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 64 + bottomPadding,
          paddingBottom: bottomPadding,
          paddingTop: 6,
          elevation: 0,
        },
        tabBarActiveTintColor: tabActive,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginBottom: 2 },
        tabBarIcon: ({ focused, color, size }) => {
          if (route.name === 'Home') {
            return <Ionicons name={focused ? 'home' : 'home-outline'} size={24} color={color} />;
          } else if (route.name === 'Markets') {
            return <MaterialCommunityIcons name="finance" size={24} color={color} />;
          } else if (route.name === 'Chart') {
            return (
              <View style={{
                width: 52, height: 52, borderRadius: 16, backgroundColor: isDark ? '#1e1e1e' : '#f0f0f0',
                justifyContent: 'center', alignItems: 'center', marginBottom: 20,
                shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
                borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              }}>
                <MaterialCommunityIcons name="chart-line-variant" size={28} color={color} />
              </View>
            );
          } else if (route.name === 'Trade') {
            return <MaterialCommunityIcons name="swap-vertical-bold" size={23} color={color} />;
          } else if (route.name === 'More') {
            return <Ionicons name="ellipsis-horizontal" size={24} color={color} />;
          }
          return <Ionicons name="help" size={size} color={color} />;
        },
      })}
      screenListeners={({ route }) => ({
        tabPress: () => {
          ctx.setCurrentMainTab(route.name);
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeTab} />
      <Tab.Screen name="Markets" component={QuotesTab} />
      <Tab.Screen name="Chart" component={ChartTab} />
      <Tab.Screen name="Trade" component={TradeTab} />
      <Tab.Screen name="More" component={MoreTab} />
    </Tab.Navigator>
  );
};

// MAIN SCREEN
const MainTradingScreen = ({ navigation, route }) => {
  return (
    <ToastProvider>
      <TradingProvider navigation={navigation} route={route}>
        <ThemedTabNavigator />
      </TradingProvider>
    </ToastProvider>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' },
  tabBar: { backgroundColor: '#121212', borderTopColor: '#333333', height: 60, paddingBottom: 8 },
  
  // Banner Slider
  bannerContainer: { marginHorizontal: 16, marginBottom: 16, borderRadius: 12, overflow: 'hidden' },
  bannerSlide: { width: Dimensions.get('window').width - 32, height: 140 },
  bannerImage: { width: '100%', height: '100%', borderRadius: 12 },
  bannerDots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', position: 'absolute', bottom: 10, left: 0, right: 0, gap: 6 },
  bannerDot: { width: 8, height: 8, borderRadius: 4 },

  // Home
  homeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 50 },
  greeting: { color: '#666', fontSize: 14 },
  userName: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  notificationBtn: { padding: 10, backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#222', position: 'relative' },
  notificationBadge: { position: 'absolute', top: 4, right: 4, backgroundColor: '#ef4444', width: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  notificationBadgeText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  
  accountCard: { margin: 16, padding: 16, backgroundColor: '#141414', borderRadius: 16, borderWidth: 1, borderColor: '#1e1e1e' },
  accountCardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  accountIconContainer: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1a73e820', justifyContent: 'center', alignItems: 'center' },
  accountInfo: { flex: 1, marginLeft: 12 },
  accountId: { color: '#fff', fontSize: 16, fontWeight: '600' },
  accountType: { color: '#666', fontSize: 12, marginTop: 2 },
  challengeBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  challengeBadgeText: { fontSize: 10, fontWeight: '700' },
  challengeInfoBar: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  challengeInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  challengeInfoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  challengeInfoRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  challengeInfoName: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 120,
  },
  challengeInfoPhase: {
    color: '#f59e0b',
    fontSize: 11,
    fontWeight: '600',
  },
  challengeInfoLabel: {
    color: '#888',
    fontSize: 11,
  },
  challengeInfoValue: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  failedReasonContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: '#ef444420', 
    padding: 12, 
    borderRadius: 10, 
    marginBottom: 12,
    gap: 8
  },
  failedReasonText: { 
    color: '#ef4444', 
    fontSize: 13, 
    flex: 1,
    fontWeight: '500'
  },
  balanceRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  balanceLabel: { color: '#666', fontSize: 11, marginBottom: 2 },
  balanceValue: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  equityValue: { fontSize: 20, fontWeight: 'bold' },
  pnlRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1e1e1e' },
  pnlValue: { fontSize: 16, fontWeight: '600' },
  freeMarginValue: { fontSize: 16, fontWeight: '600' },
  cardActionButtons: { flexDirection: 'row', gap: 8, marginTop: 4 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 16, borderTopWidth: 1, borderTopColor: '#1e1e1e' },
  statItem: { flex: 1 },
  statLabel: { color: '#666', fontSize: 12, marginBottom: 4 },
  statValue: { color: '#fff', fontSize: 16, fontWeight: '600' },
  
  // Deposit/Withdraw Buttons
  actionButtons: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 12 },
  depositBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, backgroundColor: '#1a73e8', borderRadius: 12 },
  depositBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  withdrawBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, backgroundColor: '#0f0f0f', borderRadius: 12, borderWidth: 1, borderColor: '#2a2a2a' },
  withdrawBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  
  // Quick Actions Grid - 8 stylish buttons
  quickActionsGrid: { 
    flexDirection: 'row', 
    flexWrap: 'wrap', 
    paddingHorizontal: 16, 
    paddingVertical: 12,
    justifyContent: 'space-between'
  },
  quickActionBtn: { 
    width: '23%', 
    alignItems: 'center', 
    paddingVertical: 14,
    marginBottom: 12
  },
  quickActionBtnLabel: { 
    color: '#a0a0a0', 
    fontSize: 11, 
    fontWeight: '500', 
    marginTop: 6 
  },
  // Legacy styles (kept for compatibility)
  quickActionsRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  quickActionCard: { flex: 1, alignItems: 'center', paddingVertical: 16, backgroundColor: '#1E1E1E', borderRadius: 12, borderWidth: 1, borderColor: '#333333' },
  quickActionIconBg: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  quickActionLabel: { color: '#fff', fontSize: 11, fontWeight: '500' },
  
  // Section Header
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  seeAllText: { color: '#1a73e8', fontSize: 13, fontWeight: '500' },
  
  // Copy Trade Masters Section
  mastersSection: { marginHorizontal: 16, marginTop: 16 },
  mastersScroll: { marginLeft: -4 },
  masterCard: { 
    width: 100, 
    backgroundColor: '#0f0f0f', 
    borderRadius: 12, 
    padding: 12, 
    marginLeft: 8, 
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333333'
  },
  masterCardHeader: { position: 'relative', marginBottom: 8 },
  masterAvatar: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: '#1a73e830', 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  masterAvatarText: { color: '#1a73e8', fontSize: 18, fontWeight: 'bold' },
  followingBadgeSmall: { 
    position: 'absolute', 
    bottom: -2, 
    right: -2, 
    width: 18, 
    height: 18, 
    borderRadius: 9, 
    backgroundColor: '#22c55e20', 
    justifyContent: 'center', 
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#111'
  },
  masterName: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  masterProfit: { color: '#22c55e', fontSize: 14, fontWeight: 'bold', marginTop: 4 },
  masterFollowers: { color: '#666', fontSize: 10, marginTop: 2 },
  
  // Market Data Section
  marketDataSection: { marginHorizontal: 16, marginTop: 20 },
  marketTabs: { flexDirection: 'row', backgroundColor: '#0f0f0f', borderRadius: 10, padding: 4, marginBottom: 12 },
  marketTab: { 
    flex: 1, 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 4, 
    paddingVertical: 8, 
    borderRadius: 8 
  },
  marketTabActive: { backgroundColor: '#1a73e8' },
  marketTabText: { color: '#888', fontSize: 12, fontWeight: '600' },
  marketTabTextActive: { color: '#fff' },
  marketList: {},
  marketItem: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingVertical: 12, 
    borderBottomWidth: 1, 
    borderBottomColor: '#333333' 
  },
  marketItemLeft: {},
  marketSymbol: { color: '#fff', fontSize: 14, fontWeight: '600' },
  marketName: { color: '#666', fontSize: 11, marginTop: 2, maxWidth: 150 },
  marketItemRight: { alignItems: 'flex-end' },
  marketPrice: { color: '#fff', fontSize: 14, fontWeight: '600' },
  changeBadge: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 2, 
    paddingHorizontal: 6, 
    paddingVertical: 2, 
    borderRadius: 4, 
    marginTop: 4 
  },
  changeText: { fontSize: 11, fontWeight: '600' },
  
  // Empty Watchlist Home
  emptyWatchlistHome: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 30,
  },
  emptyWatchlistHomeText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 10,
  },
  emptyWatchlistHomeHint: {
    color: '#555',
    fontSize: 12,
    marginTop: 4,
  },

  sparklineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 32,
    gap: 2,
    marginTop: 8,
    alignSelf: 'stretch',
  },
  sparklineBar: { flex: 1, borderRadius: 1, opacity: 0.9 },

  vantageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  vantageHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  vantageHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  vantageLogoMark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  vantageLogoLetter: { color: '#ffffff', fontSize: 18, fontWeight: '800' },
  liveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  liveChipText: { fontSize: 14, fontWeight: '600' },
  headerIconBtn: { padding: 10 },

  verifyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 8,
  },
  verifyStripText: { flex: 1, fontSize: 13, fontWeight: '500' },
  verifyStripCta: { color: '#fb923c', fontSize: 13, fontWeight: '700' },

  heroBlock: { paddingHorizontal: 20, paddingBottom: 16 },
  heroEquityLabel: { fontSize: 13, marginBottom: 4 },
  heroEquityValue: { fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  heroHeadline: { fontSize: 17, fontWeight: '700', marginTop: 14, lineHeight: 22 },
  heroSub: { fontSize: 14, marginTop: 6, lineHeight: 20 },
  heroWelcome: { fontSize: 14, marginTop: 10 },
  heroSetupBtn: {
    marginTop: 16,
    alignSelf: 'flex-start',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
  },
  heroSetupBtnText: { fontSize: 16, fontWeight: '700' },

  vantageQuickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
  },
  vantageQuickItem: { flex: 1, alignItems: 'center', maxWidth: '25%' },
  vantageQuickIconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  vantageQuickLabel: { fontSize: 11, fontWeight: '600', textAlign: 'center' },

  copyTradingTitle: { fontSize: 17, fontWeight: '700' },
  masterCardVantage: {
    width: 148,
    borderRadius: 14,
    padding: 12,
    marginLeft: 10,
    borderWidth: 1,
    alignItems: 'stretch',
  },
  masterCardTopRow: { position: 'relative', marginBottom: 8, alignSelf: 'stretch' },
  masterNameVantage: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  masterReturnPct: { fontSize: 20, fontWeight: '800' },
  masterReturnLabel: { fontSize: 11, marginTop: 2 },

  vantageMarketTabsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 4,
    marginBottom: 14,
    gap: 20,
  },
  vantageMarketTabHit: { paddingBottom: 8 },
  vantageMarketTabText: { fontSize: 15 },
  vantageMarketTabUnderline: { height: 3, borderRadius: 2, marginTop: 6 },

  marketGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 10,
  },
  marketGridCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginBottom: 4,
  },
  gridSymbol: { fontSize: 15, fontWeight: '700' },
  gridName: { fontSize: 11, marginTop: 2 },
  gridBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  gridCategory: { fontSize: 11, fontWeight: '500', flex: 1 },
  gridPrice: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  gridChangePill: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  addWatchlistPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 18,
    marginBottom: 8,
    paddingVertical: 12,
    borderRadius: 24,
    borderWidth: 1,
    alignSelf: 'center',
    paddingHorizontal: 22,
  },
  addWatchlistPillText: { fontSize: 15, fontWeight: '600' },
  
  // Master Detail Modal
  masterDetailModal: { 
    backgroundColor: '#111', 
    borderTopLeftRadius: 24, 
    borderTopRightRadius: 24, 
    padding: 20, 
    paddingBottom: 40,
    maxHeight: '80%'
  },
  modalHandle: { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  masterModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  masterModalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  masterProfileCard: { alignItems: 'center', marginBottom: 20 },
  masterProfileAvatar: { 
    width: 80, 
    height: 80, 
    borderRadius: 40, 
    backgroundColor: '#1a73e830', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginBottom: 12
  },
  masterProfileAvatarText: { color: '#1a73e8', fontSize: 32, fontWeight: 'bold' },
  masterProfileName: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  masterProfileBio: { color: '#888', fontSize: 13, textAlign: 'center', marginTop: 8, paddingHorizontal: 20 },
  followingBadgeLarge: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 6, 
    backgroundColor: '#22c55e20', 
    paddingHorizontal: 12, 
    paddingVertical: 6, 
    borderRadius: 20, 
    marginTop: 12 
  },
  followingBadgeLargeText: { color: '#22c55e', fontSize: 12, fontWeight: '600' },
  masterStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  masterStatBox: { 
    flex: 1, 
    minWidth: '45%', 
    backgroundColor: '#121212', 
    borderRadius: 12, 
    padding: 14, 
    alignItems: 'center' 
  },
  masterStatLabel: { color: '#666', fontSize: 11 },
  masterStatValue: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: 4 },
  followMasterBtn: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 8, 
    backgroundColor: '#1a73e8', 
    paddingVertical: 14, 
    borderRadius: 12 
  },
  followMasterBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  alreadyFollowingBox: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 8, 
    backgroundColor: '#22c55e20', 
    paddingVertical: 14, 
    borderRadius: 12 
  },
  alreadyFollowingText: { color: '#22c55e', fontSize: 14, fontWeight: '600' },
  viewFullProfileBtn: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'center', 
    gap: 6, 
    marginTop: 16, 
    paddingVertical: 12 
  },
  viewFullProfileText: { color: '#1a73e8', fontSize: 14, fontWeight: '600' },
  
  // MarketWatch News Section
  marketWatchSection: { marginHorizontal: 16, marginTop: 16 },
  marketWatchHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  marketWatchTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  marketWatchTitle: { color: '#fff', fontSize: 18, fontWeight: '600' },
  liveIndicator: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ef444420', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#ef4444', marginRight: 4 },
  liveText: { color: '#ef4444', fontSize: 10, fontWeight: '700' },
  newsCardsContainer: { paddingRight: 16, gap: 12 },
  newsCardsVertical: { gap: 16 },
  newsCard: { width: 280, backgroundColor: '#111', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#222' },
  newsCardVertical: { flexDirection: 'row', backgroundColor: '#111', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#222', marginBottom: 12 },
  newsCardFull: { width: '100%', backgroundColor: '#111', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#222' },
  newsCardImage: { width: '100%', height: 180, backgroundColor: '#333333' },
  newsCardImageVertical: { width: 140, height: 140, backgroundColor: '#333333' },
  newsCardImageFull: { width: '100%', height: 200, backgroundColor: '#333333' },
  newsCardContent: { padding: 14 },
  newsCardContentVertical: { flex: 1, padding: 14, justifyContent: 'space-between' },
  newsCardContentFull: { padding: 14 },
  newsCardMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  newsCategoryBadge: { backgroundColor: '#1a73e820', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  newsCategoryText: { color: '#1a73e8', fontSize: 11, fontWeight: '600' },
  newsTime: { color: '#666', fontSize: 11 },
  newsCardTitle: { color: '#fff', fontSize: 14, fontWeight: '600', lineHeight: 20, marginBottom: 6 },
  newsCardDesc: { color: '#888', fontSize: 12, lineHeight: 17, marginBottom: 10 },
  newsCardFooter: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  newsSource: { color: '#888', fontSize: 11, flex: 1 },
  newsLoadingContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 30, gap: 10 },
  newsLoadingText: { color: '#666', fontSize: 14 },
  marketWatchNewsContainer: { height: 450, borderRadius: 16, overflow: 'hidden', borderWidth: 1 },
  marketWatchWebView: { flex: 1, backgroundColor: 'transparent' },
  newsListContainer: { gap: 12 },
  newsCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  newsTimeText: { color: '#666', fontSize: 11 },
  newsCardSummary: { color: '#888', fontSize: 13, lineHeight: 18, marginBottom: 10 },
  newsSourceRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  newsSourceText: { color: '#888', fontSize: 12 },
  
  // Positions Card
  positionsCard: { margin: 16, padding: 16, backgroundColor: '#1E1E1E', borderRadius: 16, borderWidth: 1, borderColor: '#333333' },
  positionsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  positionsTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  positionsCount: { color: '#1a73e8', fontSize: 14 },
  noPositionsText: { color: '#666', fontSize: 14, textAlign: 'center', paddingVertical: 16 },
  positionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, backgroundColor: '#1E1E1E', borderRadius: 12, marginBottom: 8 },
  positionSide: { fontSize: 12, marginTop: 2 },
  positionPnlValue: { fontSize: 16, fontWeight: '600' },
  viewAllText: { color: '#1a73e8', fontSize: 14, textAlign: 'center', paddingTop: 8 },
  
  // News Section (Home Tab)
  newsSection: { margin: 16, marginTop: 8 },
  newsSectionTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  newsTabs: { flexDirection: 'row', backgroundColor: '#1E1E1E', borderRadius: 12, padding: 4, marginBottom: 12, borderWidth: 1, borderColor: '#333333' },
  newsTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10 },
  newsTabActive: { backgroundColor: '#1E1E1E' },
  newsTabText: { color: '#666', fontSize: 12, fontWeight: '500' },
  newsTabTextActive: { color: '#1a73e8' },
  newsContent: {},
  newsItem: { backgroundColor: '#1E1E1E', borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#333333' },
  newsCategory: { backgroundColor: '#1a73e820', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, alignSelf: 'flex-start', marginBottom: 8 },
  newsCategoryText: { color: '#1a73e8', fontSize: 11, fontWeight: '600' },
  newsTitle: { color: '#fff', fontSize: 14, fontWeight: '500', lineHeight: 20, marginBottom: 8 },
  newsMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  newsSource: { color: '#888', fontSize: 12 },
  newsTime: { color: '#666', fontSize: 12 },
  calendarContent: { backgroundColor: '#1E1E1E', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#333333' },
  calendarHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, backgroundColor: '#1E1E1E', borderBottomWidth: 1, borderBottomColor: '#333333' },
  calendarHeaderText: { color: '#666', fontSize: 11, fontWeight: '600', width: 50, textAlign: 'center' },
  calendarRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#333333' },
  calendarTime: { color: '#fff', fontSize: 12, fontWeight: '500', width: 50, textAlign: 'center' },
  currencyBadge: { backgroundColor: '#1a73e820', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, width: 50, alignItems: 'center' },
  currencyText: { color: '#1a73e8', fontSize: 11, fontWeight: '600' },
  eventName: { color: '#fff', fontSize: 13, fontWeight: '500' },
  eventForecast: { color: '#666', fontSize: 10, marginTop: 2 },
  impactDot: { width: 10, height: 10, borderRadius: 5 },
  
  // TradingView Widget Container
  tradingViewContainer: { height: 700, backgroundColor: '#1E1E1E', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#333333' },
  tradingViewWebView: { flex: 1, backgroundColor: '#1E1E1E' },
  webViewLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1E1E1E' },
  webViewLoadingText: { color: '#666', fontSize: 12, marginTop: 8 },
  
  section: { padding: 16 },
  sectionTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 12 },
  emptyState: { alignItems: 'center', padding: 40 },
  emptyText: { color: '#666', marginTop: 12 },
  
  tradeItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#1E1E1E', borderRadius: 12, marginBottom: 8, borderWidth: 1, borderColor: '#333333' },
  tradeLeft: {},
  tradeSymbol: { color: '#fff', fontSize: 16, fontWeight: '600' },
  tradeSide: { fontSize: 12, marginTop: 4 },
  tradePnl: { fontSize: 16, fontWeight: '600' },
  
  // Quotes/Market - Venta Black Style (Responsive)
  searchContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginHorizontal: 12, 
    marginTop: 50, 
    marginBottom: 10, 
    paddingHorizontal: 12, 
    paddingVertical: 10, 
    backgroundColor: '#1E1E1E', 
    borderRadius: 10,
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#333333',
  },
  searchInput: { flex: 1, marginLeft: 8, color: '#fff', fontSize: 14, paddingVertical: 0 },
  
  // Market Section - New Styles
  marketSearchContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginHorizontal: 12, 
    marginTop: 50, 
    marginBottom: 12, 
    paddingHorizontal: 14, 
    paddingVertical: 12, 
    backgroundColor: '#1E1E1E', 
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#333333',
  },
  marketTabsContainer: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginBottom: 12,
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 4,
  },
  marketTabBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
  },
  marketTabBtnActive: {
    backgroundColor: '#1a73e8',
  },
  marketTabText: {
    color: '#666',
    fontSize: 14,
    fontWeight: '600',
  },
  marketTabTextActive: {
    color: '#ffffff',
  },
  marketContent: {
    flex: 1,
    paddingHorizontal: 12,
  },
  emptyWatchlist: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyWatchlistTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
  },
  emptyWatchlistText: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 40,
  },
  segmentContainer: {
    marginBottom: 8,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#333333',
  },
  segmentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  segmentHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  segmentTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  segmentCount: {
    backgroundColor: '#1E1E1E',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  segmentCountText: {
    color: '#666',
    fontSize: 12,
  },
  segmentInstruments: {
    borderTopWidth: 1,
  },
  categoriesContainer: { paddingHorizontal: 10, marginBottom: 8, height: 40 },
  categoryBtn: { 
    paddingHorizontal: 12, 
    paddingVertical: 8, 
    marginRight: 6, 
    borderRadius: 16, 
    backgroundColor: '#1E1E1E',
    height: 34,
    justifyContent: 'center',
    minWidth: 50,
    borderWidth: 1,
    borderColor: '#333333',
  },
  categoryBtnActive: { backgroundColor: '#1a73e8' },
  categoryText: { color: '#666', fontSize: 12, fontWeight: '500' },
  categoryTextActive: { color: '#000', fontWeight: '600' },
  
  instrumentItem: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingHorizontal: 12, 
    paddingVertical: 12, 
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  starBtn: { width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  instrumentInfo: { flex: 1, marginLeft: 8 },
  instrumentSymbol: { color: '#fff', fontSize: 14, fontWeight: '600' },
  instrumentName: { color: '#666', fontSize: 10, marginTop: 2 },
  instrumentPriceCol: { width: 60, alignItems: 'center' },
  bidPrice: { color: '#1a73e8', fontSize: 13, fontWeight: '500' },
  askPrice: { color: '#ef4444', fontSize: 13, fontWeight: '500' },
  priceLabel: { color: '#666', fontSize: 9, marginTop: 1 },
  spreadBadgeCol: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 4, marginHorizontal: 4, minWidth: 32, alignItems: 'center', borderWidth: 1 },
  spreadBadgeText: { color: '#1a73e8', fontSize: 11, fontWeight: '600' },
  chartIconBtn: { 
    width: 32, 
    height: 32, 
    justifyContent: 'center', 
    alignItems: 'center', 
    borderRadius: 8,
    borderWidth: 1,
  },
  
  // Chart Trading Panel - One Click Buy/Sell
  chartTradingPanel: { backgroundColor: '#1E1E1E', paddingHorizontal: 12, paddingVertical: 10, paddingBottom: 16 },
  chartVolRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  chartVolMinusBtn: { width: 36, height: 36, backgroundColor: '#1E1E1E', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  chartVolPlusBtn: { width: 36, height: 36, backgroundColor: '#1E1E1E', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  chartVolDisplay: { alignItems: 'center', marginHorizontal: 16, minWidth: 80 },
  chartVolLabel: { color: '#666', fontSize: 10 },
  chartVolValue: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  chartTradeButtons: { flexDirection: 'row', gap: 10 },
  chartSellButton: { flex: 1, backgroundColor: '#ef4444', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  chartBuyButton: { flex: 1, backgroundColor: '#22c55e', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  chartSellLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600' },
  chartBuyLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600' },
  chartSellPrice: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  chartBuyPrice: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  chartSpreadText: { color: '#666', fontSize: 11, textAlign: 'center', marginTop: 8 },
  
  // Order Panel - Slide from Bottom (Fixed - positioned at bottom)
  orderModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  orderPanelBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  orderPanelScroll: { maxHeight: height * 0.85 },
  orderPanelContainer: { backgroundColor: '#1E1E1E', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingBottom: 40, paddingTop: 8 },
  orderPanelHandle: { width: 40, height: 4, backgroundColor: '#1E1E1E', borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 12 },
  orderPanelHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  orderPanelSymbol: { color: '#fff', fontSize: 16, fontWeight: '600' },
  orderPanelName: { color: '#666', fontSize: 12, marginTop: 2 },
  orderCloseBtn: { padding: 6 },
  leverageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#1E1E1E', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  leverageLabel: { color: '#888', fontSize: 12 },
  leverageValue: { color: '#1a73e8', fontSize: 14, fontWeight: 'bold' },
  quickTradeRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  quickSellBtn: { flex: 1, backgroundColor: '#ef4444', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  quickBuyBtn: { flex: 1, backgroundColor: '#22c55e', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  quickBtnLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600' },
  quickBtnPrice: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  btnDisabled: { opacity: 0.5 },
  spreadInfoRow: { alignItems: 'center', marginBottom: 10 },
  spreadInfoText: { color: '#666', fontSize: 11 },
  slMandatoryBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(245, 158, 11, 0.15)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, marginBottom: 10, gap: 8 },
  slMandatoryText: { color: '#f59e0b', fontSize: 12, flex: 1 },
  orderTypeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  orderTypeBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  orderTypeBtnActive: { backgroundColor: '#1a73e8' },
  orderTypeBtnText: { fontSize: 13, fontWeight: '600' },
  orderTypeBtnTextActive: { color: '#fff' },
  pendingTypeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  pendingTypeBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1 },
  pendingTypeBtnActive: { borderColor: '#1a73e8' },
  pendingTypeText: { color: '#666', fontSize: 12 },
  pendingTypeTextActive: { color: '#1a73e8' },
  inputSection: { marginBottom: 10 },
  inputLabel: { color: '#888', fontSize: 11, marginBottom: 4 },
  priceInput: { backgroundColor: '#1E1E1E', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: '#fff', fontSize: 15 },
  volumeControlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  volumeControlBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1a73e8', borderRadius: 8 },
  volumeInputField: { flex: 1, backgroundColor: '#1E1E1E', borderRadius: 8, paddingVertical: 10, textAlign: 'center', color: '#fff', fontSize: 15 },
  slTpRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  slTpCol: { flex: 1 },
  slTpInputOrder: { backgroundColor: '#1E1E1E', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, color: '#fff', fontSize: 14 },
  finalTradeRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  finalSellBtn: { flex: 1, backgroundColor: '#ef4444', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  finalBuyBtn: { flex: 1, backgroundColor: '#22c55e', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  finalBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  spreadBadge: { backgroundColor: '#1E1E1E', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginHorizontal: 8, borderWidth: 1, borderColor: '#333333' },
  spreadText: { color: '#1a73e8', fontSize: 10 },
  
  // Trade
  priceBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#1E1E1E' },
  currentSymbol: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  currentName: { color: '#666', fontSize: 12 },
  priceDisplay: { flexDirection: 'row', gap: 16 },
  bidPriceMain: { color: '#1a73e8', fontSize: 16, fontWeight: '600' },
  askPriceMain: { color: '#ef4444', fontSize: 16, fontWeight: '600' },
  
  // Trade tab — dashboard (web-style)
  tradeDashRoot: { flex: 1 },
  tradeSummaryStrip: { flexGrow: 0 },
  tradeSummaryStripContent: { flexDirection: 'row', alignItems: 'stretch', gap: 10, paddingHorizontal: 12 },
  tradeStatPill: { minWidth: 108, maxWidth: 140, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  tradeStatLabel: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
  tradeStatValue: { fontSize: 15, fontWeight: '700' },
  tradeDashCard: {
    flex: 1,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 12,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 2,
  },
  tradeDashTabsRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tradeDashTabHit: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  tradeDashTabLabel: { fontSize: 14 },
  tradeDashTabUnderline: { height: 3, width: '72%', borderRadius: 2, marginTop: 8 },
  tradeDashTabUnderlinePlaceholder: { height: 3, marginTop: 8, opacity: 0 },
  tradeToolbarRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  tradeToolOutlineBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  tradeToolBtnLabel: { fontSize: 13, fontWeight: '600' },
  tradeHScroll: { flexGrow: 0 },
  tradeTableHeaderRow: { flexDirection: 'row', alignItems: 'center', minHeight: 38, borderBottomWidth: StyleSheet.hairlineWidth },
  tradeThCell: { paddingHorizontal: 6, justifyContent: 'center', paddingVertical: 8 },
  tradeThText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  tradeTableRow: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 8, paddingHorizontal: 4 },
  tradeTableRowInner: { flexDirection: 'row', alignItems: 'center' },
  tradeTableRowTouch: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  tradeTdCell: { paddingHorizontal: 6, justifyContent: 'center', paddingVertical: 4 },
  tradeTdText: { fontSize: 12 },
  tradeTdBold: { fontWeight: '700' },
  tradeActCell: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'flex-end', paddingRight: 6 },
  tradeRowPnlHint: { fontSize: 11, fontWeight: '600', marginTop: 4, marginLeft: 6 },
  tradeEmptyWrap: { justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  tradeEmptyTitle: { fontSize: 15, fontWeight: '500' },

  // Account Summary (Trade Tab) — legacy rows (other screens may reference)
  accountSummaryList: { backgroundColor: '#1E1E1E', borderBottomWidth: 1, borderBottomColor: '#333333', paddingTop: 50 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#333333' },
  summaryLabel: { color: '#666', fontSize: 14 },
  summaryValue: { color: '#fff', fontSize: 14 },
  pendingStatus: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  historySide: { fontSize: 12, marginLeft: 8 },
  
  tradeTabs: { flexDirection: 'row', backgroundColor: '#1E1E1E', borderBottomWidth: 1, borderBottomColor: '#333333' },
  tradeTabBtn: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tradeTabBtnActive: { borderBottomWidth: 2, borderBottomColor: '#1a73e8' },
  tradeTabText: { color: '#666', fontSize: 14 },
  tradeTabTextActive: { color: '#1a73e8', fontWeight: '600' },
  
  tradesList: { flex: 1 },
  positionItem: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#333333' },
  positionRow: { flexDirection: 'row', alignItems: 'center' },
  positionInfo: { flex: 1 },
  positionSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  positionSymbol: { color: '#fff', fontSize: 15, fontWeight: '600' },
  sideBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  sideText: { fontSize: 10, fontWeight: '600' },
  positionDetail: { color: '#666', fontSize: 12, marginTop: 4 },
  slTpText: { color: '#888', fontSize: 11, marginTop: 2 },
  positionActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 8 },
  editBtn: { padding: 10, backgroundColor: '#1a73e820', borderRadius: 10 },
  closeTradeBtn: { padding: 10, backgroundColor: '#1a73e820', borderRadius: 10 },
  positionPnlCol: { alignItems: 'flex-end' },
  positionPnl: { fontSize: 15, fontWeight: '600' },
  currentPriceText: { color: '#666', fontSize: 12, marginTop: 2 },
  closeBtn: { backgroundColor: '#1a73e820', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6 },
  closeBtnText: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  
  // SL/TP Modal
  slTpModalOverlay: { flex: 1, justifyContent: 'flex-end' },
  slTpModalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)' },
  slTpModalContent: { backgroundColor: '#1E1E1E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40 },
  slTpModalHandle: { width: 40, height: 4, backgroundColor: '#1E1E1E', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  slTpModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
  slTpModalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  slTpInputGroup: { marginBottom: 16 },
  slTpLabel: { color: '#888', fontSize: 13, marginBottom: 8 },
  slTpInput: { backgroundColor: '#1E1E1E', borderRadius: 12, padding: 16, color: '#fff', fontSize: 16, borderWidth: 1, borderColor: '#333333' },
  slTpCurrentInfo: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, paddingHorizontal: 4 },
  slTpCurrentText: { color: '#888', fontSize: 13 },
  slTpButtonRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  slTpClearBtn: { flex: 1, backgroundColor: '#1E1E1E', padding: 16, borderRadius: 12, alignItems: 'center' },
  slTpClearBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  slTpSaveBtn: { flex: 2, backgroundColor: '#1a73e8', padding: 16, borderRadius: 12, alignItems: 'center' },
  slTpSaveBtnText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  
  // Trade Details Modal - colors applied inline with theme
  tradeDetailsContent: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40, maxHeight: '85%' },
  tradeDetailsScroll: { maxHeight: 500 },
  detailSection: { borderRadius: 12, padding: 16, marginBottom: 12 },
  detailSectionTitle: { color: '#1a73e8', fontSize: 14, fontWeight: 'bold', marginBottom: 12 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#333333' },
  detailLabel: { color: '#888', fontSize: 14 },
  detailValue: { color: '#fff', fontSize: 14, fontWeight: '500' },
  detailActions: { flexDirection: 'row', gap: 12, marginTop: 8, marginBottom: 20 },
  detailEditBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#ef444420', padding: 14, borderRadius: 12, borderWidth: 1, borderColor: '#ef4444' },
  detailEditText: { color: '#ef4444', fontSize: 15, fontWeight: '600' },
  detailCloseBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#ef4444', padding: 14, borderRadius: 12 },
  detailCloseText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  
  // iOS-style Confirmation Modal
  confirmModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 40 },
  confirmModalContent: { backgroundColor: '#1E1E1E', borderRadius: 20, padding: 24, width: '100%', alignItems: 'center' },
  confirmModalIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#1a73e820', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  confirmModalTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  confirmModalMessage: { color: '#888', fontSize: 15, textAlign: 'center', marginBottom: 24 },
  confirmModalButtons: { flexDirection: 'row', gap: 12, width: '100%' },
  confirmCancelBtn: { flex: 1, backgroundColor: '#1E1E1E', padding: 14, borderRadius: 12, alignItems: 'center' },
  confirmCancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  confirmCloseBtn: { flex: 1, backgroundColor: '#1a73e8', padding: 14, borderRadius: 12, alignItems: 'center' },
  confirmCloseText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  
  // Close All Buttons - background applied inline with theme
  closeAllRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  closeAllBtn: { flex: 1, backgroundColor: '#1a73e820', paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#1a73e8' },
  closeAllText: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  closeProfitBtn: { flex: 1, backgroundColor: '#1a73e820', paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#1a73e8' },
  closeProfitText: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  closeLossBtn: { flex: 1, backgroundColor: '#1a73e820', paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#1a73e8' },
  closeLossText: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  
  // Cancel Order Button
  cancelOrderBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#1a73e820', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#1a73e8' },
  cancelOrderText: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  
  // Swipe to Close
  swipeCloseBtn: { backgroundColor: '#1a73e8', justifyContent: 'center', alignItems: 'center', width: 80, height: '100%' },
  swipeCloseText: { color: '#fff', fontSize: 12, fontWeight: '600', marginTop: 4 },
  
  tradeButton: { margin: 16, padding: 16, backgroundColor: '#1a73e8', borderRadius: 12, alignItems: 'center' },
  tradeButtonText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  
  // Order Panel
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' },
  orderPanel: { backgroundColor: '#1E1E1E', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20 },
  orderPanelHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  orderPanelTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  
  sideToggle: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  sideBtn: { flex: 1, padding: 16, borderRadius: 12, backgroundColor: '#1E1E1E', alignItems: 'center' },
  sideBtnSell: { backgroundColor: '#ef4444' },
  sideBtnBuy: { backgroundColor: '#22c55e' },
  sideBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  sideBtnPrice: { color: '#fff', fontSize: 18, fontWeight: 'bold', marginTop: 4 },
  
  inputGroup: { marginBottom: 16 },
  inputLabel: { color: '#666', fontSize: 12, marginBottom: 8 },
  volumeInput: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E1E1E', borderRadius: 12 },
  volumeBtn: { padding: 16 },
  volumeValue: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 18, fontWeight: '600' },
  
  slTpRow: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  slTpInputWrapper: { flex: 1 },
  input: { backgroundColor: '#1E1E1E', borderRadius: 12, padding: 14, color: '#fff', fontSize: 16 },
  
  executeBtn: { padding: 16, borderRadius: 12, alignItems: 'center' },
  executeBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  
  // History
  historyItemFull: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#333333' },
  historyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  historyLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  historySymbol: { color: '#fff', fontSize: 16, fontWeight: '600' },
  historyPnl: { fontSize: 16, fontWeight: '600' },
  historyMeta: { flexDirection: 'row', gap: 16, marginTop: 8 },
  historyMetaText: { color: '#666', fontSize: 12 },
  historyDate: { color: '#64748b', fontSize: 11, marginTop: 8 },
  historyItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#333333' },
  historyDetails: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  historyDetail: { color: '#666', fontSize: 12 },
  adminBadge: { backgroundColor: '#1a73e820', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  adminBadgeText: { color: '#1a73e8', fontSize: 10 },
  
  // History Filters
  historyFilters: { paddingVertical: 8, borderBottomWidth: 1 },
  historyFiltersContent: { paddingHorizontal: 12, gap: 8, flexDirection: 'row' },
  historyFilterBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  historyFilterText: { fontSize: 12, fontWeight: '500' },
  historySummary: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1 },
  historySummaryText: { fontSize: 12 },
  
  // More Menu - Matching screenshot
  moreMenuHeader: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 20 },
  moreMenuTitle: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  moreMenuList: { flex: 1, paddingHorizontal: 16 },
  moreMenuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#333333' },
  moreMenuIcon: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  moreMenuItemText: { flex: 1, color: '#fff', fontSize: 16 },
  themeToggleItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#333333' },
  themeToggle: { width: 50, height: 28, backgroundColor: '#1E1E1E', borderRadius: 14, justifyContent: 'center', paddingHorizontal: 2 },
  themeToggleActive: { backgroundColor: '#1a73e8' },
  themeToggleThumb: { width: 24, height: 24, backgroundColor: '#fff', borderRadius: 12 },
  themeToggleThumbActive: { marginLeft: 'auto' },
  
  // Chart Tab - Full screen with multiple tabs
  chartContainer: { flex: 1, backgroundColor: '#1E1E1E' },
  chartTabsBar: { flexDirection: 'row', alignItems: 'center', paddingTop: 4, paddingLeft: 8, backgroundColor: '#1E1E1E', borderBottomWidth: 1, borderBottomColor: '#333333' },
  chartTabsScroll: { flexGrow: 0 },
  chartTab: { paddingHorizontal: 14, paddingVertical: 10, marginRight: 2, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  chartTabActive: { borderBottomColor: '#1a73e8' },
  chartTabText: { color: '#666', fontSize: 13, fontWeight: '500' },
  chartTabTextActive: { color: '#1a73e8' },
  addChartBtn: { paddingHorizontal: 12, paddingVertical: 10 },
  chartWrapper: { flex: 1, backgroundColor: '#1E1E1E', minHeight: 400 },
  // (unused chart-toolbar styles removed — TradingView Charting Library has its own toolbar)
  sentimentSection: { backgroundColor: '#1E1E1E', paddingHorizontal: 16, paddingVertical: 12 },
  sentimentTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  sentimentWidget: { height: 180, backgroundColor: '#1E1E1E', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#333333' },
  chartPriceBar: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#1E1E1E' },
  chartPriceItem: { alignItems: 'center' },
  chartPriceLabel: { color: '#666', fontSize: 11, marginBottom: 2 },
  chartBidPrice: { color: '#1a73e8', fontSize: 16, fontWeight: '600' },
  chartAskPrice: { color: '#ef4444', fontSize: 16, fontWeight: '600' },
  chartSpread: { color: '#fff', fontSize: 14 },
  chartOneClickContainer: { backgroundColor: '#1E1E1E', paddingBottom: 16 },
  chartVolumeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, gap: 16 },
  chartVolBtn: { width: 32, height: 32, backgroundColor: '#1E1E1E', borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  chartVolText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  chartButtons: { flexDirection: 'row', gap: 10, paddingHorizontal: 12 },
  chartSellBtn: { flex: 1, backgroundColor: '#ef4444', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  chartBuyBtn: { flex: 1, backgroundColor: '#22c55e', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  chartBtnText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  chartBtnLabel: { color: '#fff', fontSize: 12, fontWeight: '600', opacity: 0.9 },
  chartBtnPrice: { color: '#fff', fontSize: 16, fontWeight: 'bold', marginTop: 2 },
  orderSlidePanel: { backgroundColor: '#1E1E1E', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
  orderPanelHandle: { width: 40, height: 4, backgroundColor: '#1E1E1E', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  symbolPickerModal: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '70%' },
  symbolPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1 },
  symbolPickerHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  symbolPickerBackBtn: { marginRight: 4 },
  symbolPickerTitle: { fontSize: 18, fontWeight: 'bold', flexShrink: 1 },
  symbolPickerItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1 },
  symbolPickerSymbol: { fontSize: 16, fontWeight: '600' },
  symbolPickerName: { fontSize: 12, marginTop: 2 },
  chartAddSegmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  chartAddSegmentLabel: { fontSize: 16, fontWeight: '600' },
  chartAddSegmentRight: { flexDirection: 'row', alignItems: 'center' },
  chartAddSegmentCount: { fontSize: 13, fontWeight: '500' },
  chartAddEmptyWrap: { padding: 32, alignItems: 'center' },
  chartAddEmptyText: { fontSize: 15, textAlign: 'center' },
  
  // Quick Trade Bar - Screenshot Style (at top)
  quickTradeBarTop: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#1E1E1E',
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  sellPriceBtn: { 
    flex: 1,
    backgroundColor: '#ef4444',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  sellLabel: { color: '#fff', fontSize: 11, fontWeight: '500' },
  sellPrice: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  buyPriceBtn: { 
    flex: 1,
    backgroundColor: '#22c55e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'flex-end',
    borderWidth: 2,
    borderColor: '#22c55e',
  },
  buyLabel: { color: '#fff', fontSize: 11, fontWeight: '500' },
  buyPrice: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  lotControlCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#333333',
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  lotMinusBtn: {
    width: 36,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1a73e8',
    borderRadius: 6,
    marginRight: 4,
  },
  lotPlusBtn: {
    width: 36,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1a73e8',
    borderRadius: 6,
    marginLeft: 4,
  },
  lotControlText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  lotCenterInput: {
    width: 50,
    height: 36,
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 0,
  },
  btnDisabled: { opacity: 0.5 },
  
  // Leverage Picker Modal
  leverageModalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.8)' },
  leverageModalContent: { backgroundColor: '#1E1E1E', borderRadius: 16, padding: 16, width: 200 },
  leverageModalTitle: { color: '#fff', fontSize: 16, fontWeight: 'bold', textAlign: 'center', marginBottom: 12 },
  leverageModalItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8 },
  leverageModalItemActive: { backgroundColor: '#1a73e820' },
  leverageModalItemText: { color: '#888', fontSize: 14, fontWeight: '600' },
  leverageModalItemTextActive: { color: '#1a73e8' },
  
  // Leverage Selector
  leverageSelector: { flexDirection: 'row', gap: 6 },
  leverageOption: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#1E1E1E', borderRadius: 6, borderWidth: 1, borderColor: '#333333' },
  leverageOptionActive: { backgroundColor: '#1a73e820', borderColor: '#1a73e8' },
  leverageOptionText: { color: '#888', fontSize: 12, fontWeight: '600' },
  leverageOptionTextActive: { color: '#1a73e8' },
  
  // Account Selector - Below search bar
  accountSelector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E1E1E', marginHorizontal: 12, marginTop: 0, marginBottom: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#333333' },
  accountSelectorLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accountIcon: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#1a73e820', justifyContent: 'center', alignItems: 'center' },
  accountSelectorLabel: { color: '#666', fontSize: 9 },
  accountSelectorValue: { color: '#fff', fontSize: 12, fontWeight: '600' },
  
  // Account Picker Modal
  accountPickerOverlay: { flex: 1, justifyContent: 'flex-end' },
  accountPickerBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)' },
  accountPickerContent: { backgroundColor: '#1E1E1E', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '60%' },
  accountPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#333333' },
  accountPickerTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  accountPickerList: { paddingHorizontal: 12, paddingBottom: 40 },
  accountPickerSectionTitle: { fontSize: 12, fontWeight: '600', paddingHorizontal: 4, paddingTop: 12, paddingBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  accountPickerItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, marginVertical: 4, backgroundColor: '#1E1E1E', borderRadius: 12 },
  accountPickerItemActive: { backgroundColor: '#1a73e815', borderWidth: 1, borderColor: '#1a73e8' },
  accountPickerItemLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accountPickerIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1E1E1E', justifyContent: 'center', alignItems: 'center' },
  accountPickerIconActive: { backgroundColor: '#1a73e820' },
  accountPickerNumber: { color: '#fff', fontSize: 15, fontWeight: '600' },
  accountPickerType: { color: '#666', fontSize: 12, marginTop: 2 },
  accountPickerItemRight: { alignItems: 'flex-end', gap: 4 },
  accountPickerBalance: { color: '#1a73e8', fontSize: 16, fontWeight: 'bold' },
  
  // Quick SL Modal for Challenge Accounts
  quickSlModalOverlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)' },
  quickSlModalContent: { width: '85%', borderRadius: 16, padding: 20 },
  quickSlModalHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  quickSlModalTitle: { fontSize: 18, fontWeight: 'bold' },
  quickSlModalSubtitle: { fontSize: 13, lineHeight: 18, marginBottom: 16 },
  quickSlInputContainer: { marginBottom: 20 },
  quickSlInputLabel: { fontSize: 12, marginBottom: 6 },
  quickSlInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  quickSlHint: { fontSize: 11, marginTop: 6 },
  quickSlModalButtons: { flexDirection: 'row', gap: 10 },
  quickSlCancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  quickSlCancelBtnText: { fontSize: 15, fontWeight: '600' },
  quickSlConfirmBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  quickSlConfirmBtnText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
});

// Orders Screen Styles - matching screenshot design
const ordStyles = StyleSheet.create({
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 80,
  },
  emptyText: { fontSize: 14, marginTop: 12 },
});

// Market Screen Styles - matching screenshot design
const mktStyles = StyleSheet.create({
  accountHeader: {
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  accountHeaderContent: {},
  accountLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 4 },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accountId: { fontSize: 16, fontWeight: '700' },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  centBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
  },
  centBadgeText: { fontSize: 12, fontWeight: '600' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    paddingVertical: 0,
  },
  goBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  goBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  categoryScroll: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  categoryScrollContent: {
    paddingHorizontal: 12,
    gap: 0,
  },
  categoryTab: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  categoryTabText: {
    fontSize: 13,
    fontWeight: '600',
  },
  instrumentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  instrLeft: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  instrSymbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  instrSymbol: {
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  instrCategory: {
    fontSize: 11,
    lineHeight: 14,
  },
  instrRight: {
    alignItems: 'flex-end',
    marginRight: 12,
  },
  instrPrice: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  instrPip: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
});

export default MainTradingScreen;

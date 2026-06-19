import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import { useTheme } from '../context/ThemeContext';
import socketService from '../services/socketService';
import { currencySymbol } from '../utils/currency';

const OrderBookScreen = ({ navigation }) => {
  const { colors, isDark } = useTheme();
  const [accounts, setAccounts] = useState([]);
  const [usdInrRate, setUsdInrRate] = useState(1);
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [activeTab, setActiveTab] = useState('positions');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openTrades, setOpenTrades] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [livePrices, setLivePrices] = useState({});
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [historyFilter, setHistoryFilter] = useState('all');

  useEffect(() => {
    loadData();
  }, []);

  // WebSocket for real-time price updates
  useEffect(() => {
    socketService.connect();
    const unsubscribe = socketService.addPriceListener((prices) => {
      if (prices && Object.keys(prices).length > 0) {
        setLivePrices(prices);
      }
    });
    return () => unsubscribe();
  }, []);

  const loadData = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      if (!token) { return; }

      // Fetch accounts
      const accountsRes = await fetch(`${API_URL}/accounts`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const accountsData = await accountsRes.json();
      const items = accountsData.items || accountsData || [];
      const isActive = (a) => {
        if (a.is_active === false || a.isActive === false) return false;
        const s = String(a.status || '').toLowerCase();
        return s !== 'deleted' && s !== 'closed' && s !== 'inactive';
      };
      const mapped = items.filter(isActive).map(a => ({
        ...a,
        _id: a.id || a._id,
        accountId: a.account_number || a.accountId || a.id,
        currency: a.currency || 'USD',
      }));
      setAccounts(mapped);

      // USD->INR rate for converting client-computed P&L on INR accounts.
      try {
        const fxRes = await fetch(`${API_URL}/wallet/fx-rate`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (fxRes.ok) {
          const fxData = await fxRes.json().catch(() => ({}));
          const r = Number(fxData?.rate || fxData?.usd_inr || 0);
          if (r > 0) setUsdInrRate(r);
        }
      } catch (_) {}

      // Fetch positions & history for all accounts
      await fetchAllTradesForAccounts(mapped, token);
    } catch (e) {
      console.error('[OrderBook] Error loading data:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (accounts.length > 0 && !loading) {
      refreshTrades();
    }
  }, [selectedAccount]);

  const refreshTrades = async () => {
    const token = await SecureStore.getItemAsync('token');
    if (token) await fetchAllTradesForAccounts(accounts, token);
  };

  const fetchAllTradesForAccounts = async (accountsList, token) => {
    try {
      const headers = { 'Authorization': `Bearer ${token}` };
      
      // Determine which accounts to fetch
      let accountsToFetch = accountsList;
      if (selectedAccount !== 'all') {
        accountsToFetch = accountsList.filter(a => a._id === selectedAccount);
      }

      if (accountsToFetch.length === 0) return;

      // Fetch all data in parallel for all accounts
      const allOpenPromises = accountsToFetch.map(acct =>
        fetch(`${API_URL}/positions/?account_id=${acct._id}&status=open`, { headers })
          .then(r => r.ok ? r.json() : [])
          .then(data => {
            const items = Array.isArray(data) ? data : (data.items || []);
            return items.map(p => ({
              _id: p.id,
              symbol: p.symbol,
              side: (p.side || '').toUpperCase(),
              quantity: p.lots,
              openPrice: p.open_price,
              currentPrice: p.current_price,
              stopLoss: p.stop_loss,
              takeProfit: p.take_profit,
              swap: p.swap || 0,
              commission: p.commission || 0,
              profit: p.profit || 0,
              contractSize: p.contract_size || 100000,
              accountName: acct.accountId,
              accountId: acct._id,
              currency: acct.currency || 'USD',
              createdAt: p.created_at,
            }));
          })
          .catch(() => [])
      );

      const allPendingPromises = accountsToFetch.map(acct =>
        fetch(`${API_URL}/orders/?account_id=${acct._id}&status=pending`, { headers })
          .then(r => r.ok ? r.json() : [])
          .then(data => {
            const items = Array.isArray(data) ? data : (data.items || []);
            return items.map(o => ({
              _id: o.id,
              symbol: o.symbol,
              side: (o.side || '').toUpperCase(),
              orderType: (o.order_type || '').toUpperCase().replace('_', ' '),
              quantity: o.lots,
              entryPrice: o.price,
              stopLoss: o.stop_loss,
              takeProfit: o.take_profit,
              accountName: acct.accountId,
              accountId: acct._id,
              currency: acct.currency || 'USD',
              createdAt: o.created_at,
            }));
          })
          .catch(() => [])
      );

      // Fetch trade history via portfolio/trades
      const historyAccountParam = selectedAccount !== 'all' ? `&account_id=${selectedAccount}` : '';
      const historyRes = await fetch(`${API_URL}/portfolio/trades?per_page=50${historyAccountParam}`, { headers });
      let historyItems = [];
      if (historyRes.ok) {
        const histData = await historyRes.json();
        historyItems = (histData.items || []).map(t => ({
          _id: t.id,
          symbol: t.symbol,
          side: (t.side || '').toUpperCase(),
          quantity: t.lots,
          openPrice: t.open_price,
          closePrice: t.close_price,
          swap: t.swap || 0,
          commission: t.commission || 0,
          realizedPnl: t.pnl || t.profit || 0,
          closeReason: t.close_reason,
          openedAt: t.opened_at,
          closedAt: t.close_time || t.closed_at,
          accountName: '',
          currency: (accountsList.find(a => a._id === (t.account_id || t.accountId))?.currency) || 'USD',
        }));
      }

      const [openResults, pendingResults] = await Promise.all([
        Promise.all(allOpenPromises),
        Promise.all(allPendingPromises),
      ]);

      const allOpen = openResults.flat();
      const allPending = pendingResults.flat();

      setOpenTrades(allOpen);
      setPendingOrders(allPending);
      setClosedTrades(historyItems);
    } catch (e) {
      console.error('[OrderBook] Error fetching trades:', e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshTrades();
    setRefreshing(false);
  };

  const getContractSize = (symbol) => {
    if (symbol === 'XAUUSD') return 100;
    if (symbol === 'XAGUSD') return 5000;
    if (['BTCUSD', 'ETHUSD', 'BNBUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD', 'DOGEUSD'].includes(symbol)) return 1;
    return 100000;
  };

  const calculateFloatingPnl = (trade) => {
    // If backend already calculated profit, use it
    if (trade.profit && trade.profit !== 0) return trade.profit;
    
    const prices = livePrices[trade.symbol];
    if (!prices || !prices.bid) return 0;

    const currentPrice = trade.side === 'BUY' ? prices.bid : prices.ask;
    if (!currentPrice) return 0;

    const contractSize = trade.contractSize || getContractSize(trade.symbol);
    let pnl = trade.side === 'BUY'
      ? (currentPrice - trade.openPrice) * trade.quantity * contractSize
      : (trade.openPrice - currentPrice) * trade.quantity * contractSize;

    // Client-side price P&L is in USD; convert to INR for INR accounts.
    if (String(trade.currency || 'USD').toUpperCase() === 'INR') {
      pnl = pnl * (Number(usdInrRate) || 1);
    }
    // Commission/swap are already in the account currency.
    return pnl - (trade.commission || 0) - (trade.swap || 0);
  };

  const getTotalPnl = () => {
    return openTrades.reduce((sum, trade) => sum + calculateFloatingPnl(trade), 0);
  };

  const getFilteredHistory = () => {
    const now = new Date();
    return closedTrades.filter(trade => {
      const tradeDate = new Date(trade.closedAt || trade.openedAt);
      if (historyFilter === 'all') return true;
      if (historyFilter === 'today') return tradeDate.toDateString() === now.toDateString();
      if (historyFilter === 'week') return tradeDate >= new Date(now.getTime() - 7 * 86400000);
      if (historyFilter === 'month') return tradeDate >= new Date(now.getTime() - 30 * 86400000);
      if (historyFilter === 'year') return tradeDate >= new Date(now.getTime() - 365 * 86400000);
      return true;
    });
  };

  const getHistoryTotalPnl = () => {
    return getFilteredHistory().reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  };

  const closeTrade = async (trade) => {
    Alert.alert(
      'Close Position',
      `Close ${trade.side} ${trade.quantity} ${trade.symbol}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close',
          style: 'destructive',
          onPress: async () => {
            try {
              const token = await SecureStore.getItemAsync('token');
              const res = await fetch(`${API_URL}/positions/${trade._id}/close`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({})
              });
              const data = await res.json();
              if (res.ok) {
                Alert.alert('Success', `Trade closed! P/L: $${(data.profit || data.pnl || 0).toFixed(2)}`);
                refreshTrades();
              } else {
                Alert.alert('Error', data.detail || data.message || 'Failed to close trade');
              }
            } catch (e) {
              console.error('Close trade error:', e);
              Alert.alert('Error', 'Network error - please check your connection');
            }
          }
        }
      ]
    );
  };

  const cancelPendingOrder = async (order) => {
    Alert.alert(
      'Cancel Order',
      `Cancel ${order.orderType} order for ${order.symbol}?`,
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: async () => {
            try {
              const token = await SecureStore.getItemAsync('token');
              const res = await fetch(`${API_URL}/orders/${order._id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (res.ok) {
                Alert.alert('Success', 'Order cancelled');
                refreshTrades();
              } else {
                const data = await res.json();
                Alert.alert('Error', data.detail || 'Failed to cancel order');
              }
            } catch (e) {
              Alert.alert('Error', 'Network error');
            }
          }
        }
      ]
    );
  };

  const getSelectedAccountName = () => {
    if (selectedAccount === 'all') return 'All Accounts';
    const acc = accounts.find(a => a._id === selectedAccount);
    return acc?.accountId || 'Select Account';
  };

  const renderPositionItem = (trade) => {
    const pnl = calculateFloatingPnl(trade);
    const prices = livePrices[trade.symbol] || {};
    const currentPrice = trade.side === 'BUY' ? prices.bid : prices.ask;

    return (
      <View key={trade._id} style={[styles.tradeCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
        <View style={styles.tradeHeader}>
          <View style={styles.tradeSymbolRow}>
            <Text style={[styles.tradeSymbol, { color: colors.textPrimary }]}>{trade.symbol}</Text>
            <View style={[styles.sideBadge, { backgroundColor: trade.side === 'BUY' ? '#22c55e20' : '#ef444420' }]}>
              <Text style={[styles.sideText, { color: trade.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>
                {trade.side}
              </Text>
            </View>
          </View>
          <Text style={[styles.accountLabel, { color: colors.textMuted }]}>{trade.accountName}</Text>
        </View>

        <View style={styles.tradeDetails}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Volume</Text>
            <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{trade.quantity}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Open Price</Text>
            <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{trade.openPrice?.toFixed(5)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Current</Text>
            <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{(currentPrice || trade.currentPrice)?.toFixed(5) || '...'}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: colors.textMuted }]}>P/L</Text>
            <Text style={[styles.detailValue, { color: pnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: '600' }]}>
              ${pnl.toFixed(2)}
            </Text>
          </View>
        </View>

        {trade.stopLoss || trade.takeProfit ? (
          <View style={styles.slTpRow}>
            {trade.stopLoss && <Text style={[styles.slTpText, { color: '#ef4444' }]}>SL: {trade.stopLoss.toFixed(5)}</Text>}
            {trade.takeProfit && <Text style={[styles.slTpText, { color: '#22c55e' }]}>TP: {trade.takeProfit.toFixed(5)}</Text>}
          </View>
        ) : null}

        <TouchableOpacity style={styles.closeBtn} onPress={() => closeTrade(trade)}>
          <Text style={styles.closeBtnText}>Close Position</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderPendingItem = (order) => (
    <View key={order._id} style={[styles.tradeCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
      <View style={styles.tradeHeader}>
        <View style={styles.tradeSymbolRow}>
          <Text style={[styles.tradeSymbol, { color: colors.textPrimary }]}>{order.symbol}</Text>
          <View style={[styles.sideBadge, { backgroundColor: '#eab30820' }]}>
            <Text style={[styles.sideText, { color: '#eab308' }]}>{order.orderType}</Text>
          </View>
        </View>
        <Text style={[styles.accountLabel, { color: colors.textMuted }]}>{order.accountName}</Text>
      </View>

      <View style={styles.tradeDetails}>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Side</Text>
          <Text style={[styles.detailValue, { color: order.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>{order.side}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Volume</Text>
          <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{order.quantity}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Entry Price</Text>
          <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{order.entryPrice?.toFixed(5)}</Text>
        </View>
      </View>

      <TouchableOpacity style={[styles.closeBtn, { backgroundColor: '#ef444420' }]} onPress={() => cancelPendingOrder(order)}>
        <Text style={[styles.closeBtnText, { color: '#ef4444' }]}>Cancel Order</Text>
      </TouchableOpacity>
    </View>
  );

  const renderHistoryItem = (trade) => (
    <View key={trade._id} style={[styles.tradeCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
      <View style={styles.tradeHeader}>
        <View style={styles.tradeSymbolRow}>
          <Text style={[styles.tradeSymbol, { color: colors.textPrimary }]}>{trade.symbol}</Text>
          <View style={[styles.sideBadge, { backgroundColor: trade.side === 'BUY' ? '#22c55e20' : '#ef444420' }]}>
            <Text style={[styles.sideText, { color: trade.side === 'BUY' ? '#22c55e' : '#ef4444' }]}>
              {trade.side}
            </Text>
          </View>
        </View>
        {trade.closeReason && (
          <Text style={[styles.accountLabel, { color: colors.textMuted }]}>{trade.closeReason}</Text>
        )}
      </View>

      <View style={styles.tradeDetails}>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Volume</Text>
          <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{trade.quantity}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Open</Text>
          <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{trade.openPrice?.toFixed(5)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>Close</Text>
          <Text style={[styles.detailValue, { color: colors.textPrimary }]}>{trade.closePrice?.toFixed(5)}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={[styles.detailLabel, { color: colors.textMuted }]}>P/L</Text>
          <Text style={[styles.detailValue, { color: (trade.realizedPnl || 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: '600' }]}>
            ${(trade.realizedPnl || 0).toFixed(2)}
          </Text>
        </View>
      </View>

      {trade.closedAt && (
        <Text style={[styles.dateText, { color: colors.textMuted }]}>
          {new Date(trade.closedAt).toLocaleDateString()} {new Date(trade.closedAt).toLocaleTimeString()}
        </Text>
      )}
    </View>
  );

  if (loading && accounts.length === 0) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.bgPrimary }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Order Book</Text>
        <TouchableOpacity onPress={onRefresh} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={22} color={colors.accent} />
        </TouchableOpacity>
      </View>

      {/* Account Selector */}
      <TouchableOpacity
        style={[styles.accountSelector, { backgroundColor: colors.bgCard, borderColor: colors.border }]}
        onPress={() => setShowAccountPicker(!showAccountPicker)}
      >
        <Ionicons name="briefcase-outline" size={18} color={colors.accent} />
        <Text style={[styles.accountSelectorText, { color: colors.textPrimary }]}>{getSelectedAccountName()}</Text>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>

      {showAccountPicker && (
        <View style={[styles.accountPickerDropdown, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
          <TouchableOpacity
            style={[styles.accountOption, { borderBottomColor: colors.border }, selectedAccount === 'all' && styles.accountOptionActive]}
            onPress={() => { setSelectedAccount('all'); setShowAccountPicker(false); }}
          >
            <Text style={[styles.accountOptionText, { color: colors.textPrimary }]}>All Accounts</Text>
          </TouchableOpacity>
          {accounts.map(acc => (
            <TouchableOpacity
              key={acc._id}
              style={[styles.accountOption, { borderBottomColor: colors.border }, selectedAccount === acc._id && styles.accountOptionActive]}
              onPress={() => { setSelectedAccount(acc._id); setShowAccountPicker(false); }}
            >
              <Text style={[styles.accountOptionText, { color: colors.textPrimary }]}>{acc.accountId} - ${(acc.balance || 0).toFixed(2)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Tabs */}
      <View style={[styles.tabsContainer, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'positions' && styles.tabActive]}
          onPress={() => setActiveTab('positions')}
        >
          <Text style={[styles.tabText, { color: colors.textMuted }, activeTab === 'positions' && styles.tabTextActive]}>
            Positions ({openTrades.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'pending' && styles.tabActive]}
          onPress={() => setActiveTab('pending')}
        >
          <Text style={[styles.tabText, { color: colors.textMuted }, activeTab === 'pending' && styles.tabTextActive]}>
            Pending ({pendingOrders.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'history' && styles.tabActive]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[styles.tabText, { color: colors.textMuted }, activeTab === 'history' && styles.tabTextActive]}>
            History
          </Text>
        </TouchableOpacity>
      </View>

      {/* Summary Bar */}
      {activeTab === 'positions' && openTrades.length > 0 && (
        <View style={[styles.summaryBar, { backgroundColor: colors.bgCard }]}>
          <Text style={[styles.summaryLabel, { color: colors.textMuted }]}>Total Floating P/L:</Text>
          <Text style={[styles.summaryValue, { color: getTotalPnl() >= 0 ? '#22c55e' : '#ef4444' }]}>
            ${getTotalPnl().toFixed(2)}
          </Text>
        </View>
      )}

      {/* Content */}
      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {loading ? (
          <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            {activeTab === 'positions' && (
              openTrades.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="trending-up-outline" size={48} color={colors.textMuted} />
                  <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Open Positions</Text>
                  <Text style={[styles.emptyText, { color: colors.textMuted }]}>Your open trades will appear here</Text>
                </View>
              ) : (
                openTrades.map(trade => renderPositionItem(trade))
              )
            )}

            {activeTab === 'pending' && (
              pendingOrders.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="time-outline" size={48} color={colors.textMuted} />
                  <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Pending Orders</Text>
                  <Text style={[styles.emptyText, { color: colors.textMuted }]}>Your pending orders will appear here</Text>
                </View>
              ) : (
                pendingOrders.map(order => renderPendingItem(order))
              )
            )}

            {activeTab === 'history' && (
              <>
                {/* History Filter Buttons */}
                <View style={[styles.historyFilters, { backgroundColor: colors.bgSecondary }]}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyFiltersContent}>
                    {[
                      { key: 'all', label: 'All' },
                      { key: 'today', label: 'Today' },
                      { key: 'week', label: 'This Week' },
                      { key: 'month', label: 'This Month' },
                      { key: 'year', label: 'This Year' }
                    ].map(filter => (
                      <TouchableOpacity
                        key={filter.key}
                        style={[styles.historyFilterBtn, { backgroundColor: historyFilter === filter.key ? '#22c55e' : colors.bgCard }]}
                        onPress={() => setHistoryFilter(filter.key)}
                      >
                        <Text style={[styles.historyFilterText, { color: historyFilter === filter.key ? '#000' : colors.textMuted }]}>
                          {filter.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>

                {/* History Summary */}
                <View style={[styles.historySummary, { backgroundColor: colors.bgCard }]}>
                  <Text style={[styles.historySummaryText, { color: colors.textMuted }]}>
                    {getFilteredHistory().length} trades
                  </Text>
                  <Text style={[styles.historySummaryText, { color: colors.textMuted }]}>
                    P&L: <Text style={{ color: getHistoryTotalPnl() >= 0 ? '#22c55e' : '#ef4444', fontWeight: '600' }}>
                      ${getHistoryTotalPnl().toFixed(2)}
                    </Text>
                  </Text>
                </View>

                {getFilteredHistory().length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
                    <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Trade History</Text>
                    <Text style={[styles.emptyText, { color: colors.textMuted }]}>Your closed trades will appear here</Text>
                  </View>
                ) : (
                  getFilteredHistory().slice(0, 50).map(trade => renderHistoryItem(trade))
                )}
              </>
            )}
          </>
        )}
        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 50, paddingHorizontal: 16, paddingBottom: 16,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  refreshBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  accountSelector: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, marginHorizontal: 16, marginTop: 12, borderRadius: 10, borderWidth: 1, zIndex: 101,
  },
  accountSelectorText: { fontSize: 14, fontWeight: '500' },
  accountPickerDropdown: {
    marginHorizontal: 16, marginTop: 4, borderRadius: 10, borderWidth: 1,
    overflow: 'hidden', zIndex: 100, elevation: 5,
  },
  accountOption: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1 },
  accountOptionActive: { backgroundColor: '#1a73e820' },
  accountOptionText: { fontSize: 14 },
  tabsContainer: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, padding: 4,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#1a73e8' },
  tabText: { fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: '#fff' },
  summaryBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: 16, marginTop: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
  },
  summaryLabel: { fontSize: 13 },
  summaryValue: { fontSize: 16, fontWeight: '700' },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  tradeCard: { borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1 },
  tradeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  tradeSymbolRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tradeSymbol: { fontSize: 16, fontWeight: '600' },
  sideBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  sideText: { fontSize: 11, fontWeight: '600' },
  accountLabel: { fontSize: 11 },
  tradeDetails: { flexDirection: 'row', flexWrap: 'wrap', gap: 0, marginBottom: 12 },
  detailRow: { width: '50%', marginBottom: 8 },
  detailLabel: { fontSize: 11, marginBottom: 2 },
  detailValue: { fontSize: 14, fontWeight: '500' },
  slTpRow: { flexDirection: 'row', gap: 16, marginBottom: 10, paddingTop: 4, borderTopWidth: 1, borderTopColor: '#ffffff10' },
  slTpText: { fontSize: 12, fontWeight: '500' },
  closeBtn: { backgroundColor: '#1a73e820', paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  closeBtnText: { color: '#1a73e8', fontSize: 13, fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginTop: 12 },
  emptyText: { fontSize: 13, marginTop: 6 },
  dateText: { fontSize: 11, textAlign: 'right', marginTop: 4 },
  historyFilters: { borderRadius: 8, paddingVertical: 8, marginBottom: 8 },
  historyFiltersContent: { paddingHorizontal: 4, gap: 6 },
  historyFilterBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
  historyFilterText: { fontSize: 12, fontWeight: '500' },
  historySummary: {
    flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14,
    paddingVertical: 10, borderRadius: 8, marginBottom: 8,
  },
  historySummaryText: { fontSize: 13 },
});

export default OrderBookScreen;

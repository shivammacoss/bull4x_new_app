import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import { useTheme } from '../context/ThemeContext';
import { authedFetch } from '../utils/authedFetch';
import { isKycApproved, showKycGate } from '../utils/kycGate';

const fmt = (n, currency = 'USD') => {
  const num = Number(n) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
};

const accountLabelFor = (row) => {
  if (row?.is_demo) return 'Demo Account';
  const n = String(row?.account_number || '');
  if (n.startsWith('PM')) return 'PAMM Pool Account';
  if (n.startsWith('MM')) return 'MAM Pool Account';
  if (n.startsWith('CT')) return 'Copy Trade Pool Account';
  if (n.startsWith('CF')) return 'Copy Trade Account';
  if (n.startsWith('IF')) return 'Investment Account';
  return 'Live Account';
};

const DashboardScreen = () => {
  const navigation = useNavigation();
  const { colors } = useTheme();

  const [tab, setTab] = useState('accounts');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mainWallet, setMainWallet] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [userInitials, setUserInitials] = useState('U');

  // Internal transfer state
  const [uniFrom, setUniFrom] = useState('wallet');
  const [uniTo, setUniTo] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  // Top-bar stock search
  const [searchQuery, setSearchQuery] = useState('');
  const [allInstruments, setAllInstruments] = useState([]);

  // KYC banner / popup state
  const [kycStatus, setKycStatus] = useState('none'); // none | review | rejected | approved
  const kycPopupShown = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await SecureStore.getItemAsync('token');
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_URL}/instruments/`, { headers });
        if (!res.ok) return;
        const data = await res.json().catch(() => []);
        const list = Array.isArray(data) ? data : (data.items || data.instruments || []);
        if (!cancelled) setAllInstruments(list);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q) return [];
    return allInstruments
      .filter((i) => {
        const sym = String(i.symbol || '').toUpperCase();
        const name = String(i.name || i.display_name || '').toUpperCase();
        return sym.includes(q) || name.includes(q);
      })
      .slice(0, 8);
  }, [searchQuery, allInstruments]);

  const loadGen = useRef(0);

  const fetchAccounts = useCallback(async () => {
    const gen = ++loadGen.current;
    try {
      const res = await authedFetch('/accounts');
      if (res.status === 401 || res.status === 403) {
        // Silent re-login already attempted inside authedFetch — only here if
        // re-login itself failed (no stored creds or backend rejected). Skip
        // redirect so the user can retry instead of being kicked out on a
        // transient network blip.
        return;
      }
      const data = await res.json();
      if (gen !== loadGen.current) return;
      const list = Array.isArray(data) ? data : data?.items ?? [];
      setRows(list.filter((a) => a.is_active !== false));
    } catch (e) {
      console.log('accounts fetch error', e?.message);
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, [navigation]);

  const fetchWallet = useCallback(async () => {
    try {
      const res = await authedFetch('/wallet/summary');
      if (!res.ok) return;
      const data = await res.json();
      setMainWallet(Number(data?.main_wallet_balance) || 0);
    } catch {}
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await authedFetch('/notifications?page=1&per_page=50');
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data) ? data : data?.items ?? [];
      setUnreadCount(items.filter((n) => !n.is_read && !n.read).length);
    } catch {}
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const stored = await SecureStore.getItemAsync('user');
      if (stored) {
        const u = JSON.parse(stored);
        const src = (u?.first_name || u?.name || u?.email || 'U').toString();
        setUserInitials(src.slice(0, 2).toUpperCase());
      }
    } catch {}
  }, []);

  const fetchKycStatus = useCallback(async () => {
    try {
      const res = await authedFetch('/profile');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const raw = String(data?.kyc_status || '').toLowerCase();
      const norm =
        raw === 'verified' || raw === 'approved' ? 'approved' :
        raw === 'submitted' || raw === 'under_review' || raw === 'pending' ? 'review' :
        raw === 'rejected' || raw === 'failed' ? 'rejected' :
        'none';
      setKycStatus(norm);

      // One-shot popup per app session if KYC isn't approved.
      if (norm !== 'approved' && !kycPopupShown.current) {
        kycPopupShown.current = true;
        const msg = norm === 'rejected'
          ? 'Your KYC was rejected. Please re-upload valid documents to continue trading.'
          : norm === 'review'
          ? 'Your KYC is under review. You can upload additional documents if requested.'
          : 'Complete your KYC verification to unlock all features.';
        Alert.alert(
          'KYC Verification Required',
          msg,
          [
            { text: 'Later', style: 'cancel' },
            { text: 'Complete KYC', onPress: () => navigation.navigate('Kyc') },
          ],
        );
      }
    } catch {}
  }, [navigation]);

  useEffect(() => {
    loadProfile();
    fetchAccounts();
    fetchWallet();
    fetchNotifications();
    fetchKycStatus();

    const i = setInterval(() => {
      fetchAccounts();
      fetchWallet();
      fetchNotifications();
    }, 15000);
    return () => clearInterval(i);
  }, [fetchAccounts, fetchWallet, fetchNotifications, loadProfile, fetchKycStatus]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchAccounts(), fetchWallet(), fetchNotifications(), fetchKycStatus()]);
    setRefreshing(false);
  };

  const liveAccounts = useMemo(() => rows.filter((a) => !a.is_demo), [rows]);

  const transferOptions = useMemo(() => {
    const opts = [
      { id: 'wallet', label: 'Main Wallet', sublabel: 'Wallet', balance: mainWallet },
    ];
    for (const a of liveAccounts) {
      opts.push({
        id: a.id,
        label: `#${a.account_number}`,
        sublabel: a.account_group?.name ?? 'Live',
        balance: Number(a.free_margin ?? a.balance ?? 0),
      });
    }
    return opts;
  }, [liveAccounts, mainWallet]);

  useEffect(() => {
    if (!uniTo && transferOptions.length > 1) {
      setUniTo(transferOptions[1].id);
    }
  }, [transferOptions, uniTo]);

  const uniFromBalance = useMemo(() => {
    const o = transferOptions.find((x) => x.id === uniFrom);
    return o ? o.balance : 0;
  }, [uniFrom, transferOptions]);

  const swapFromTo = () => {
    const prev = uniFrom;
    setUniFrom(uniTo);
    setUniTo(prev);
  };

  const submitTransfer = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) {
      Alert.alert('Invalid amount', 'Enter a valid amount');
      return;
    }
    if (uniFrom === uniTo) {
      Alert.alert('Invalid', 'Source and destination must differ');
      return;
    }
    if (amt > uniFromBalance + 1e-9) {
      Alert.alert('Insufficient balance', 'Not enough funds to transfer');
      return;
    }
    setSubmitting(true);
    try {
      let path, body;
      if (uniFrom === 'wallet') {
        path = '/wallet/transfer-main-to-trading';
        body = { to_account_id: uniTo, amount: amt };
      } else if (uniTo === 'wallet') {
        path = '/wallet/transfer-trading-to-main';
        body = { from_account_id: uniFrom, amount: amt };
      } else {
        path = '/wallet/transfer-internal';
        body = { from_account_id: uniFrom, to_account_id: uniTo, amount: amt };
      }
      const res = await authedFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.detail || data?.message || 'Transfer failed');
      Alert.alert('Success', `Transferred ${fmt(amt)}`);
      setAmount('');
      await Promise.all([fetchAccounts(), fetchWallet()]);
    } catch (e) {
      Alert.alert('Transfer failed', e?.message || 'Please try again');
    } finally {
      setSubmitting(false);
    }
  };

  const newAccount = () => {
    // Mirror web: live trading accounts require approved KYC. Block here so
    // the user can't even land on the picker, then show the gate dialog.
    if (!isKycApproved(kycStatus)) {
      showKycGate(navigation, kycStatus);
      return;
    }
    navigation.navigate('Accounts', { action: 'open' });
  };

  // ── Render ─────────────────────────────────────────────────────

  const S = styles(colors);

  return (
    <View style={[S.root, { backgroundColor: colors.bgPrimary }]}>
      {/* Top bar */}
      <View style={[S.topBar, { backgroundColor: colors.bgPrimary, borderBottomColor: colors.border }]}>
        <Text style={S.logo}>
          <Text style={{ color: colors.textPrimary }}>inTrend</Text>
          <Text style={{ color: colors.accent }}>FX</Text>
        </Text>

        <View style={S.topRight}>
          {/* Search bar (replaces wallet pill) */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flex: 1,
              minWidth: 120,
              maxWidth: 220,
              height: 36,
              borderRadius: 18,
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
              placeholder="Search"
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

          <TouchableOpacity
            style={[S.iconBtn, { backgroundColor: colors.bgCard }]}
            onPress={() => navigation.navigate('Notifications')}
          >
            <Ionicons name="notifications-outline" size={20} color={colors.textPrimary} />
            {unreadCount > 0 && (
              <View style={S.bellBadge}>
                <Text style={S.bellBadgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[S.avatar, { backgroundColor: colors.accent + '22', borderColor: colors.accent + '55' }]}
            onPress={() => navigation.navigate('Profile')}
          >
            <Text style={[S.avatarText, { color: colors.accent }]}>{userInitials}</Text>
          </TouchableOpacity>
        </View>
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
                  navigation.navigate('MainTrading', { screen: 'Chart', params: { symbol: item.symbol } });
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
                  {!!(item.name || item.display_name) && (
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      {item.name || item.display_name}
                    </Text>
                  )}
                </View>
                {!!(item.category || item.segment) && (
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>{item.category || item.segment}</Text>
                )}
              </TouchableOpacity>
            ))
          )}
        </View>
      )}

      {/* Tabs */}
      <View style={[S.tabsRow, { backgroundColor: colors.bgCard, borderBottomColor: colors.border }]}>
        {[
          { id: 'accounts', label: 'Accounts' },
          { id: 'transfer', label: 'Internal Transfer' },
        ].map((t) => {
          const active = tab === t.id;
          return (
            <TouchableOpacity key={t.id} style={S.tabBtn} onPress={() => setTab(t.id)}>
              <Text style={[S.tabLabel, { color: active ? colors.accent : colors.textMuted, fontWeight: active ? '800' : '600' }]}>
                {t.label}
              </Text>
              {active && <View style={[S.tabIndicator, { backgroundColor: colors.accent }]} />}
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        showsVerticalScrollIndicator={false}
      >
        {kycStatus !== 'approved' && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => navigation.navigate('Kyc')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: 14,
              borderRadius: 12,
              marginBottom: 14,
              backgroundColor: kycStatus === 'rejected' ? '#ef444415' : '#f59e0b15',
              borderWidth: 1,
              borderColor: kycStatus === 'rejected' ? '#ef4444' : '#f59e0b',
            }}
          >
            <View style={{
              width: 40, height: 40, borderRadius: 20, marginRight: 12,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: kycStatus === 'rejected' ? '#ef444425' : '#f59e0b25',
            }}>
              <Ionicons
                name={kycStatus === 'rejected' ? 'close-circle' : kycStatus === 'review' ? 'time' : 'shield-outline'}
                size={22}
                color={kycStatus === 'rejected' ? '#ef4444' : '#f59e0b'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.textPrimary, fontWeight: '700', fontSize: 14 }}>
                {kycStatus === 'rejected' ? 'KYC Rejected — Re-upload required'
                  : kycStatus === 'review' ? 'KYC Under Review — Tap to upload more'
                  : 'Complete Your KYC Verification'}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                {kycStatus === 'rejected' ? 'Submit valid documents to continue trading.'
                  : kycStatus === 'review' ? 'Add additional documents if admin requested.'
                  : 'Verify your identity to unlock all features.'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
          </TouchableOpacity>
        )}

        {tab === 'accounts' && (
          <View style={[S.panel, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
            <Text style={[S.panelTitle, { color: colors.textPrimary }]}>Trading Accounts</Text>
            <Text style={[S.panelSubtitle, { color: colors.textMuted }]}>Manage your trading accounts</Text>

            <TouchableOpacity
              style={[S.newAccountBtn, { borderColor: colors.accent }]}
              onPress={newAccount}
              activeOpacity={0.7}
            >
              <Ionicons name="add" size={18} color={colors.accent} />
              <Text style={[S.newAccountText, { color: colors.accent }]}>New Account</Text>
            </TouchableOpacity>

            {loading ? (
              <View style={S.loaderBox}>
                <ActivityIndicator color={colors.accent} />
                <Text style={[S.loaderText, { color: colors.textMuted }]}>Loading accounts…</Text>
              </View>
            ) : rows.length === 0 ? (
              <View style={[S.emptyBox, { borderColor: colors.border, backgroundColor: colors.bgSecondary }]}>
                <Text style={[S.emptyText, { color: colors.textMuted }]}>
                  You do not have a trading account yet. Open one to start.
                </Text>
              </View>
            ) : (
              rows.map((row) => (
                <AccountCard
                  key={row.id}
                  row={row}
                  colors={colors}
                  expanded={expandedId === row.id}
                  onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  onTrade={() => navigation.navigate('MainTrading', { account_id: row.id, account_number: row.account_number })}
                  onJournal={() =>
                    navigation.navigate('Portfolio', { account_id: row.id, account_no: row.account_number, tab: 'history' })
                  }
                />
              ))
            )}
          </View>
        )}

        {tab === 'transfer' && (
          <View style={[S.panel, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
            <View style={S.transferHeader}>
              <View style={[S.transferHeaderIcon, { backgroundColor: colors.accent + '18', borderColor: colors.accent + '44' }]}>
                <Ionicons name="swap-horizontal" size={20} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[S.panelTitle, { color: colors.textPrimary, marginBottom: 2 }]}>Internal Transfer</Text>
                <Text style={[S.panelSubtitle, { color: colors.textMuted }]}>
                  Move funds between your main wallet and live trading accounts.
                </Text>
              </View>
            </View>

            {liveAccounts.length === 0 ? (
              <View style={[S.emptyBox, { borderColor: colors.border, backgroundColor: colors.bgSecondary, marginTop: 16 }]}>
                <Text style={[S.emptyText, { color: colors.textMuted }]}>
                  No live trading accounts yet. Open one to transfer.
                </Text>
              </View>
            ) : (
              <>
                {/* From */}
                <Text style={[S.fieldLabel, { color: colors.textMuted }]}>FROM</Text>
                <TransferOptionPicker
                  options={transferOptions}
                  value={uniFrom}
                  onChange={(v) => {
                    setUniFrom(v);
                    if (uniTo === v) {
                      const alt = transferOptions.find((o) => o.id !== v);
                      if (alt) setUniTo(alt.id);
                    }
                  }}
                  colors={colors}
                  highlight
                />

                <View style={S.swapWrap}>
                  <TouchableOpacity
                    style={[S.swapBtn, { borderColor: colors.accent + '55', backgroundColor: colors.bgSecondary }]}
                    onPress={swapFromTo}
                  >
                    <Ionicons name="swap-vertical" size={18} color={colors.accent} />
                  </TouchableOpacity>
                </View>

                {/* To */}
                <Text style={[S.fieldLabel, { color: colors.textMuted }]}>TO</Text>
                <TransferOptionPicker
                  options={transferOptions.filter((o) => o.id !== uniFrom)}
                  value={uniTo}
                  onChange={setUniTo}
                  colors={colors}
                />

                {/* Amount */}
                <View style={[S.amountRow, { borderTopColor: colors.border }]}>
                  <Text style={[S.fieldLabel, { color: colors.textPrimary, marginBottom: 0 }]}>Amount</Text>
                  <TouchableOpacity onPress={() => setAmount(uniFromBalance > 0 ? uniFromBalance.toFixed(2) : '')}>
                    <Text style={[S.maxText, { color: colors.accent }]}>Max: {fmt(uniFromBalance)}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  style={[
                    S.amountInput,
                    { borderColor: colors.border, color: colors.textPrimary, backgroundColor: colors.bgSecondary },
                  ]}
                />

                <TouchableOpacity
                  style={[
                    S.submitBtn,
                    { backgroundColor: colors.accent, opacity: submitting || !amount ? 0.5 : 1 },
                  ]}
                  disabled={submitting || !amount || uniFrom === uniTo || uniFromBalance <= 0}
                  onPress={submitTransfer}
                  activeOpacity={0.85}
                >
                  <Ionicons name="swap-horizontal" size={18} color="#fff" />
                  <Text style={S.submitText}>{submitting ? 'Transferring…' : 'Transfer'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
};

// ── Account Card ──────────────────────────────────────────────────

const AccountCard = ({ row, colors, expanded, onToggle, onTrade, onJournal }) => {
  const S = styles(colors);
  const balance = Number(row.balance) || 0;
  const equity = Number(row.equity) || 0;
  const pnl = equity - balance;
  const pct = balance > 0 ? (equity / balance - 1) * 100 : 0;
  const pnlPos = pnl >= 0;
  const idLabel = row.is_demo ? `#D#${row.account_number}` : `#L#${row.account_number}`;
  const label = accountLabelFor(row);

  return (
    <View
      style={[
        S.accountCard,
        {
          borderColor: expanded ? colors.accent + '80' : colors.border,
          backgroundColor: colors.bgPrimary,
        },
      ]}
    >
      <TouchableOpacity activeOpacity={0.8} onPress={onToggle} style={S.accountHeader}>
        <View style={[S.accountDot, { backgroundColor: row.is_demo ? '#38bdf8' : colors.accent }]} />
        <View style={{ flex: 1 }}>
          <View style={S.accountTitleRow}>
            <Text style={[S.accountLabel, { color: colors.textPrimary }]}>{label}</Text>
            <Text style={[S.accountId, { color: colors.textMuted }]}>{idLabel}</Text>
          </View>

          <View style={S.statsGrid}>
            <View style={S.statCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Balance</Text>
              <Text style={[S.statValue, { color: colors.textPrimary }]}>{fmt(balance, row.currency)}</Text>
            </View>
            <View style={S.statCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Equity</Text>
              <Text style={[S.statValue, { color: colors.textPrimary }]}>{fmt(equity, row.currency)}</Text>
            </View>
            <View style={S.statCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>P&L</Text>
              <Text style={[S.statValue, { color: pnlPos ? colors.accent : colors.error }]}>
                ~ {pnlPos ? '+' : ''}
                {fmt(pnl, row.currency)}
              </Text>
              <Text style={[S.statSub, { color: pnlPos ? colors.accent + 'b0' : colors.error + 'b0' }]}>
                ({pnlPos ? '+' : ''}
                {pct.toFixed(2)}%)
              </Text>
            </View>
            <View style={S.statCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Leverage</Text>
              <Text style={[S.statValue, { color: colors.textPrimary }]}>1:{row.leverage || 0}</Text>
            </View>
          </View>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={colors.textMuted}
          style={{ alignSelf: 'flex-start', marginTop: 4 }}
        />
      </TouchableOpacity>

      {expanded && (
        <View style={[S.accountBody, { borderTopColor: colors.border }]}>
          <View style={S.detailsGrid}>
            <View style={S.detailCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Free Margin</Text>
              <Text style={[S.detailValue, { color: colors.textPrimary }]}>
                {fmt(row.free_margin, row.currency)}
              </Text>
            </View>
            <View style={S.detailCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Margin Level</Text>
              <Text style={[S.detailValue, { color: colors.textPrimary }]}>
                {Number.isFinite(Number(row.margin_level)) && Number(row.margin_level) > 0
                  ? `${Number(row.margin_level).toFixed(2)}%`
                  : '0.00%'}
              </Text>
            </View>
            <View style={S.detailCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Currency</Text>
              <Text style={[S.detailValue, { color: colors.textPrimary }]}>{row.currency || 'USD'}</Text>
            </View>
            <View style={S.detailCol}>
              <Text style={[S.statLabel, { color: colors.textMuted }]}>Type</Text>
              <Text style={[S.detailValue, { color: colors.textPrimary }]}>
                {row.account_group?.name || (row.is_demo ? 'Demo' : 'Live')}
              </Text>
            </View>
          </View>

          <View style={S.actionRow}>
            <TouchableOpacity style={[S.secondaryBtn, { borderColor: colors.border }]} onPress={onJournal}>
              <Ionicons name="book-outline" size={14} color={colors.textPrimary} />
              <Text style={[S.secondaryBtnText, { color: colors.textPrimary }]}>Journal</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[S.primaryBtn, { backgroundColor: colors.accent }]} onPress={onTrade}>
              <Text style={S.primaryBtnText}>Trade</Text>
              <Ionicons name="open-outline" size={13} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

// ── Transfer option picker (horizontal chip selector) ────────────

const TransferOptionPicker = ({ options, value, onChange, colors, highlight }) => {
  const S = styles(colors);
  return (
    <View style={{ marginBottom: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {options.map((o) => {
          const active = value === o.id;
          return (
            <TouchableOpacity
              key={o.id}
              onPress={() => onChange(o.id)}
              style={[
                S.chip,
                {
                  borderColor: active ? colors.accent : colors.border,
                  backgroundColor: active ? colors.accent + '18' : colors.bgSecondary,
                },
              ]}
            >
              <Ionicons
                name={o.id === 'wallet' ? 'wallet' : 'briefcase'}
                size={14}
                color={active ? colors.accent : colors.textMuted}
              />
              <Text style={[S.chipLabel, { color: active ? colors.accent : colors.textPrimary }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {value && (
        <View
          style={[
            S.selectedCard,
            {
              borderColor: highlight ? colors.accent + '55' : colors.border,
              backgroundColor: colors.bgSecondary,
            },
          ]}
        >
          {(() => {
            const opt = options.find((o) => o.id === value);
            if (!opt) return null;
            const isWallet = opt.id === 'wallet';
            return (
              <>
                <View style={[S.selectedIcon, { backgroundColor: colors.accent + '18' }]}>
                  <Ionicons name={isWallet ? 'wallet' : 'briefcase'} size={18} color={colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[S.selectedLabel, { color: colors.textPrimary }]}>{opt.label}</Text>
                  <Text style={[S.selectedSub, { color: colors.textMuted }]}>{opt.sublabel}</Text>
                </View>
                <Text style={[S.selectedAmount, { color: highlight ? colors.accent : colors.textPrimary }]}>
                  {fmt(opt.balance)}
                </Text>
              </>
            );
          })()}
        </View>
      )}
    </View>
  );
};

// ── Styles ───────────────────────────────────────────────────────

const styles = (colors) =>
  StyleSheet.create({
    root: { flex: 1, paddingTop: 44 },

    // Top bar
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    logo: { fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
    topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    balancePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
    },
    balancePillText: { fontSize: 13, fontWeight: '700' },
    iconBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      justifyContent: 'center',
      alignItems: 'center',
    },
    bellBadge: {
      position: 'absolute',
      top: -2,
      right: -2,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: '#ef4444',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 4,
    },
    bellBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
    avatar: {
      width: 38,
      height: 38,
      borderRadius: 19,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
    },
    avatarText: { fontSize: 13, fontWeight: '800' },

    // Tabs
    tabsRow: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    tabBtn: { flex: 1, paddingVertical: 16, alignItems: 'center' },
    tabLabel: { fontSize: 14 },
    tabIndicator: {
      position: 'absolute',
      bottom: 0,
      height: 3,
      width: '40%',
      borderTopLeftRadius: 3,
      borderTopRightRadius: 3,
    },

    // Panel
    panel: {
      borderRadius: 16,
      borderWidth: 1,
      padding: 18,
    },
    panelTitle: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
    panelSubtitle: { fontSize: 13, marginTop: 4, marginBottom: 14 },

    // New account
    newAccountBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 12,
      borderRadius: 10,
      borderWidth: 2,
      marginBottom: 14,
    },
    newAccountText: { fontSize: 14, fontWeight: '800' },

    // Account card
    accountCard: {
      borderRadius: 14,
      borderWidth: 1,
      marginBottom: 10,
      overflow: 'hidden',
    },
    accountHeader: {
      flexDirection: 'row',
      gap: 10,
      padding: 14,
      alignItems: 'flex-start',
    },
    accountDot: { width: 9, height: 9, borderRadius: 5, marginTop: 8 },
    accountTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 10,
    },
    accountLabel: { fontSize: 14, fontWeight: '800' },
    accountId: { fontSize: 12, fontFamily: 'monospace' },

    statsGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
    statCol: { width: '50%' },
    statLabel: { fontSize: 10, fontWeight: '600', marginBottom: 2, letterSpacing: 0.3 },
    statValue: { fontSize: 15, fontWeight: '800' },
    statSub: { fontSize: 10, fontWeight: '700', marginTop: 1 },

    accountBody: { borderTopWidth: StyleSheet.hairlineWidth, padding: 14, gap: 14 },
    detailsGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
    detailCol: { width: '50%' },
    detailValue: { fontSize: 14, fontWeight: '700' },

    actionRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 8,
    },
    primaryBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
    secondaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      borderWidth: 1,
    },
    secondaryBtnText: { fontSize: 13, fontWeight: '700' },

    // Empty / loader
    emptyBox: {
      borderWidth: 1,
      borderRadius: 12,
      padding: 20,
      alignItems: 'center',
    },
    emptyText: { fontSize: 13, textAlign: 'center' },
    loaderBox: { alignItems: 'center', paddingVertical: 36, gap: 8 },
    loaderText: { fontSize: 13 },

    // Transfer
    transferHeader: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14 },
    transferHeaderIcon: {
      width: 42,
      height: 42,
      borderRadius: 12,
      borderWidth: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8, marginTop: 6 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
    },
    chipLabel: { fontSize: 12, fontWeight: '700' },
    selectedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      marginTop: 8,
    },
    selectedIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
    },
    selectedLabel: { fontSize: 14, fontWeight: '700' },
    selectedSub: { fontSize: 10, fontWeight: '600', marginTop: 2, letterSpacing: 0.4, textTransform: 'uppercase' },
    selectedAmount: { fontSize: 15, fontWeight: '800' },

    swapWrap: { alignItems: 'center', marginVertical: 4 },
    swapBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      borderWidth: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },

    amountRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      paddingTop: 14,
      marginTop: 8,
      marginBottom: 8,
    },
    maxText: { fontSize: 12, fontWeight: '700' },
    amountInput: {
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
    },
    submitBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 14,
      borderRadius: 12,
      marginTop: 14,
    },
    submitText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  });

export default DashboardScreen;

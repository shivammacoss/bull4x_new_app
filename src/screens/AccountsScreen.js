import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import { useTheme } from '../context/ThemeContext';
import { authedFetch } from '../utils/authedFetch';
import { isKycApproved, showKycGate, fetchKycStatus } from '../utils/kycGate';
import { fmtMoney, fmtSigned } from '../utils/currency';

function isDemoAccount(a) {
  return !!(a?.is_demo || a?.isDemo || a?.accountTypeId?.isDemo);
}

// Account-open flow currencies (mirrors web AccountTypePickerModal). The backend
// converts the min deposit / virtual balance into the chosen currency via FX.
const OPEN_CURRENCIES = [
  { code: 'USD', label: 'US Dollar', symbol: '$', flag: '🇺🇸' },
  { code: 'INR', label: 'Indian Rupee', symbol: '₹', flag: '🇮🇳' },
];

/** Common leverage tiers up to (and including) a group's max. */
function leverageTiers(max) {
  const common = [1, 2, 5, 10, 25, 50, 100, 200, 300, 400, 500, 1000];
  const m = Number(max) || 100;
  const tiers = common.filter((v) => v <= m);
  if (!tiers.includes(m)) tiers.push(m);
  return tiers.sort((a, b) => a - b);
}

function isActiveStatus(a) {
  const s = String(a?.status || '').toLowerCase();
  return !s || s === 'active';
}

const AccountsScreen = ({ navigation, route }) => {
  const { colors } = useTheme();
  const [user, setUser] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  
  // Transfer states
  const [walletBalance, setWalletBalance] = useState(0);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [showWithdrawRequestModal, setShowWithdrawRequestModal] = useState(false);
  const [showAccountTransferModal, setShowAccountTransferModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [targetAccount, setTargetAccount] = useState(null);
  const [transferAmount, setTransferAmount] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  
  // Withdrawal request states
  const [withdrawMethod, setWithdrawMethod] = useState('Bank'); // 'Bank', 'UPI'
  const [bankDetails, setBankDetails] = useState({
    bankName: '',
    accountNumber: '',
    ifscCode: '',
    accountHolderName: '',
  });
  const [upiId, setUpiId] = useState('');

  // KYC gate state — live trading accounts require approved KYC (matches web).
  const [kycStatus, setKycStatus] = useState('none');

  // Account creation states (matches web /accounts/available-groups + POST /accounts/open)
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [openingAccount, setOpeningAccount] = useState(false);
  // Multi-step open flow: type -> currency -> leverage (mirrors web)
  const [openStep, setOpenStep] = useState('type');
  const [chosenCurrency, setChosenCurrency] = useState('USD');
  const [chosenLeverage, setChosenLeverage] = useState(null);
  // Live / Demo mode toggle (mirrors web acctMode). Demo opens skip the KYC gate
  // and are auto-funded with virtual balance by the backend.
  const [acctMode, setAcctMode] = useState('live');

  // Delete account state
  const [deletingAccountId, setDeletingAccountId] = useState(null);

  // Expand/collapse + label editing for cards
  const [expandedAccountId, setExpandedAccountId] = useState(null);
  const [accountLabels, setAccountLabels] = useState({});
  const [editingLabelId, setEditingLabelId] = useState(null);
  const [labelDraft, setLabelDraft] = useState('');

  // Load saved labels from SecureStore
  useEffect(() => {
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync('accountLabels');
        if (stored) setAccountLabels(JSON.parse(stored));
      } catch (e) {}
    })();
  }, []);

  const saveLabel = async (aid) => {
    const next = { ...accountLabels };
    const v = (labelDraft || '').trim();
    if (v) next[aid] = v;
    else delete next[aid];
    setAccountLabels(next);
    try {
      await SecureStore.setItemAsync('accountLabels', JSON.stringify(next));
    } catch (e) {}
    setEditingLabelId(null);
    setLabelDraft('');
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
      return '—';
    }
  };

  // Handle incoming route params for deposit/withdraw action
  const [pendingAction, setPendingAction] = useState(null);

  useEffect(() => {
    loadUser();
    // Refresh the KYC status on every mount so the gate reflects the latest
    // admin decision without forcing a full re-login.
    (async () => {
      const s = await fetchKycStatus();
      setKycStatus(s);
    })();
  }, []);

  useEffect(() => {
    if (user) {
      // Fetch all data and then set loading false
      const loadData = async () => {
        try {
          await Promise.all([fetchAccounts(), fetchWalletBalance()]);
        } catch (e) {
          console.error('Error loading accounts data:', e);
        } finally {
          setLoading(false);
        }
      };
      loadData();
    }
  }, [user]);
  
  // Auto-open the new-account modal if navigated with action=open
  useEffect(() => {
    if (route?.params?.action === 'open') {
      openNewAccountModal();
      navigation.setParams({ action: null });
    }
  }, [route?.params?.action]);

  // Handle route params to auto-open deposit/withdraw modal
  useEffect(() => {
    if (route?.params?.action && route?.params?.accountId && accounts.length > 0) {
      const account = accounts.find(
        (a) => String(a.id || a._id) === String(route.params.accountId)
      );
      if (account) {
        setSelectedAccount(account);
        setTransferAmount('');
        if (route.params.action === 'deposit') {
          fetchWalletBalance();
          setShowTransferModal(true);
        } else if (route.params.action === 'withdraw') {
          setShowWithdrawModal(true);
        }
        // Clear the params to prevent re-triggering
        navigation.setParams({ action: null, accountId: null });
      }
    }
  }, [route?.params, accounts]);

  const fetchWalletBalance = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      if (!token) return;
      const headers = { 'Authorization': `Bearer ${token}` };
      const res = await fetch(`${API_URL}/wallet/summary`, { headers });
      const data = await res.json().catch(() => ({}));
      // API sometimes returns strings like "0" or "100.50" — coerce + check via Number
      let mainBal = data.main_wallet_balance ?? data.wallet_balance ?? data.balance;

      // Fallback: /wallet/summary returned 0/missing — try /wallet/:userId
      if (mainBal == null || Number(mainBal) === 0 || Number.isNaN(Number(mainBal))) {
        try {
          const userData = await SecureStore.getItemAsync('user');
          if (userData) {
            const u = JSON.parse(userData);
            const userId = u._id || u.id;
            if (userId) {
              const r2 = await fetch(`${API_URL}/wallet/${userId}`, { headers });
              if (r2.ok) {
                const d2 = await r2.json().catch(() => ({}));
                const w = d2.wallet || d2;
                const fb = w.main_wallet_balance ?? w.wallet_balance ?? w.balance;
                if (fb != null && Number(fb) > 0) mainBal = fb;
              }
            }
          }
        } catch (_) {}
      }

      setWalletBalance(Number(mainBal) || 0);
    } catch (e) {
      console.error('Error fetching wallet:', e);
    }
  };

  const loadUser = async () => {
    try {
      const userData = await SecureStore.getItemAsync('user');
      if (userData) {
        setUser(JSON.parse(userData));
      }
    } catch (e) {
      console.error('Error loading user:', e);
    }
  };

  const fetchAccounts = async () => {
    if (!user) return;
    try {
      const token = await SecureStore.getItemAsync('token');
      console.log('AccountsScreen - Fetching accounts with token auth');
      const res = await fetch(`${API_URL}/accounts`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const items = data.items || data || [];
      // Map TrustEdge account fields to expected format (show both demo and live, like web)
      const mappedAccounts = items.map((a) => ({
        ...a,
        id: a.id || a._id,
        _id: a.id || a._id,
        accountId: a.account_number || a.accountId || a.id,
        account_number: a.account_number,
        isDemo: a.is_demo || a.isDemo || false,
        status: a.status === 'active' ? 'Active' : (a.status || 'Active'),
        accountType: a.account_type || a.accountType || (a.account_group?.name) || 'Standard',
      }));
      console.log('AccountsScreen - Accounts response:', mappedAccounts.length, 'accounts (demo+live)');
      setAccounts(mappedAccounts);
    } catch (e) {
      console.warn('AccountsScreen - Error fetching accounts:', e.message);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchAccounts(), fetchWalletBalance()]);
    setRefreshing(false);
  };


  const handleDeposit = (account) => {
    console.log('Opening deposit modal for account:', account.accountId, account._id);
    setSelectedAccount(account);
    setTransferAmount('');
    fetchWalletBalance(); // Refresh wallet balance
    setShowTransferModal(true);
  };

  const handleWithdraw = (account) => {
    console.log('Opening withdraw modal for account:', account.accountId, account._id);
    setSelectedAccount(account);
    setTransferAmount('');
    setShowWithdrawModal(true);
  };

  const handleAccountTransfer = (account) => {
    setSelectedAccount(account);
    setTargetAccount(null);
    setTransferAmount('');
    setShowAccountTransferModal(true);
  };

  // Transfer from wallet to account - TrustEdge uses wallet deposit
  const handleTransferFunds = async () => {
    if (!selectedAccount || !selectedAccount._id) {
      Alert.alert('Error', 'No account selected');
      return;
    }
    if (!transferAmount || parseFloat(transferAmount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }
    if (parseFloat(transferAmount) > walletBalance) {
      Alert.alert('Error', 'Insufficient wallet balance');
      return;
    }

    setIsTransferring(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
      const accountId = selectedAccount.id || selectedAccount._id;
      const amount = parseFloat(transferAmount);

      // Try the web endpoint first (matches frontend/trader)
      let res = await fetch(`${API_URL}/wallet/transfer-main-to-trading`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to_account_id: accountId, amount }),
      });

      // Fall back to legacy /wallet/deposit if the new endpoint isn't available
      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${API_URL}/wallet/deposit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            account_id: accountId,
            amount,
            method: 'internal_transfer',
          }),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        await Promise.all([fetchAccounts(), fetchWalletBalance()]);
        setShowTransferModal(false);
        setTransferAmount('');
        setSelectedAccount(null);
        Alert.alert('Success', 'Funds transferred to account!');
      } else {
        Alert.alert('Error', data.detail || data.message || `Transfer failed (HTTP ${res.status})`);
      }
    } catch (e) {
      console.error('Transfer error:', e);
      Alert.alert('Error', 'Error transferring funds: ' + e.message);
    }
    setIsTransferring(false);
  };

  // Withdraw from account to wallet - TrustEdge uses wallet withdraw
  const handleWithdrawFromAccount = async () => {
    if (!transferAmount || parseFloat(transferAmount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }
    if (!selectedAccount) {
      Alert.alert('Error', 'No account selected');
      return;
    }
    if (parseFloat(transferAmount) > (selectedAccount.balance || 0)) {
      Alert.alert('Error', 'Insufficient account balance');
      return;
    }

    setIsTransferring(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
      const accountId = selectedAccount.id || selectedAccount._id;
      const amount = parseFloat(transferAmount);

      // Try the web endpoint first
      let res = await fetch(`${API_URL}/wallet/transfer-trading-to-main`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from_account_id: accountId, amount }),
      });

      // Fall back to legacy /wallet/withdraw with internal_transfer method
      if (res.status === 404 || res.status === 405) {
        res = await fetch(`${API_URL}/wallet/withdraw`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            account_id: accountId,
            amount,
            method: 'internal_transfer',
          }),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        await Promise.all([fetchAccounts(), fetchWalletBalance()]);
        setShowWithdrawModal(false);
        setTransferAmount('');
        setSelectedAccount(null);
        Alert.alert('Success', 'Funds withdrawn to main wallet!');
      } else {
        Alert.alert('Error', data.detail || data.message || `Withdrawal failed (HTTP ${res.status})`);
      }
    } catch (e) {
      Alert.alert('Error', 'Error withdrawing funds: ' + e.message);
    }
    setIsTransferring(false);
  };

  // Submit withdrawal request to admin (from wallet to bank/UPI)
  const handleWithdrawRequest = async () => {
    if (!transferAmount || parseFloat(transferAmount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }
    if (parseFloat(transferAmount) > walletBalance) {
      Alert.alert('Error', 'Insufficient wallet balance');
      return;
    }

    // Validate payment details
    if (withdrawMethod === 'Bank') {
      if (!bankDetails.bankName || !bankDetails.accountNumber || !bankDetails.ifscCode || !bankDetails.accountHolderName) {
        Alert.alert('Error', 'Please fill all bank details');
        return;
      }
    } else if (withdrawMethod === 'UPI') {
      if (!upiId) {
        Alert.alert('Error', 'Please enter UPI ID');
        return;
      }
    }

    setIsTransferring(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const bankAccountDetails = withdrawMethod === 'Bank' 
        ? {
            type: 'Bank',
            bankName: bankDetails.bankName,
            accountNumber: bankDetails.accountNumber,
            ifscCode: bankDetails.ifscCode,
            accountHolderName: bankDetails.accountHolderName,
          }
        : {
            type: 'UPI',
            upiId: upiId,
          };

      const res = await fetch(`${API_URL}/wallet/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          amount: parseFloat(transferAmount),
          method: withdrawMethod === 'Bank' ? 'bank' : 'upi',
          bank_details: bankAccountDetails,
        })
      });
      const data = await res.json();
      
      if (res.ok) {
        Alert.alert('Success', 'Withdrawal request submitted! Admin will process it shortly.');
        setShowWithdrawRequestModal(false);
        setTransferAmount('');
        setBankDetails({ bankName: '', accountNumber: '', ifscCode: '', accountHolderName: '' });
        setUpiId('');
        fetchWalletBalance();
      } else {
        Alert.alert('Error', data.message || 'Withdrawal request failed');
      }
    } catch (e) {
      Alert.alert('Error', 'Error submitting withdrawal request');
    }
    setIsTransferring(false);
  };

  // Transfer between accounts - matches web POST /wallet/transfer-internal
  const handleAccountToAccountTransfer = async () => {
    if (!selectedAccount?._id) {
      Alert.alert('Error', 'No source account selected');
      return;
    }
    if (!targetAccount?._id) {
      Alert.alert('Error', 'Please select a target account');
      return;
    }
    if (selectedAccount._id === targetAccount._id) {
      Alert.alert('Error', 'Source and target must be different accounts');
      return;
    }
    if (!transferAmount || parseFloat(transferAmount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }
    const freeMargin = Number(selectedAccount.free_margin ?? selectedAccount.balance ?? 0);
    if (parseFloat(transferAmount) > freeMargin) {
      Alert.alert('Error', 'Insufficient free margin in source account');
      return;
    }

    setIsTransferring(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/wallet/transfer-internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          from_account_id: selectedAccount.id || selectedAccount._id,
          to_account_id: targetAccount.id || targetAccount._id,
          amount: parseFloat(transferAmount),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        await Promise.all([fetchAccounts(), fetchWalletBalance()]);
        setShowAccountTransferModal(false);
        setTransferAmount('');
        setSelectedAccount(null);
        setTargetAccount(null);
        Alert.alert('Success', 'Funds transferred between accounts');
      } else {
        Alert.alert('Error', data.detail || data.message || 'Transfer failed');
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Transfer failed');
    }
    setIsTransferring(false);
  };

  // Fetch available account groups for new account creation. Demo mode asks the
  // backend for demo-only groups (is_demo=true), matching the web picker.
  const fetchAccountGroups = async (isDemo = false) => {
    setGroupsLoading(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(
        `${API_URL}/accounts/available-groups?is_demo=${isDemo ? 'true' : 'false'}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
      );
      const data = await res.json().catch(() => ({}));
      const items = data.items || data || [];
      setGroups(Array.isArray(items) ? items : []);
    } catch (e) {
      console.warn('Account groups fetch error:', e.message);
      setGroups([]);
    }
    setGroupsLoading(false);
  };

  const openNewAccountModal = async () => {
    const demo = acctMode === 'demo';
    // Live accounts require approved KYC. Demo accounts skip the gate (matches web).
    if (!demo) {
      // Re-check KYC so the gate stays accurate even if the user lingered long
      // enough for an admin decision to land.
      const fresh = await fetchKycStatus();
      setKycStatus(fresh);
      if (!isKycApproved(fresh)) {
        showKycGate(navigation, fresh);
        return;
      }
    }
    setSelectedGroupId(null);
    setOpenStep('type');
    setChosenCurrency('USD');
    setChosenLeverage(null);
    setShowOpenModal(true);
    await fetchAccountGroups(demo);
  };

  // Create new trading account (matches web POST /accounts/open — sends the
  // chosen currency so the backend can open an INR or USD account with FX).
  const handleOpenAccount = async () => {
    if (!selectedGroupId) {
      Alert.alert('Account type', 'Please select an account type');
      return;
    }
    if (!chosenLeverage) {
      Alert.alert('Leverage', 'Please select a leverage');
      return;
    }
    setOpeningAccount(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/accounts/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          account_group_id: selectedGroupId,
          leverage: chosenLeverage,
          currency: chosenCurrency,
          is_demo: acctMode === 'demo',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setShowOpenModal(false);
        setSelectedGroupId(null);
        setOpenStep('type');
        setChosenLeverage(null);
        await fetchAccounts();
        const kind = acctMode === 'demo' ? 'Demo' : chosenCurrency;
        Alert.alert('Success', `${kind} account ${data.account_number || 'created'} opened`);
      } else {
        Alert.alert('Error', data.detail || data.message || 'Could not open account');
      }
    } catch (e) {
      Alert.alert('Error', e.message || 'Could not open account');
    }
    setOpeningAccount(false);
  };

  // Delete a trading account
  const handleDeleteAccount = (account) => {
    const aid = account.id || account._id;
    const label = account.account_number || account.accountId || 'this account';
    Alert.alert(
      'Delete account',
      `Permanently delete ${label}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingAccountId(aid);
            try {
              const token = await SecureStore.getItemAsync('token');
              const res = await fetch(`${API_URL}/accounts/${aid}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
              });
              if (res.ok) {
                setAccounts((prev) => prev.filter((a) => (a.id || a._id) !== aid));
                Alert.alert('Deleted', 'Account removed');
              } else {
                const data = await res.json().catch(() => ({}));
                Alert.alert('Error', data.detail || data.message || 'Delete failed');
              }
            } catch (e) {
              Alert.alert('Error', e.message);
            }
            setDeletingAccountId(null);
          },
        },
      ]
    );
  };

  const selectAccountForTrading = async (account) => {
    const aid = account.id || account._id;
    console.log('[AccountsScreen] Trade pressed for account:', aid);
    try {
      await SecureStore.setItemAsync('selectedAccountId', aid);
    } catch (e) {}
    // First: send selectedAccountId to MainTrading stack route (triggers TradingProvider's useEffect to switch active account)
    navigation.navigate('MainTrading', { selectedAccountId: aid });
    // Then: jump to the Chart tab inside MainTrading's bottom tab navigator
    setTimeout(() => {
      try {
        navigation.navigate('MainTrading', { screen: 'Chart' });
      } catch (e) {
        console.warn('[AccountsScreen] Could not switch to Chart tab:', e?.message);
      }
    }, 80);
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Active accounts split by Live / Demo (mirrors web acctMode tabs).
  const activeAccounts = accounts.filter((a) => isActiveStatus(a));
  const liveAccountsList = activeAccounts.filter((a) => !isDemoAccount(a));
  const demoAccountsList = activeAccounts.filter((a) => isDemoAccount(a));
  const mainTradingAccounts = acctMode === 'demo' ? demoAccountsList : liveAccountsList;

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.bgPrimary }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Trading Accounts</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>Manage your trading accounts</Text>
        </View>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {/* Live / Demo segmented toggle (mirrors web) */}
        <View style={{ flexDirection: 'row', backgroundColor: colors.bgSecondary, borderRadius: 12, padding: 4, marginBottom: 14 }}>
          {[
            { key: 'live', label: 'Live Accounts', count: liveAccountsList.length },
            { key: 'demo', label: 'Demo Accounts', count: demoAccountsList.length },
          ].map((t) => {
            const active = acctMode === t.key;
            const activeColor = t.key === 'demo' ? colors.warning : colors.success;
            return (
              <TouchableOpacity
                key={t.key}
                activeOpacity={0.85}
                onPress={() => setAcctMode(t.key)}
                style={{
                  flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                  paddingVertical: 10, borderRadius: 9,
                  backgroundColor: active ? activeColor + '22' : 'transparent',
                  borderWidth: active ? 1 : 0, borderColor: active ? activeColor : 'transparent',
                }}
              >
                <Text style={{ color: active ? activeColor : colors.textMuted, fontSize: 13, fontWeight: '700' }}>{t.label}</Text>
                <View style={{ minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 10, backgroundColor: active ? activeColor + '33' : colors.bgCard }}>
                  <Text style={{ color: active ? activeColor : colors.textMuted, fontSize: 11, fontWeight: '700', textAlign: 'center' }}>{t.count}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* New Account button — full width dashed (matches web) */}
        <TouchableOpacity
          onPress={openNewAccountModal}
          activeOpacity={0.85}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            paddingVertical: 18,
            borderRadius: 14,
            borderWidth: 2,
            borderStyle: 'dashed',
            borderColor: acctMode === 'demo' ? colors.warning : colors.success,
            backgroundColor: 'transparent',
            marginBottom: 16,
          }}
        >
          <Ionicons name="add" size={20} color={acctMode === 'demo' ? colors.warning : colors.success} />
          <Text style={{ color: acctMode === 'demo' ? colors.warning : colors.success, fontSize: 15, fontWeight: '700' }}>
            {acctMode === 'demo' ? 'New Demo Account' : 'New Account'}
          </Text>
        </TouchableOpacity>

        {mainTradingAccounts.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="briefcase-outline" size={64} color={colors.textMuted} />
            <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No {acctMode === 'demo' ? 'demo' : 'live'} account</Text>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>
              Tap "+ {acctMode === 'demo' ? 'New Demo Account' : 'New Account'}" above to open one.
            </Text>
          </View>
        ) : (
          mainTradingAccounts.map((account) => {
            const aid = account.id || account._id;
            const isExpanded = expandedAccountId === aid;
            const isDemo = isDemoAccount(account);
            const dotColor = isDemo ? colors.warning : colors.success;
            const customLabel = accountLabels[aid];
            const defaultLabel = isDemo ? 'Demo Account' : 'Live Account';
            const balance = Number(account.balance || 0);
            const credit = Number(account.credit || 0);
            const equity = Number(account.equity || balance + credit);
            const pnl = equity - balance - credit;
            const pnlPct = balance > 0 ? (pnl / balance) * 100 : 0;
            const acctCur = account.currency || 'USD';
            const lev = String(account.leverage || '').includes(':')
              ? account.leverage
              : `1:${account.leverage || 100}`;
            const acctType = account.account_group?.name || account.accountTypeId?.name || account.accountType || 'Standard';
            const acctNum = account.account_number || account.accountId || '';
            const numPrefix = isDemo ? 'D' : 'L';

            return (
              <View
                key={String(aid)}
                style={{
                  backgroundColor: colors.bgCard,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: colors.border,
                  marginBottom: 14,
                }}
              >
                {/* Collapsed header — always visible, tap to expand */}
                <Pressable
                  onPress={() => {
                    console.log('[AccountsScreen] Toggle expand for', aid);
                    setExpandedAccountId(isExpanded ? null : aid);
                  }}
                  android_ripple={{ color: 'rgba(255,255,255,0.05)' }}
                  style={({ pressed }) => ({ padding: 16, opacity: pressed ? 0.95 : 1 })}
                >
                  {/* Title row: dot + label + chevron */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dotColor, marginRight: 10 }} />
                    <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '700', flex: 1 }}>
                      {customLabel || defaultLabel}
                    </Text>
                    <Ionicons
                      name={isExpanded ? 'chevron-up' : 'chevron-down'}
                      size={20}
                      color={colors.textMuted}
                    />
                  </View>

                  {/* Account number + add label */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '600' }}>
                      #{numPrefix}#{acctNum}
                    </Text>
                    {editingLabelId === aid ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginLeft: 10 }}>
                        <TextInput
                          autoFocus
                          value={labelDraft}
                          onChangeText={setLabelDraft}
                          placeholder="Account label"
                          placeholderTextColor={colors.textMuted}
                          style={{
                            flex: 1,
                            borderWidth: 1,
                            borderColor: colors.accent,
                            borderRadius: 6,
                            paddingHorizontal: 8,
                            paddingVertical: 4,
                            color: colors.textPrimary,
                            fontSize: 12,
                          }}
                        />
                        <TouchableOpacity
                          onPress={() => saveLabel(aid)}
                          style={{ marginLeft: 6, padding: 4 }}
                        >
                          <Ionicons name="checkmark" size={18} color={colors.success} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => { setEditingLabelId(null); setLabelDraft(''); }}
                          style={{ padding: 4 }}
                        >
                          <Ionicons name="close" size={18} color={colors.error} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity
                        onPress={(e) => {
                          e?.stopPropagation?.();
                          setEditingLabelId(aid);
                          setLabelDraft(customLabel || '');
                        }}
                        style={{ marginLeft: 10 }}
                      >
                        <Text style={{ color: colors.success, fontSize: 12, fontWeight: '600' }}>
                          {customLabel ? 'Edit label' : '+ Add label'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>

                  {/* Stats grid: Balance | Equity */}
                  <View style={{ flexDirection: 'row', marginBottom: 14 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>Balance</Text>
                      <Text style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '800' }}>
                        {fmtMoney(balance, acctCur)}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>Equity</Text>
                      <Text style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '800' }}>
                        {fmtMoney(equity, acctCur)}
                      </Text>
                    </View>
                  </View>

                  {/* Stats grid: P&L | Leverage */}
                  <View style={{ flexDirection: 'row' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>P&L</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Ionicons
                          name={pnl >= 0 ? 'trending-up' : 'trending-down'}
                          size={14}
                          color={pnl >= 0 ? colors.success : colors.error}
                        />
                        <Text style={{ color: pnl >= 0 ? colors.success : colors.error, fontSize: 14, fontWeight: '700' }}>
                          {fmtSigned(pnl, acctCur)}
                        </Text>
                      </View>
                      <Text style={{ color: pnl >= 0 ? colors.success : colors.error, fontSize: 11, marginTop: 2 }}>
                        ({pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 4 }}>Leverage</Text>
                      <Text style={{ color: colors.textPrimary, fontSize: 14, fontWeight: '700' }}>{lev}</Text>
                    </View>
                  </View>
                </Pressable>

                {/* Expanded section */}
                {isExpanded && (
                  <View style={{ paddingHorizontal: 16, paddingBottom: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                    <View style={{ flexDirection: 'row', marginTop: 14 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.textMuted, fontSize: 11 }}>Currency</Text>
                        <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                          {account.currency || 'USD'}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.textMuted, fontSize: 11 }}>Created</Text>
                        <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                          {formatDate(account.created_at)}
                        </Text>
                      </View>
                    </View>

                    <View style={{ marginTop: 14 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>Account type</Text>
                      <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                        {acctType}
                      </Text>
                    </View>

                    {/* Free margin (extra info) */}
                    <View style={{ marginTop: 14 }}>
                      <Text style={{ color: colors.textMuted, fontSize: 11 }}>Free margin</Text>
                      <Text style={{ color: colors.textPrimary, fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                        {fmtMoney(account.free_margin != null ? Number(account.free_margin) : 0, acctCur)}
                      </Text>
                    </View>

                    {/* Trade — primary CTA (Pressable for reliable Android touch) */}
                    <Pressable
                      onPress={() => {
                        console.log('[AccountsScreen] Trade button pressed', aid);
                        selectAccountForTrading(account);
                      }}
                      android_ripple={{ color: 'rgba(0,0,0,0.15)' }}
                      hitSlop={8}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        backgroundColor: colors.success,
                        borderRadius: 12,
                        paddingVertical: 14,
                        marginTop: 18,
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <Ionicons name="open-outline" size={18} color="#000" />
                      <Text style={{ color: '#000', fontSize: 15, fontWeight: '800' }}>Trade</Text>
                    </Pressable>

                    {/* Fund movement row */}
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <Pressable
                        onPress={() => {
                          console.log('[AccountsScreen] Deposit pressed', aid);
                          handleDeposit(account);
                        }}
                        android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
                        hitSlop={6}
                        style={({ pressed }) => ({
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          gap: 6, paddingVertical: 12, borderRadius: 10,
                          backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.border,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <Ionicons name="arrow-down-circle-outline" size={16} color={colors.textPrimary} />
                        <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>Deposit</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          console.log('[AccountsScreen] Withdraw pressed', aid);
                          handleWithdraw(account);
                        }}
                        android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
                        hitSlop={6}
                        style={({ pressed }) => ({
                          flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                          gap: 6, paddingVertical: 12, borderRadius: 10,
                          backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.border,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <Ionicons name="arrow-up-circle-outline" size={16} color={colors.textPrimary} />
                        <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>Withdraw</Text>
                      </Pressable>
                      {mainTradingAccounts.length > 1 && (
                        <Pressable
                          onPress={() => {
                            console.log('[AccountsScreen] Transfer pressed', aid);
                            handleAccountTransfer(account);
                          }}
                          android_ripple={{ color: 'rgba(255,255,255,0.1)' }}
                          hitSlop={6}
                          style={({ pressed }) => ({
                            flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                            gap: 6, paddingVertical: 12, borderRadius: 10,
                            backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.border,
                            opacity: pressed ? 0.7 : 1,
                          })}
                        >
                          <Ionicons name="swap-horizontal-outline" size={16} color={colors.textPrimary} />
                          <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>Transfer</Text>
                        </Pressable>
                      )}
                    </View>

                    {/* Close account — destructive */}
                    <Pressable
                      onPress={() => {
                        console.log('[AccountsScreen] Close account pressed', aid);
                        handleDeleteAccount(account);
                      }}
                      disabled={deletingAccountId === aid}
                      android_ripple={{ color: 'rgba(239,68,68,0.15)' }}
                      hitSlop={6}
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        marginTop: 14,
                        paddingVertical: 12,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      {deletingAccountId === aid ? (
                        <ActivityIndicator size="small" color={colors.error} />
                      ) : (
                        <Ionicons name="trash-outline" size={16} color={colors.error} />
                      )}
                      <Text style={{ color: colors.error, fontSize: 13, fontWeight: '700' }}>Close account</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Deposit Modal - Transfer from Wallet to Account */}
      <Modal visible={showTransferModal} animationType="slide" transparent onRequestClose={() => setShowTransferModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowTransferModal(false)} />
          <View style={[styles.transferModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Deposit to Account</Text>
              <TouchableOpacity onPress={() => setShowTransferModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            
            <View style={[styles.transferInfo, { backgroundColor: colors.bgSecondary }]}>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>From</Text>
                <Text style={[styles.transferValue, { color: colors.textPrimary }]}>Main Wallet</Text>
              </View>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>Available</Text>
                <Text style={[styles.transferValueGold, { color: colors.primary }]}>${walletBalance.toFixed(2)}</Text>
              </View>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>To</Text>
                <Text style={[styles.transferValue, { color: colors.textPrimary }]}>{selectedAccount?.accountId}</Text>
              </View>
            </View>

            <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Amount (USD)</Text>
            <TextInput
              style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
              value={transferAmount}
              onChangeText={setTransferAmount}
              placeholder="Enter amount"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
            />

            <TouchableOpacity 
              style={[styles.transferSubmitBtn, isTransferring && styles.btnDisabled]}
              onPress={handleTransferFunds}
              disabled={isTransferring}
            >
              {isTransferring ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.transferSubmitBtnText}>Transfer to Account</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Withdraw Modal - Transfer from Account to Wallet */}
      <Modal visible={showWithdrawModal} animationType="slide" transparent onRequestClose={() => setShowWithdrawModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowWithdrawModal(false)} />
          <View style={[styles.transferModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Withdraw to Wallet</Text>
              <TouchableOpacity onPress={() => setShowWithdrawModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            
            <View style={[styles.transferInfo, { backgroundColor: colors.bgSecondary }]}>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>From</Text>
                <Text style={[styles.transferValue, { color: colors.textPrimary }]}>{selectedAccount?.accountId}</Text>
              </View>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>Available</Text>
                <Text style={[styles.transferValueGold, { color: colors.primary }]}>${(selectedAccount?.balance || 0).toFixed(2)}</Text>
              </View>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>To</Text>
                <Text style={[styles.transferValue, { color: colors.textPrimary }]}>Main Wallet</Text>
              </View>
            </View>

            <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Amount (USD)</Text>
            <TextInput
              style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
              value={transferAmount}
              onChangeText={setTransferAmount}
              placeholder="Enter amount"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
            />

            <TouchableOpacity 
              style={[styles.withdrawSubmitBtn, { backgroundColor: colors.primary }, isTransferring && styles.btnDisabled]}
              onPress={handleWithdrawFromAccount}
              disabled={isTransferring}
            >
              {isTransferring ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.withdrawSubmitBtnText}>Withdraw to Wallet</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Withdrawal Request Modal - To Bank/UPI */}
      <Modal visible={showWithdrawRequestModal} animationType="slide" transparent onRequestClose={() => setShowWithdrawRequestModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowWithdrawRequestModal(false)} />
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ justifyContent: 'flex-end', flexGrow: 1 }}>
            <View style={[styles.transferModalContent, { backgroundColor: colors.bgCard, maxHeight: '90%' }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Withdraw Funds</Text>
                <TouchableOpacity onPress={() => setShowWithdrawRequestModal(false)}>
                  <Ionicons name="close" size={24} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              
              <View style={[styles.transferInfo, { backgroundColor: colors.bgSecondary }]}>
                <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.transferLabel, { color: colors.textMuted }]}>Wallet Balance</Text>
                  <Text style={[styles.transferValueGold, { color: colors.primary }]}>${walletBalance.toFixed(2)}</Text>
                </View>
              </View>

              <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Amount (USD)</Text>
              <TextInput
                style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                value={transferAmount}
                onChangeText={setTransferAmount}
                placeholder="Enter amount"
                placeholderTextColor={colors.textMuted}
                keyboardType="numeric"
              />

              <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Payment Method</Text>
              <View style={styles.methodRow}>
                <TouchableOpacity
                  style={[styles.methodBtn, { backgroundColor: colors.bgSecondary, borderColor: colors.border }, withdrawMethod === 'Bank' && { backgroundColor: `${colors.primary}20`, borderColor: colors.primary }]}
                  onPress={() => setWithdrawMethod('Bank')}
                >
                  <Ionicons name="business-outline" size={20} color={withdrawMethod === 'Bank' ? colors.primary : colors.textMuted} />
                  <Text style={[styles.methodBtnText, { color: withdrawMethod === 'Bank' ? colors.primary : colors.textMuted }]}>Bank Transfer</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.methodBtn, { backgroundColor: colors.bgSecondary, borderColor: colors.border }, withdrawMethod === 'UPI' && { backgroundColor: `${colors.primary}20`, borderColor: colors.primary }]}
                  onPress={() => setWithdrawMethod('UPI')}
                >
                  <Ionicons name="phone-portrait-outline" size={20} color={withdrawMethod === 'UPI' ? colors.primary : colors.textMuted} />
                  <Text style={[styles.methodBtnText, { color: withdrawMethod === 'UPI' ? colors.primary : colors.textMuted }]}>UPI</Text>
                </TouchableOpacity>
              </View>

              {withdrawMethod === 'Bank' && (
                <View>
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Account Holder Name</Text>
                  <TextInput
                    style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                    value={bankDetails.accountHolderName}
                    onChangeText={(text) => setBankDetails({ ...bankDetails, accountHolderName: text })}
                    placeholder="Enter account holder name"
                    placeholderTextColor={colors.textMuted}
                  />
                  
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Bank Name</Text>
                  <TextInput
                    style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                    value={bankDetails.bankName}
                    onChangeText={(text) => setBankDetails({ ...bankDetails, bankName: text })}
                    placeholder="Enter bank name"
                    placeholderTextColor={colors.textMuted}
                  />
                  
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Account Number</Text>
                  <TextInput
                    style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                    value={bankDetails.accountNumber}
                    onChangeText={(text) => setBankDetails({ ...bankDetails, accountNumber: text })}
                    placeholder="Enter account number"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="numeric"
                  />
                  
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>IFSC Code</Text>
                  <TextInput
                    style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                    value={bankDetails.ifscCode}
                    onChangeText={(text) => setBankDetails({ ...bankDetails, ifscCode: text.toUpperCase() })}
                    placeholder="Enter IFSC code"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="characters"
                  />
                </View>
              )}

              {withdrawMethod === 'UPI' && (
                <View>
                  <Text style={[styles.inputLabel, { color: colors.textMuted }]}>UPI ID</Text>
                  <TextInput
                    style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
                    value={upiId}
                    onChangeText={setUpiId}
                    placeholder="Enter UPI ID (e.g., name@upi)"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                  />
                </View>
              )}

              <TouchableOpacity 
                style={[styles.withdrawSubmitBtn, { backgroundColor: colors.primary }, isTransferring && styles.btnDisabled]}
                onPress={handleWithdrawRequest}
                disabled={isTransferring}
              >
                {isTransferring ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.withdrawSubmitBtnText}>Submit Withdrawal Request</Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Open New Account Modal */}
      <Modal visible={showOpenModal} animationType="slide" transparent onRequestClose={() => setShowOpenModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowOpenModal(false)} />
          <View style={[styles.transferModalContent, { backgroundColor: colors.bgCard, maxHeight: '85%' }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
                {openStep === 'type' ? (acctMode === 'demo' ? 'Open Demo Account' : 'Open New Account') : openStep === 'currency' ? 'Select Currency' : 'Select Leverage'}
              </Text>
              <TouchableOpacity onPress={() => setShowOpenModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Step 1: account type */}
            {openStep === 'type' && (
              groupsLoading ? (
                <ActivityIndicator color={colors.accent} style={{ marginVertical: 30 }} />
              ) : groups.length === 0 ? (
                <View style={{ paddingVertical: 30, alignItems: 'center' }}>
                  <Ionicons name="alert-circle-outline" size={40} color={colors.textMuted} />
                  <Text style={{ color: colors.textMuted, marginTop: 10, fontSize: 13 }}>No account types available</Text>
                </View>
              ) : (
                <>
                  <ScrollView style={{ maxHeight: 360 }}>
                    {groups.map((g) => {
                      const selected = selectedGroupId === g.id;
                      return (
                        <TouchableOpacity
                          key={g.id}
                          onPress={() => setSelectedGroupId(g.id)}
                          activeOpacity={0.85}
                          style={{
                            borderRadius: 12,
                            borderWidth: selected ? 2 : 1,
                            borderColor: selected ? colors.accent : colors.border,
                            backgroundColor: selected ? colors.accent + '15' : colors.bgSecondary,
                            padding: 14,
                            marginBottom: 10,
                          }}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '700' }}>{g.name}</Text>
                              {g.description ? (
                                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }} numberOfLines={2}>
                                  {g.description}
                                </Text>
                              ) : null}
                            </View>
                            {selected && <Ionicons name="checkmark-circle" size={22} color={colors.accent} />}
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                            <View>
                              <Text style={{ color: colors.textMuted, fontSize: 10 }}>Min Deposit</Text>
                              <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '700', marginTop: 2 }}>${g.minimum_deposit ?? 0}</Text>
                            </View>
                            <View>
                              <Text style={{ color: colors.textMuted, fontSize: 10 }}>Leverage</Text>
                              <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '700', marginTop: 2 }}>1:{g.leverage_default ?? 100}</Text>
                            </View>
                            <View>
                              <Text style={{ color: colors.textMuted, fontSize: 10 }}>Commission</Text>
                              <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '700', marginTop: 2 }}>${g.commission_per_lot ?? 0}/lot</Text>
                            </View>
                            {g.swap_free ? (
                              <View>
                                <Text style={{ color: colors.textMuted, fontSize: 10 }}>Swap</Text>
                                <Text style={{ color: colors.success, fontSize: 12, fontWeight: '700', marginTop: 2 }}>Free</Text>
                              </View>
                            ) : null}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>

                  <TouchableOpacity
                    style={[styles.transferSubmitBtn, !selectedGroupId && styles.btnDisabled]}
                    onPress={() => { if (selectedGroupId) setOpenStep('currency'); }}
                    disabled={!selectedGroupId}
                  >
                    <Text style={styles.transferSubmitBtnText}>Continue</Text>
                  </TouchableOpacity>
                </>
              )
            )}

            {/* Step 2: currency (USD / INR) */}
            {openStep === 'currency' && (
              <>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 12, lineHeight: 18 }}>
                  Your account balance, P&L and margin will show in this currency. Market prices stay the same.
                </Text>
                {OPEN_CURRENCIES.map((c) => {
                  const sel = chosenCurrency === c.code;
                  return (
                    <TouchableOpacity
                      key={c.code}
                      onPress={() => setChosenCurrency(c.code)}
                      activeOpacity={0.85}
                      style={{
                        flexDirection: 'row', alignItems: 'center', borderRadius: 12,
                        borderWidth: sel ? 2 : 1, borderColor: sel ? colors.accent : colors.border,
                        backgroundColor: sel ? colors.accent + '15' : colors.bgSecondary,
                        padding: 14, marginBottom: 10,
                      }}
                    >
                      <Text style={{ fontSize: 26, marginRight: 12 }}>{c.flag}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '700' }}>
                          {c.code} <Text style={{ color: colors.textMuted, fontWeight: '400' }}>{c.symbol}</Text>
                        </Text>
                        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>{c.label}</Text>
                      </View>
                      {sel && <Ionicons name="checkmark-circle" size={22} color={colors.accent} />}
                    </TouchableOpacity>
                  );
                })}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                  <TouchableOpacity
                    style={[styles.transferSubmitBtn, { flex: 1, backgroundColor: colors.bgSecondary }]}
                    onPress={() => setOpenStep('type')}
                  >
                    <Text style={[styles.transferSubmitBtnText, { color: colors.textPrimary }]}>Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.transferSubmitBtn, { flex: 1 }]}
                    onPress={() => {
                      const g = groups.find((x) => x.id === selectedGroupId);
                      setChosenLeverage(g?.leverage_default ?? 100);
                      setOpenStep('leverage');
                    }}
                  >
                    <Text style={styles.transferSubmitBtnText}>Continue</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* Step 3: leverage */}
            {openStep === 'leverage' && (() => {
              const g = groups.find((x) => x.id === selectedGroupId);
              const tiers = leverageTiers(g?.leverage_default);
              return (
                <>
                  <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.accent + '40', backgroundColor: colors.accent + '0c', padding: 12, marginBottom: 14 }}>
                    <Text style={{ color: colors.textPrimary, fontWeight: '700', fontSize: 14 }}>{g?.name}</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                      Currency: <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>{chosenCurrency}</Text>
                      {'  ·  '}Max: <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>1:{g?.leverage_default ?? 100}</Text>
                    </Text>
                  </View>
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 10, lineHeight: 18 }}>
                    Higher leverage increases both potential profit and risk. You can change it later when no positions are open.
                  </Text>
                  <ScrollView style={{ maxHeight: 200 }}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {tiers.map((lev) => {
                        const sel = chosenLeverage === lev;
                        const isMax = lev === (g?.leverage_default ?? 100);
                        return (
                          <TouchableOpacity
                            key={lev}
                            onPress={() => setChosenLeverage(lev)}
                            style={{
                              width: '31%', paddingVertical: 12, borderRadius: 10,
                              borderWidth: sel ? 2 : 1, borderColor: sel ? colors.accent : colors.border,
                              backgroundColor: sel ? colors.accent + '15' : colors.bgSecondary, alignItems: 'center',
                            }}
                          >
                            <Text style={{ color: sel ? colors.accent : colors.textPrimary, fontWeight: '700' }}>1:{lev}</Text>
                            {isMax ? <Text style={{ color: colors.textMuted, fontSize: 9, marginTop: 2 }}>MAX</Text> : null}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </ScrollView>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                    <TouchableOpacity
                      style={[styles.transferSubmitBtn, { flex: 1, backgroundColor: colors.bgSecondary }]}
                      onPress={() => setOpenStep('currency')}
                      disabled={openingAccount}
                    >
                      <Text style={[styles.transferSubmitBtnText, { color: colors.textPrimary }]}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.transferSubmitBtn, { flex: 1.5 }, (openingAccount || !chosenLeverage) && styles.btnDisabled]}
                      onPress={handleOpenAccount}
                      disabled={openingAccount || !chosenLeverage}
                    >
                      {openingAccount ? (
                        <ActivityIndicator color="#000" />
                      ) : (
                        <Text style={styles.transferSubmitBtnText}>
                          {acctMode === 'demo' ? 'Open Demo Account' : `Open ${chosenCurrency} Account`}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* Account to Account Transfer Modal */}
      <Modal visible={showAccountTransferModal} animationType="slide" transparent onRequestClose={() => setShowAccountTransferModal(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setShowAccountTransferModal(false)} />
          <View style={[styles.transferModalContent, { backgroundColor: colors.bgCard }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Transfer Between Accounts</Text>
              <TouchableOpacity onPress={() => setShowAccountTransferModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            
            <View style={[styles.transferInfo, { backgroundColor: colors.bgSecondary }]}>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>From</Text>
                <Text style={[styles.transferValue, { color: colors.textPrimary }]}>{selectedAccount?.accountId}</Text>
              </View>
              <View style={[styles.transferInfoRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.transferLabel, { color: colors.textMuted }]}>Available</Text>
                <Text style={[styles.transferValueGold, { color: colors.primary }]}>${(selectedAccount?.balance || 0).toFixed(2)}</Text>
              </View>
            </View>

            <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Select Target Account</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.accountsScroll}>
              {accounts.filter(a => a._id !== selectedAccount?._id).map(account => (
                <TouchableOpacity
                  key={account._id}
                  style={[styles.accountSelectCard, { backgroundColor: colors.bgSecondary, borderColor: colors.border }, targetAccount?._id === account._id && styles.accountSelectCardActive]}
                  onPress={() => setTargetAccount(account)}
                >
                  <Text style={[styles.accountSelectId, { color: colors.textPrimary }, targetAccount?._id === account._id && { color: '#fff' }]}>{account.accountId}</Text>
                  <Text style={[styles.accountSelectBalance, { color: colors.textMuted }]}>${(account.balance || 0).toFixed(2)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={[styles.inputLabel, { color: colors.textMuted }]}>Amount (USD)</Text>
            <TextInput
              style={[styles.transferInput, { backgroundColor: colors.bgSecondary, borderColor: colors.border, color: colors.textPrimary }]}
              value={transferAmount}
              onChangeText={setTransferAmount}
              placeholder="Enter amount"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
            />

            <TouchableOpacity 
              style={[styles.transferSubmitBtn, { backgroundColor: colors.primary }, isTransferring && styles.btnDisabled]}
              onPress={handleAccountToAccountTransfer}
              disabled={isTransferring}
            >
              {isTransferring ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.transferSubmitBtnText}>Transfer</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  backBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
    marginTop: 8,
  },
  accountCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#333333',
  },
  primaryCard: {
    borderColor: '#1a73e8',
    borderWidth: 2,
  },
  primaryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a73e8',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    alignSelf: 'flex-start',
    marginBottom: 12,
    gap: 4,
  },
  primaryBadgeText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  accountHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  accountIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1a73e820',
    justifyContent: 'center',
    alignItems: 'center',
  },
  accountInfo: {
    flex: 1,
    marginLeft: 12,
  },
  accountId: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  accountType: {
    color: '#666',
    fontSize: 13,
    marginTop: 2,
  },
  balanceSection: {
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  balanceItem: {
    alignItems: 'center',
  },
  balanceLabel: {
    color: '#666',
    fontSize: 12,
    marginBottom: 4,
  },
  balanceValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  depositBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
  },
  depositBtnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '600',
  },
  withdrawBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  withdrawBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  setPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    marginBottom: 12,
  },
  setPrimaryBtnText: {
    color: '#1a73e8',
    fontSize: 14,
  },
  tradeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    backgroundColor: '#1a73e8',
    borderRadius: 10,
  },
  tradeBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '600',
  },
  openAccountBtn: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Tabs Styles
  tabsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: '#1a73e8',
  },
  tabText: {
    color: '#888',
    fontSize: 11,
    fontWeight: '500',
  },
  tabTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  // Buy Challenge Styles
  buyChallengeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 16,
    marginHorizontal: 16,
  },
  buyChallengeBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  walletBalanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#1E1E1E',
    marginHorizontal: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  walletBalanceLabel: {
    color: '#888',
    fontSize: 14,
  },
  walletBalanceValue: {
    color: '#1a73e8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  challengesList: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  challengeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginVertical: 6,
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  challengeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1a73e820',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  challengeInfo: {
    flex: 1,
  },
  challengeName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  challengeDesc: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  challengeDetails: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
  },
  challengeDetail: {
    color: '#666',
    fontSize: 11,
  },
  buyBtnSmall: {
    backgroundColor: '#1a73e8',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  buyBtnSmallText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  // Challenge Account Styles
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  challengeProgress: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  progressLabel: {
    color: '#888',
    fontSize: 12,
  },
  progressValue: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '70%',
    paddingTop: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  accountTypesList: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  loadingTypes: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    color: '#666',
    marginTop: 12,
  },
  accountTypeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    marginVertical: 6,
    borderRadius: 12,
  },
  accountTypeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#1a73e820',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  accountTypeInfo: {
    flex: 1,
  },
  accountTypeName: {
    fontSize: 16,
    fontWeight: '600',
  },
  accountTypeDesc: {
    color: '#666',
    fontSize: 12,
    marginTop: 2,
  },
  accountTypeDetails: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 6,
  },
  accountTypeDetail: {
    color: '#888',
    fontSize: 11,
  },
  backToTypesBtn: {
    flex: 1,
    backgroundColor: '#333',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  backToTypesBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  createAccountBtn: {
    flex: 1,
    backgroundColor: '#1a73e8',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  createAccountBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  
  // Transfer Modal Styles
  transferModalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 20,
    paddingBottom: 40,
  },
  transferInfo: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  transferInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  transferLabel: {
    color: '#888',
    fontSize: 14,
  },
  transferValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  transferValueGold: {
    color: '#1a73e8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  inputLabel: {
    color: '#888',
    fontSize: 12,
    marginBottom: 8,
    marginTop: 8,
  },
  transferInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    textAlign: 'center',
  },
  transferSubmitBtn: {
    backgroundColor: '#1a73e8',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  transferSubmitBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  withdrawSubmitBtn: {
    backgroundColor: '#1a73e8',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 20,
  },
  withdrawSubmitBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  accountsScroll: {
    marginVertical: 8,
  },
  accountSelectCard: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginRight: 10,
    alignItems: 'center',
    minWidth: 100,
    borderWidth: 1,
  },
  accountSelectCardActive: {
    backgroundColor: '#1a73e8',
    borderColor: '#1a73e8',
  },
  accountSelectId: {
    fontSize: 14,
    fontWeight: '600',
  },
  accountSelectBalance: {
    color: '#888',
    fontSize: 12,
    marginTop: 4,
  },
  // Wallet Card Styles
  walletCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  walletHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  walletIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  walletInfo: {
    flex: 1,
  },
  walletTitle: {
    fontSize: 12,
    marginBottom: 2,
  },
  walletBalanceText: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  walletWithdrawBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 6,
  },
  walletWithdrawBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Method Selection Styles
  methodRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  methodBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  methodBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default AccountsScreen;

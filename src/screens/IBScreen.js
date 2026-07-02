import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Share,
  TextInput,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { API_URL } from '../config';
import { useTheme } from '../context/ThemeContext';

const IBScreen = ({ navigation, route }) => {
  const { colors, isDark } = useTheme();
  const hideMainHeader = route?.params?.hideMainHeader;
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [ibProfile, setIbProfile] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [downline, setDownline] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (user) {
      fetchIBProfile();
    }
  }, [user]);

  useEffect(() => {
    if (ibProfile?._id && (ibProfile.status === 'ACTIVE' || ibProfile.ibStatus === 'ACTIVE')) {
      fetchReferrals();
      fetchCommissions();
      fetchDownline();
    }
  }, [ibProfile]);

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

  const fetchIBProfile = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      if (!token) { setLoading(false); return; }
      
      const res = await fetch(`${API_URL}/business/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      
      if (!data.is_ib && !data.ib_status) {
        setIbProfile(null);
      } else {
        // Fetch full dashboard if IB is active
        const ibStatus = data.ib_status || data.status || 'PENDING';
        const profileData = {
          _id: data.id || user?.id,
          status: ibStatus.toUpperCase(),
          ibStatus: ibStatus.toUpperCase(),
          referralCode: data.referral_code || data.referralCode || '',
          ibWalletBalance: 0,
          totalCommissionEarned: 0,
          stats: {},
        };
        
        if (ibStatus.toUpperCase() === 'ACTIVE' || ibStatus.toUpperCase() === 'APPROVED') {
          try {
            const dashRes = await fetch(`${API_URL}/business/ib/dashboard`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (dashRes.ok) {
              const dash = await dashRes.json();
              profileData.totalEarned = Number(dash.total_earned || 0);
              profileData.totalCommission = Number(dash.total_commission || 0);
              profileData.totalCommissionEarned = Number(dash.total_earned || dash.total_commission || 0);
              profileData.pendingPayout = Number(dash.pending_payout || 0);
              profileData.ibWalletBalance = Number(dash.pending_payout || 0);
              profileData.level = Number(dash.level || 1);
              profileData.totalReferrals = Number(dash.total_referrals || 0);
              profileData.isActive = !!dash.is_active;
              profileData.stats = {
                directReferrals: Number(dash.total_referrals || 0),
                totalDownline: 0,
              };
              profileData.referralCode = dash.referral_code || profileData.referralCode;
              profileData.referralLink = dash.referral_link || '';
            }
          } catch (e) { console.error('Dashboard fetch error:', e); }
        }
        
        setIbProfile(profileData);
      }
    } catch (e) {
      console.error('Error fetching IB profile:', e);
      setIbProfile(null);
    }
    setLoading(false);
    setRefreshing(false);
  };

  const fetchReferrals = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/business/ib/referrals`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const items = (data.items || []).map(r => {
        const u = r.referred_user || {};
        const fullName = (u.name || '').trim();
        const [firstName, ...rest] = fullName.split(' ');
        return {
          _id: r.id,
          firstName: firstName || (u.email || '').charAt(0).toUpperCase(),
          lastName: rest.join(' '),
          email: u.email || '',
          createdAt: u.joined_at || r.created_at,
          totalDeposit: Number(r.total_deposit || 0),
          accountsCount: r.accounts_count || 0,
        };
      });
      setReferrals(items);
    } catch (e) {
      console.error('Error fetching referrals:', e);
    }
  };

  const fetchCommissions = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/business/ib/commissions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      const items = (data.items || []).map(c => {
        const u = c.source_user || {};
        return {
          _id: c.id,
          sourceName: u.name || u.email || '—',
          sourceEmail: u.email || '',
          commissionType: c.commission_type || '',
          amount: Number(c.amount || 0),
          mlmLevel: c.mlm_level || 1,
          status: (c.status || 'pending').toLowerCase(),
          createdAt: c.created_at,
        };
      });
      setCommissions(items);
    } catch (e) {
      console.error('Error fetching commissions:', e);
    }
  };

  const flattenTree = (nodes, out = []) => {
    for (const n of nodes || []) {
      const nameParts = (n.name || n.email || '').split(' ');
      out.push({
        _id: n.id,
        firstName: nameParts[0] || (n.email || '?').charAt(0).toUpperCase(),
        email: n.email || '',
        level: n.depth || 1,
        totalEarned: Number(n.total_earned || 0),
        isActive: !!n.is_active,
        isIB: !!n.referral_code,
      });
      if (n.children?.length) flattenTree(n.children, out);
    }
    return out;
  };

  const fetchDownline = async () => {
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/business/ib/tree`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) { setDownline([]); return; }
      const data = await res.json();
      const flat = flattenTree(data.tree || []);
      setDownline(flat);
      if (flat.length) {
        setIbProfile((p) => p ? { ...p, stats: { ...(p.stats || {}), totalDownline: data.total_nodes || flat.length } } : p);
      }
    } catch (e) {
      console.error('Error fetching downline:', e);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchIBProfile();
  };

  const handleApplyIB = async () => {
    setIsSubmitting(true);
    try {
      const token = await SecureStore.getItemAsync('token');
      const res = await fetch(`${API_URL}/business/apply`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (res.ok) {
        Alert.alert('Success', 'IB application submitted! Please wait for admin approval.');
        fetchIBProfile();
      } else {
        Alert.alert('Error', data.detail || data.message || 'Failed to apply');
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to submit application');
    }
    setIsSubmitting(false);
  };

  const copyReferralLink = async () => {
    const link = ibProfile?.referralLink || (ibProfile?.referralCode ? `?ref=${ibProfile.referralCode}` : '');
    if (!link) return;
    await Clipboard.setStringAsync(link);
    Alert.alert('Copied!', 'Referral link copied to clipboard');
  };

  const shareReferralLink = async () => {
    const link = ibProfile?.referralLink;
    const code = ibProfile?.referralCode;
    if (!link && !code) return;
    try {
      await Share.share({
        message: `Join me on BULL4X — use my referral code: ${code}\n\nSign up: ${link || ''}`,
      });
    } catch (e) {
      console.error('Error sharing:', e);
    }
  };

  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
  };

  const isActive = ibProfile?.status === 'ACTIVE' || ibProfile?.ibStatus === 'ACTIVE';
  const isPending = ibProfile?.status === 'PENDING' || ibProfile?.ibStatus === 'PENDING';
  const isRejected = ibProfile?.status === 'REJECTED' || ibProfile?.ibStatus === 'REJECTED';

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  const tabs = ['overview', 'referrals', 'commissions', 'downline'];

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {!hideMainHeader ? (
        <View style={[styles.header, { backgroundColor: colors.bgPrimary }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>IB Program</Text>
          <View style={{ width: 40 }} />
        </View>
      ) : null}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Not an IB - Show Apply */}
        {!ibProfile && (
          <View style={styles.applyContainer}>
            <View style={styles.applyIconContainer}>
              <Ionicons name="ribbon" size={48} color={colors.accent} />
            </View>
            <Text style={[styles.applyTitle, { color: colors.textPrimary }]}>Become an Introducing Broker</Text>

            <View style={[styles.benefitsCard, { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }]}>
              <Text style={[styles.benefitsTitle, { color: colors.textPrimary }]}>Benefits:</Text>
              {[
                'Earn commission on every trade your referrals make',
                'Real-time commission tracking',
                'Easy withdrawal to your wallet'
              ].map((benefit, idx) => (
                <View key={idx} style={styles.benefitRow}>
                  <Ionicons name="chevron-forward" size={16} color="#1a73e8" />
                  <Text style={styles.benefitText}>{benefit}</Text>
                </View>
              ))}
            </View>
            
            <TouchableOpacity 
              style={[styles.applyBtn, isSubmitting && styles.btnDisabled]} 
              onPress={handleApplyIB}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.applyBtnText}>Apply Now</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Pending Status */}
        {isPending && (
          <View style={styles.statusContainer}>
            <View style={[styles.statusIconContainer, { backgroundColor: '#eab30830' }]}>
              <Ionicons name="time" size={48} color="#eab308" />
            </View>
            <Text style={[styles.statusTitle, { color: colors.textPrimary }]}>Application Pending</Text>
            <Text style={[styles.statusSubtitle, { color: colors.textMuted }]}>Your IB application is under review. You will be notified once approved.</Text>
          </View>
        )}

        {/* Rejected Status */}
        {isRejected && (
          <View style={styles.statusContainer}>
            <View style={[styles.statusIconContainer, { backgroundColor: '#ef444430' }]}>
              <Ionicons name="close-circle" size={48} color="#ef4444" />
            </View>
            <Text style={[styles.statusTitle, { color: colors.textPrimary }]}>Application Rejected</Text>
            <Text style={[styles.statusSubtitle, { color: colors.textMuted }]}>Unfortunately, your IB application was not approved.</Text>
            {ibProfile?.rejectionReason && (
              <Text style={styles.rejectionReason}>Reason: {ibProfile.rejectionReason}</Text>
            )}
          </View>
        )}

        {/* Active IB Dashboard */}
        {isActive && (
          <>
            {/* Stats Cards */}
            <View style={styles.statsGrid}>
              <View style={[styles.statCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                <View style={[styles.statIcon, { backgroundColor: '#22c55e20' }]}>
                  <Ionicons name="trending-up" size={20} color="#22c55e" />
                </View>
                <Text style={[styles.statLabel, { color: colors.textMuted }]}>Total Earned</Text>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>${(ibProfile?.totalEarned || 0).toFixed(2)}</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                <View style={[styles.statIcon, { backgroundColor: '#eab30820' }]}>
                  <Ionicons name="time" size={20} color="#eab308" />
                </View>
                <Text style={[styles.statLabel, { color: colors.textMuted }]}>Pending Payout</Text>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>${(ibProfile?.pendingPayout || 0).toFixed(2)}</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                <View style={[styles.statIcon, { backgroundColor: '#a855f720' }]}>
                  <Ionicons name="people" size={20} color="#a855f7" />
                </View>
                <Text style={[styles.statLabel, { color: colors.textMuted }]}>Referrals</Text>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>{ibProfile?.totalReferrals || 0}</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                <View style={[styles.statIcon, { backgroundColor: '#f9731620' }]}>
                  <Ionicons name="ribbon" size={20} color="#f97316" />
                </View>
                <Text style={[styles.statLabel, { color: colors.textMuted }]}>Level</Text>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>L{ibProfile?.level || 1}</Text>
              </View>
            </View>

            {/* Referral Link Card */}
            <View style={styles.referralLinkCard}>
              <Text style={styles.referralLinkLabel}>Your Referral Link</Text>
              <Text style={styles.referralLinkText} numberOfLines={1}>
                {ibProfile?.referralLink || `?ref=${ibProfile?.referralCode || ''}`}
              </Text>
              <Text style={styles.referralCodeText}>Code: <Text style={styles.referralCodeBold}>{ibProfile?.referralCode}</Text></Text>
              <View style={styles.referralActions}>
                <TouchableOpacity style={styles.copyBtn} onPress={copyReferralLink}>
                  <Ionicons name="copy-outline" size={18} color="#fff" />
                  <Text style={styles.copyBtnText}>Copy Link</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.shareBtn} onPress={shareReferralLink}>
                  <Ionicons name="share-outline" size={18} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>

            {/* Tabs */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
              <View style={styles.tabs}>
                {tabs.map(tab => (
                  <TouchableOpacity
                    key={tab}
                    style={[styles.tab, activeTab === tab && styles.tabActive]}
                    onPress={() => setActiveTab(tab)}
                  >
                    <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                      {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            {/* Tab Content */}
            <View style={styles.tabContent}>
              {/* Overview Tab */}
              {activeTab === 'overview' && (
                <View style={styles.levelStatsGrid}>
                  {[1, 2, 3, 4, 5].map(level => (
                    <View key={level} style={[styles.levelStatCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                      <Text style={[styles.levelStatLabel, { color: colors.textMuted }]}>Level {level}</Text>
                      <Text style={[styles.levelStatValue, { color: colors.textPrimary }]}>{ibProfile?.stats?.[`level${level}Count`] || 0}</Text>
                      <Text style={[styles.levelStatSubLabel, { color: colors.textMuted }]}>trades</Text>
                      <Text style={styles.levelStatCommission}>${(ibProfile?.stats?.[`level${level}Commission`] || 0).toFixed(2)}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Referrals Tab */}
              {activeTab === 'referrals' && (
                <View>
                  {referrals.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Ionicons name="people-outline" size={48} color={colors.textMuted} />
                      <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Referrals Yet</Text>
                      <Text style={styles.emptyText}>Share your referral link to start earning</Text>
                    </View>
                  ) : (
                    referrals.map((ref) => (
                      <View key={ref._id} style={[styles.referralItem, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                        <View style={styles.referralAvatar}>
                          <Text style={styles.avatarText}>{(ref.firstName || '?').charAt(0)}</Text>
                        </View>
                        <View style={styles.referralInfo}>
                          <Text style={[styles.referralName, { color: colors.textPrimary }]} numberOfLines={1}>
                            {`${ref.firstName || ''} ${ref.lastName || ''}`.trim() || ref.email}
                          </Text>
                          <Text style={styles.referralEmail} numberOfLines={1}>{ref.email}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={[styles.referralName, { color: colors.textPrimary, fontSize: 13 }]}>
                            ${ref.totalDeposit.toFixed(2)}
                          </Text>
                          <Text style={styles.referralDate}>{ref.createdAt ? formatDate(ref.createdAt) : '—'}</Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              )}

              {/* Commissions Tab */}
              {activeTab === 'commissions' && (
                <View>
                  {commissions.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Ionicons name="cash-outline" size={48} color={colors.textMuted} />
                      <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Commissions Yet</Text>
                      <Text style={styles.emptyText}>Commissions will appear when your referrals trade</Text>
                    </View>
                  ) : (
                    commissions.map((comm) => (
                      <View key={comm._id} style={[styles.commissionItem, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                        <View style={styles.commissionItemLeft}>
                          <Text style={[styles.commissionSymbol, { color: colors.textPrimary }]} numberOfLines={1}>{comm.sourceName}</Text>
                          <Text style={styles.commissionMeta}>
                            {(comm.commissionType || '').replace('_', ' ')} • L{comm.mlmLevel}
                          </Text>
                        </View>
                        <View style={styles.commissionItemRight}>
                          <Text style={styles.commissionAmount}>${comm.amount.toFixed(2)}</Text>
                          <View style={[styles.commissionStatus, { backgroundColor: comm.status === 'paid' ? '#22c55e20' : '#eab30820' }]}>
                            <Text style={[styles.commissionStatusText, { color: comm.status === 'paid' ? '#22c55e' : '#eab308' }]}>
                              {comm.status}
                            </Text>
                          </View>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              )}

              {/* Downline Tab */}
              {activeTab === 'downline' && (
                <View>
                  {downline.length === 0 ? (
                    <View style={styles.emptyState}>
                      <Ionicons name="git-network-outline" size={48} color={colors.textMuted} />
                      <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Downline Yet</Text>
                      <Text style={styles.emptyText}>Your referral network will appear here</Text>
                    </View>
                  ) : (
                    downline.map((node, idx) => (
                      <View key={node._id || idx} style={[styles.downlineItem, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
                        <View style={[styles.downlineAvatar, { backgroundColor: node.isIB ? '#1a73e830' : '#33333320' }]}>
                          <Text style={[styles.avatarText, { color: node.isIB ? '#1a73e8' : '#888' }]}>{node.firstName?.charAt(0) || '?'}</Text>
                        </View>
                        <View style={styles.downlineInfo}>
                          <Text style={[styles.downlineName, { color: colors.textPrimary }]} numberOfLines={1}>{node.firstName || node.email || 'Unknown'}</Text>
                          <Text style={styles.downlineEmail} numberOfLines={1}>{node.email}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 4 }}>
                          <Text style={{ color: '#22c55e', fontSize: 12, fontWeight: '700' }}>
                            ${node.totalEarned.toFixed(2)}
                          </Text>
                          <View style={[styles.downlineBadge, { backgroundColor: node.isIB ? '#1a73e820' : '#33333320' }]}>
                            <Text style={[styles.downlineBadgeText, { color: node.isIB ? '#1a73e8' : '#888' }]}>
                              {node.isIB ? 'IB' : 'User'} • L{node.level}
                            </Text>
                          </View>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              )}
            </View>
          </>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: 'bold' },
  
  // Apply Container
  applyContainer: { padding: 20, alignItems: 'center' },
  applyIconContainer: { width: 80, height: 80, borderRadius: 40, backgroundColor: '#1a73e820', justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  applyTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
  applySubtitle: { color: '#888', fontSize: 14, textAlign: 'center', marginBottom: 20 },
  benefitsCard: { borderRadius: 16, padding: 16, width: '100%', marginBottom: 20 },
  benefitsTitle: { fontSize: 14, fontWeight: '600', marginBottom: 12 },
  benefitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  benefitText: { color: '#888', fontSize: 13, flex: 1 },
  applyBtn: { backgroundColor: '#1a73e8', paddingHorizontal: 40, paddingVertical: 16, borderRadius: 12 },
  applyBtnText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  btnDisabled: { opacity: 0.6 },
  
  // Status Container
  statusContainer: { padding: 20, alignItems: 'center' },
  statusIconContainer: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  statusTitle: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
  statusSubtitle: { color: '#888', fontSize: 14, textAlign: 'center' },
  rejectionReason: { color: '#ef4444', fontSize: 13, marginTop: 12, textAlign: 'center' },
  
  // Stats Grid
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 10, marginBottom: 12 },
  statCard: { width: '48%', borderRadius: 14, padding: 14, borderWidth: 1 },
  statIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  statLabel: { color: '#888', fontSize: 11 },
  statValue: { fontSize: 20, fontWeight: 'bold', marginTop: 4 },
  
  // Info Cards
  infoCardsRow: { paddingHorizontal: 16, marginBottom: 12 },
  commissionRateCard: { borderRadius: 14, padding: 16, borderWidth: 1 },
  cardLabel: { color: '#888', fontSize: 12, marginBottom: 8 },
  commissionRateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  commissionRateValue: { fontSize: 28, fontWeight: 'bold' },
  commissionRateUnit: { color: '#888', fontSize: 14, fontWeight: 'normal' },
  levelName: { color: '#888', fontSize: 12, marginTop: 4 },
  commissionIcon: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  
  // Referral Link Card
  referralLinkCard: { marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 14, backgroundColor: '#7c3aed' },
  referralLinkLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginBottom: 4 },
  referralLinkText: { color: '#fff', fontSize: 12, fontFamily: 'monospace', marginBottom: 4 },
  referralCodeText: { color: 'rgba(255,255,255,0.6)', fontSize: 11, marginBottom: 12 },
  referralCodeBold: { color: '#fff', fontWeight: 'bold' },
  referralActions: { flexDirection: 'row', gap: 8 },
  copyBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.2)', paddingVertical: 10, borderRadius: 8 },
  copyBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  shareBtn: { width: 40, height: 40, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  
  // Level Progress
  levelProgressCard: { marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: 14, borderWidth: 1 },
  levelProgressHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  levelProgressTitle: { fontSize: 15, fontWeight: '600' },
  progressBarContainer: {},
  progressBarLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressLabel: { color: '#888', fontSize: 12 },
  progressPercent: { color: '#1a73e8', fontSize: 12, fontWeight: '600' },
  progressBarBg: { height: 6, backgroundColor: '#222', borderRadius: 3, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#1a73e8', borderRadius: 3 },
  progressHint: { color: '#666', fontSize: 11, marginTop: 6 },
  
  // Tabs
  tabsScroll: { marginBottom: 12 },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, gap: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  tabActive: { backgroundColor: '#1a73e8' },
  tabText: { color: '#888', fontSize: 12, fontWeight: '500' },
  tabTextActive: { color: '#000' },
  
  // Tab Content
  tabContent: { paddingHorizontal: 16 },
  
  // Level Stats Grid
  levelStatsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  levelStatCard: { width: '31%', borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1 },
  levelStatLabel: { color: '#888', fontSize: 10 },
  levelStatValue: { fontSize: 18, fontWeight: 'bold', marginTop: 4 },
  levelStatSubLabel: { color: '#666', fontSize: 10 },
  levelStatCommission: { color: '#22c55e', fontSize: 12, fontWeight: '600', marginTop: 4 },
  
  // Empty State
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginTop: 12 },
  emptyText: { color: '#666', fontSize: 13, marginTop: 6, textAlign: 'center' },
  
  // Referral Item
  referralItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1 },
  referralAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1a73e830', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#1a73e8', fontSize: 16, fontWeight: 'bold' },
  referralInfo: { flex: 1, marginLeft: 12 },
  referralName: { fontSize: 14, fontWeight: '600' },
  referralEmail: { color: '#666', fontSize: 12, marginTop: 2 },
  referralDate: { color: '#666', fontSize: 11 },
  
  // Commission Item
  commissionItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1 },
  commissionItemLeft: {},
  commissionSymbol: { fontSize: 14, fontWeight: '600' },
  commissionMeta: { color: '#666', fontSize: 11, marginTop: 2 },
  commissionItemRight: { alignItems: 'flex-end' },
  commissionAmount: { color: '#22c55e', fontSize: 15, fontWeight: '600' },
  commissionStatus: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginTop: 4 },
  commissionStatusText: { fontSize: 10, fontWeight: '600' },
  
  // Downline Item
  downlineItem: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1 },
  downlineAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  downlineInfo: { flex: 1, marginLeft: 12 },
  downlineName: { fontSize: 14, fontWeight: '500' },
  downlineEmail: { color: '#666', fontSize: 11, marginTop: 2 },
  downlineBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  downlineBadgeText: { fontSize: 10, fontWeight: '600' },
  
  // Withdraw
  withdrawContainer: {},
  withdrawBalanceCard: { borderRadius: 14, padding: 20, alignItems: 'center', marginBottom: 20, borderWidth: 1 },
  withdrawBalanceLabel: { color: '#888', fontSize: 12 },
  withdrawBalanceValue: { color: '#22c55e', fontSize: 32, fontWeight: 'bold', marginTop: 8 },
  inputLabel: { color: '#888', fontSize: 12, marginBottom: 8 },
  input: { borderRadius: 12, padding: 16, fontSize: 16, borderWidth: 1, marginBottom: 16 },
  withdrawBtn: { backgroundColor: '#1a73e8', padding: 16, borderRadius: 12, alignItems: 'center' },
  withdrawBtnText: { color: '#000', fontSize: 16, fontWeight: 'bold' },
  pendingWithdrawal: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16 },
  pendingWithdrawalText: { color: '#eab308', fontSize: 13 },
});

export default IBScreen;

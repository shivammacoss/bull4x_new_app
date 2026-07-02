import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

const InstructionsScreen = ({ navigation }) => {
  const { colors, isDark } = useTheme();
  const [expandedSection, setExpandedSection] = useState('getting-started');

  const sections = [
    {
      id: 'getting-started',
      title: 'Getting Started',
      icon: 'play-circle-outline',
      content: [
        { title: 'Create an Account', text: 'Sign up with your email and complete the verification process.' },
        { title: 'Complete KYC', text: 'Submit your identity documents for verification. This is required for deposits and withdrawals.' },
        { title: 'Create Trading Account', text: 'Go to Account section and create a new trading account. Choose your preferred account type.' },
        { title: 'Fund Your Account', text: 'Deposit funds to your wallet and transfer to your trading account.' },
      ]
    },
    {
      id: 'deposits',
      title: 'Deposits & Withdrawals',
      icon: 'cash-outline',
      content: [
        { title: 'Making a Deposit', text: 'Go to Wallet → Deposit. Select your payment method, enter the amount, and follow the instructions.' },
        { title: 'Deposit Processing', text: 'Deposits are usually processed within 24 hours after admin verification.' },
        { title: 'Making a Withdrawal', text: 'Go to Wallet → Withdraw. Enter the amount and your payment details. Minimum withdrawal may apply.' },
        { title: 'Withdrawal Processing', text: 'Withdrawals are processed within 1-3 business days after approval.' },
      ]
    },
    {
      id: 'trading',
      title: 'Trading Guide',
      icon: 'trending-up-outline',
      content: [
        { title: 'Opening a Trade', text: 'Select an instrument, set your volume (lot size), and click Buy or Sell to open a market order.' },
        { title: 'Pending Orders', text: 'Use pending orders (Limit/Stop) to enter the market at a specific price.' },
        { title: 'Stop Loss & Take Profit', text: 'Set SL/TP to automatically close your trade at a certain profit or loss level.' },
        { title: 'Closing a Trade', text: 'Click the X button on your open position to close it at the current market price.' },
        { title: 'Understanding Margin', text: 'Margin is the amount required to open a position. It depends on your leverage and position size.' },
      ]
    },
    {
      id: 'copy-trading',
      title: 'Copy Trading',
      icon: 'copy-outline',
      content: [
        { title: 'What is Copy Trading?', text: 'Copy trading allows you to automatically copy trades from experienced traders (Masters).' },
        { title: 'Following a Master', text: 'Go to Copytrade → Discover Masters. Select a master and click Follow.' },
        { title: 'Copy Settings', text: 'Choose Fixed Lot (same lot size for all trades) or Lot Multiplier (proportional to master).' },
        { title: 'Commission', text: 'Masters charge a commission on profitable days only. This is deducted automatically.' },
        { title: 'Managing Subscriptions', text: 'You can pause, resume, or stop following a master at any time.' },
      ]
    },
    {
      id: 'ib-program',
      title: 'IB Program',
      icon: 'people-outline',
      content: [
        { title: 'What is IB?', text: 'Introducing Broker (IB) program lets you earn commissions by referring traders.' },
        { title: 'Becoming an IB', text: 'Go to IB section and click Apply Now. Your application will be reviewed by admin.' },
        { title: 'Referral Link', text: 'Once approved, you get a unique referral link. Share it to invite new traders.' },
        { title: 'Commission Structure', text: 'Earn commission on every trade your referrals make. Up to 5 levels of referrals.' },
        { title: 'Withdrawing Commission', text: 'Your IB earnings are credited to your IB wallet. You can withdraw anytime.' },
      ]
    },
    {
      id: 'security',
      title: 'Security',
      icon: 'shield-checkmark-outline',
      content: [
        { title: 'Password Security', text: 'Use a strong password with letters, numbers, and symbols. Change it regularly.' },
        { title: 'Two-Factor Authentication', text: 'Enable 2FA for an extra layer of security on your account.' },
        { title: 'Account Security', text: 'Keep your login credentials secure. Never share them with anyone.' },
        { title: 'Suspicious Activity', text: 'If you notice any suspicious activity, contact support immediately.' },
      ]
    },
  ];

  const toggleSection = (sectionId) => {
    setExpandedSection(expandedSection === sectionId ? '' : sectionId);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.bgPrimary }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Instructions</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Welcome Banner */}
        <View style={[styles.welcomeBanner, { borderColor: colors.accent + '30' }]}>
          <View style={styles.welcomeIcon}>
            <Ionicons name="book-outline" size={28} color={colors.accent} />
          </View>
          <View style={styles.welcomeText}>
            <Text style={[styles.welcomeTitle, { color: colors.textPrimary }]}>Welcome to BULL4X</Text>
            <Text style={[styles.welcomeSubtitle, { color: colors.textMuted }]}>Learn how to use our platform</Text>
          </View>
        </View>

        {/* Accordion Sections */}
        <View style={styles.sectionsContainer}>
          {sections.map(section => (
            <View key={section.id} style={[styles.sectionCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
              <TouchableOpacity 
                style={styles.sectionHeader}
                onPress={() => toggleSection(section.id)}
                activeOpacity={0.7}
              >
                <View style={styles.sectionHeaderLeft}>
                  <View style={styles.sectionIcon}>
                    <Ionicons name={section.icon} size={20} color={colors.accent} />
                  </View>
                  <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{section.title}</Text>
                </View>
                <Ionicons 
                  name={expandedSection === section.id ? 'chevron-down' : 'chevron-forward'} 
                  size={20} 
                  color={colors.textMuted} 
                />
              </TouchableOpacity>
              
              {expandedSection === section.id && (
                <View style={[styles.sectionContent, { borderTopColor: colors.border }]}>
                  {section.content.map((item, idx) => (
                    <View key={idx} style={styles.contentItem}>
                      <View style={styles.contentNumber}>
                        <Text style={styles.contentNumberText}>{idx + 1}</Text>
                      </View>
                      <View style={styles.contentText}>
                        <Text style={[styles.contentTitle, { color: colors.textPrimary }]}>{item.title}</Text>
                        <Text style={[styles.contentDescription, { color: colors.textMuted }]}>{item.text}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Contact Support */}
        <View style={[styles.supportCard, { backgroundColor: colors.bgCard, borderColor: colors.border }]}>
          <Text style={[styles.supportTitle, { color: colors.textPrimary }]}>Need More Help?</Text>
          <Text style={[styles.supportText, { color: colors.textMuted }]}>
            If you couldn't find what you're looking for, our support team is here to help.
          </Text>
          <TouchableOpacity 
            style={styles.supportBtn}
            onPress={() => navigation.navigate('Support')}
          >
            <Text style={styles.supportBtnText}>Contact Support</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16 },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  
  // Welcome Banner
  welcomeBanner: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginHorizontal: 16, 
    marginBottom: 16, 
    padding: 16, 
    borderRadius: 16, 
    backgroundColor: '#1a73e815',
    borderWidth: 1,
    borderColor: '#1a73e830'
  },
  welcomeIcon: { 
    width: 50, 
    height: 50, 
    borderRadius: 25, 
    backgroundColor: '#1a73e820', 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  welcomeText: { marginLeft: 14 },
  welcomeTitle: { color: '#fff', fontSize: 17, fontWeight: 'bold' },
  welcomeSubtitle: { color: '#888', fontSize: 13, marginTop: 2 },
  
  // Sections
  sectionsContainer: { paddingHorizontal: 16 },
  sectionCard: { 
    backgroundColor: '#111', 
    borderRadius: 14, 
    marginBottom: 10, 
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#222'
  },
  sectionHeader: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    justifyContent: 'space-between', 
    padding: 16 
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center' },
  sectionIcon: { 
    width: 36, 
    height: 36, 
    borderRadius: 10, 
    backgroundColor: '#1a73e820', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginRight: 12
  },
  sectionTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  
  sectionContent: { 
    paddingHorizontal: 16, 
    paddingBottom: 16, 
    borderTopWidth: 1, 
    borderTopColor: '#222' 
  },
  contentItem: { 
    flexDirection: 'row', 
    marginTop: 14 
  },
  contentNumber: { 
    width: 24, 
    height: 24, 
    borderRadius: 12, 
    backgroundColor: '#1a73e820', 
    justifyContent: 'center', 
    alignItems: 'center',
    marginRight: 12,
    marginTop: 2
  },
  contentNumberText: { color: '#1a73e8', fontSize: 12, fontWeight: 'bold' },
  contentText: { flex: 1 },
  contentTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  contentDescription: { color: '#888', fontSize: 13, marginTop: 4, lineHeight: 18 },
  
  // Support Card
  supportCard: { 
    marginHorizontal: 16, 
    marginTop: 10, 
    padding: 20, 
    backgroundColor: '#111', 
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#222'
  },
  supportTitle: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  supportText: { color: '#888', fontSize: 13, lineHeight: 18, marginBottom: 16 },
  supportBtn: { 
    backgroundColor: '#1a73e8', 
    paddingVertical: 12, 
    borderRadius: 10, 
    alignItems: 'center' 
  },
  supportBtnText: { color: '#000', fontSize: 14, fontWeight: '600' },
});

export default InstructionsScreen;

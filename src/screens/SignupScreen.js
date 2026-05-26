import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { Image } from 'react-native';
import { API_URL } from '../config';

const { width, height } = Dimensions.get('window');
const AUTH_URL = `${API_URL}/auth`;

const SignupScreen = ({ navigation }) => {
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [step, setStep] = useState(1); // Step 1: Personal Info, Step 2: Password
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    referral_code: '',
    password: '',
    confirmPassword: '',
  });

  const handleNextStep = () => {
    if (!formData.first_name.trim()) {
      Alert.alert('Error', 'Please enter your first name');
      return;
    }
    if (!formData.last_name.trim()) {
      Alert.alert('Error', 'Please enter your last name');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!formData.email || !emailRegex.test(formData.email)) {
      Alert.alert('Error', 'Please enter a valid email address');
      return;
    }
    setStep(2);
  };

  const handleSignup = async () => {
    if (!formData.password || formData.password.length < 8) {
      Alert.alert('Error', 'Password must be at least 8 characters long');
      return;
    }
    if (formData.password !== formData.confirmPassword) {
      Alert.alert('Error', 'Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const registerData = {
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
        first_name: formData.first_name.trim(),
        last_name: formData.last_name.trim(),
        phone: formData.phone.trim() || undefined,
        referral_code: formData.referral_code.trim() || undefined,
      };

      console.log('[Registration] Sending to:', `${AUTH_URL}/register`);

      const response = await fetch(`${AUTH_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registerData),
      });

      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Server error: ${responseText.substring(0, 100)}`);
      }

      console.log('[Registration] Response status:', response.status, data);

      if (!response.ok) {
        const errorMsg = data.detail || data.message || `Registration failed (${response.status})`;
        throw new Error(Array.isArray(errorMsg) ? errorMsg[0]?.msg || 'Validation error' : errorMsg);
      }

      if (data.access_token) {
        await SecureStore.setItemAsync('token', data.access_token);
        const userInfo = {
          id: data.user_id,
          email: formData.email.trim().toLowerCase(),
          role: data.role,
          expires_at: data.expires_at,
        };
        await SecureStore.setItemAsync('user', JSON.stringify(userInfo));
        // Persist credentials for silent token refresh on expiry.
        await SecureStore.setItemAsync('savedEmail', formData.email.trim().toLowerCase());
        if (formData.password) {
          await SecureStore.setItemAsync('savedPassword', formData.password);
        }
        navigation.replace('MainTrading');
      } else {
        Alert.alert(
          'Account Created!',
          'Your account has been created. Please login to continue.',
          [{ text: 'OK', onPress: () => navigation.replace('Login') }]
        );
      }
    } catch (error) {
      console.error('Registration error:', error);
      Alert.alert('Registration Error', error.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Logo */}
        <View style={styles.logoContainer}>
          <Image
            source={require('../../assets/intrendfx-logo-light.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <Text style={styles.brandName}>inTrendFX</Text>
        </View>

        {/* Tab Switcher */}
        <View style={styles.tabContainer}>
          <TouchableOpacity style={[styles.tab, styles.activeTab]}>
            <Text style={styles.activeTabText}>Sign up</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.tab}
            onPress={() => navigation.navigate('Login')}
          >
            <Text style={styles.tabText}>Sign in</Text>
          </TouchableOpacity>
        </View>

        {/* Step Indicator */}
        <View style={styles.stepIndicator}>
          <View style={[styles.stepDot, step >= 1 && styles.stepDotActive]} />
          <View style={styles.stepLine} />
          <View style={[styles.stepDot, step >= 2 && styles.stepDotActive]} />
        </View>

        {step === 1 ? (
          <>
            <Text style={styles.title}>Personal Details</Text>
            <Text style={styles.subtitle}>Step 1 of 2 — Tell us about yourself</Text>

            {/* First Name */}
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="First name"
                placeholderTextColor="#666"
                value={formData.first_name}
                onChangeText={(text) => setFormData({ ...formData, first_name: text })}
              />
            </View>

            {/* Last Name */}
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Last name"
                placeholderTextColor="#666"
                value={formData.last_name}
                onChangeText={(text) => setFormData({ ...formData, last_name: text })}
              />
            </View>

            {/* Email */}
            <View style={styles.inputContainer}>
              <Ionicons name="mail-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Email address"
                placeholderTextColor="#666"
                keyboardType="email-address"
                autoCapitalize="none"
                value={formData.email}
                onChangeText={(text) => setFormData({ ...formData, email: text })}
              />
            </View>

            {/* Phone (optional) */}
            <View style={styles.inputContainer}>
              <Ionicons name="call-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Phone number (optional)"
                placeholderTextColor="#666"
                keyboardType="phone-pad"
                value={formData.phone}
                onChangeText={(text) => setFormData({ ...formData, phone: text })}
              />
            </View>

            {/* Referral Code (optional) */}
            <View style={styles.inputContainer}>
              <Ionicons name="gift-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Referral code (optional)"
                placeholderTextColor="#666"
                autoCapitalize="characters"
                value={formData.referral_code}
                onChangeText={(text) => setFormData({ ...formData, referral_code: text })}
              />
            </View>

            {/* Next Button */}
            <TouchableOpacity style={styles.button} onPress={handleNextStep}>
              <Text style={styles.buttonText}>Next</Text>
              <Ionicons name="arrow-forward" size={18} color="#ffffff" style={{ marginLeft: 8 }} />
            </TouchableOpacity>

            {/* Sign In Link */}
            <View style={styles.signinContainer}>
              <Text style={styles.signinText}>Already have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                <Text style={styles.signinLink}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>Set Password</Text>
            <Text style={styles.subtitle}>Step 2 of 2 — Secure your account</Text>

            {/* Summary */}
            <View style={styles.summaryBox}>
              <Ionicons name="person-circle-outline" size={20} color="#1a73e8" />
              <Text style={styles.summaryText}>
                {formData.first_name} {formData.last_name} · {formData.email}
              </Text>
            </View>

            {/* Password */}
            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Password (min 8 characters)"
                placeholderTextColor="#666"
                secureTextEntry={!showPassword}
                value={formData.password}
                onChangeText={(text) => setFormData({ ...formData, password: text })}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeIcon}>
                <Ionicons name={showPassword ? 'eye-outline' : 'eye-off-outline'} size={20} color="#666" />
              </TouchableOpacity>
            </View>

            {/* Confirm Password */}
            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color="#666" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Confirm password"
                placeholderTextColor="#666"
                secureTextEntry={!showConfirmPassword}
                value={formData.confirmPassword}
                onChangeText={(text) => setFormData({ ...formData, confirmPassword: text })}
              />
              <TouchableOpacity onPress={() => setShowConfirmPassword(!showConfirmPassword)} style={styles.eyeIcon}>
                <Ionicons name={showConfirmPassword ? 'eye-outline' : 'eye-off-outline'} size={20} color="#666" />
              </TouchableOpacity>
            </View>

            {/* Password match indicator */}
            {formData.confirmPassword.length > 0 && (
              <View style={styles.matchIndicator}>
                <Ionicons
                  name={formData.password === formData.confirmPassword ? 'checkmark-circle' : 'close-circle'}
                  size={16}
                  color={formData.password === formData.confirmPassword ? '#22c55e' : '#ef4444'}
                />
                <Text style={[styles.matchText, { color: formData.password === formData.confirmPassword ? '#22c55e' : '#ef4444' }]}>
                  {formData.password === formData.confirmPassword ? 'Passwords match' : 'Passwords do not match'}
                </Text>
              </View>
            )}

            {/* Create Account Button */}
            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleSignup}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.buttonText}>Create Account</Text>
              )}
            </TouchableOpacity>

            {/* Back Button */}
            <TouchableOpacity style={styles.backButton} onPress={() => setStep(1)}>
              <Ionicons name="arrow-back" size={20} color="#1a73e8" />
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>

            {/* Terms */}
            <Text style={styles.terms}>
              By creating an account, you agree to our{' '}
              <Text style={styles.termsLink}>Terms of Service</Text>
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingBottom: 40,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logoImage: {
    width: 120,
    height: 120,
  },
  brandName: {
    color: '#111',
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 12,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#f2f4f7',
    borderRadius: 12,
    padding: 4,
    marginBottom: 24,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: '#1a73e8',
  },
  tabText: {
    color: '#666',
    fontSize: 15,
    fontWeight: '600',
  },
  activeTabText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  stepIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
    gap: 0,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#d0d5dd',
  },
  stepDotActive: {
    backgroundColor: '#1a73e8',
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: '#d0d5dd',
    marginHorizontal: 8,
    maxWidth: 60,
  },
  title: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#111',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 28,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f8fa',
    borderWidth: 1,
    borderColor: '#e1e4e8',
    borderRadius: 12,
    marginBottom: 14,
    paddingHorizontal: 16,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 16,
    color: '#111',
    fontSize: 16,
  },
  eyeIcon: {
    padding: 4,
  },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  summaryBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f7f8fa',
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
    gap: 10,
  },
  summaryText: {
    color: '#333',
    fontSize: 14,
    flex: 1,
  },
  matchIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
    marginTop: -6,
  },
  matchText: {
    fontSize: 13,
  },
  terms: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 20,
    lineHeight: 20,
  },
  termsLink: {
    color: '#1a73e8',
  },
  signinContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 24,
  },
  signinText: {
    color: '#666',
    fontSize: 15,
  },
  signinLink: {
    color: '#1a73e8',
    fontSize: 15,
    fontWeight: '600',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    padding: 12,
    gap: 8,
  },
  backButtonText: {
    color: '#1a73e8',
    fontSize: 15,
    fontWeight: '500',
  },
});

export default SignupScreen;

import { API_URL } from '../config';
import * as SecureStore from 'expo-secure-store';

class ApiService {
  constructor() {
    this.baseUrl = API_URL;
  }

  async getAuthHeaders() {
    const token = await SecureStore.getItemAsync('token');
    return {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    };
  }

  async request(endpoint, options = {}) {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...headers,
          ...options.headers,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || data.message || 'Request failed');
      }

      return data;
    } catch (error) {
      console.error('API Request Error:', error);
      throw error;
    }
  }

  // Portfolio APIs
  async getPortfolioSummary(accountId = null) {
    const query = accountId ? `?account_id=${accountId}` : '';
    return this.request(`/portfolio/summary${query}`);
  }

  async getPortfolioPerformance(period = 'all') {
    return this.request(`/portfolio/performance?period=${period}`);
  }

  async getTradeHistory(page = 1, perPage = 50) {
    return this.request(`/portfolio/trades?page=${page}&per_page=${perPage}`);
  }

  // Wallet APIs
  async getWalletSummary() {
    return this.request('/wallet/summary');
  }

  async getDeposits(page = 1, perPage = 20) {
    return this.request(`/wallet/deposits?page=${page}&per_page=${perPage}`);
  }

  async getWithdrawals(page = 1, perPage = 20) {
    return this.request(`/wallet/withdrawals?page=${page}&per_page=${perPage}`);
  }

  async submitDeposit(data) {
    return this.request('/wallet/deposit', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async submitWithdrawal(data) {
    return this.request('/wallet/withdraw', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Social Trading APIs
  async getLeaderboard(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/social/leaderboard${query ? `?${query}` : ''}`);
  }

  async getMyCopies() {
    return this.request('/social/my-copies');
  }

  // Copy a master: amount-based allocation. Backend takes query params.
  async followProvider(masterId, accountId, amount) {
    const query = new URLSearchParams({
      master_id: masterId,
      account_id: accountId,
      amount,
    }).toString();
    return this.request(`/social/copy?${query}`, {
      method: 'POST',
    });
  }

  async unfollowProvider(allocationId) {
    return this.request(`/social/copy/${allocationId}`, {
      method: 'DELETE',
    });
  }

  async getMAMMPAMM() {
    return this.request('/social/mamm-pamm');
  }

  async investInMAMMPAMM(accountId, amount) {
    return this.request(`/social/mamm-pamm/${accountId}/invest`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
  }

  async getMyProvider() {
    return this.request('/social/my-provider');
  }

  async becomeProvider(data) {
    return this.request('/social/become-provider', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Business/IB APIs
  async getBusinessStatus() {
    return this.request('/business/status');
  }

  async applyForIB() {
    return this.request('/business/apply', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getIBDashboard() {
    return this.request('/business/ib/dashboard');
  }

  async getIBReferrals() {
    return this.request('/business/ib/referrals');
  }

  async getIBCommissions() {
    return this.request('/business/ib/commissions');
  }

  async getIBTree() {
    return this.request('/business/ib/tree');
  }

  async applyForSubBroker(data) {
    return this.request('/business/apply-sub-broker', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSubBrokerDashboard() {
    return this.request('/business/sub-broker/dashboard');
  }

  // Profile APIs
  async getProfile() {
    return this.request('/profile');
  }

  async updateProfile(data) {
    return this.request('/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async uploadDocument(formData) {
    const token = await SecureStore.getItemAsync('token');
    const response = await fetch(`${this.baseUrl}/profile/upload-document`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: formData,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || data.message || 'Upload failed');
    }
    return data;
  }

  async getDocuments() {
    return this.request('/profile/documents');
  }

  // Support APIs
  async getTickets(page = 1, perPage = 20) {
    return this.request(`/support/tickets?page=${page}&per_page=${perPage}`);
  }

  async createTicket(data) {
    return this.request('/support/tickets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getTicketDetails(ticketId) {
    return this.request(`/support/tickets/${ticketId}`);
  }

  async replyToTicket(ticketId, message) {
    return this.request(`/support/tickets/${ticketId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  // Notifications APIs
  async getNotifications(page = 1, perPage = 20) {
    return this.request(`/notifications?page=${page}&per_page=${perPage}`);
  }

  async markNotificationRead(notificationId) {
    return this.request(`/notifications/${notificationId}/read`, {
      method: 'PUT',
    });
  }

  async deleteNotification(notificationId) {
    return this.request(`/notifications/${notificationId}`, {
      method: 'DELETE',
    });
  }

  // Banners API
  async getBanners(page = 'dashboard') {
    return this.request(`/banners?page=${page}`);
  }

  // Accounts APIs
  async getAccounts() {
    return this.request('/accounts');
  }

  async createAccount(data) {
    return this.request('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getAvailableAccountGroups() {
    return this.request('/accounts/available-groups');
  }

  async openAccount(accountGroupId, { currency = 'USD', leverage = null, isDemo = false } = {}) {
    return this.request('/accounts/open', {
      method: 'POST',
      body: JSON.stringify({
        account_group_id: accountGroupId,
        currency,
        ...(leverage != null && { leverage }),
        is_demo: isDemo,
      }),
    });
  }

  async deleteAccount(accountId) {
    return this.request(`/accounts/${accountId}`, {
      method: 'DELETE',
    });
  }

  async transferInternal(fromAccountId, toAccountId, amount) {
    return this.request('/wallet/transfer-internal', {
      method: 'POST',
      body: JSON.stringify({
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
      }),
    });
  }

  // KYC API (matches web /profile/kyc/submit/)
  async submitKyc(formData) {
    const token = await SecureStore.getItemAsync('token');
    const res = await fetch(`${this.baseUrl}/profile/kyc/submit/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.message || 'KYC submit failed');
    return data;
  }

  // PAMM allocations (web format)
  async getMyAllocations() {
    return this.request('/social/my-allocations');
  }

  async withdrawAllocation(masterId) {
    return this.request(`/social/mamm-pamm/${masterId}/withdraw`, {
      method: 'DELETE',
    });
  }

  async getMasterPerformance() {
    return this.request('/social/master-performance');
  }

  async getMasterInvestors() {
    return this.request('/social/master-investors');
  }

  // Instruments APIs
  async getInstruments() {
    return this.request('/instruments');
  }

  async getAllPrices() {
    return this.request('/instruments/prices/all');
  }

  // Orders APIs
  async getOrders(accountId, status = null) {
    const query = new URLSearchParams({ account_id: accountId });
    if (status) query.append('status', status);
    return this.request(`/orders?${query.toString()}`);
  }

  async placeOrder(data) {
    return this.request('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async modifyOrder(orderId, data) {
    return this.request(`/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async cancelOrder(orderId) {
    return this.request(`/orders/${orderId}`, {
      method: 'DELETE',
    });
  }

  // Positions APIs
  async getPositions(accountId, status = 'open') {
    const query = new URLSearchParams({ account_id: accountId, status });
    return this.request(`/positions?${query.toString()}`);
  }

  async modifyPosition(positionId, data) {
    return this.request(`/positions/${positionId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async closePosition(positionId, lots = null) {
    const body = lots ? { lots } : {};
    return this.request(`/positions/${positionId}/close`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  // Account Summary API
  async getAccountSummary(accountId) {
    return this.request(`/accounts/${accountId}/summary`);
  }

  // Social Trading - TrustEdge format
  async getMasters() {
    return this.request('/social/leaderboard?sort_by=total_return_pct&page=1&per_page=50');
  }

  async getMySubscriptions() {
    return this.request('/social/my-copies');
  }

  async followMaster(masterId, accountId, amount) {
    const query = new URLSearchParams({
      master_id: masterId,
      account_id: accountId,
      amount,
    }).toString();
    return this.request(`/social/copy?${query}`, {
      method: 'POST',
    });
  }

  async unfollowMaster(allocationId) {
    return this.request(`/social/copy/${allocationId}`, {
      method: 'DELETE',
    });
  }
}

export default new ApiService();

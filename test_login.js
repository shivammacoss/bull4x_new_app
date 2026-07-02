// Test BULL4X Login API
const API_URL = 'https://api.bull4x.com/api/v1';

async function testLogin() {
  console.log('Testing inTrendFX Login API...\n');

  try {
    // Test login endpoint
    console.log('1. Testing /auth/login:');
    const loginData = {
      email: 'test@example.com', // Replace with actual test email
      password: 'testpassword123' // Replace with actual test password
    };

    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(loginData)
    });

    console.log('Status:', response.status);
    const data = await response.json();
    console.log('Response:', data);

    if (response.ok) {
      console.log('\n✅ Login successful!');
      console.log('Access Token:', data.access_token ? 'Received' : 'Missing');
      console.log('User ID:', data.user_id);
      console.log('Role:', data.role);
      console.log('Expires At:', data.expires_at);
    } else {
      console.log('\n❌ Login failed:', data.detail || data.message);
    }

  } catch (error) {
    console.error('Test Error:', error.message);
  }
}

// Run test
testLogin();

// Test BULL4X API endpoints
const API_URL = 'https://api.bull4x.com/api/v1';

async function testAPI() {
  console.log('Testing inTrendFX API endpoints...\n');

  try {
    // Test instruments endpoint
    console.log('1. Testing /instruments:');
    const instrumentsRes = await fetch(`${API_URL}/instruments`);
    const instruments = await instrumentsRes.json();
    console.log('Status:', instrumentsRes.status);
    console.log('Type:', Array.isArray(instruments) ? 'Array' : typeof instruments);
    console.log('Count:', Array.isArray(instruments) ? instruments.length : 'N/A');
    if (Array.isArray(instruments) && instruments.length > 0) {
      console.log('Sample:', instruments[0]);
    }
    console.log('');

    // Test prices endpoint
    console.log('2. Testing /instruments/prices/all:');
    const pricesRes = await fetch(`${API_URL}/instruments/prices/all`);
    const prices = await pricesRes.json();
    console.log('Status:', pricesRes.status);
    console.log('Type:', Array.isArray(prices) ? 'Array' : typeof prices);
    console.log('Count:', Array.isArray(prices) ? prices.length : 'N/A');
    if (Array.isArray(prices) && prices.length > 0) {
      console.log('Sample:', prices[0]);
    }
    console.log('');

    // Test specific price endpoint
    if (Array.isArray(instruments) && instruments.length > 0) {
      const symbol = instruments[0].symbol;
      console.log(`3. Testing /instruments/${symbol}/price:`);
      const priceRes = await fetch(`${API_URL}/instruments/${symbol}/price`);
      const price = await priceRes.json();
      console.log('Status:', priceRes.status);
      console.log('Data:', price);
    }

  } catch (error) {
    console.error('API Test Error:', error);
  }
}

// Run test
testAPI();

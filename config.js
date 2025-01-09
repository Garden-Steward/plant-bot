require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Make sure to use an API key that has access to Gemini Pro Vision
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize the API with error checking
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set in environment variables');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Test the API key on startup
async function testGeminiAPI() {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-pro-vision' });
    console.log('Gemini API initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Gemini API:', error.message);
    process.exit(1);
  }
}

testGeminiAPI();

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  STRAPI_CONFIG: {
    apiUrl: process.env.STRAPI_API_URL,
    apiToken: process.env.STRAPI_API_TOKEN
  },
  genAI
}; 
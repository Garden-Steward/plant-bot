require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

module.exports = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  genAI,
  STRAPI_CONFIG: {
    apiUrl: process.env.STRAPI_API_URL,
    apiToken: process.env.STRAPI_API_TOKEN,
  }
}; 
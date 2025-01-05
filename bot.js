const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

// Simple in-memory session store (consider using Redis for production)
const userSessions = new Map();

// Session states
const STATES = {
  IDLE: 'IDLE',
  WAITING_FOR_PLANT_NAME: 'WAITING_FOR_PLANT_NAME',
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_LOCATION: 'WAITING_FOR_LOCATION'
};

// Initialize the bot with the token from config
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// Start command handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  initSession(chatId);
  askForPlantName(chatId);
});

// Cancel command handler
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  initSession(chatId);
  bot.sendMessage(chatId, 'Operation cancelled. Send /start to begin again.');
});

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId) || initSession(chatId);

  try {
    switch (session.state) {
      case STATES.WAITING_FOR_PLANT_NAME:
        if (msg.text && msg.text !== '/start' && msg.text !== '/cancel') {
          session.plantName = msg.text;
          session.state = STATES.WAITING_FOR_IMAGE;
          await askForImage(chatId);
        }
        break;

      case STATES.WAITING_FOR_IMAGE:
        if (msg.photo) {
          await handlePhoto(msg, session);
          session.state = STATES.WAITING_FOR_LOCATION;
          await askForLocation(chatId);
        } else if (msg.text !== '/cancel') {
          await bot.sendMessage(chatId, 'Please send a photo of the plant.');
        }
        break;

      case STATES.WAITING_FOR_LOCATION:
        if (msg.location) {
          await handleLocation(msg, session);
          // Reset session after successful completion
          await sendSummary(chatId, session);
          initSession(chatId);
        } else if (msg.text !== '/cancel') {
          await bot.sendMessage(chatId, 'Please send the location or use the button below.');
        }
        break;
    }
  } catch (error) {
    console.error('Message Handler Error:', error);
    await bot.sendMessage(chatId, 'An error occurred. Please try again or use /cancel to restart.');
  }
});

// Helper functions
function initSession(chatId) {
  const session = {
    state: STATES.IDLE,
    plantName: null,
    imageUrl: null,
    imageAnalysis: null,
    location: null
  };
  userSessions.set(chatId, session);
  return session;
}

async function askForPlantName(chatId) {
  const session = userSessions.get(chatId);
  session.state = STATES.WAITING_FOR_PLANT_NAME;
  await bot.sendMessage(chatId, 
    'Let\'s start! What is the name of the plant you\'re documenting?\n\n' +
    'You can use /cancel at any time to start over.'
  );
}

async function askForImage(chatId) {
  await bot.sendMessage(
    chatId,
    'Great! Now please send me a photo of the plant.'
  );
}

async function askForLocation(chatId) {
  const locationKeyboard = {
    reply_markup: {
      keyboard: [[{
        text: '📍 Share Location',
        request_location: true
      }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  
  await bot.sendMessage(
    chatId,
    'Thanks! Now please share the location where this plant is growing.',
    locationKeyboard
  );
}

async function handlePhoto(msg, session) {
  const photo = msg.photo[msg.photo.length - 1];
  const file = await bot.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

  // Download image from Telegram
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  
  // Create form data for Strapi upload
  const formData = new FormData();
  formData.append('files', new Blob([response.data], { type: 'image/jpeg' }), `${session.plantName}_${photo.file_id}.jpg`);

  // Upload to Strapi
  try {
    const uploadResponse = await axios.post(
      `${config.STRAPI_CONFIG.apiUrl}/api/upload`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
          'Content-Type': 'multipart/form-data'
        }
      }
    );

    // Get the URL from Strapi's response
    const uploadedFile = uploadResponse.data[0];
    session.imageUrl = uploadedFile.url;

    // Analyze with Gemini
    const model = genAI.getGenerativeModel({ model: 'gemini-pro-vision' });
    const result = await model.generateContent([
      session.imageUrl,
      `Analyze this image of a plant named "${session.plantName}". ` +
      'Provide details about its appearance and health.'
    ]);
    const aiResponse = await result.response;

    // Save analysis to session
    session.imageAnalysis = aiResponse.text();

    await bot.sendMessage(msg.chat.id, 'Photo received and analyzed! Now I need the location.');
  } catch (error) {
    console.error('Error uploading to Strapi:', error.response?.data || error.message);
    throw new Error('Failed to upload image');
  }
}

async function handleLocation(msg, session) {
  const { latitude, longitude } = msg.location;
  session.location = { latitude, longitude };

  // Save to Strapi
  await saveToStrapi({
    plantName: session.plantName,
    imageUrl: session.imageUrl,
    analysis: session.imageAnalysis,
    latitude,
    longitude,
    userId: msg.from.id
  });
}

async function sendSummary(chatId, session) {
  const message = 
    `✅ Entry Complete!\n\n` +
    `🌿 Plant: ${session.plantName}\n` +
    `📍 Location: ${session.location.latitude}, ${session.location.longitude}\n\n` +
    `Analysis:\n${session.imageAnalysis}\n\n` +
    `Send /start to document another plant!`;

  await bot.sendMessage(chatId, message, {
    reply_markup: {
      remove_keyboard: true
    }
  });
}

async function saveToStrapi(data) {
  try {
    const response = await axios.post(
      `${config.STRAPI_CONFIG.apiUrl}/api/plants`,
      {
        data: {
          name: data.plantName,
          image_url: data.imageUrl,
          analysis: data.imageAnalysis,
          latitude: data.latitude,
          longitude: data.longitude,
          telegram_user_id: data.userId.toString()
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error saving to Strapi:', error.response?.data || error.message);
    throw new Error('Failed to save plant data to database');
  }
}

// ... (rest of your code remains the same) ...

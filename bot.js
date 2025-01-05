const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

// Initialize Google AI
const genAI = config.genAI;

// Simple in-memory session store (consider using Redis for production)
const userSessions = new Map();

// Session states
const STATES = {
  IDLE: 'IDLE',
  WAITING_FOR_PLANT_NAME: 'WAITING_FOR_PLANT_NAME',
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_LOCATION: 'WAITING_FOR_LOCATION',
  WAITING_FOR_PHONE: 'WAITING_FOR_PHONE'
};

// Initialize the bot with the token from config
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// Start command handler
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  initSession(chatId);
  askForPhone(chatId);
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
      case STATES.IDLE:
        if (msg.contact && msg.contact.phone_number) {
          session.phoneNumber = msg.contact.phone_number;
          session.state = STATES.WAITING_FOR_PLANT_NAME;
          await askForPlantName(chatId);
        } else if (!msg.contact && msg.text !== '/cancel') {
          await bot.sendMessage(chatId, 'Please use the button to share your phone number.');
        }
        break;

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
    phoneNumber: null,
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
    'Please share the location where this plant is growing.',
    locationKeyboard
  );
}

async function askForPhone(chatId) {
  const phoneKeyboard = {
    reply_markup: {
      keyboard: [[{
        text: '📱 Share Phone Number',
        request_contact: true
      }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
  
  await bot.sendMessage(
    chatId,
    'Please share your phone number to get started.',
    phoneKeyboard
  );
}

async function handlePhoto(msg, session) {
  const photo = msg.photo[msg.photo.length - 1];
  const file = await bot.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  
  // Generate a shorter, sanitized filename
  const timestamp = Date.now();
  const sanitizedPlantName = session.plantName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .substring(0, 30);
  const filename = `${sanitizedPlantName}_${timestamp}.jpg`;

  const formData = new FormData();
  formData.append('files', Buffer.from(response.data), {
    filename: filename,
    contentType: 'image/jpeg',
  });
  formData.append('folder', 'plants');

  console.log('Uploading file:', filename, 'to folder: plants');
  
  try {
    const uploadResponse = await axios.post(
      `${config.STRAPI_CONFIG.apiUrl}/api/upload`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
          ...formData.getHeaders()
        }
      }
    );

    if (!uploadResponse.data || !Array.isArray(uploadResponse.data)) {
      throw new Error('Invalid upload response from Strapi');
    }

    const uploadedFile = uploadResponse.data[0];
    if (!uploadedFile || !uploadedFile.id) {
      throw new Error('No file ID received from Strapi');
    }

    console.log('File successfully uploaded with ID:', uploadedFile.id);
    session.imageId = uploadedFile.id;

    // Start image analysis in the background
    analyzeImage(msg.chat.id, session, uploadedFile.url).catch(error => {
      console.error('Image analysis error:', error);
      bot.sendMessage(msg.chat.id, 'Note: There was an error analyzing your image, but we\'ll continue with the location.');
    });

    // Set state and ask for location only once
    session.state = STATES.WAITING_FOR_LOCATION;
    await askForLocation(msg.chat.id);

  } catch (error) {
    console.error('Detailed upload error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

// New separate function for image analysis
async function analyzeImage(chatId, session, imageUrl) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent([
      imageUrl,
      'Briefly describe this image in 2-3 short sentences. Focus only on what you can see in the image.'
    ]);
    const aiResponse = await result.response;
    session.imageAnalysis = aiResponse.text();
    
    // Notify user that analysis is complete
    await bot.sendMessage(chatId, 'Image analysis complete! I\'ll include it in the final summary.');
  } catch (error) {
    console.error('Analysis error:', error);
    session.imageAnalysis = 'Image analysis failed';
    throw error;
  }
}

async function handleLocation(msg, session) {
  const { latitude, longitude } = msg.location;
  session.location = { latitude, longitude };

  // Save to Strapi
  await saveToStrapi({
    plantName: session.plantName,
    imageId: session.imageId,
    imageAnalysis: session.imageAnalysis,
    latitude,
    longitude,
    userId: msg.from.id,
    phoneNumber: session.phoneNumber
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
      `${config.STRAPI_CONFIG.apiUrl}/api/location-trackings`,
      {
        data: {
          label: data.plantName,
          plant_image: data.imageId,
          analysis: data.imageAnalysis,
          latitude: data.latitude,
          longitude: data.longitude,
          last_verified: new Date().toISOString(),
          phone_number: data.phoneNumber
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

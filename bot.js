process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
  // Don't exit the process
});

const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const FormData = require('form-data');
const config = require('./config');

// At the top after requires
console.log('Application starting...');
console.log('Environment:', process.env.NODE_ENV);
console.log('Server Port:', 8080);

// Initialize Express first
const express = require('express');
const app = express();
const PORT = 8080;
const HOST = '0.0.0.0';

// Initialize Google AI
const genAI = config.genAI;

// Simple in-memory session store (consider using Redis for production)
const userSessions = new Map();

// In-memory storage (consider using Redis/DB for production)
const userPhoneNumbers = new Map();

// Session states
const STATES = {
  IDLE: 'IDLE',
  WAITING_FOR_PLANT_NAME: 'WAITING_FOR_PLANT_NAME',
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_LOCATION: 'WAITING_FOR_LOCATION',
  WAITING_FOR_PHONE: 'WAITING_FOR_PHONE'
};

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`Health check received on port ${PORT}`);
  res.status(200).send('OK');
});

// Start Express with more detailed logging
const server = app.listen(PORT, HOST, () => {
  console.log(`Server started and listening on http://${HOST}:${PORT}`);
  console.log(`Health check available at http://${HOST}:${PORT}/health`);
  console.log('Starting bot...');
  startBot();
}).on('error', (error) => {
  console.error(`Express Server Error on port ${PORT}:`, error);
});

// Add shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Add a catch-all route
app.use((req, res) => {
  console.log('Received request:', req.method, req.url);
  res.status(404).send('Not Found');
});

// Near the top of your file
const isProd = process.env.NODE_ENV === 'production';
console.log('Running in', isProd ? 'production' : 'development', 'mode');

function startBot() {
  console.log('Bot starting...');
  const botConfig = {
    // Use webhooks in production, polling in development
    ...(isProd ? {
      webHook: {
        port: 8080
      }
    } : {
      polling: true
    })
  };

  const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, botConfig);
  console.log('Bot initialized with', isProd ? 'webhook' : 'polling');

  if (isProd) {
    // Set webhook only in production
    const webhookUrl = `https://steward-plant-bot.fly.dev/${config.TELEGRAM_BOT_TOKEN}`;
    bot.setWebHook(webhookUrl).then(() => {
      console.log('Webhook set to:', webhookUrl);
    });
  }

  // Add error handler for the bot
  bot.on('error', (error) => {
    console.error('Bot error:', error);
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });

  // [Paste all your original bot code here, starting from the initSession function]
  function initSession(chatId) {
    console.log(`Attempting to initialize/get session for chatId: ${chatId}`);
    
    // Check if session already exists
    if (userSessions.has(chatId)) {
      console.log(`Session already exists for chatId: ${chatId}`, {
        state: userSessions.get(chatId).state
      });
      return userSessions.get(chatId);
    }

    console.log('Creating new session for chatId:', chatId);
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

  // [Paste the rest of your original bot code here, including all handlers and helper functions]
  // Start command handler
  bot.onText(/\/start/, async (msg) => {
    console.log('Received /start command from:', msg.chat.id);
    const chatId = msg.chat.id;
    initSession(chatId);
    
    // Check if we already have the user's phone number
    if (userPhoneNumbers.has(chatId)) {
      console.log(`Found existing phone number for chatId: ${chatId}`);
      const phoneNumber = userPhoneNumbers.get(chatId);
      const session = userSessions.get(chatId);
      session.phoneNumber = phoneNumber;
      session.state = STATES.WAITING_FOR_PLANT_NAME;
      await askForPlantName(chatId);
    } else {
      console.log(`No phone number found for chatId: ${chatId}, asking for phone`);
      await askForPhone(chatId);
    }
  });

  // Message handler
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const session = userSessions.get(chatId) || initSession(chatId);

    try {
      // console.log(`Processing message in state: ${session.state}`);
      switch (session.state) {
        case STATES.IDLE:
          if (msg.contact && msg.contact.phone_number) {
            session.phoneNumber = msg.contact.phone_number;
            // Store the phone number for future use
            userPhoneNumbers.set(chatId, msg.contact.phone_number);
            session.state = STATES.WAITING_FOR_PLANT_NAME;
            await askForPlantName(chatId);
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
          } else if (msg.text !== '/cancel') {
            await bot.sendMessage(chatId, 'Please send a photo of the plant.');
          }
          break;

        case STATES.WAITING_FOR_LOCATION:
          if (msg.location) {
            await handleLocation(msg, session);
            await sendSummary(chatId, session);
            initSession(chatId);
          } else if (msg.text !== '/cancel') {
            await askForLocation(chatId);
          }
          break;
      }
    } catch (error) {
      console.error('Message Handler Error:', error);
      await bot.sendMessage(chatId, 'An error occurred. Please try again or use /cancel to restart.');
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    
    switch (query.data) {
      case 'add_plant':
        initSession(chatId);
        askForPhone(chatId);
        break;
      case 'view_map':
        // Handle map view
        break;
    }
    
    // Answer the callback query to remove the loading state
    await bot.answerCallbackQuery(query.id);
  });

  // Helper functions
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

  // Add this new function to create a menu with multiple options
  async function showMainMenu(chatId) {
    const keyboard = {
      reply_markup: {
        keyboard: [
          ['🌿 Document New Plant'],
          ['🗺️ View My Plants'],
          ['ℹ️ Help']
        ],
        resize_keyboard: true
      }
    };

    await bot.sendMessage(
      chatId,
      'What would you like to do?',
      keyboard
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

      // Start image analysis in background
      analyzeImage(msg.chat.id, session, uploadedFile.url)
        .catch(error => console.error('Image analysis error:', error));

      // Set state and ask for location ONCE
      session.state = STATES.WAITING_FOR_LOCATION;
      await askForLocation(msg.chat.id);

    } catch (error) {
      console.error('Detailed upload error:', error);
      throw new Error(`Failed to upload image: ${error.message}`);
    }
  }

  // New separate function for image analysis
  async function analyzeImage(chatId, session, imageUrl) {
    try {
      console.log('Starting image analysis for:', imageUrl);
      
      // Fetch the image data
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const imageData = Buffer.from(imageResponse.data);
      
      // Initialize Gemini model with the new version
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      
      // Prepare the image data
      const imagePart = {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: 'image/jpeg'
        }
      };
      
      // Generate content with the base64 image
      const result = await model.generateContent([
        imagePart,
        'Analyze this plant image. Describe what you see in 2-3 short sentences, focusing on the plant\'s appearance, condition, and notable features.'
      ]);
      
      const response = await result.response;
      session.imageAnalysis = response.text();
      console.log('Analysis complete:', session.imageAnalysis);
      
    } catch (error) {
      console.error('Analysis error:', error);
      session.imageAnalysis = 'Image analysis failed: ' + error.message;
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
    let message = 
      `✅ Entry Complete!\n\n` +
      `🌿 Plant: ${session.plantName}\n` +
      `📍 Location: ${session.location.latitude}, ${session.location.longitude}\n\n`;

    // Only add analysis if it exists
    if (session.imageAnalysis) {
      message += `Analysis:\n${session.imageAnalysis}\n\n`;
    }

    message += `Send /start to document another plant!`;

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

  // Cancel command handler
  bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    initSession(chatId);
    bot.sendMessage(chatId, 'Operation cancelled. Send /start to begin again.');
  });

  // Add error handler for the bot
  bot.on('error', (error) => {
    console.error('Bot error:', error);
  });

  bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
  });

}

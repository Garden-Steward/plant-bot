const axios = require('axios');
const config = require('../config');
const FormData = require('form-data');
const client = require('../api');

// Add this helper function at the top with other constants
const MAINTENANCE_MESSAGE = "🛠️ The service is temporarily undergoing maintenance. Please try again later. We apologize for the inconvenience.";

// Add STATES at the top of the file
const STATES = {
  IDLE: 'IDLE',
  WAITING_FOR_PLANT_NAME: 'WAITING_FOR_PLANT_NAME',
  WAITING_FOR_IMAGE: 'WAITING_FOR_IMAGE',
  WAITING_FOR_LOCATION: 'WAITING_FOR_LOCATION',
  WAITING_FOR_PHONE: 'WAITING_FOR_PHONE'
};

function isConnectionError(error) {
  return error.code === 'ECONNREFUSED' || 
         error.code === 'ECONNRESET' || 
         error.code === 'ETIMEDOUT' ||
         error.message.includes('connect');
}

// Image handling and analysis
async function analyzeImage(session, imageUrl) {
  try {
    console.log('Starting image analysis for:', imageUrl);
    
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageData = Buffer.from(imageResponse.data);
    
    const model = config.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const imagePart = {
      inlineData: {
        data: imageData.toString('base64'),
        mimeType: 'image/jpeg'
      }
    };
    
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

// Strapi interactions
async function saveToStrapi(data) {
  try {
    const payload = {
      data: {
        label: data.plantName,
        plant_image: data.imageId,
        analysis: data.imageAnalysis,
        latitude: data.latitude,
        longitude: data.longitude,
        last_verified: new Date().toISOString(),
        phone_number: data.phoneNumber,
        user: data.userId
      }
    };

    // Add planted_date only for new plantings
    if (data.isNewPlanting) {
      payload.data.planted_date = new Date().toISOString();
    }
    console.log('payload', payload);

    const response = await client.post('/api/location-trackings', payload);
    return response.data;
  } catch (error) {
    console.error('Error saving to Strapi:', error);
    if (isConnectionError(error)) {
      throw new Error(MAINTENANCE_MESSAGE);
    }
    throw new Error('Failed to save plant data to database');
  }
}

// Session management
function initSession(chatId, userSessions, STATES) {
  console.log(`Attempting to initialize/get session for chatId: ${chatId}`);
  
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
    userId: null,
    plantName: null,
    imageUrl: null,
    imageAnalysis: null,
    location: null,
    isNewPlanting: false
  };
  userSessions.set(chatId, session);
  return session;
}

// Message formatting
async function sendSummary(bot, chatId, session) {
  let message = 
    `✅ Entry Complete!\n\n` +
    `🌿 Plant: ${session.plantName}\n` +
    `📍 Location: ${session.location.latitude}, ${session.location.longitude}\n\n`;

  if (session.imageAnalysis) {
    message += `Analysis:\n${session.imageAnalysis}\n\n`;
  }

  if (session.isNewPlanting) {
    message += `📅 Planting Date: ${new Date().toLocaleDateString()}\n\n`;
  }

  message += `What would you like to do next?\n` +
             `/newplanting - Document a new planting\n` +
             `/addplant - Add an existing plant`;

  await bot.sendMessage(chatId, message, {
    reply_markup: {
      remove_keyboard: true
    }
  });
}

// File handling
async function handlePhotoUpload(msg, session, bot, config) {
  const photo = msg.photo[msg.photo.length - 1];
  const file = await bot.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  
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
    const uploadResponse = await client.post(
      '/api/upload',
      formData,
      {
        headers: {
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
    return {
      fileId: uploadedFile.id,
      fileUrl: uploadedFile.url
    };

  } catch (error) {
    console.error('Detailed upload error:', error);
    if (isConnectionError(error)) {
      throw new Error(MAINTENANCE_MESSAGE);
    }
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

// Add this to your helper functions
async function removeKeyboard(bot, chatId, message = 'Keyboard removed') {
  return await bot.sendMessage(chatId, message, {
    reply_markup: {
      remove_keyboard: true
    }
  });
}

async function findUserByChatId(chatId) {
  try {
    const response = await client.get('/api/users', {
      params: {
        filters: {
          chatId: {
            $eq: chatId
          }
        }
      }
    });
    
    if (response.data && Array.isArray(response.data)) {
      return response.data[0] || null;
    }
    return null;
  } catch (error) {
    console.error('Error finding user');
    if (isConnectionError(error)) {
      throw new Error(MAINTENANCE_MESSAGE);
    }
    throw error;
  }
}

async function findUserByPhone(phoneNumber) {
  try {
    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const response = await client.get('/api/users', {
      params: {
        filters: {
          phoneNumber: {
            $eq: formattedPhone
          }
        }
      }
    });
    
    if (response.data && Array.isArray(response.data)) {
      return response.data[0] || null;
    }
    return null;
  } catch (error) {
    console.error('Error finding user by phone:');
    if (isConnectionError(error)) {
      throw new Error(MAINTENANCE_MESSAGE);
    }
    throw error;
  }
}

async function updateUserChatId(userId, chatId) {
  try {
    const response = await client.put(`/api/users/${userId}`, {
      chatId: chatId.toString()
    });
    
    console.log('Updated user chatId:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error updating user chatId:', error);
    if (isConnectionError(error)) {
      throw new Error(MAINTENANCE_MESSAGE);
    }
    throw error;
  }
}

// Helper function for command options message
async function sendCommandOptions(bot, chatId) {
  const message = 
    `Choose an option:\n\n` +
    `/newplanting - Document a new planting\n` +
    `/addplant - Add an existing plant`;
  
  await bot.sendMessage(chatId, message);
}

// Update askForPlantName to use the local STATES
async function askForPlantName(chatId, session, bot) {
  session.state = STATES.WAITING_FOR_PLANT_NAME;
  const actionType = session.isNewPlanting ? 'planting' : 'documenting';
  
  await bot.sendMessage(chatId, 
    `Hi ${session.username}! Let's get started. What is the name of the plant you're ${actionType}?\n\n` +
    `You can use /cancel at any time to start over.`
  );
}

// Update handleLocation to pass isNewPlanting
async function handleLocation(msg, session) {
  const { latitude, longitude } = msg.location;
  session.location = { latitude, longitude };

  if (!session.userId) {
    throw new Error('No user ID found in session');
  }

  // Save to Strapi using session's userId and isNewPlanting flag
  await saveToStrapi({
    plantName: session.plantName,
    imageId: session.imageId,
    imageAnalysis: session.imageAnalysis,
    latitude,
    longitude,
    phoneNumber: session.phoneNumber,
    userId: session.userId,
    isNewPlanting: session.isNewPlanting
  });
}

// Export STATES along with other functions
module.exports = {
  STATES,
  analyzeImage,
  saveToStrapi,
  initSession,
  sendSummary,
  handlePhotoUpload,
  removeKeyboard,
  findUserByChatId,
  findUserByPhone,
  updateUserChatId,
  sendCommandOptions,
  askForPlantName,
  handleLocation
}; 
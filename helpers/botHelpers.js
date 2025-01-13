const axios = require('axios');
const config = require('../config');
const FormData = require('form-data');

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
          phone_number: data.phoneNumber,
          user: data.userId
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
    location: null
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

  message += `Send /start to document another plant!`;

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
    return {
      fileId: uploadedFile.id,
      fileUrl: uploadedFile.url
    };

  } catch (error) {
    console.error('Detailed upload error:', error);
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
    const response = await axios.get(
      `${config.STRAPI_CONFIG.apiUrl}/api/users`,
      {
        params: {
          filters: {
            chatId: {
              $eq: chatId
            }
          }
        },
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
        }
      }
    );
    
    console.log('Strapi user response:', response.data); // Debug log
    
    // Check if we have data and it has the expected structure
    if (response.data && Array.isArray(response.data)) {
      return response.data[0] || null;
    }
    
    return null;
  } catch (error) {
    console.error('Error finding user:', error.response?.data || error.message);
    return null;
  }
}

async function findUserByPhone(phoneNumber) {
  try {
    // Ensure phone number starts with '+'
    const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    
    const response = await axios.get(
      `${config.STRAPI_CONFIG.apiUrl}/api/users`,
      {
        params: {
          filters: {
            phoneNumber: {
              $eq: formattedPhone
            }
          }
        },
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
        }
      }
    );
    
    console.log('Strapi phone lookup response:', response.data);
    
    if (response.data && Array.isArray(response.data)) {
      return response.data[0] || null;
    }
    
    return null;
  } catch (error) {
    console.error('Error finding user by phone:', error.response?.data || error.message);
    return null;
  }
}

async function updateUserChatId(userId, chatId) {
  try {
    const response = await axios.put(
      `${config.STRAPI_CONFIG.apiUrl}/api/users/${userId}`,
      {
        chatId: chatId.toString() // Ensure chatId is stored as string
      },
      {
        headers: {
          'Authorization': `Bearer ${config.STRAPI_CONFIG.apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Updated user chatId:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error updating user chatId:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = {
  analyzeImage,
  saveToStrapi,
  initSession,
  sendSummary,
  handlePhotoUpload,
  removeKeyboard,
  findUserByChatId,
  findUserByPhone,
  updateUserChatId
}; 
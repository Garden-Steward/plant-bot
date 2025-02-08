const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');

async function handlePhotoUpload(msg, session, bot, config) {
  const photo = msg.photo[msg.photo.length - 1];
  const file = await bot.getFile(photo.file_id);
  const imageUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  let plantName = session.plantName || 'unknown plant';
  
  const timestamp = Date.now();
  const sanitizedPlantName = plantName
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
          ...formData.getHeaders(),
          authorization: `Bearer ${config.STRAPI_CONFIG.apiToken}`
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

async function processImage(msg, session, bot, config) {
  const { fileId, fileUrl } = await handlePhotoUpload(msg, session, bot, config);
  const analysis = await analyzeImage(session, fileUrl);

  if (analysis.plantDetails?.close_up && session.isPlant) {
    session.closeImageId = fileId;
    session.imageAnalysis = analysis.description;
    await bot.sendMessage(msg.chat.id, 'Close-up image received and processed.' + 
      (!session.locationImageId ? ' Send us a distance shot next so we can understand the location of the plant better!' : ''));
  } else if (analysis.plantDetails?.distance_shot && session.isPlant) {
    if (session.locationImageId) {
      session.pendingLocationImageId = fileId;
      await bot.sendMessage(msg.chat.id, 'You already have a distance shot uploaded. Would you like to replace it with this new image? Reply with "/replace" or "/keep".');
    } else {
      session.locationImageId = fileId;
      await bot.sendMessage(msg.chat.id, 'Location image received and processed.' + 
        (!session.closeImageId ? ' Send us a close-up image next!' : ''));
    }
  } else {
    await bot.sendMessage(msg.chat.id, 'The image does not qualify as a close-up or distance shot. Please try again.');
  }
}

// Image handling and analysis
async function analyzeImage(session, imageUrl) {
  try {
    console.log('Starting image analysis for:', imageUrl);
    
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageData = Buffer.from(imageResponse.data);
    
    try {
      const model = config.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      
      const imagePart = {
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: 'image/jpeg'
        }
      };

      const prompt = `Analyze this image and respond in the following JSON format:
{
  "isPlant": boolean,
  "description": "2-3 sentences describing what you see",
  "plantDetails": {
    "distance_shot": "boolean, true if the image is a distance shot where we can see the plant from a distance"
    "close_up": "boolean, true if the image is a close-up where we can see details of the plant",
    "type": "string describing the type of plant (only if close up is true)",
    "type_confidence": "high" | "medium" | "low" | "unknown" (only if close up is true),
    "health": "description of plant health (only if close up is true)",
    "notable_features": "key visual features (only if close up is true)",

  }
}

If the image is not of a plant, set isPlant to false and only fill the description field.
Keep all descriptions concise and focused on visual elements.`;

      const result = await model.generateContent([imagePart, prompt]);
      const response = await result.response;
      const analysisText = response.text();
      
      const cleanedText = analysisText.replace(/```json\n?|\n?```/g, '').trim();
      const analysis = JSON.parse(cleanedText);
      
      session.isPlant = analysis.isPlant;
      session.confidence = analysis.plantDetails.type_confidence;
      
      if (!analysis.isPlant) {
        session.imageAnalysis = analysis.description;
        return false;
      }
      
      session.imageAnalysis = `${analysis.description}\n\n` +
        `Type: ${analysis.plantDetails.type}\n` +
        `Health: ${analysis.plantDetails.health}\n` +
        `Notable Features: ${analysis.plantDetails.notable_features}\n` +
        `Close up: ${analysis.plantDetails.close_up}\n` +
        `Distance shot: ${analysis.plantDetails.distance_shot}`;
      
      return analysis;

    } catch (aiError) {
      console.error('AI Analysis failed:', aiError);
      
      // Check specifically for API blocked error
      if (aiError.message && aiError.message.includes('API_KEY_SERVICE_BLOCKED')) {
        console.log('Gemini API access is blocked - continuing without analysis');
        session.isPlant = true;
        session.confidence = 'unverified';
        session.imageAnalysis = 'AI analysis currently unavailable - image saved';
      } else {
        // Handle other AI-related errors
        session.isPlant = true;
        session.confidence = 'unknown';
        session.imageAnalysis = 'Image analysis failed - please try again later';
      }
      
      return true;
    }
    
  } catch (error) {
    console.error('Image processing error:', error);
    
    session.isPlant = true;
    session.confidence = 'unknown';
    session.imageAnalysis = 'Image processing failed';
    
    return true;
  }
}

module.exports = {
  handlePhotoUpload,
  processImage
};

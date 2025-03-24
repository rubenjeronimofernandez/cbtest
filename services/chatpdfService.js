const axios = require('axios');
const fs = require('fs');
const logger = require('../utils/logger');

const CHATPDF_API_KEY = process.env.CHATPDF_API_KEY;
const CHATPDF_API_URL = 'https://api.chatpdf.com/v1';

async function uploadPDF(filePath) {
    try {
        const fileBuffer = fs.readFileSync(filePath);
        const response = await axios.post(
            `${CHATPDF_API_URL}/sources/add-file`,
            fileBuffer,
            {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'x-api-key': CHATPDF_API_KEY,
                },
            }
        );
        return response.data.sourceId; // ID del PDF subido
    } catch (error) {
        logger.error(`Error uploading PDF to ChatPDF: ${error.message}`);
        return null;
    }
}

async function askChatPDF(sourceId, question) {
    try {
        const response = await axios.post(
            `${CHATPDF_API_URL}/chats/message`,
            {
                sourceId: sourceId,
                messages: [
                    {
                        role: 'user',
                        content: question,
                    },
                ],
            },
            {
                headers: {
                    'x-api-key': CHATPDF_API_KEY,
                },
            }
        );
        return response.data.content; // Respuesta de ChatPDF
    } catch (error) {
        logger.error(`Error asking ChatPDF: ${error.message}`);
        return 'Lo siento, hubo un error al procesar tu pregunta.';
    }
}

module.exports = { uploadPDF, askChatPDF };
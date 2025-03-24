const { addKeyword } = require('@bot-whatsapp/bot');
const { askChatPDF, uploadPDF } = require('../services/chatpdfService');
const logger = require('../utils/logger');

const chatpdfHandler = addKeyword(['pdf', 'chatpdf'])
    .addAnswer('¡Claro! Puedo ayudarte a buscar información en un PDF. ¿Qué quieres saber?', { capture: true }, async (ctx, { flowDynamic }) => {
        const question = ctx.body;
        const pdfPath = './pdfs/documento.pdf'; // Ruta al PDF que deseas usar

        try {
            // Subir el PDF a ChatPDF (si no está subido)
            const sourceId = await uploadPDF(pdfPath);
            if (!sourceId) {
                return await flowDynamic('❌ No se pudo cargar el PDF. Por favor, intenta de nuevo.');
            }

            // Preguntar a ChatPDF
            const response = await askChatPDF(sourceId, question);
            return await flowDynamic(response);
        } catch (error) {
            logger.error(`Error in chatpdfHandler: ${error.message}`);
            return await flowDynamic('❌ Ocurrió un error al procesar tu pregunta. Por favor, intenta de nuevo.');
        }
    });

module.exports = chatpdfHandler;
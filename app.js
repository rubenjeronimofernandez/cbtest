require('dotenv').config();
const { createBot, createProvider, createFlow, addKeyword, addAnswer, addAction } = require('@bot-whatsapp/bot');
const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MySQLAdapter = require('@bot-whatsapp/database/mysql');
const axios = require('axios');
const LocalStorage = require('node-localstorage').LocalStorage;
const { v4: uuidv4 } = require('uuid'); // Importa la biblioteca UUID
const express = require('express');
const app = express();
//const chatpdfHandler = require('./handlers/chatpdfHandler'); // Importa el nuevo flujo
const { uploadPDF, askChatPDF } = require('../src/services/chatpdfService');
app.use(express.json()); // Necesario para parsear el body de las peticiones POST.
const { jidDecode } = require('@whiskeysockets/baileys');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

// Initialize localStorage
const localStorage = new LocalStorage('./scratch');

const MYSQL_DB_HOST = process.env.MYSQL_DB_HOST;
const MYSQL_DB_USER = process.env.MYSQL_DB_USER;
const MYSQL_DB_PASSWORD = process.env.MYSQL_DB_PASSWORD;
const MYSQL_DB_NAME = process.env.MYSQL_DB_NAME;
const MYSQL_DB_PORT = process.env.MYSQL_DB_PORT;
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK;
const BOT_URL = process.env.BOT_URL;
const API_URL=process.env.API_URL;

// Horario laboral
const horaEntrada1=9;
const horaSalida1=14;
const horaEntrada2=16;
const horaSalida2=20;

// Function to format date and time (YYYY-MM-DD HH:MM)
function formatearFechaHora(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}:00+01:00`;
}

function encontrarProximaHoraDisponible(fechaHoraSolicitada, citasOcupadas) {
    if (!citasOcupadas || citasOcupadas.length === 0) {
        return null;
    }

    const ahora = new Date(fechaHoraSolicitada);
    ahora.setMinutes(0, 0, 0);
    if (fechaHoraSolicitada.getMinutes() > 0) {
        ahora.setHours(ahora.getHours() + 1);
    }

    const citas = citasOcupadas.map(cita => {
        const [fechaStr, horaStr] = cita.split(' ');
        if (!horaStr) {
            console.error(`Error: horaStr es undefined en cita: ${cita}`);
            return null;
        }
        const [horas, minutos] = horaStr.split(':').map(Number);

        const [diaStr, mesStr, añoStr] = fechaStr.split('-');
        const dia = parseInt(diaStr, 10);
        const mes = parseInt(mesStr, 10);
        const año = parseInt(añoStr, 10);

        return new Date(año, mes - 1, dia, horas, minutos);
    });

    citas.sort((a, b) => a - b);

    for (let i = 0; i < 24; i++) {
        const proximaHora = new Date(ahora);
        proximaHora.setHours(ahora.getHours() + i, 0, 0, 0);

        if (!isWorkingHour(proximaHora)) {
            continue;
        }

        let ocupada = false;
        for (const cita of citas) {
            const finCita = new Date(cita);
            finCita.setHours(cita.getHours() + 1);

            if (proximaHora >= cita && proximaHora < finCita) {
                ocupada = true;
                break;
            }
        }

        if (!ocupada) {
            return `${String(proximaHora.getDate()).padStart(2, '0')}-${String(proximaHora.getMonth() + 1).padStart(2, '0')}-${proximaHora.getFullYear()} ${String(proximaHora.getHours()).padStart(2, '0')}:${String(proximaHora.getMinutes()).padStart(2, '0')}`;
        }
    }

    return null;
}

function isWorkingHour(date) {
    const day = date.getDay();
    const hour = date.getHours();

    if (day === 0 || day === 6) {
        return false;
    }

    return (hour >= horaEntrada1 && hour < horaSalida1) || (hour >= horaEntrada2 && hour < horaSalida2);
}

function parsearFechaDesdeTexto(fechaTexto) {
    const [dia, mes, añoHora] = fechaTexto.split('-');  
    const [año, horaMinuto] = añoHora.split(' ');  
    const [hora, minuto] = horaMinuto.split(':');  

    return new Date(año, mes - 1, dia, hora, minuto);  
}

// Flow definitions
const flowbienvenida = addKeyword(['hola', 'hi', 'buenos días', 'buenas tardes', 'buenas noches'])
    .addAnswer('Un momento por favor...', null, async (ctx, { flowDynamic, state, gotoFlow }) => {
        const telefono = ctx.from;
        const nombre = ctx.pushName || 'Cliente';
        const nombreSolo = ctx.pushName ? ctx.pushName.split(' ')[0] : 'Cliente';
        localStorage.setItem('telefono', telefono);
        localStorage.setItem('nombre', nombre);
        const now = new Date();
        const fecha = now.toLocaleDateString('es-ES');
        const hora = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        localStorage.setItem('fecha', fecha);
        localStorage.setItem('hora', hora);
        // Generate unique request ID
        const requestId = uuidv4();
        await state.update({ requestId });
        await flowDynamic(`👋 Hola ${nombreSolo}, ¿qué puedo hacer por ti?`, {keyword: 'saludo'});
    })
    .addAnswer(
        [
            '🎫 Puedes reservar *_citas_* si quieres que hablemos en persona.',
            'ℹ️ O te puedo contar más sobre Efficienta si envías *_info_*.',
            '📬 Si prefieres te paso los datos de *_contacto_* y nos llamas o nos escribes cuando quieras.',
            '🏆 Te puedo contar algunos *Casos* de éxito.',
            '💼 Y si te interesa el tipo de *Servicios* con el que te sientas mejor, solo escribelo y te lo cuento.',
            '📄 También me puedes preguntar lo que quieras. ¿En qué te puedo ayudar?'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic, gotoFlow }) => {
            const pregunta = ctx.body.trim();

            // Verifica si el mensaje coincide con alguna palabra clave de otros flujos
            const palabrasClave = [
                'citas', 'agendar', 'reservar', // Palabras clave para flowCitas
                'info', 'información', 'empresa', // Palabras clave para flowInfo
                'contacto', 'teléfono', 'email', // Palabras clave para flowContacto
                'servicios', 'automatización', 'digitalización', 'consultoría', 'crm', 'erp', // Palabras clave para flowServicios
                'casos', 'ejemplos', 'éxito', 'clientes', // Palabras clave para flowCasos
                'restaurante', 'reservar mesa' // Palabras clave para flowRestauranteReserva
            ];

            if (palabrasClave.some(palabra => pregunta.toLowerCase().includes(palabra))) {
                // Si coincide con alguna palabra clave, redirige al flujo correspondiente
                switch (true) {
                    case pregunta.toLowerCase().includes('citas'):
                    case pregunta.toLowerCase().includes('agendar'):
                    case pregunta.toLowerCase().includes('reservar'):
                        return gotoFlow(flowCitas);
                    case pregunta.toLowerCase().includes('info'):
                    case pregunta.toLowerCase().includes('información'):
                    case pregunta.toLowerCase().includes('empresa'):
                        return gotoFlow(flowInfo);
                    case pregunta.toLowerCase().includes('contacto'):
                    case pregunta.toLowerCase().includes('teléfono'):
                    case pregunta.toLowerCase().includes('email'):
                        return gotoFlow(flowContacto);
                    case pregunta.toLowerCase().includes('servicios'):
                    case pregunta.toLowerCase().includes('automatización'):
                    case pregunta.toLowerCase().includes('digitalización'):
                    case pregunta.toLowerCase().includes('consultoría'):
                    case pregunta.toLowerCase().includes('crm'):
                    case pregunta.toLowerCase().includes('erp'):
                        return gotoFlow(flowServicios);
                    case pregunta.toLowerCase().includes('casos'):
                    case pregunta.toLowerCase().includes('ejemplos'):
                    case pregunta.toLowerCase().includes('éxito'):
                    case pregunta.toLowerCase().includes('clientes'):
                        return gotoFlow(flowCasos);
                    case pregunta.toLowerCase().includes('restaurante'):
                    case pregunta.toLowerCase().includes('reservar mesa'):
                        return gotoFlow(flowRestauranteReserva);
                    default:
                        break;
                }
            }

            // Si no coincide con ninguna palabra clave, consulta el PDF
            const pdfPath = './pdfs/PDFefficienta.pdf'; // Ruta al PDF que deseas usar
            const sourceId = await uploadPDF(pdfPath); // Subir el PDF a ChatPDF

            if (!sourceId) {
                return await flowDynamic('❌ No se pudo cargar el PDF. Por favor, intenta de nuevo.');
            }

            // Preguntar a ChatPDF
            const response = await askChatPDF(sourceId, pregunta);
            return await flowDynamic(response);
        }
    );

const flowInfo = addKeyword(['info', 'información', 'empresa'])
    .addAnswer('🏢 Efficienta es una empresa especializada en transformación digital y automatización de procesos.')
    .addAnswer('🕒 Nuestro horario de atención es de lunes a viernes, de 9:00 a 14:00 y de 16:00 a 20:00.')
    .addAnswer('💼 Ofrecemos soluciones personalizadas para optimizar y digitalizar los procesos de tu negocio.')
    .addAnswer('📞 Para más información o para agendar una cita, escribe "citas".');

const flowContacto = addKeyword(['contacto', 'teléfono', 'email'])
    .addAnswer('📞 Teléfono: +34 624 613 877')
    .addAnswer('📧 Email: efficientasolucion@gmail.com')
    .addAnswer('🌐 Sitio web: www.efficienta.com')
    .addAnswer('🏠 Dirección: Calle Río Sequillo 13-103, 05004 Ávila, España');

const flowServicios = addKeyword(['servicios', 'automatización', 'digitalización', 'consultoría', 'crm', 'erp'])
    .addAnswer(
        [
            'Ofrecemos una amplia gama de servicios para la transformación digital de tu negocio. ¿Qué área te interesa más?',
            '1. Automatización de Procesos',
            '2. Implementación de CRM/ERP',
            '3. Consultoría de Transformación Digital',
            '4. Desarrollo de Software a Medida',
            'Escribe el número de la opción deseada.'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic }) => {
            const opcion = ctx.body.trim();
            switch (opcion) {
                case '1':
                    return await flowDynamic([
                        '**Automatización de Procesos:**',
                        'Optimizamos tus operaciones mediante la automatización de tareas repetitivas y procesos clave. Esto incluye:',
                        '- **RPA (Robotic Process Automation):** Implementación de robots de software para ejecutar tareas.',
                        '- **Automatización de flujos de trabajo:** Diseño e implementación de flujos de trabajo digitales para mejorar la eficiencia.',
                        '- **Integración de sistemas:** Conexión de sistemas existentes con nuevas funcionalidades.',
                        '**Beneficios:** Reducción de costos, aumento de la productividad, minimización de errores, y mejora en la toma de decisiones.',
                        '¿Te gustaría saber cómo podemos automatizar tus procesos específicos? Envía "analizar" para una consulta gratuita.'
                    ].join('\n'));
                case '2':
                    return await flowDynamic([
                        '**Implementación de CRM/ERP:**',
                        'Implementamos y personalizamos soluciones de CRM (Customer Relationship Management) y ERP (Enterprise Resource Planning) para gestionar eficientemente tu negocio.',
                        '- **CRM:** Mejora la gestión de las relaciones con tus clientes, desde la captación hasta la fidelización.',
                        '- **ERP:** Integra todos los procesos de tu empresa, como finanzas, recursos humanos, producción y logística.',
                        '**Beneficios:** Visión 360º de tu negocio, mejora en la gestión de clientes, optimización de recursos, y aumento de la rentabilidad.',
                        '¿Quieres saber qué CRM o ERP se adapta mejor a tu empresa? Envía "asesoramiento" para recibir una recomendación personalizada.'
                    ].join('\n'));
                case '3':
                    return await flowDynamic([
                        '**Consultoría de Transformación Digital:**',
                        'Te acompañamos en el proceso de transformación digital de tu empresa, desde la definición de la estrategia hasta la implementación de las soluciones.',
                        '- **Análisis de la situación actual:** Identificación de las áreas de mejora y las oportunidades de digitalización.',
                        '- **Diseño de la hoja de ruta digital:** Definición de los objetivos, las estrategias y las acciones a seguir.',
                        '- **Acompañamiento en la implementación:** Soporte y capacitación para asegurar el éxito de la transformación.',
                        '**Beneficios:** Mayor competitividad, adaptación a las nuevas tendencias del mercado, mejora en la experiencia del cliente, y optimización de los procesos internos.',
                        '¿Listo para comenzar tu transformación digital? Envía "diagnóstico" para un análisis inicial gratuito.'
                    ].join('\n'));
                case '4':
                    return await flowDynamic([
                        '**Desarrollo de Software a Medida:**',
                        'Creamos soluciones de software personalizadas para resolver tus necesidades específicas.',
                        '- **Aplicaciones web y móviles:** Desarrollo de aplicaciones intuitivas y funcionales para tus clientes y empleados.',
                        '- **Integraciones personalizadas:** Conexión de sistemas existentes con nuevas funcionalidades.',
                        '- **Automatización de tareas complejas:** Desarrollo de software para automatizar procesos que no pueden ser automatizados con herramientas estándar.',
                        '**Beneficios:** Soluciones adaptadas a tus necesidades, mayor eficiencia, innovación, y diferenciación de la competencia.',
                        '¿Tienes una idea para un software? Envía "proyecto" para contarnos tu idea y obtener una cotización.'
                    ].join('\n'));
                default:
                    return await flowDynamic('Opción no válida. Por favor, elige una opción del 1 al 4.');
            }
        }
    );

const flowCasos = addKeyword(['casos', 'ejemplos', 'éxito', 'clientes'])
    .addAnswer('Aquí tienes algunos ejemplos de nuestros casos de éxito más recientes:')
    .addAnswer(
        [
            '1. **La Tienda de la Esquina (Retail):** Automatización de inventario. Aumento de eficiencia en un 30%.',
            '2. **Transportes Logísticos del Sur (Logística):** Implementación de CRM. Mejora en la satisfacción del cliente en un 20%.',
            '3. **Clínica Dental Sonrisas Brillantes (Salud):** Digitalización de la gestión de citas. Reducción del absentismo en un 15%.',
            '¿Te interesa saber más sobre alguno de estos casos? Escribe el número correspondiente.'
        ].join('\n'),
        { capture: true },
        async (ctx, { flowDynamic }) => {
            const opcion = ctx.body.trim();
            switch (opcion) {
                case '1':
                    return await flowDynamic([
                        '**Caso de éxito: La Tienda de la Esquina**',
                        'La Tienda de la Esquina, una cadena de tiendas de conveniencia, se enfrentaba a problemas de gestión de inventario, lo que resultaba en pérdidas por productos caducados y falta de stock de productos populares.',
                        '**Solución:** Implementamos un sistema de automatización de inventario que utiliza sensores IoT y análisis de datos en tiempo real para predecir la demanda y optimizar los niveles de stock.',
                        '**Resultados:**',
                        '- Aumento de la eficiencia en la gestión de inventario en un 30%.',
                        '- Reducción de las pérdidas por productos caducados en un 20%.',
                        '- Mejora en la disponibilidad de productos populares en un 15%.',
                        '¿Te gustaría saber cómo podemos optimizar tu inventario? Escribe "inventario" para más información.'
                    ].join('\n'));
                case '2':
                    return await flowDynamic([
                        '**Caso de éxito: Transportes Logísticos del Sur**',
                        'Transportes Logísticos del Sur, una empresa de transporte de mercancías, tenía dificultades para gestionar las relaciones con sus clientes, lo que afectaba a la satisfacción y la fidelización.',
                        '**Solución:** Implementamos un sistema CRM personalizado que integra la información de todos los clientes en una única plataforma, permitiendo una gestión más eficiente de las interacciones y las necesidades.',
                        '**Resultados:**',
                        '- Mejora en la satisfacción del cliente en un 20%.',
                        '- Aumento de la fidelización de clientes en un 15%.',
                        '- Reducción del tiempo de respuesta a las consultas de los clientes en un 25%.',
                        '¿Te gustaría mejorar la gestión de tus clientes? Escribe "CRM" para una consulta gratuita.'
                    ].join('\n'));
                case '3':
                    return await flowDynamic([
                        '**Caso de éxito: Clínica Dental Sonrisas Brillantes**',
                        'La Clínica Dental Sonrisas Brillantes sufría un alto índice de absentismo de pacientes a las citas, lo que generaba pérdidas económicas y dificultaba la optimización de la agenda.',
                        '**Solución:** Digitalizamos la gestión de citas con un sistema de recordatorios automatizados por WhatsApp y email, y un portal online para que los pacientes puedan gestionar sus citas.',
                        '**Resultados:**',
                        '- Reducción del absentismo en un 15%.',
                        '- Aumento de la ocupación de la agenda en un 10%.',
                        '- Mejora en la satisfacción de los pacientes con el sistema de gestión de citas.',
                        '¿Te gustaría reducir el absentismo en tu clínica? Escribe "citas dental" para más información.'
                    ].join('\n'));
                default:
                    return await flowDynamic('Opción no válida. Por favor, elige 1, 2 o 3.');
            }
        }
    );
  
async function confirmarCita(ctx, flowDynamic, state) {
    try {
        // Leer la respuesta y los datos
        const respuesta = ctx.body.trim().toLowerCase();
        let telefono = state.get('telefono');
        let nombre = state.get('nombre');
        const requestId = state.get('requestId');
        const proximaHora = state.get('proximaHora');

        // Validar que los datos clave existen y recuperar si falta algo
        if (!telefono || !nombre) {
            console.warn("⚠️ Faltan datos en el estado. Intentando recuperar...");
            telefono = ctx.from || 'desconocido';
            nombre = ctx.pushName || 'Cliente';
            await state.update({ telefono, nombre });
        }


        // Validar que los datos clave existen
        if (!telefono || !nombre || !requestId || !proximaHora) {
            console.error("🚨 Faltan datos esenciales:", { telefono, nombre, requestId, proximaHora });
            return await flowDynamic('❌ Hay un problema interno con tus datos. Por favor, intenta de nuevo.');
        }

        // Procesar la respuesta del usuario
        if (respuesta === 'si' || respuesta === 'sí') {

            const fechaObjeto = parsearFechaDesdeTexto(proximaHora);
            const fechaFormateada = formatearFechaHora(new Date(fechaObjeto));

            try {
                const payload = {
                    nombre,
                    telefono,
                    fecha: fechaFormateada,
                    tipoSolicitud: "crearCita",
                    requestId
                };

                const respuestaMake = await axios.post(MAKE_WEBHOOK, payload);

                await flowDynamic('✅ ¡Perfecto! Tu cita ha sido confirmada.', { keyword: 'reservaRealizada' });

            } catch (error) {
                console.error("❌ Error al enviar a Make:", {
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                });
                return await flowDynamic('❌ Error al confirmar tu cita. Intenta de nuevo más tarde.');
            }

        } else if (respuesta === 'no') {
            return await flowDynamic('🛑 De acuerdo, cancelando la reserva. Escribe "citas" si quieres buscar otra hora.');
        } else {
            return await flowDynamic('No te he entendido. ¿Puedes repetir?');
        }

        // Limpiar estado al final
        await state.update({ proximaHora: null, esperandoConfirmacion: false });

    } catch (fatalError) {
        console.error("💥 Error inesperado:", fatalError);
        return await flowDynamic('❌ Ocurrió un error inesperado. Vuelve a intentarlo.');
    }
}

const flowCitas = addKeyword(['citas', 'agendar', 'reservar'])
  .addAnswer(
    '¡Perfecto! Para agendar tu cita, necesito algunos datos...',
    null,
    async (ctx, { flowDynamic, state, gotoFlow }) => {
      const telefono = ctx.from; // Obtén el teléfono directamente del contexto
      const nombre = ctx.pushName || 'Cliente'; // Obtén el nombre del usuario
      const now = new Date();
      const fechaHora = formatearFechaHora(now);
      const requestId = uuidv4();

      // Actualiza el estado con los datos necesarios
      await state.update({ telefono, nombre, requestId });

      let reservas = null;

      try {
        // 1. Crear entrada pendiente en el servidor
        await axios.post(`${API_URL}/create-pending-response`, {
          telefono,
          requestId,
        });
      } catch (error) {
        console.error(
          'Error al iniciar el flujo de citas:',
          error.response?.data || error.message
        );
        await flowDynamic(
          '❌ Ocurrió un error al procesar tu solicitud. Por favor, intenta de nuevo.'
        );
        return;
      }

      try {
        // 2. Enviar solicitud a Make para obtener las reservas
        const makeResponse = await axios.post(MAKE_WEBHOOK, {
          nombre,
          telefono,
          fechaHora,
          tipoSolicitud: 'leerAgenda',
          requestId,
          reservas: [], // Inicialmente, las reservas están vacías
        });

        // Si la respuesta de Make.com es exitosa, continuamos
        if (makeResponse.status === 200) {
          // 3. Obtener las reservas del servidor
          let intentos = 0;
          const maxIntentos = 5;
          const intervalo = 2000;

          while (intentos < maxIntentos && !reservas) {
            try {
              const response = await axios.get(
                `${API_URL}/check-reservas/${telefono}`,
                { params: { requestId } }
              );

              if (response.status === 200 && response.data.reservas) {
                reservas = response.data.reservas;
                await state.update({ reservas });
                break;
              }
            } catch (error) {
              console.error(
                `[${telefono}] - Error al obtener reservas (intento ${intentos + 1}):`,
                error.response?.data || error.message
              );
            }

            intentos++;
            await new Promise((resolve) => setTimeout(resolve, intervalo));
          }

          if (reservas) {
            await state.update({ flujoActual: 'opcionesReserva' });
            await gotoFlow(flujoOpcionesReserva);
            return; // Añadimos return para el linter
          } else {
            await flowDynamic('❌ No se pudieron obtener las reservas. Por favor, intenta de nuevo más tarde.');
            return;
          }
        } else {
          await flowDynamic('❌ Error al obtener las reservas desde Make.com. Por favor, intenta de nuevo.');
          return;
        }
      } catch (error) {
        console.error(
          'Error al enviar solicitud a Make:',
          error.response?.data || error.message
        );
        await flowDynamic(
          '❌ Ocurrió un error al procesar tu solicitud. Por favor, intenta de nuevo.'
        );
        return;
      }
    }
  );

const flujoOpcionesReserva = addKeyword(['flw_options'])
  .addAnswer([
    '¿Cómo prefieres reservar tu cita?',
    '1️⃣ Primera cita disponible',
    '2️⃣ Elegir fecha y hora',
  ].join('\n'), { capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
    // Verificar si las reservas están disponibles en el estado
    const reservas = state.get('reservas');
    if (!reservas) {
      await flowDynamic('❌ No se encontraron reservas disponibles. Por favor, inicia el proceso de nuevo.');
      return await gotoFlow(flowCitas); // Redirige al flujo inicial
    }

    const opcion = ctx.body.trim();
    const telefono = localStorage.getItem('telefono');

    if (opcion === '1') {
      await flowDynamic(`Estamos buscando la disponibilidad...`, { keyword: 'confirmandoDisponibilidad' });
      const reservasFormateadas = reservas
        .split(',')
        .map((reserva) => {
          try {
            const dateObj = new Date(reserva.trim());
            if (isNaN(dateObj.getTime())) {
              throw new Error(`Fecha inválida: ${reserva}`);
            }
            const dia = String(dateObj.getDate()).padStart(2, '0');
            const mes = String(dateObj.getMonth() + 1).padStart(2, '0');
            const año = dateObj.getFullYear();
            const horas = String(dateObj.getHours()).padStart(2, '0');
            const minutos = String(dateObj.getMinutes()).padStart(2, '0');
            return `${dia}-${mes}-${año} ${horas}:${minutos}`;
          } catch (error) {
            console.error(`Error al procesar la fecha: ${reserva}`, error);
            return null;
          }
        })
        .filter((reserva) => reserva !== null);

      const proximaHora = encontrarProximaHoraDisponible(
        new Date(),
        reservasFormateadas
      );

      if (proximaHora) {
        await state.update({ proximaHora, esperandoConfirmacion: true, opcion });
        await flowDynamic(` Primera cita disponible: ${proximaHora}. ¿Te gustaría confirmarla? Responde "sí" para confirmar o "no" para cancelar.`, { keyword: 'primeraCitaDisponible' });
        await state.update({ flujoActual: 'confirmacion' });
        return await gotoFlow(flujoConfirmacion);
      } else {
        await flowDynamic(
          '❌ No se encontró disponibilidad. Por favor, intenta de nuevo más tarde.'
        );
        await state.update({ proximaHora: null, esperandoConfirmacion: false, opcion: null });
      }
    } else if (opcion === '2') {
      await state.update({ opcion: '2', esperandoFecha: true, flujoActual: 'fechaPersonalizada' });
      return await gotoFlow(flujoFechaPersonalizada); // Redirige al flujo de fecha personalizada
    } else {
      await flowDynamic('❌ Opción inválida. Por favor, elige 1 o 2.');
    }
  });

const flujoFechaPersonalizada = addKeyword(['fl_date'])
  .addAnswer('Por favor, indica la fecha preferida (DD-MM-AAAA).', { capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
    const reservas = state.get('reservas'); // Obtener reservas del estado
    let fecha = ctx.body.trim();

    // Formateo automático de la fecha (acepta DD/MM/AA o D/M/AAAA, etc.)
    const fechaMatch = fecha.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (fechaMatch) {
      let [_, dia, mes, anio] = fechaMatch;
      dia = dia.padStart(2, '0');
      mes = mes.padStart(2, '0');
      anio = anio.length === 2 ? `20${anio}` : anio; // Si el año tiene solo 2 cifras, se asume 20XX
      fecha = `${dia}-${mes}-${anio}`;
    } else {
      await flowDynamic('❌ Formato de fecha inválido. Por favor, usa DD-MM-AAAA.');
      return;
    }

    // Convertir la fecha a objeto Date para usar isWorkingHour
    const [diaNum, mesNum, anioNum] = fecha.split('-').map(Number);
    const fechaDate = new Date(Date.UTC(anioNum, mesNum - 1, diaNum)); // Usar Date.UTC para evitar problemas de zona horaria

    // Obtener la fecha actual
    const hoy = new Date();
    const hoyUTC = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate())); // Fecha actual en UTC sin horas/minutos/segundos

    // Verificar si la fecha es anterior a hoy
    if (fechaDate < hoyUTC) {
      await flowDynamic('❌ La fecha ingresada es anterior a hoy. Por favor, elige una fecha válida.');
      return await gotoFlow(flujoFechaPersonalizada); // Vuelve a solicitar la fecha
    }

    // Verificar si la fecha es un día laborable
    if (!isWorkingDate(fechaDate)) {
      await flowDynamic('❌ Lo siento, esa fecha no es un día laborable. Por favor, elige otra.');
      return await gotoFlow(flujoFechaPersonalizada); // Vuelve a solicitar la fecha
    }

    // Convertir las reservas simuladas a formato DD-MM-AAAA HH:MM
    const reservasFormateadas = reservas
      .split(',')
      .map(reserva => convertirISOaFormatoLegible(reserva));

    // Filtrar reservas para la fecha seleccionada
    const reservasFecha = reservasFormateadas.filter(reserva => reserva.startsWith(fecha)); // Filtrar directamente el array

    if (reservasFecha.length === 0) {
      await state.update({ fecha, esperandoHora: true });
      return await gotoFlow(flujoHoraPersonalizada); // Redirige al flujo para manejar la hora
    } else {
      await flowDynamic('❌ Lo siento, esa fecha está completa. Por favor, elige otra.');
      return await gotoFlow(flujoFechaPersonalizada); // Vuelve a solicitar la fecha
    }
  });

// Función para verificar si la fecha es un día laborable
function isWorkingDate(date) {
    const day = date.getUTCDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    return day !== 0 && day !== 6; // Devuelve true si no es domingo ni sábado
}

const flujoHoraPersonalizada = addKeyword(['fl_hora'])
  .addAnswer('✅ Fecha disponible. ¿A qué hora te gustaría reservar? (HH:MM)', { capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
    const reservas = state.get('reservas'); // Obtener reservas del estado
    const fecha = state.get('fecha'); // Obtener la fecha del estado
    const hora = ctx.body.trim();

    // Convertir las reservas simuladas a formato DD-MM-AAAA HH:MM
    const reservasFormateadas = reservas
      .split(',')
      .map(reserva => convertirISOaFormatoLegible(reserva));

    if (!/^(\d{1,2}):(\d{2})$/.test(hora)) {
      await flowDynamic('❌ Formato de hora inválido. Por favor, usa HH:MM.');
      return await gotoFlow(flujoHoraPersonalizada); // Vuelve a solicitar la hora
    }

    const fechaHora = `${fecha} ${hora}`; // Formato DD-MM-AAAA HH:MM

    // Verificar si la hora está ocupada
    if (reservasFormateadas.includes(fechaHora)) {
      await flowDynamic('❌ Lo siento, esa hora no está disponible.');
      const horasDisponibles = obtenerHorasDisponibles(reservas, fecha);
      if (horasDisponibles.length > 0) {
        await flowDynamic(`Las horas disponibles son: ${horasDisponibles.join(', ')}`);
      }
      return await gotoFlow(flujoHoraPersonalizada); // Vuelve a solicitar la hora
    } else {
      await flowDynamic(`✅ La hora propuesta está disponible. ¿Quieres que la reservemos?`);
      await state.update({ 
        fechaHora, 
        esperandoConfirmacion: true,
        proximaHora: fechaHora // Actualizar proximaHora en el estado
      });
      return await gotoFlow(flujoConfirmacion); // Redirige al flujo de confirmación
    }
  });

function convertirISOaFormatoLegible(fechaISO) {
  // Parsear la fecha ISO
  const date = new Date(fechaISO);

  // Verificar si la fecha es válida
  if (isNaN(date.getTime())) {
    throw new Error(`Fecha ISO inválida: ${fechaISO}`);
  }

  // Extraer día, mes, año, horas y minutos
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const anio = date.getFullYear();
  const horas = String(date.getHours()).padStart(2, '0');
  const minutos = String(date.getMinutes()).padStart(2, '0');

  // Devolver la fecha en formato DD-MM-AAAA HH:MM
  return `${dia}-${mes}-${anio} ${horas}:${minutos}`;
}

// Función auxiliar para obtener horas disponibles
function obtenerHorasDisponibles(reservas, fecha) {
  const horasDisponibles = [];
  const [dia, mes, anio] = fecha.split('-');
  const fechaObj = new Date(anio, mes - 1, dia); // Convertir la fecha a objeto Date
  const ahora = new Date(); // Obtener la hora actual

  // Convertir las reservas simuladas a formato DD-MM-AAAA HH:MM
  const reservasFormateadas = reservas
    .split(',')
    .map(reserva => convertirISOaFormatoLegible(reserva));

  // Filtrar las reservas para la fecha seleccionada
  const reservasFecha = reservasFormateadas
    .filter(reserva => reserva.startsWith(fecha));

  // Convertir las reservas a horas en formato "HH:MM"
  const horasOcupadas = reservasFecha.map(reserva => {
    const [_, hora] = reserva.split(' ');
    return hora;
  });

  // Recorrer todas las horas del día y verificar disponibilidad
  for (let hora = 0; hora < 24; hora++) {
    const horaFormateada = `${String(hora).padStart(2, '0')}:00`; // Formato "HH:MM"

    // Verificar si la hora está dentro del horario laboral
    const fechaHora = new Date(fechaObj);
    fechaHora.setHours(hora, 0, 0, 0); // Establecer la hora a verificar

    // Verificar si la hora es futura (solo para el día actual)
    const esHoraFutura = fechaObj.getDate() === ahora.getDate() && 
                         fechaObj.getMonth() === ahora.getMonth() && 
                         fechaObj.getFullYear() === ahora.getFullYear() && 
                         fechaHora > ahora;

    // Si no es el día actual, considerar todas las horas válidas
    const esHoraValida = fechaObj.getDate() !== ahora.getDate() || esHoraFutura;

    if (isWorkingHour(fechaHora) && esHoraValida) {
      // Verificar si la hora no está ocupada
      if (!horasOcupadas.includes(horaFormateada)) {
        horasDisponibles.push(horaFormateada);
      }
    }
  }

  return horasDisponibles;
}

const flujoConfirmacion = addKeyword(['flw_confirm'])
  .addAction({ capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
    const respuesta = ctx.body.trim().toLowerCase();
    if (respuesta === 'si' || respuesta === 'sí') {
      try {
        await confirmarCita(ctx, flowDynamic, state);

        // 🔥 Forzamos una keyword temporal si no existe
        const tempKeyword = state.get('keyword') || `temp_key_${Date.now()}`;

        await state.update({
          flujoActual: 'flw_operations',
          keyword: tempKeyword
        });

        return await gotoFlow(flujoOtrasOperaciones);
      } catch (error) {
        console.error('Error en flujoConfirmacion:', error);
        await flowDynamic('❌ Ocurrió un error. Por favor, intenta de nuevo.');
      }
    } else {
      await flowDynamic('🛑 De acuerdo, cancelando la reserva. Si quieres buscar otra hora, escribe "citas".');
      await state.update({
        esperandoConfirmacion: false,
        proximaHora: null,
        flujoActual: null
      });
    }
  });

const flujoOtrasOperaciones = addKeyword(['flw_operations'])
  .addAnswer(
    'Gracias por reservar cita con nosotros. ¿Puedo hacer algo más por ti?',
    { capture: false },
    async (ctx, { state, gotoFlow }) => {
      

      return await gotoFlow(flowbienvenida); // Vuelve a la bienvenida
    }
  );

//FLUJOS PARA RESTAURANTE
// Función para verificar el horario del restaurante
const horarioRestaurante = (hora, fecha) => {
    const horaApertura1 = '12:00'; // Horario de apertura (turno 1)
    const horaCierre1 = '17:00';   // Horario de cierre (turno 1)
    const horaApertura2 = '19:00'; // Horario de apertura (turno 2)
    const horaCierre2 = '23:00';   // Horario de cierre (turno 2)

    // Verificar si la hora está dentro de los turnos
    const dentroTurno1 = hora >= horaApertura1 && hora <= horaCierre1;
    const dentroTurno2 = hora >= horaApertura2 && hora <= horaCierre2;

    // Verificar si el día es laborable (de lunes a domingo)
    const diaSemana = fecha.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const esDiaLaborable = diaSemana >= 1 && diaSemana <= 7; // El restaurante está abierto todos los días

    return (dentroTurno1 || dentroTurno2) && esDiaLaborable;
};

//Disponibilidad fecha restaurante
const comprobarDisponibilidadFecha = async (fechaFormateada, state) => {
    try {
        // Obtener datos del usuario
        const telefono = localStorage.getItem('telefono');
        const nombre = localStorage.getItem('nombre');
        const requestId = state.get('requestId');

        const response = await axios.post(MAKE_WEBHOOK, {
            nombre: nombre,
            telefono: telefono,
            fechaHora: fechaFormateada,
            tipoSolicitud: "consultarRestaurante",
            requestId: requestId,
            reservas: [], // Inicialmente, las reservas están vacías
        });
        return response.data.disponible; // Suponiendo que Make devuelve { disponible: true/false }
    } catch (error) {
        console.error('Error al comprobar disponibilidad de fecha:', error);
        return false;
    }
};

//Comprobar comensales
const comprobarComensales = async (fechaHoraFormateada, personas, state) => {
    try {
        // Obtener datos del usuario
        const telefono = localStorage.getItem('telefono');
        const nombre = localStorage.getItem('nombre');
        const requestId = state.get('requestId');

        const response = await axios.post(MAKE_WEBHOOK, {
            nombre: nombre,
            telefono: telefono,
            fechaHora: fechaHoraFormateada,
            tipoSolicitud: "consultarRestaurante",
            requestId: requestId,
            reservas: [], // Inicialmente, las reservas están vacías
            numeroPersonas: personas,
        });
        return response.data.disponible; // Suponiendo que Make devuelve { disponible: true/false }
    } catch (error) {
        console.error('Error al comprobar disponibilidad de comensales:', error);
        return false;
    }
};

function convertirFechaADate(fechaTexto) {
    // Expresión regular para capturar diferentes formatos de fecha
    const fechaMatch = fechaTexto.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    
    if (!fechaMatch) {
        throw new Error('Formato de fecha inválido. Por favor, usa DD/MM/YYYY o D/M/YY.');
    }

    let [_, dia, mes, anio] = fechaMatch;

    // Asegurar que el año tenga 4 dígitos
    if (anio.length === 2) {
        anio = `20${anio}`; // Asumimos que los años de dos dígitos son del siglo XXI
    }

    // Convertir a números
    dia = parseInt(dia, 10);
    mes = parseInt(mes, 10) - 1; // Los meses en JavaScript van de 0 a 11
    anio = parseInt(anio, 10);

    // Crear el objeto Date
    return new Date(anio, mes, dia);
}

// Flujo principal para reservar mesa en el restaurante
const flowRestauranteReserva = addKeyword(['restaurante', 'reservar mesa'])
    .addAnswer('¡Excelente! Vamos a reservar tu mesa. ¿Para qué fecha deseas reservar?')
    .addAnswer(
        'Por favor, introduce la fecha en formato DD/MM/YYYY:',
        { capture: true },
        async (ctx, { flowDynamic, state, gotoFlow }) => {
            const fechaDeseada = ctx.body.trim();

            try {
                // Convertir la fecha a un objeto Date usando la función mejorada
                const fechaObj = convertirFechaADate(fechaDeseada);

                // Formatear la fecha para Make
                const fechaFormateada = formatearFechaHora(fechaObj);

                // Guardar la fecha formateada en el estado
                await state.update({ fechaDeseada: fechaFormateada });

                // Verificar disponibilidad de la fecha
                const disponible = await comprobarDisponibilidadFecha(fechaFormateada, state);
                if (!disponible) {
                    return await flowDynamic('Lo siento, no hay disponibilidad para esa fecha. Por favor, elige otra fecha.');
                }

                // Ir al flujo de comensales
                return gotoFlow(flowComensales);
            } catch (error) {
                // Manejar errores de formato de fecha
                return await flowDynamic(error.message);
            }
        }
    );

const flowComensalesRestaurante = addKeyword(['flw_rest_com'])
    .addAnswer('¿Para cuántas personas?', { capture: true }, async (ctx, { flowDynamic, state, gotoFlow }) => {
        const numeroPersonas = ctx.body.trim();
        await state.update({ numeroPersonas });

        // Ir al flujo de hora
        return gotoFlow(flowHora);
    });

const flowHoraRestaurante = addKeyword(['flw_hora_rest'])
    .addAnswer('¿A qué hora le gustaría reservar? (HH:MM)', { capture: true }, async (ctx, { flowDynamic, state }) => {
        const horaDeseada = ctx.body.trim();

        // Obtener la fecha formateada del estado
        const fechaFormateada = state.get('fechaDeseada');
        const numeroPersonas = state.get('numeroPersonas');

        // Combinar fecha y hora en un objeto Date
        const [año, mes, dia] = fechaFormateada.split('T')[0].split('-');
        const [horas, minutos] = horaDeseada.split(':');
        const fechaHora = new Date(año, mes - 1, dia, horas, minutos);

        // Formatear la fecha y hora
        const fechaHoraFormateada = formatearFechaHora(fechaHora);

        // Verificar si la hora está dentro del horario laboral
        if (!horarioRestaurante(horaDeseada, fechaHora)) {
            return await flowDynamic('Lo siento, el restaurante no está abierto a esa hora. Por favor, elige otra hora.');
        }

        // Verificar disponibilidad de comensales
        const disponible = await comprobarComensales(fechaHoraFormateada, numeroPersonas, state);
        if (!disponible) {
            return await flowDynamic('Lo siento, no hay disponibilidad para esa hora. Por favor, elige otra hora.');
        }

        // Obtener datos del usuario
        const telefono = localStorage.getItem('telefono');
        const nombre = localStorage.getItem('nombre');
        const requestId = state.get('requestId');

        // Enviar solicitud de reserva a Make
        try {
            await axios.post(MAKE_WEBHOOK, {
                nombre: nombre,
                telefono: telefono,
                fechaHora: fechaHoraFormateada, // Usar la fecha y hora formateadas
                tipoSolicitud: "reservarRestaurante",
                requestId: requestId,
                reservas: [], // Inicialmente, las reservas están vacías
            });
            return await flowDynamic(`¡Perfecto! Estamos reservando una mesa para ${numeroPersonas} personas el ${fechaDeseada} a las ${horaDeseada}. Te confirmaremos en breve.`);
        } catch (error) {
            return await flowDynamic('⚠ Hubo un error al reservar la mesa. Por favor, intenta de nuevo más tarde.');
        }
    });

//endpoints
const port1 = 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const pendingResponses = {};

function formatearFechaHora(fecha) {
    const day = String(fecha.getDate()).padStart(2, '0');
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const año = fecha.getFullYear();
    const horas = String(fecha.getHours()).padStart(2, '0');
    const minutos = String(fecha.getMinutes()).padStart(2, '0');
    return `${año}-${mes}-${day} ${horas}:${minutos}`;
}

function encontrarProximaHoraDisponible(fechaHoraSolicitada, citasOcupadas) {
    if (!citasOcupadas || citasOcupadas.length === 0) {
        return null;
    }

    const ahora = new Date(fechaHoraSolicitada);
    ahora.setMinutes(0, 0, 0);
    if (fechaHoraSolicitada.getMinutes() > 0) {
        ahora.setHours(ahora.getHours() + 1);
    }

    const citas = citasOcupadas.map(cita => {
        const [fechaStr, horaStr] = cita.split(' ');
        if (!horaStr) {
            console.error(`Error: horaStr es undefined en cita: ${cita}`);
            return null;
        }
        const [horas, minutos] = horaStr.split(':').map(Number);

        const [diaStr, mesStr, añoStr] = fechaStr.split('-');
        const dia = parseInt(diaStr, 10);
        const mes = parseInt(mesStr, 10);
        const año = parseInt(añoStr, 10);
        return new Date(año, mes - 1, dia, horas, minutos);
    });

    citas.sort((a, b) => a - b);

    for (let i = 0; i < 24; i++) {
        const proximaHora = new Date(ahora);
        proximaHora.setHours(ahora.getHours() + i, 0, 0, 0);

        if (!isWorkingHour(proximaHora)) {
            continue;
        }

        let ocupada = false;
        for (const cita of citas) {
            const finCita = new Date(cita);
            finCita.setHours(cita.getHours() + 1);

            if (proximaHora >= cita && proximaHora < finCita) {
                ocupada = true;
                break;
            }
        }

        if (!ocupada) {
            return `${String(proximaHora.getDate()).padStart(2, '0')}-${String(proximaHora.getMonth() + 1).padStart(2, '0')}-${proximaHora.getFullYear()} ${String(proximaHora.getHours()).padStart(2, '0')}:${String(proximaHora.getMinutes()).padStart(2, '0')}`;
        }
    }

    return null;
}

function isWorkingHour(date) {
    const day = date.getDay();
    const hour = date.getHours();

    if (day === 0 || day === 6) {
        return false;
    }

    return (hour >= 9 && hour < 14) || (hour >= 16 && hour < 20);
}

// Endpoint to handle Make webhook
app.post('/make-webhook', async (req, res) => {
    try {
        if (!req.body.nombre || !req.body.telefono || !req.body.fecha || !req.body.hora || !req.body.tipoSolicitud || !req.body.requestId) {
            console.warn('Datos incompletos en /make-webhook:', req.body);
            return res.status(400).json({ error: 'Datos incompletos' });
        }
        const makeData = req.body;
        await axios.post(process.env.MAKE_WEBHOOK, makeData);

        pendingResponses[req.body.telefono] = {
            status: 'pending',
            timestamp: Date.now(),
            requestId: req.body.requestId
        };
        res.status(202).json({ message: 'Solicitud recibida, esperando respuesta de Make' });
    } catch (error) {
        console.error('Error en /make-webhook:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Error al procesar la solicitud en Make' });
    }
});

// Endpoint to handle responses from Make
app.post('/make-webhook/citas', (req, res) => {
    const { reservas, telefono, requestId } = req.body;

    // Verifica si los campos requeridos están presentes
    if (!reservas || !telefono || !requestId) {
        console.warn('Datos incompletos en /make-webhook/citas:', req.body);
        return res.status(400).json({ error: 'Los campos "reservas", "telefono" y "requestId" son requeridos' });
    }

    // Verifica si hay una solicitud pendiente para este teléfono y requestId
    if (!pendingResponses[telefono] || pendingResponses[telefono].requestId !== requestId) {
        console.warn(`[${telefono}] - No hay solicitud pendiente o requestId no coincide.`);
        return res.status(400).json({ error: "No hay solicitud pendiente para este usuario o requestId no coincide" });
    }

    // Actualiza las reservas en pendingResponses
    pendingResponses[telefono].reservas = reservas;

    res.status(200).json({ message: 'Reservas recibidas y actualizadas correctamente' });
});

// Endpoint to check availability
app.get('/check-reservas/:telefono', (req, res) => {
    const { telefono } = req.params;
    const { requestId } = req.query;


    // Verifica si hay una solicitud pendiente para este teléfono y requestId
    if (!pendingResponses[telefono] || pendingResponses[telefono].requestId !== requestId) {
        console.warn(`[${telefono}] - No hay solicitud pendiente o requestId no coincide.`);
        return res.status(404).json({ error: 'No se encontró solicitud para este número o requestId no coincide' });
    }

    // Devuelve las reservas si están disponibles
    if (pendingResponses[telefono].reservas) {
        const responseData = {
            reservas: pendingResponses[telefono].reservas,
            telefono: telefono,
            requestId: requestId
        };
        return res.status(200).json(responseData);
    }

    // Si no hay reservas, devuelve un error
    return res.status(404).json({ error: 'No hay reservas disponibles' });
});

// Endpoint para manejar las reservas del restaurante desde Make
app.post('/make-webhook/restaurante-reservas', (req, res) => {
    const { reservas, telefono, requestId } = req.body;

    // Verifica si los campos requeridos están presentes
    if (!reservas || !telefono || !requestId) {
        console.warn('Datos incompletos en /make-webhook/restaurante:', req.body);
        return res.status(400).json({ error: 'Los campos "reservas", "telefono" y "requestId" son requeridos' });
    }

    // Verifica si hay una solicitud pendiente para este teléfono y requestId
    if (!pendingResponses[telefono] || pendingResponses[telefono].requestId !== requestId) {
        console.warn(`[${telefono}] - No hay solicitud pendiente o requestId no coincide.`);
        return res.status(400).json({ error: "No hay solicitud pendiente para este usuario o requestId no coincide" });
    }

    // Actualiza las reservas en pendingResponses
    pendingResponses[telefono].reservas = reservas;

    // Envía las reservas al bot (aquí puedes agregar la lógica para enviar al bot)
    enviarReservasAlBot(telefono, reservas);

    res.status(200).json({ message: 'Reservas de restaurante recibidas y actualizadas correctamente' });
});

// Endpoint to create a pending response
app.post('/create-pending-response', (req, res) => {
    const { telefono, requestId } = req.body;
    pendingResponses[telefono] = { requestId, reservas: null };
    res.status(200).send('OK');
});

// Endpoint para recibir datos del script de Google Apps Script
    app.post('/coche-enviar-mensaje', async (req, res) => {
        let { telefono, mensaje } = req.body;
        console.log('enviando mensaje: ',mensaje);

        // Verifica que telefono y mensaje estén definidos
        if (!telefono || !mensaje) {
            console.warn('Datos incompletos en /coche-enviar-mensaje:', req.body);
            return res.status(400).json({ error: 'Los campos "telefono" y "mensaje" son requeridos' });
        }

        try {
            // Convierte telefono a cadena de texto
            telefono = String(telefono);

            // Limpia el número de teléfono (elimina caracteres no deseados)
            telefono = telefono.replace(/\D/g, "");

            // Formatea el número de teléfono (agrega el código de país si no lo tiene)
            if (!telefono.startsWith("+34")) {
                telefono = "34" + telefono;
            }
            console.log('telefono: ',telefono);
            // Valida la longitud del número de teléfono
            if (telefono.length !== 11) {
                console.error('El número de teléfono no tiene la longitud correcta:', telefono);
                return res.status(400).json({ error: 'El número de teléfono debe tener 9 dígitos (sin incluir el prefijo +34)' });
            }

            // Genera el JID a partir del número de teléfono
            const jid = `${telefono}@s.whatsapp.net`;
            console.log('jid: ',jid);

            // Envía el mensaje usando el provider de WhatsApp
            await adapterProvider.sendText(jid, mensaje);

            res.status(200).json({ message: 'Mensaje enviado correctamente' });
        } catch (error) {
            console.error('Error al enviar el mensaje:', error);
            res.status(500).json({ error: 'Error al enviar el mensaje' });
        }
    });

app.listen(port1, () => {
    console.log(`Servidor server.js webhook escuchando en el puerto ${port1}`);
});

const main = async () => {
    console.log('🚀 Intentando conectar a la base de datos...');

    try {
        const adapterDB = new MySQLAdapter({
            host: process.env.MYSQL_DB_HOST,
            port: process.env.MYSQL_DB_PORT,
            user: process.env.MYSQL_DB_USER,
            password: process.env.MYSQL_DB_PASSWORD,
            database: process.env.MYSQL_DB_NAME,
        });

        console.log('✅ Conexión a la base de datos establecida correctamente.');

        const adapterFlow = createFlow([
            flowbienvenida,
            flowInfo,
            flowContacto,
            flowServicios,
            flowCasos,
            flowCitas,
            flowRestauranteReserva,
            flowComensalesRestaurante,
            flowHoraRestaurante,
            flujoOpcionesReserva,
            flujoConfirmacion,
            flujoOtrasOperaciones,
            flujoFechaPersonalizada,
            flujoHoraPersonalizada,
        ]);

        const adapterProvider = createProvider(BaileysProvider);
        adapterProvider.on('ready', () => console.log('✅ Bot conectado a WhatsApp'));
        adapterProvider.on('connection.update', (update) => console.log('🔄 Estado de la conexión:', update));
        adapterProvider.on('close', (error) => console.error('🚨 Conexión cerrada:', error));

        createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        console.log('🚀 Bot inicializado correctamente');
        
        // Iniciar el servidor Express
        app.listen(PORT, () => {
            console.log(`Servidor escuchando en puerto ${PORT}`);
        });

        QRPortalWeb(); // Opcional: interfaz web para escanear QR
    } catch (error) {
        console.error('❌ Error conectando a la base de datos:', error.message);
    }
};

main();
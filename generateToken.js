require('dotenv').config(); // Cargar las variables de entorno
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

// Scopes para acceder al calendario
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Rutas desde .env
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH;
const TOKEN_PATH = process.env.TOKEN_PATH;

// Función para autorizar al usuario
async function authorize(credentials) {
    const { client_secret, client_id, redirect_uris } = credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    try {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
        return oAuth2Client;
    } catch (err) {
        return getAccessToken(oAuth2Client);
    }
}

// Función para obtener el token de acceso
async function getAccessToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
    console.log('Autoriza esta app visitando esta URL:', authUrl);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    rl.question('Introduce el código de autorización desde esa página: ', (code) => {
        rl.close();
        oAuth2Client.getToken(code, (err, token) => {
            if (err) return console.error('Error al recuperar el token de acceso', err);
            oAuth2Client.setCredentials(token);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
            console.log('Token almacenado en', TOKEN_PATH);
        });
    });
    return oAuth2Client;
}

// Función principal
async function main() {
    try {
        const content = fs.readFileSync(CREDENTIALS_PATH);
        const credentials = JSON.parse(content);
        const auth = await authorize(credentials);
    } catch (err) {
        console.log('Error al cargar el archivo de credenciales:', err);
    }
}

main();
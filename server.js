import express from 'express';
import fetch from 'node-fetch';
import 'dotenv/config';

// --- Инициализация ---
const app = express();
app.use(express.json());
app.use(express.static('.'));

console.log('Чтение POE_TOKEN из окружения...');
const poeToken = process.env.POE_TOKEN;

if (!poeToken) {
    console.error('POE_TOKEN не установлен в файле .env.');
    process.exit(1);
}

console.log('Сервер инициализирован.');

// --- Вспомогательная функция для генерации аудио ---
async function generateAudio(text) {
    console.log(`Получен текст для генерации: "${text}"`);
    console.log('Шаг 1: Отправка запроса к Poe API для получения URL...');

    const apiResponse = await fetch('https://api.poe.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${poeToken}`
        },
        body: JSON.stringify({
            model: 'ElevenLabs-v3',
            messages: [{ role: 'user', content: text }],
            stream: true
        })
    });

    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        console.error(`Ошибка от Poe API: ${apiResponse.status} ${apiResponse.statusText}`, errorBody);
        throw new Error(`Poe API Error: ${errorBody}`);
    }

    // Собираем URL из потока с таймаутом (60 секунд)
    const audioUrl = await Promise.race([
        new Promise((resolve, reject) => {
            let fullContentUrl = '';
            let responseText = '';

            apiResponse.body.on('data', (chunk) => {
                responseText += chunk.toString('utf-8');
                const events = responseText.split('\n\n');
                responseText = events.pop() || '';

                for (const line of events) {
                    if (line.startsWith('data: ')) {
                        const dataJson = line.substring(6);
                        if (dataJson.trim() === '[DONE]') {
                            resolve(fullContentUrl);
                            return;
                        }
                        
                        try {
                            const data = JSON.parse(dataJson);
                            // Ищем фрагмент контента в ответе
                            const contentPart = data.choices?.[0]?.delta?.content;
                            if (contentPart) {
                                fullContentUrl += contentPart;
                            }
                        } catch (e) {
                            console.log('Не удалось распарсить JSON из строки:', dataJson);
                        }
                    }
                }
            });

            apiResponse.body.on('end', () => {
                console.log('Поток от Poe API завершен.');
                resolve(fullContentUrl);
            });

            apiResponse.body.on('error', (err) => {
                console.error('Ошибка в потоке ответа:', err);
                reject(err);
            });
        }),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout: Poe API не ответил в течение 60 секунд')), 60000)
        )
    ]);

    if (!audioUrl || !audioUrl.startsWith('http')) {
        console.error('Не удалось получить валидный URL на аудиофайл от Poe API. Получено:', audioUrl);
        throw new Error('API response did not contain a valid audio URL.');
    }

    console.log('Шаг 1 завершен. Получен URL аудиофайла:', audioUrl);
    console.log('Шаг 2: Скачивание аудиофайла по полученному URL...');

    // Шаг 2: Скачиваем аудио по полученной ссылке
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
        console.error(`Не удалось скачать аудиофайл. Статус: ${audioResponse.status} ${audioResponse.statusText}`);
        throw new Error('Failed to download the audio file from the provided URL.');
    }

    // Преобразуем ответ в буфер
    const audioBuffer = await audioResponse.buffer();
    console.log('Шаг 2 завершен. Аудиофайл скачан. Размер (байт):', audioBuffer.length);
    
    return audioBuffer;
}

// --- Маршрут для генерации аудио (JSON с base64) ---
app.post('/generate', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    // Validate text length (Poe API limit is 2000 characters)
    const MAX_TEXT_LENGTH = 2000;
    if (text.length > MAX_TEXT_LENGTH) {
        return res.status(400).json({ 
            error: `Text length (${text.length} characters) exceeds the maximum limit of ${MAX_TEXT_LENGTH} characters. Please split the text into smaller chunks.` 
        });
    }

    try {
        const audioBuffer = await generateAudio(text);
        
        // Преобразуем буфер в base64
        const audioData = audioBuffer.toString('base64');
        
        // Отправляем JSON с base64-encoded аудио
        res.status(200).json({ audioData });
        console.log('Шаг 3 завершен. Аудиофайл успешно отправлен клиенту (base64).');

    } catch (error) {
        console.error('Произошла глобальная ошибка:', error);
        res.status(500).json({ error: error.message || 'An error occurred on the server.' });
    }
});

// --- Основной маршрут для генерации аудио (бинарный) ---
app.post('/generate-audio', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        const audioBuffer = await generateAudio(text);
        
        // Отправляем аудио как бинарный файл
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioBuffer.length);
        res.send(audioBuffer);

        console.log('Шаг 3 завершен. Аудиофайл успешно отправлен клиенту (binary).');

    } catch (error) {
        console.error('Произошла глобальная ошибка:', error);
        res.status(500).json({ error: error.message || 'An error occurred on the server.' });
    }
});

// --- Запуск сервера ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в вашем браузере`);
});
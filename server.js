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

// --- Основной маршрут для генерации аудио ---
app.post('/generate-audio', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    console.log(`Получен текст для генерации: "${text}"`);
    console.log('Шаг 1: Отправка запроса к Poe API для получения URL...');

    try {
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
            return res.status(apiResponse.status).json({ error: `Poe API Error: ${errorBody}` });
        }

        // Собираем URL из потока
        const audioUrl = await new Promise((resolve, reject) => {
            let fullContentUrl = '';
            let responseText = ''; // Для отладки

            apiResponse.body.on('data', (chunk) => {
                responseText += chunk.toString('utf-8');
                const events = responseText.split('\n\n');
                responseText = events.pop() || '';

                for (const line of events) {
                    if (line.startsWith('data: ')) {
                        const dataJson = line.substring(6);
                        if (dataJson.trim() === '[DONE]') continue;
                        
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
        });

        if (!audioUrl || !audioUrl.startsWith('http')) {
            console.error('Не удалось получить валидный URL на аудиофайл от Poe API. Получено:', audioUrl);
            return res.status(500).json({ error: 'API response did not contain a valid audio URL.' });
        }

        console.log('Шаг 1 завершен. Получен URL аудиофайла:', audioUrl);
        console.log('Шаг 2: Скачивание аудиофайла по полученному URL...');

        // Шаг 2: Скачиваем аудио по полученной ссылке
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
            console.error(`Не удалось скачать аудиофайл. Статус: ${audioResponse.status} ${audioResponse.statusText}`);
            return res.status(500).json({ error: 'Failed to download the audio file from the provided URL.' });
        }

        // Преобразуем ответ в буфер
        const audioBuffer = await audioResponse.buffer();
        console.log('Шаг 2 завершен. Аудиофайл скачан. Размер (байт):', audioBuffer.length);
        
        // Шаг 3: Отправляем аудио клиенту
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioBuffer.length);
        res.send(audioBuffer);

        console.log('Шаг 3 завершен. Аудиофайл успешно отправлен клиенту.');

    } catch (error) {
        console.error('Произошла глобальная ошибка:', error);
        res.status(500).json({ error: 'An error occurred on the server.' });
    }
});

// --- Запуск сервера ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в вашем браузере`);
});
import fetch from 'node-fetch';

// Это Serverless Function, которая будет запускаться Vercel на каждый запрос
export default async function handler(req, res) {
    // 1. Проверяем, что это POST-запрос
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 2. Получаем токен из переменных окружения Vercel
    const poeToken = process.env.POE_TOKEN;
    if (!poeToken) {
        console.error('POE_TOKEN не установлен в переменных окружения Vercel.');
        return res.status(500).json({ error: 'Server configuration error.' });
    }

    // 3. Получаем текст из тела запроса
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text is required in the request body.' });
    }

    // Validate text length (Poe API limit is 2000 characters)
    const MAX_TEXT_LENGTH = 2000;
    if (text.length > MAX_TEXT_LENGTH) {
        return res.status(400).json({ 
            error: `Text length (${text.length} characters) exceeds the maximum limit of ${MAX_TEXT_LENGTH} characters. Please split the text into smaller chunks.` 
        });
    }

    console.log(`Получен текст для генерации: "${text}"`);

    try {
        // --- ШАГ А: Получаем URL аудиофайла от Poe API ---
        console.log('Шаг А: Отправка запроса к Poe API для получения URL...');
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

        // Собираем URL из потокового ответа с таймаутом (60 секунд)
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
            console.error('Не удалось получить валидный URL на аудиофайл. Получено:', audioUrl);
            return res.status(500).json({ error: 'API response did not contain a valid audio URL.' });
        }

        console.log('Шаг А завершен. Получен URL:', audioUrl);

        // --- ШАГ Б: Скачиваем аудиофайл по полученному URL ---
        console.log('Шаг Б: Скачивание аудиофайла по URL...');
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
            console.error(`Не удалось скачать аудиофайл. Статус: ${audioResponse.status} ${audioResponse.statusText}`);
            return res.status(500).json({ error: 'Failed to download the audio file.' });
        }

        // Используем .arrayBuffer() - это современный стандарт
        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        console.log('Шаг Б завершен. Аудиофайл скачан. Размер (байт):', audioBuffer.length);

        // --- ШАГ В: Отправляем аудио клиенту (в браузер) ---
        // Проверяем, нужен ли JSON ответ (для chunking функциональности)
        const acceptHeader = req.headers.accept || '';
        const wantsJson = acceptHeader.includes('application/json') || req.query.format === 'json';
        
        if (wantsJson) {
            // Отправляем JSON с base64-encoded аудио (для chunking)
            const audioData = audioBuffer.toString('base64');
            res.status(200).json({ audioData });
            console.log('Шаг В завершен. Аудиофайл успешно отправлен клиенту (base64).');
        } else {
            // Отправляем бинарный аудио (для обратной совместимости)
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', audioBuffer.length);
            res.status(200).send(audioBuffer);
            console.log('Шаг В завершен. Аудиофайл успешно отправлен клиенту (binary).');
        }

    } catch (error) {
        console.error('Произошла глобальная ошибка в Serverless Function:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
}
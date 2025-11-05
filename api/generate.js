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
                let buffer = '';
                let hasReceivedData = false;

                apiResponse.body.on('data', (chunk) => {
                    hasReceivedData = true;
                    buffer += chunk.toString('utf-8');
                    
                    // Parse complete lines (SSE format: data: {...}\n\n)
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep incomplete line in buffer
                    
                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine) continue;
                        
                        if (trimmedLine.startsWith('data: ')) {
                            const dataJson = trimmedLine.substring(6).trim();
                            
                            if (dataJson === '[DONE]') {
                                console.log('Получен маркер [DONE] от Poe API.');
                                resolve(fullContentUrl);
                                return;
                            }
                            
                            try {
                                const data = JSON.parse(dataJson);
                                const contentPart = data.choices?.[0]?.delta?.content;
                                
                                if (contentPart) {
                                    fullContentUrl += contentPart;
                                    console.log(`Получен фрагмент URL (общая длина: ${fullContentUrl.length} символов)`);
                                }
                            } catch (e) {
                                console.log('Не удалось распарсить JSON из строки:', dataJson.substring(0, 100));
                            }
                        }
                    }
                });

                apiResponse.body.on('end', () => {
                    console.log('Поток от Poe API завершен. Получено символов URL:', fullContentUrl.length);
                    console.log('Первые 100 символов URL:', fullContentUrl.substring(0, 100));
                    
                    // Process any remaining buffer
                    if (buffer.trim()) {
                        const trimmedBuffer = buffer.trim();
                        if (trimmedBuffer.startsWith('data: ')) {
                            const dataJson = trimmedBuffer.substring(6).trim();
                            if (dataJson !== '[DONE]') {
                                try {
                                    const data = JSON.parse(dataJson);
                                    const contentPart = data.choices?.[0]?.delta?.content;
                                    if (contentPart) {
                                        fullContentUrl += contentPart;
                                    }
                                } catch (e) {
                                    console.log('Не удалось распарсить последний JSON:', dataJson.substring(0, 100));
                                }
                            }
                        }
                    }
                    
                    resolve(fullContentUrl);
                });

                apiResponse.body.on('error', (err) => {
                    console.error('Ошибка в потоке ответа:', err);
                    reject(err);
                });
                
                // Add a check after a short delay to ensure we received data
                setTimeout(() => {
                    if (!hasReceivedData) {
                        console.error('Не получено данных от Poe API в течение 5 секунд');
                        reject(new Error('Poe API не отправил данные в потоке'));
                    }
                }, 5000);
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout: Poe API не ответил в течение 60 секунд')), 60000)
            )
        ]);

        // Clean up the URL - remove any extra whitespace or newlines
        const cleanedUrl = audioUrl.trim();
        
        if (!cleanedUrl || cleanedUrl.length === 0) {
            console.error('Получен пустой URL от Poe API. Полная длина:', audioUrl.length);
            return res.status(500).json({ 
                error: 'API response did not contain a valid audio URL. The stream was empty.' 
            });
        }
        
        if (!cleanedUrl.startsWith('http')) {
            console.error('Получен невалидный URL от Poe API. Первые 200 символов:', cleanedUrl.substring(0, 200));
            console.error('Полная длина:', cleanedUrl.length);
            return res.status(500).json({ 
                error: `API response did not contain a valid audio URL. Received: ${cleanedUrl.substring(0, 100)}...` 
            });
        }

        console.log('Шаг А завершен. Получен URL (длина:', cleanedUrl.length, '):', cleanedUrl.substring(0, 100) + '...');

        // --- ШАГ Б: Скачиваем аудиофайл по полученному URL ---
        console.log('Шаг Б: Скачивание аудиофайла по URL...');
        const audioResponse = await fetch(cleanedUrl);
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